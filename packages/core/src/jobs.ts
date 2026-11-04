/**
 * Durable job runner over PostgreSQL (authority for money-changing work). Claims with
 * FOR UPDATE SKIP LOCKED + a lease; a crashed worker's lease expires and the job is re-run.
 * All handlers are idempotent and re-read authoritative state.
 */
import { many, tx } from "@zeb/db";
import { DomainError, randomToken } from "@zeb/domain";
import type { CoreContext } from "./context";
import { unlockCredit } from "./credits";
import { ingestScannerEvent } from "./deposits";
import { enqueueJob, raiseException } from "./events";
import { deliverOutbox } from "./alerts";
import type { P2PExecutor } from "./executor";
import { lockIntent, transitionIntent } from "./intents";
import { advancePayout } from "./payouts";
import { reconcile, refreshInventory } from "./reconcile";
import { treasury } from "@zeb/ledger";
import { deliverEmails } from "./mail";
import { advanceTfPayout, type TfDeps } from "./tfpayouts";
import { advanceP2pPreparation } from "./p2pprep";

export interface JobRow {
  id: string;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type Handler = (ctx: CoreContext, job: JobRow) => Promise<{ rerunInMs?: number | null } | void>;

export const PERIODIC: Array<{ kind: string; everyMs: number }> = [
  { kind: "intents.expire", everyMs: 15_000 },
  { kind: "treasury.inventory", everyMs: 60_000 },
  { kind: "reconcile", everyMs: 10 * 60_000 },
  { kind: "scanner.poll", everyMs: 4_000 } /* near-realtime: mempool sighting within seconds */,
  { kind: "email.deliver", everyMs: 10_000 },
  { kind: "outbox.dispatch", everyMs: 5_000 },
];

export function buildHandlers(exec: P2PExecutor | null, tf: TfDeps = { port: null, web: null }): Record<string, Handler> {
  return {
    "tfpayout.advance": async (ctx, job) => advanceTfPayout(ctx, tf, String(job.payload.id)),
    "p2p.prepare": async (ctx, job) => advanceP2pPreparation(ctx, tf, String(job.payload.intentId)),
    "payout.advance": async (ctx, job) => advancePayout(ctx, exec, job.payload.kind as "scan_pay", String(job.payload.id)),
    "credit.unlock": async (ctx, job) => {
      const result = await unlockCredit(ctx, String(job.payload.creditId));
      // Return the reschedule to the lease owner; enqueueing the currently running
      // dedupe key alone would be overwritten by runJob's completion update.
      return { rerunInMs: result === "not_due" ? 60_000 : result === "blocked" ? 3_600_000 : null };
    },
    "intents.expire": async (ctx) => {
      await expireIntents(ctx);
      return { rerunInMs: 15_000 };
    },
    "treasury.inventory": async (ctx) => {
      await refreshInventory(ctx);
      return { rerunInMs: 60_000 };
    },
    reconcile: async (ctx) => {
      await reconcile(ctx);
      return { rerunInMs: 10 * 60_000 };
    },
    "scanner.poll": async (ctx) => {
      await pollScanner(ctx);
      return { rerunInMs: 10_000 };
    },
    "email.deliver": async (ctx) => {
      await deliverEmails(ctx);
      return { rerunInMs: 10_000 };
    },
    "outbox.dispatch": async (ctx) => {
      await deliverOutbox(ctx);
      return { rerunInMs: 5_000 };
    },
  };
}

export async function expireIntents(ctx: CoreContext): Promise<number> {
  const due = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM payment_intents pi WHERE environment=$1 AND status='awaiting_zec' AND deposit_submission_deadline < $2
       AND NOT EXISTS (SELECT 1 FROM deposit_observations d WHERE d.intent_id=pi.id) LIMIT 200`,
    [ctx.env, ctx.now()],
  );
  for (const { id } of due) {
    await tx(ctx.db, async (t) => {
      const i = await lockIntent(t, ctx, id);
      if (i.status !== "awaiting_zec") return;
      const obs = await many(t, `SELECT 1 FROM deposit_observations WHERE intent_id=$1`, [id]);
      if (obs.length) return; // a deposit raced in; never expire a funded intent
      await transitionIntent(t, ctx, i, "expired_without_funds", { label: "Expired", detail: "No ZEC was detected before the deadline. The address stays monitored; late ZEC is routed to refund review." });
      await treasury.setState(t, ctx.env, id, "released");
    });
  }
  const stalled = await many<{id:string}>(ctx.db, `SELECT id FROM payment_intents WHERE environment=$1 AND status IN ('deposit_seen','confirming') AND finality_deadline<$2 LIMIT 200`,[ctx.env,ctx.now()]);
  for (const {id} of stalled) await tx(ctx.db,async(t)=>{
    const i=await lockIntent(t,ctx,id);
    if (!["deposit_seen","confirming"].includes(i.status)) return;
    await transitionIntent(t,ctx,i,"manual_review",{label:"Confirmation window ended",detail:"Payment remains watched. Any canonical funds require custody/refund review.",set:{exception_reason:"finality_window_expired"}});
    await raiseException(t,ctx.env,{kind:"finality_window_expired",severity:"warning",intentId:id});
  });
  return due.length+stalled.length;
}

const zkoolWatchOnlyProven = new WeakSet<object>();
const zkoolSchemaChecked = new WeakSet<object>();

/**
 * zkool_graphql watch-only watcher (HACKATHON_TESTNET receiving; MAINNET_READONLY monitoring).
 * Each poll: sync the account, read incoming notes (mined + mempool), map each note to the invoice
 * whose diversified address it was paid to, and ingest idempotently. Restart-safe: every event id
 * is derived from (network, note identity, height, confirmations), so replays are no-ops.
 */
export async function pollZkool(ctx: CoreContext, z = ctx.zkool!): Promise<{ events: number; reorged: number }> {
  const net = z.network;
  try {
    if (!zkoolSchemaChecked.has(z)) {
      await z.assertSchema(); // introspection: refuse to run against an incompatible zkool build
      zkoolSchemaChecked.add(z);
    }
    if (!zkoolWatchOnlyProven.has(z)) {
      await z.assertWatchOnly(); // refuse to operate a spend-capable account/token
      zkoolWatchOnlyProven.add(z);
    }
    const st = await z.status();
    await ctx.db.query(
      `INSERT INTO scanner_state(environment, network, tip_height, scanned_height, tip_observed_at, consensus_branch, ironwood_supported, status, gateway_version, nu7_active, tip_hash, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$10,$5,$6,$7,$8,$9,$11,NULL,now())
       ON CONFLICT (environment, network) DO UPDATE SET tip_height=EXCLUDED.tip_height, tip_hash=EXCLUDED.tip_hash, scanned_height=EXCLUDED.scanned_height, tip_observed_at=EXCLUDED.tip_observed_at,
         consensus_branch=EXCLUDED.consensus_branch, ironwood_supported=EXCLUDED.ironwood_supported, status=EXCLUDED.status, gateway_version=EXCLUDED.gateway_version,
         nu7_active=EXCLUDED.nu7_active, last_error=NULL, updated_at=now()`,
      [ctx.env, net, st.tipHeight, st.scannedHeight, st.consensusBranchId, st.ironwoodSupported, st.state, st.version, st.nu7Active, st.tipTime, st.tipHash],
    );
    // Do not attribute while the wallet is still catching up from its birth height (WATCHER_CATCHING_UP).
    if (st.state !== "synced") return { events: 0, reorged: 0 };
    const rows = await many<{ diversifier_index: string; address: string }>(
      ctx.db,
      `SELECT diversifier_index::text AS diversifier_index, address FROM zcash_addresses
        WHERE environment=$1 AND network=$2 AND wallet_id=$3 AND memo_code IS NULL`,
      [ctx.env, net, `zkool:${net}:${z.accountId}`],
    );
    const byIndex = new Map(rows.map((r) => [r.diversifier_index, r.address]));
    const events = await z.snapshot(st.tipHeight, byIndex);
    for (const ev of events) {
      // A clamped confirmation event may already have been seen before a reorg.
      const previous=await ctx.db.query<{reorged_at:Date}>(`SELECT reorged_at FROM deposit_observations WHERE environment=$1 AND network=$2 AND output_ref=$3 AND NOT canonical`,[ctx.env,net,ev.outputRef]);
      const removed=previous.rows[0]?.reorged_at;
      await ingestScannerEvent(ctx, removed ? {...ev,eventId:`${ev.eventId}:reobserved:${removed.toISOString()}`} : ev, "zkool");
    }
    // Reorg detection: a mined, canonical observation whose note is no longer reported as mined.
    const minedNow = new Set(events.filter((e) => e.blockHeight !== null).map((e) => e.outputRef));
    const known = await many<{ txid: string; output_ref: string; pool: string; value_zatoshis: string; address: string }>(
      ctx.db,
      `SELECT d.txid, d.output_ref, d.pool, d.value_zatoshis, coalesce(za.address,d.observed_address) AS address FROM deposit_observations d LEFT JOIN zcash_addresses za ON za.id=d.zcash_address_id
        WHERE d.environment=$1 AND d.network=$2 AND d.mined AND d.canonical AND d.scan_version='zkool_graphql'
          AND d.wallet_id=$3`, // unknown historical account ownership is never guessed
      [ctx.env, net, `zkool:${net}:${z.accountId}`],
    );
    let reorged = 0;
    for (const k of known) {
      if (minedNow.has(k.output_ref)) continue;
      reorged++;
      await ingestScannerEvent(ctx, { eventId: `zkool-reorg:${k.output_ref}:${st.tipHeight}`, kind: "note_reorged", network: net, pool: k.pool as "ironwood", txid: k.txid, outputRef: k.output_ref, valueZatoshis: k.value_zatoshis, address: k.address, blockHeight: null, blockHash: null, confirmations: 0, scanVersion: "zkool_graphql", memo: null }, "zkool");
    }
    return { events: events.length, reorged };
  } catch (e) {
    await ctx.db.query(
      `INSERT INTO scanner_state(environment, network, status, last_error, updated_at) VALUES ($1,$2,'error',$3,now())
       ON CONFLICT (environment, network) DO UPDATE SET status='error', last_error=EXCLUDED.last_error, updated_at=now()`,
      [ctx.env, net, (e as Error).message.slice(0, 300)],
    );
    throw e;
  }
}

export async function pollScanner(ctx: CoreContext): Promise<void> {
  if (ctx.zkool) {
    for (const z of [ctx.zkool,...(ctx.zkoolLegacy ?? [])]) {
      await pollZkool(ctx,z);
      const status=(await ctx.db.query<{status:string}>(`SELECT status FROM scanner_state WHERE environment=$1 AND network=$2`,[ctx.env,z.network])).rows[0]?.status;
      if(status!=='synced') throw new DomainError('WALLET_CATCHING_UP','All receiving accounts must finish scanning before readiness opens');
    }
    const watched=[ctx.zkool,...(ctx.zkoolLegacy ?? [])].map(z=>`zkool:${z.network}:${z.accountId}`);
    const missing=await ctx.db.query(`SELECT DISTINCT wallet_id FROM zcash_addresses WHERE environment=$1 AND network=$2 AND wallet_id LIKE 'zkool:%' AND NOT(wallet_id=ANY($3))`,[ctx.env,ctx.zkool.network,watched]);
    if(missing.rowCount) {
      await ctx.db.query(`UPDATE scanner_state SET status='error',last_error='Existing receiving account is no longer configured for monitoring',updated_at=now() WHERE environment=$1 AND network=$2`,[ctx.env,ctx.zkool.network]);
      throw new DomainError('WALLET_MONITORING_GAP','Every previously issued receiver must remain monitored');
    }
    return;
  }
  if (!ctx.gateway || !ctx.cfg.zcashNetwork) return;
  const net = ctx.cfg.zcashNetwork;
  try {
    const st = await ctx.gateway.status();
    if (st.network !== net) throw new DomainError("WALLET_NETWORK_MISMATCH", `gateway reports ${st.network}, expected ${net}`);
    await ctx.db.query(
      `INSERT INTO scanner_state(environment, network, tip_height, tip_hash, scanned_height, tip_observed_at, consensus_branch, ironwood_supported, status, gateway_version, nu7_active, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,now())
       ON CONFLICT (environment, network) DO UPDATE SET tip_height=EXCLUDED.tip_height, tip_hash=EXCLUDED.tip_hash, scanned_height=EXCLUDED.scanned_height,
         tip_observed_at=EXCLUDED.tip_observed_at, consensus_branch=EXCLUDED.consensus_branch, ironwood_supported=EXCLUDED.ironwood_supported,
         status=EXCLUDED.status, gateway_version=EXCLUDED.gateway_version, nu7_active=EXCLUDED.nu7_active, last_error=NULL, updated_at=now()`,
      [ctx.env, net, st.tipHeight, st.tipHash, st.scannedHeight, st.tipTime, st.consensusBranchId, st.ironwoodSupported, st.state, st.version, st.nu7Active],
    );
    const cur = await many<{ deposit_cursor: string | null }>(ctx.db, `SELECT deposit_cursor FROM scanner_state WHERE environment=$1 AND network=$2`, [ctx.env, net]);
    let cursor = cur[0]?.deposit_cursor ?? null;
    for (let page = 0; page < 10; page++) {
      const r = await ctx.gateway.deposits(cursor);
      for (const ev of r.events) await ingestScannerEvent(ctx, ev);
      if (!r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
      await ctx.db.query(`UPDATE scanner_state SET deposit_cursor=$3 WHERE environment=$1 AND network=$2`, [ctx.env, net, cursor]);
      if (r.events.length === 0) break;
    }
  } catch (e) {
    await ctx.db.query(
      `INSERT INTO scanner_state(environment, network, status, last_error, updated_at) VALUES ($1,$2,'error',$3,now())
       ON CONFLICT (environment, network) DO UPDATE SET status='error', last_error=EXCLUDED.last_error, updated_at=now()`,
      [ctx.env, net, (e as Error).message.slice(0, 300)],
    );
    throw e;
  }
}

/* ------------------------------------------------------------------ runner */

export async function ensurePeriodic(ctx: CoreContext) {
  for (const p of PERIODIC) await enqueueJob(ctx.db, ctx.env, p.kind, "periodic", {});
}

export async function claim(ctx: CoreContext, owner: string, limit = 5, leaseMs = 120_000): Promise<JobRow[]> {
  return tx(ctx.db, async (t) => {
    const r = await t.query<JobRow>(
      `UPDATE jobs SET state='running', lease_owner=$2, lease_expires_at=now() + ($3 || ' milliseconds')::interval, attempts=attempts+1, updated_at=now()
        WHERE id IN (
          SELECT id FROM jobs WHERE environment=$1 AND (
            (state IN ('queued','failed') AND run_at <= now()) OR (state='running' AND lease_expires_at < now())
          ) ORDER BY run_at LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, dedupe_key, payload, attempts, max_attempts`,
      [ctx.env, owner, String(leaseMs), limit],
    );
    return r.rows;
  });
}

export async function runJob(ctx: CoreContext, handlers: Record<string, Handler>, job: JobRow, owner: string): Promise<void> {
  const h = handlers[job.kind];
  try {
    if (!h) throw new Error(`no handler for ${job.kind}`);
    const out = (await h(ctx, job)) ?? {};
    const rerun = out.rerunInMs;
    if (rerun !== undefined && rerun !== null) {
      await ctx.db.query(`UPDATE jobs SET state='queued', attempts=0, run_at=now() + ($3 || ' milliseconds')::interval, lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now() WHERE id=$1 AND lease_owner=$2`, [
        job.id,
        owner,
        String(rerun),
      ]);
    } else {
      await ctx.db.query(`UPDATE jobs SET state='done', lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND lease_owner=$2`, [job.id, owner]);
    }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const dead = job.attempts >= job.max_attempts;
    const backoff = Math.min(15 * 60_000, 2_000 * 2 ** Math.min(job.attempts, 9)) + Math.floor(Math.random() * 1000);
    await ctx.db.query(
      `UPDATE jobs SET state=$3, last_error=$4, run_at=now() + ($5 || ' milliseconds')::interval, lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND lease_owner=$2`,
      [job.id, owner, dead ? "dead" : "failed", msg, String(backoff)],
    );
    ctx.log.warn({ job: job.kind, id: job.id, attempts: job.attempts, dead, err: msg }, "job failed");
  }
}

export function workerId(): string {
  return `w-${process.pid}-${randomToken(4)}`;
}
