/**
 * P2P preparation: the 1-confirmation trigger (P2P_INIT_CONFIRMATIONS).
 *
 * SAFETY CONTRACT
 *  - Preparation is READ-ONLY: a fresh TinyFish capability preflight of the authenticated provider
 *    account. It never places an order, never commits provider escrow, never signs a USDC transfer.
 *    No provider draft is created (the provider offers no non-binding draft); provider_draft_ref
 *    stays NULL. A READY row is NOT an authorization to pay.
 *  - Deposit acceptance, ledger liabilities and the payout command still wait for
 *    REQUIRED_CONFIRMATIONS (deposits.ts) and every gate in tfpayouts.executionBlockers.
 *  - One row per checkout (UNIQUE environment,intent_id) + one outbox job per checkout: replayed
 *    scanner events, repeated block observations and worker restarts cannot start a second run.
 *  - The TinyFish run id is persisted; an existing run is polled, never re-queued. An ambiguous
 *    queue error is reconciled by searching runs for the checkout reference before any retry.
 *  - A reorg, stale scanner, or pause HOLDS the preparation; nothing downstream may rely on it.
 */
import { createHash } from "node:crypto";
import { many, maybeOne, tx, type Tx } from "@zeb/db";
import { maskVpa, newId } from "@zeb/domain";
import { PREFLIGHT_SCHEMA, buildPreflightGoal } from "@zeb/providers";
import { canonicalJson } from "@zeb/security";
import type { CoreContext } from "./context";
import { audit, emitResource, enqueueJob } from "./events";
import type { IntentRow } from "./intents";
import { evaluatePreflight, railReady, type TfDeps } from "./tfpayouts";

export type PrepState = "PENDING" | "RUNNING" | "READY" | "BLOCKED" | "HELD" | "CANCELLED";
export const MAX_PREP_ATTEMPTS = 3;

export interface PrepRow {
  id: string;
  environment: string;
  intent_id: string;
  deposit_id: string;
  block_height: string;
  confirmations: number;
  inr_paise: string;
  max_usdc_debit_micros: string;
  vpa_masked: string;
  terms_hash: string;
  state: PrepState;
  state_reason: string | null;
  attempts: number;
  tinyfish_run_id: string | null;
  provider_draft_ref: string | null;
  run_started_at: Date | null;
  updated_at: Date;
}

/**
 * The chain view the trigger relies on: the scanner must be synced, fresh, Ironwood-capable, on the
 * expected network and not lagging. Returns the blocking reason, or null when healthy.
 */
export async function chainViewBlocker(q: Tx | CoreContext["db"], ctx: CoreContext): Promise<string | null> {
  const s = await maybeOne<{ status: string; ironwood_supported: boolean; tip_height: string | null; scanned_height: string | null; tip_observed_at: Date | null; updated_at: Date }>(
    q,
    `SELECT status, ironwood_supported, tip_height, scanned_height, tip_observed_at, updated_at FROM scanner_state WHERE environment=$1 AND network=$2`,
    [ctx.env, ctx.cfg.zcashNetwork],
  );
  const now = ctx.now().getTime();
  if (!s) return "scanner has not reported";
  if (!s.ironwood_supported) return "scanner does not report Ironwood support";
  if (s.status !== "synced") return `scanner is ${s.status}`;
  if (now - new Date(s.updated_at).getTime() > 120_000) return "scanner status is stale";
  if (s.tip_height && s.scanned_height && BigInt(s.tip_height) - BigInt(s.scanned_height) > BigInt(ctx.cfg.policy.scannerMaxLagBlocks)) return "scanner is behind the chain tip";
  if (s.tip_observed_at && now - new Date(s.tip_observed_at).getTime() > ctx.cfg.policy.scannerMaxTipAgeSec * 1000) return "chain tip is stale";
  return null;
}

async function paused(q: Tx | CoreContext["db"], ctx: CoreContext): Promise<boolean> {
  const g = await many<{ feature: string }>(q, `SELECT feature FROM feature_gates WHERE environment=$1 AND NOT enabled AND feature = ANY($2)`, [ctx.env, ["all", "payouts", "scanPay"]]);
  return g.length > 0;
}

export function prepTermsHash(c: { environment: string; intentId: string; vpa: string; inrPaise: bigint; maxUsdc: bigint; quoteId: string; depositId: string }): string {
  return createHash("sha256")
    .update(canonicalJson({ ...c, vpa: c.vpa.toLowerCase(), inrPaise: c.inrPaise.toString(), maxUsdc: c.maxUsdc.toString() }))
    .digest("hex");
}

/**
 * Called inside the deposit-ingestion transaction for a mined output of an open checkout. Creates the
 * preparation row and its outbox job atomically, or does nothing. Never throws for a missing
 * prerequisite (deposit scanning must not be blocked) and never calls TinyFish.
 */
export async function maybeQueueP2pPreparation(
  t: Tx,
  ctx: CoreContext,
  intent: IntentRow,
  obs: { id: string; block_height: string | number | null; block_hash?: string | null; confirmations: number; canonical: boolean; mined: boolean },
): Promise<"queued" | "exists" | "skipped"> {
  const need = ctx.cfg.policy.p2pInitConfirmations;
  if (ctx.env !== "mainnet-enabled" || ctx.cfg.payoutRail !== "P2P_TINYFISH_WEB") return "skipped";
  if (intent.mode !== "scan_pay" || !intent.recipient_vpa_ct || intent.payout_status !== "not_started") return "skipped";
  if (!obs.canonical || !obs.mined || obs.block_height === null || obs.confirmations < need) return "skipped";
  if (await chainViewBlocker(t, ctx)) return "skipped"; // re-evaluated on the next scanner event
  if (await paused(t, ctx)) return "skipped";

  const quote = await maybeOne<{ id: string; inr_paise: string; required_usdc_micros: string; zec_zatoshis: string }>(t, `SELECT id, inr_paise, required_usdc_micros, zec_zatoshis FROM quotes WHERE id=$1`, [intent.quote_id]);
  const auth = await maybeOne(t, `SELECT 1 FROM payout_authorizations WHERE intent_id=$1 AND environment=$2`, [intent.id, ctx.env]);
  if (!quote || !auth) return "skipped"; // terms are not locked
  const vpa = await ctx.envelope.open(intent.recipient_vpa_ct, `payment_intents:${intent.id}:recipient_vpa`);
  const hash = prepTermsHash({ environment: ctx.env, intentId: intent.id, vpa, inrPaise: BigInt(quote.inr_paise), maxUsdc: BigInt(quote.required_usdc_micros), quoteId: quote.id, depositId: obs.id });

  const ins = await maybeOne<{ id: string }>(
    t,
    `INSERT INTO payout_preparations(id, environment, intent_id, deposit_id, block_height, block_hash, confirmations, zec_zatoshis, inr_paise, max_usdc_debit_micros, vpa_masked, terms_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (environment, intent_id) DO NOTHING RETURNING id`,
    [newId("order").replace(/^ord_/, "prep_"), ctx.env, intent.id, obs.id, String(obs.block_height), obs.block_hash ?? null, obs.confirmations, quote.zec_zatoshis, quote.inr_paise, quote.required_usdc_micros, maskVpa(vpa), hash],
  );
  if (ins) {
    await enqueueJob(t, ctx.env, "p2p.prepare", intent.id, { intentId: intent.id });
    await emitResource(t, ctx.env, `checkout:${intent.id}`, "p2p.preparing", { label: "1 confirmation — preparing P2P", detail: "Read-only provider check only. No order is placed and no funds are committed." });
    await audit(t, ctx.env, { actorType: "system", action: "p2p.preparation.queued", target: intent.id, details: { depositId: obs.id, height: String(obs.block_height), confirmations: obs.confirmations, termsHash: hash } });
    return "queued";
  }
  // A HELD preparation stays held: after a reorg the checkout moves to chain_reorg_review and needs a human.
  return "exists";
}

/** Hold (never delete) a preparation whose deposit is no longer safe. Called from reorg handling. */
export async function holdP2pPreparation(q: Tx, ctx: CoreContext, intentId: string, reason: string): Promise<void> {
  const r = await q.query(`UPDATE payout_preparations SET state='HELD', state_reason=$3, updated_at=now() WHERE environment=$1 AND intent_id=$2 AND state IN ('PENDING','RUNNING','READY','BLOCKED')`, [ctx.env, intentId, reason]);
  if (r.rowCount) {
    await emitResource(q, ctx.env, `checkout:${intentId}`, "p2p.held", { label: "P2P preparation on hold", detail: reason });
    await audit(q, ctx.env, { actorType: "system", action: "p2p.preparation.held", target: intentId, details: { reason } });
  }
}

export async function loadPreparation(q: Tx | CoreContext["db"], env: string, intentId: string): Promise<PrepRow | null> {
  return maybeOne<PrepRow>(q, `SELECT * FROM payout_preparations WHERE environment=$1 AND intent_id=$2`, [env, intentId]);
}

async function setPrep(ctx: CoreContext, id: string, state: PrepState, reason: string | null, extra: { response?: unknown; runId?: string | null } = {}) {
  await ctx.db.query(
    `UPDATE payout_preparations SET state=$2, state_reason=$3, provider_response=coalesce($4::jsonb, provider_response), tinyfish_run_id=coalesce($5, tinyfish_run_id), updated_at=now() WHERE id=$1 AND state<>'HELD'`,
    [id, state, reason, extra.response === undefined ? null : JSON.stringify(extra.response), extra.runId ?? null],
  );
}

/**
 * Outbox consumer for `p2p.prepare`. Idempotent and restart-safe. Returns the re-run delay.
 */
export async function advanceP2pPreparation(ctx: CoreContext, deps: TfDeps, intentId: string): Promise<{ rerunInMs: number | null }> {
  const p = await loadPreparation(ctx.db, ctx.env, intentId);
  if (!p || ["READY", "BLOCKED", "HELD", "CANCELLED"].includes(p.state)) return { rerunInMs: null };

  // Re-verify the chain view and the deposit immediately before any external action.
  const why = await tx(ctx.db, async (t) => {
    const obs = await maybeOne<{ canonical: boolean; mined: boolean; confirmations: number }>(t, `SELECT canonical, mined, confirmations FROM deposit_observations WHERE id=$1 FOR SHARE`, [p.deposit_id]);
    const it = await maybeOne<{ status: string; payout_status: string }>(t, `SELECT status, payout_status FROM payment_intents WHERE id=$1`, [intentId]);
    let reason: string | null = null;
    if (!obs || !obs.canonical || !obs.mined) reason = "deposit is no longer on the canonical chain";
    else if (obs.confirmations < ctx.cfg.policy.p2pInitConfirmations) reason = "deposit confirmations dropped below the initiation threshold";
    else if (!it || !["confirming", "deposit_accepted"].includes(it.status)) reason = `checkout is ${it?.status ?? "missing"}`;
    else if (await paused(t, ctx)) reason = "payments or payouts are paused";
    if (reason) await holdP2pPreparation(t, ctx, intentId, reason);
    return reason;
  });
  if (why) return { rerunInMs: null };
  const chain = await chainViewBlocker(ctx.db, ctx);
  if (chain) return { rerunInMs: 30_000 }; // stale chain view: wait, never trigger TinyFish
  const rail = railReady(ctx, deps);
  if (rail) {
    await setPrep(ctx, p.id, "PENDING", `provider automation unavailable: ${rail}`);
    return { rerunInMs: 300_000 };
  }

  const ref = `prep-${intentId}`;
  if (p.state === "PENDING" || (p.state === "RUNNING" && !p.tinyfish_run_id)) {
    if (p.attempts >= MAX_PREP_ATTEMPTS) {
      await setPrep(ctx, p.id, "BLOCKED", "preparation could not start after repeated attempts");
      return { rerunInMs: null };
    }
    // Persist intent to run BEFORE the external call; a crash leaves RUNNING without a run id.
    await ctx.db.query(`UPDATE payout_preparations SET state='RUNNING', attempts=attempts+1, run_started_at=now(), updated_at=now() WHERE id=$1 AND state IN ('PENDING','RUNNING')`, [p.id]);
    // Ambiguity guard: a previous attempt may have queued a run whose id we never saved.
    let existing: string | null = null;
    if (p.attempts > 0) {
      try {
        const found = await deps.port!.listByGoal(ref, new Date(new Date(p.run_started_at ?? ctx.now()).getTime() - 60_000).toISOString());
        existing = found[0]?.run_id ?? null;
      } catch {
        return { rerunInMs: 30_000 }; // cannot rule out an existing run: do not queue another
      }
    }
    if (existing) {
      await setPrep(ctx, p.id, "RUNNING", null, { runId: existing });
      return { rerunInMs: 5_000 };
    }
    try {
      const q = await deps.port!.queue({
        url: deps.web!.startUrl,
        goal: buildPreflightGoal(ref),
        use_profile: true,
        ...(deps.web!.profileId ? { profile_id: deps.web!.profileId } : {}),
        use_vault: false,
        agent_config: { mode: "strict", max_steps: ctx.cfg.pilot.runMaxSteps, max_duration_seconds: ctx.cfg.pilot.runMaxDurationSec },
        capture_config: { screenshots: true },
        output_schema: PREFLIGHT_SCHEMA as unknown as Record<string, unknown>,
      });
      if (!q.run_id) {
        await setPrep(ctx, p.id, "PENDING", `TinyFish rejected the run: ${(q.error?.message ?? "unknown").slice(0, 160)}`);
        return { rerunInMs: 120_000 };
      }
      await setPrep(ctx, p.id, "RUNNING", null, { runId: q.run_id });
      await audit(ctx.db, ctx.env, { actorType: "system", action: "p2p.preparation.run_started", target: intentId, details: { runId: q.run_id } });
      await emitResource(ctx.db, ctx.env, `checkout:${intentId}`, "p2p.preflight_running", { label: "TinyFish preflight running", detail: "Read-only check of the payout provider." });
      return { rerunInMs: 5_000 };
    } catch (e) {
      // Ambiguous: the run may exist. The next pass searches by reference before any retry.
      await setPrep(ctx, p.id, "RUNNING", `queue call failed ambiguously: ${(e as Error).message.slice(0, 120)}`);
      return { rerunInMs: 30_000 };
    }
  }

  // RUNNING with a persisted run id: poll only.
  const run = await deps.port!.get(p.tinyfish_run_id!);
  if (run.status === "PENDING" || run.status === "RUNNING") {
    const age = ctx.now().getTime() - new Date(p.run_started_at ?? p.updated_at).getTime();
    if (age < (ctx.cfg.pilot.runMaxDurationSec + 300) * 1000) return { rerunInMs: 5_000 };
    await setPrep(ctx, p.id, "BLOCKED", "preflight run did not finish in time");
    return { rerunInMs: null };
  }
  if (run.status !== "COMPLETED") {
    // Read-only run failed: safe to retry (bounded). Clear the run id so a fresh run is queued.
    await ctx.db.query(`UPDATE payout_preparations SET tinyfish_run_id=NULL, state='PENDING', state_reason=$2, updated_at=now() WHERE id=$1 AND state='RUNNING'`, [p.id, `preflight run ${run.status}`]);
    return { rerunInMs: 60_000 };
  }
  const v = evaluatePreflight(run.result, deps.web!, { flow: "SCAN_PAY", usdcMicros: BigInt(p.max_usdc_debit_micros) });
  const response = { ok: v.ok, reasons: v.reasons, observedUrl: v.obs?.observed_url ?? null, runId: run.run_id };
  if (v.ok) {
    await setPrep(ctx, p.id, "READY", null, { response });
    await tx(ctx.db, async (t) => {
      await emitResource(t, ctx.env, `checkout:${intentId}`, "p2p.prepared", { label: "P2P preparation ready", detail: "Provider reachable and funded. No order has been placed; execution waits for settlement finality and operator authorization." });
      await audit(t, ctx.env, { actorType: "system", action: "p2p.preparation.ready", target: intentId, details: { runId: run.run_id } });
    });
  } else {
    await setPrep(ctx, p.id, "BLOCKED", v.reasons.join("; ").slice(0, 400), { response });
    await tx(ctx.db, (t) => emitResource(t, ctx.env, `checkout:${intentId}`, "p2p.blocked", { label: "P2P preparation blocked", detail: v.reasons.join("; ").slice(0, 200) }));
  }
  return { rerunInMs: null };
}
