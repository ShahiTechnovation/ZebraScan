/**
 * P2P_TINYFISH_WEB rail under fault injection. A scripted TinyFish port (kind "simulated", which the
 * core only accepts in DEMO) drives the REAL payout state machine, leases, ledger and DB.
 */
import { afterEach, describe, expect, it } from "vitest";
import { approvePayout, markVerifiedNotSubmitted, reconcile, requestReconcile, type TfDeps } from "@zeb/core";
import { validateP2PWebConfig, type TfQueueParams, type TfRun, type TinyFishPort } from "@zeb/providers";
import { Client, key, makeHarness, type Harness } from "../integration/harness";

const WEB = validateP2PWebConfig("https://app.p2p.me/");
const ORIGIN = "https://app.p2p.me";

type Kind = "preflight" | "execute" | "reconcile";
type Script = Partial<Record<Kind, (goal: string, n: number) => { status?: TfRun["status"]; result?: Record<string, unknown> | null; throwOnQueue?: boolean; reject?: boolean }>>;

class ScriptedPort implements TinyFishPort {
  readonly kind = "simulated" as const;
  calls: Record<Kind, number> = { preflight: 0, execute: 0, reconcile: 0 };
  runs = new Map<string, TfRun>();
  constructor(private script: Script) {}
  private kindOf(goal: string): Kind {
    return /capability check/.test(goal) ? "preflight" : /order reconciliation/.test(goal) ? "reconcile" : "execute";
  }
  async queue(p: TfQueueParams) {
    const k = this.kindOf(p.goal);
    const n = ++this.calls[k];
    const s = this.script[k]?.(p.goal, n) ?? {};
    if (s.throwOnQueue) throw new Error("ECONNRESET");
    if (s.reject) return { run_id: null, error: { message: "billing: out of credits" } };
    const id = `run_${k}_${n}_${Math.random().toString(36).slice(2, 8)}`;
    this.runs.set(id, { run_id: id, status: s.status ?? "COMPLETED", goal: p.goal, result: s.result ?? null, error: s.status === "FAILED" ? { message: "agent crashed", category: "AGENT_FAILURE" } : null });
    return { run_id: id, error: null };
  }
  async get(id: string) {
    return this.runs.get(id)!;
  }
  async listByGoal() {
    return [];
  }
}

const preflightOk = () => ({ result: { account_authenticated: true, login_page_shown: false, account_identifier: "ops-account-1", pay_ui_available: true, sell_ui_available: true, visible_usdc_balance: "5000.00", visible_limits: "", wallet_signature_required: false, blocker: "", observed_url: `${ORIGIN}/` } });
const vpaOf = (goal: string) => /UPI VPA ([^ ]+)\./.exec(goal)?.[1] ?? "";
const inrOf = (goal: string) => /INR ([0-9.]+) to/.exec(goal)?.[1] ?? "";
const executeOk = (goal: string) => ({ result: { action: "submitted", submitted: true, final_url: `${ORIGIN}/orders/77`, provider_order_id: "P2P-77", visible_recipient: vpaOf(goal), visible_inr: `₹${inrOf(goal)}`, visible_usdc: "1.50 USDC", provider_order_status: "PLACED", blocking_issue: "", evidence_summary: "order placed" } });
const reconcileStatus = (status: string, vpa = "fault.test@okaxis", inr = "150.00") => ({ result: { order_found: true, provider_order_id: "P2P-77", provider_order_status: status, visible_recipient: vpa, visible_inr: `INR ${inr}`, visible_usdc: "1.50", provider_reference: "", observed_url: `${ORIGIN}/orders/77`, blocker: "" } });

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(script: Script) {
  const port = new ScriptedPort(script);
  const deps: TfDeps = { port, web: WEB };
  h = await makeHarness({ PAYOUT_RAIL: "P2P_TINYFISH_WEB" }, undefined, () => deps);
  return { port, deps };
}

async function paidScanPay(hh: Harness, vpa = "fault.test@okaxis", inr = "15000") {
  const c = new Client(hh.app);
  const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: inr, privacyPreference: "shielded" }, key: key() });
  const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa, source: "manual" }, payeeConfirmed: true }, key: key() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const s = await c.req("POST", `/api/v1/demo/checkout/${r.json.checkout.id}/simulate-deposit`, { body: { kind: "exact", confirmations: 3 }, key: key(), bearer: r.json.accessToken });
  expect(s.json.status).toBe("deposit_accepted");
  const cmd = (await hh.db.query(`SELECT id, state, command_hash FROM payout_commands WHERE source_intent_id=$1`, [r.json.checkout.id])).rows[0];
  return { c, intentId: r.json.checkout.id as string, token: r.json.accessToken as string, payoutId: cmd.id as string, hash: cmd.command_hash as string };
}
const state = async (hh: Harness, id: string) => (await hh.db.query(`SELECT state, state_reason FROM payout_commands WHERE id=$1`, [id])).rows[0] as { state: string; state_reason: string | null };

describe("TinyFish payout rail", () => {
  it("happy path: preflight → operator approval → order observed → separate reconciliation → RECONCILED", async () => {
    const { port } = await setup({ preflight: preflightOk, execute: (g) => executeOk(g), reconcile: () => reconcileStatus("COMPLETED") });
    const { payoutId, hash, intentId, c, token } = await paidScanPay(h!);
    // payer consent snapshot exists and is immutable
    const auth = await h!.db.query(`SELECT terms FROM payout_authorizations WHERE intent_id=$1`, [intentId]);
    expect(auth.rows[0].terms.recipientVpaMasked).not.toContain("fault.test");
    await expect(h!.db.query(`UPDATE payout_authorizations SET actor='x'`)).rejects.toThrow(/append-only/);

    await h!.runJobs();
    expect((await state(h!, payoutId)).state).toBe("OPERATOR_APPROVAL_REQUIRED"); // never unattended
    expect(port.calls.execute).toBe(0);

    await expect(approvePayout(h!.ctx, payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", "0".repeat(64))).rejects.toThrow(/differ/);
    await approvePayout(h!.ctx, payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", hash);
    await h!.runJobs(3);
    // TinyFish COMPLETED on the execute run is NOT success: only the order was observed.
    const mid = await state(h!, payoutId);
    expect(["ORDER_SUBMISSION_OBSERVED", "PROVIDER_COMPLETED_VERIFIED", "RECONCILED"]).toContain(mid.state);
    await h!.runJobs(20);
    expect((await state(h!, payoutId)).state).toBe("RECONCILED");
    expect(port.calls.execute).toBe(1);
    expect(port.calls.reconcile).toBeGreaterThanOrEqual(1);
    const pub = await c.req("GET", `/api/v1/checkout/${intentId}`, { bearer: token });
    expect(pub.json.payout.status).toBe("completed");
    expect(JSON.stringify(pub.json)).not.toMatch(/run_|P2P-77|tinyfish/i); // no runUrl / provider internals on public payloads
    const rec = await reconcile(h!.ctx, "tf");
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("authorized terms are immutable at the database level", async () => {
    await setup({ preflight: preflightOk });
    const { payoutId } = await paidScanPay(h!);
    await expect(h!.db.query(`UPDATE payout_commands SET requested_inr_paise = requested_inr_paise + 1 WHERE id=$1`, [payoutId])).rejects.toThrow(/immutable/);
  });

  it("preflight on a login page blocks the payout (a COMPLETED run is not readiness)", async () => {
    await setup({ preflight: () => ({ result: { ...preflightOk().result, account_authenticated: false, login_page_shown: true } }) });
    const { payoutId, intentId } = await paidScanPay(h!);
    await h!.runJobs();
    const s = await state(h!, payoutId);
    expect(s.state).toBe("PREFLIGHT_BLOCKED");
    expect(s.state_reason).toMatch(/not authenticated/);
    expect((await h!.db.query(`SELECT payout_status FROM payment_intents WHERE id=$1`, [intentId])).rows[0].payout_status).toBe("not_liquid");
  });

  it("execute run FAILED after possible click → OUTCOME_UNKNOWN_REVIEW, no retry, account lease held", async () => {
    const { port } = await setup({ preflight: preflightOk, execute: () => ({ status: "FAILED" }) });
    const a = await paidScanPay(h!, "first.payee@okaxis");
    await h!.runJobs();
    await approvePayout(h!.ctx, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", a.hash);
    await h!.runJobs(10);
    expect((await state(h!, a.payoutId)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    expect(port.calls.execute).toBe(1);
    const exc = await h!.db.query(`SELECT severity FROM exceptions WHERE kind='payout_outcome_unknown'`);
    expect(exc.rows[0]?.severity).toBe("urgent");
    // Second payout on the same operational account is blocked by the lease.
    const b = await paidScanPay(h!, "second.payee@okaxis");
    await h!.runJobs();
    await approvePayout(h!.ctx, b.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", b.hash);
    await h!.runJobs(5);
    expect((await state(h!, b.payoutId)).state).toBe("QUEUED");
    expect(port.calls.execute).toBe(1);
  });

  it("ambiguous queue error → OUTCOME_UNKNOWN_REVIEW; never re-queued", async () => {
    const { port } = await setup({ preflight: preflightOk, execute: () => ({ throwOnQueue: true }) });
    const a = await paidScanPay(h!);
    await h!.runJobs();
    await approvePayout(h!.ctx, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", a.hash);
    await h!.runJobs(10);
    expect((await state(h!, a.payoutId)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    expect(port.calls.execute).toBe(1);
  });

  it("explicit API rejection (never started) → AGENT_FAILED_BEFORE_COMMIT and frees the lease", async () => {
    await setup({ preflight: preflightOk, execute: () => ({ reject: true }) });
    const a = await paidScanPay(h!);
    await h!.runJobs();
    await approvePayout(h!.ctx, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", a.hash);
    await h!.runJobs(5);
    expect((await state(h!, a.payoutId)).state).toBe("AGENT_FAILED_BEFORE_COMMIT");
    const lease = await h!.db.query(`SELECT payout_id FROM p2p_account_leases`);
    expect(lease.rows[0].payout_id).toBeNull();
  });

  it("recipient mismatch after submission → urgent review, never completed", async () => {
    await setup({ preflight: preflightOk, execute: (g) => ({ result: { ...executeOk(g).result, visible_recipient: "attacker@okaxis" } }) });
    const a = await paidScanPay(h!);
    await h!.runJobs();
    await approvePayout(h!.ctx, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", a.hash);
    await h!.runJobs(10);
    expect((await state(h!, a.payoutId)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    const exc = await h!.db.query(`SELECT kind FROM exceptions WHERE kind='payout_mismatch_after_submit'`);
    expect(exc.rowCount).toBe(1);
  });

  it("verified-not-submitted needs a read-only reconciliation that finds no order, plus dual control", async () => {
    const { deps } = await setup({ preflight: preflightOk, execute: () => ({ status: "FAILED" }), reconcile: () => ({ result: { order_found: false, provider_order_id: "", provider_order_status: "UNKNOWN", visible_recipient: "", visible_inr: "", visible_usdc: "", observed_url: `${ORIGIN}/orders`, blocker: "" } }) });
    const a = await paidScanPay(h!);
    await h!.runJobs();
    await approvePayout(h!.ctx, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa", a.hash);
    await h!.runJobs(10);
    await expect(markVerifiedNotSubmitted(h!.ctx, a.payoutId, "apr_x")).rejects.toThrow(/reconciliation/);
    await requestReconcile(h!.ctx, deps, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa"); // queues read-only run
    await requestReconcile(h!.ctx, deps, a.payoutId, "usr_operator_aaaaaaaaaaaaaaaaaaaa"); // reads it
    await markVerifiedNotSubmitted(h!.ctx, a.payoutId, "apr_test");
    expect((await state(h!, a.payoutId)).state).toBe("AGENT_FAILED_BEFORE_COMMIT");
  });

  it("merchant withdrawal via SELL: provider cancels → credits restored exactly once", async () => {
    await setup({ preflight: preflightOk, execute: (g) => executeOk(g), reconcile: () => reconcileStatus("CANCELLED", "cancel.shop@okicici", "397.00") });
    const m = new Client(h!.app);
    await m.req("POST", "/api/v1/auth/register", { body: { email: "rail-shop@example.test", password: "correct horse battery staple" } });
    await m.req("POST", "/api/v1/merchants", { body: { displayName: "Rail Shop", handle: "rail-shop", category: "food" }, key: key() });
    await h!.db.query(`UPDATE users SET email_verified_at=now()`);
    const q = await m.req("POST", "/api/v1/quotes", { body: { mode: "terminal", inrPaise: "40000", privacyPreference: "shielded" }, key: key() });
    const t = await m.req("POST", "/api/v1/merchant-terminal/intents", { body: { quoteId: q.json.id }, key: key() });
    await m.req("POST", `/api/v1/demo/checkout/${t.json.checkout.id}/simulate-deposit`, { body: { kind: "exact", confirmations: 3 }, key: key(), bearer: t.json.accessToken });
    await h!.runJobs();
    const pd = await m.req("POST", "/api/v1/merchants/me/payout-destinations", { body: { vpa: "cancel.shop@okicici" }, key: key() });
    const w = await m.req("POST", "/api/v1/withdrawals", { body: { inrPaise: "40000", payoutDestinationId: pd.json.id }, key: key() });
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    const cmd = (await h!.db.query(`SELECT id, command_hash FROM payout_commands WHERE withdrawal_id=$1`, [w.json.id])).rows[0];
    await h!.runJobs();
    await approvePayout(h!.ctx, cmd.id, "usr_operator_aaaaaaaaaaaaaaaaaaaa", cmd.command_hash);
    await h!.runJobs(20);
    expect((await state(h!, cmd.id)).state).toBe("PAYOUT_FAILED_RECOVERY");
    const bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.availableInrPaise).toBe("40000");
    expect(bal.json.reservedInrPaise).toBe("0");
    const restores = await h!.db.query(`SELECT count(*)::int AS n FROM ledger_journals WHERE event_id=$1`, [`withdrawal_restore:${w.json.id}`]);
    expect(restores.rows[0].n).toBe(1);
  });
});
