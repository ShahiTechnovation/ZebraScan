/** Isolated defect reproductions; harness refuses database names not ending in _test. */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { enqueueJob, evaluateReconcile, ingestScannerEvent, runJob, claim } from "@zeb/core";
import { validateP2PWebConfig } from "@zeb/providers";
import { Client, key, makeHarness } from "../tests/integration/harness";

const h = await makeHarness();
const out: Record<string, unknown> = { checkedAt: new Date().toISOString(), scope: "isolated _test database; synthetic events only" };
try {
  const c = new Client(h.app);
  const make = async () => {
    const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "20000", privacyPreference: "shielded" }, key: key() });
    const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "audit.fixture@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    if (r.status !== 201) throw new Error(`fixture creation HTTP ${r.status}`);
    return { id: r.json.checkout.id as string, zat: q.json.zecZatoshis as string, address: r.json.checkout.zcash.address as string };
  };
  const ev = (id: string, address: string, zat: string, memo: string | null = null) => ({ eventId: id, kind: "note_confirmed" as const, network: "demo", pool: "demo" as const, txid: createHash("sha256").update(id).digest("hex"), outputRef: id, valueZatoshis: zat, address, blockHeight: 10, blockHash: null, confirmations: 3, scanVersion: "audit-fixture", memo });
  await ingestScannerEvent(h.ctx, ev("unknown-1", "unmapped:a", "10"));
  await ingestScannerEvent(h.ctx, ev("unknown-2", "unmapped:b", "20"));
  out.unmatched = { inputs: 2, deposits: (await h.db.query("SELECT count(*)::int AS n FROM deposit_observations")).rows[0].n, exceptions: (await h.db.query("SELECT count(*)::int AS n FROM exceptions WHERE kind='unattributed_deposit'")).rows[0].n, retainedDetails: (await h.db.query("SELECT details FROM exceptions WHERE kind='unattributed_deposit'")).rows };

  const m = await make();
  const memo = "ZEB-AAAAAAAAAAAAAAAA";
  await h.db.query("UPDATE zcash_addresses SET memo_code=$1 WHERE intent_id=$2", [memo, m.id]);
  const original = ev("memo-deposit", m.address, m.zat, memo);
  await ingestScannerEvent(h.ctx, original);
  await ingestScannerEvent(h.ctx, { ...original, eventId: "memo-reorg", kind: "note_reorged", blockHeight: null, confirmations: 0, memo: null });
  out.memoReorg = (await h.db.query("SELECT p.status,d.canonical,d.accepted FROM payment_intents p JOIN deposit_observations d ON d.intent_id=p.id WHERE p.id=$1", [m.id])).rows;

  const late = await make();
  await h.db.query("UPDATE payment_intents SET status='expired_without_funds' WHERE id=$1", [late.id]);
  const lateEv = { ...ev("late-mempool", late.address, late.zat), kind: "note_seen" as const, blockHeight: null, confirmations: 0 };
  await ingestScannerEvent(h.ctx, lateEv);
  out.lateMempool = (await h.db.query("SELECT p.status,d.mined,d.confirmations,(SELECT count(*)::int FROM ledger_journals j WHERE j.event_id LIKE 'refund_due:' || p.id || '%') AS refund_journals FROM payment_intents p JOIN deposit_observations d ON d.intent_id=p.id WHERE p.id=$1", [late.id])).rows;

  await enqueueJob(h.db, "demo", "audit.reschedule", "one", {});
  const job = (await claim(h.ctx, "audit", 20)).find(j => j.kind === "audit.reschedule")!;
  await runJob(h.ctx, { "audit.reschedule": async ctx => { await enqueueJob(ctx.db, ctx.env, "audit.reschedule", "one", {}, new Date(Date.now() + 3600000)); } }, job, "audit");
  out.reschedule = (await h.db.query("SELECT state FROM jobs WHERE kind='audit.reschedule'")).rows;

  out.agentOnlyCompletion = evaluateReconcile({ order_found: true, provider_order_id: "audit-fixture-order", provider_order_status: "COMPLETED", visible_recipient: "audit.fixture@okaxis", visible_inr: "200.00", visible_usdc: "", provider_reference: "", observed_url: "https://app.p2p.me/", blocker: "" }, { vpa: "audit.fixture@okaxis", inrPaise: 20000n, maxUsdc: 3000000n, variance: 0n }, "audit-fixture-order", validateP2PWebConfig("https://app.p2p.me/"));
} finally { await h.close(); }
writeFileSync("docs/evidence/audit-2026-11-04/reproductions.json", JSON.stringify(out, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
console.log(JSON.stringify(out, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2));
