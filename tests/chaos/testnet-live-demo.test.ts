/**
 * TESTNET_LIVE_PAYOUT_DEMO (strict opt-in) under fault injection.
 *
 * In production a HACKATHON_TESTNET payment is real shielded TAZ seen by the watch-only watcher. Here the
 * testnet rows are cloned from demo checkouts inside the isolated _test database (same approach as
 * tests/integration/production-safety.test.ts) and a scripted TinyFish port (same pattern as
 * tests/chaos/tinyfish-rail.test.ts) drives the REAL payout state machine, leases, jobs and DB.
 * Nothing here calls TinyFish, P2P.lol, a chain or any other network service.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { tx } from "@zeb/db";
import {
  advancePayoutAsOperator,
  advanceTfPayout,
  approvePayout,
  approvePayoutAsOperator,
  buildHandlers,
  checkoutPublic,
  claim,
  createPayoutCommand,
  emitResource,
  enqueueJob,
  evaluateExecution,
  health,
  ingestScannerEvent,
  listPendingPayoutCommands,
  liveDemoPayoutsEnabled,
  loadConfig,
  markVerifiedNotSubmitted,
  payoutReadiness,
  quoteInputsHash,
  reconcile,
  requestReconcile,
  resetReadinessCache,
  runJob,
  TESTNET_LIVE_DEMO_LIMITS,
  testnetLiveDemo,
  type CoreContext,
  type QuoteRow,
  type ScannerEvent,
  type TfDeps,
} from "@zeb/core";
import { PublicConfigZ } from "@zeb/contracts";
import { environmentCapabilities, newId } from "@zeb/domain";
import { usdcInputText, validateP2PWebConfig, type TfQueueParams, type TfRun, type TinyFishPort } from "@zeb/providers";
import { getPublicConfig } from "../../apps/api/src/handlers/public";
import { Client, key, makeHarness, type Harness } from "../integration/harness";

const WEB = validateP2PWebConfig("https://app.p2p.lol/");
const ORIGIN = "https://app.p2p.lol";
const OPERATOR = "usr_operator_aaaaaaaaaaaaaaaaaaaa";
const GATE_ON = {
  TESTNET_LIVE_PAYOUT_DEMO: "true",
  LIVE_PAYOUTS_ENABLED: "true",
  PILOT_MAX_PAYOUT_INR_PAISE: "20000",
  PILOT_DAILY_MAX_USDC_MICROS: "3000000",
  LEGAL_APPROVAL_REF: "fixture-legal-ref",
  PROVIDER_APPROVAL_REF: "fixture-provider-ref",
};
const CAPS_WITHOUT_FLAG = { LIVE_PAYOUTS_ENABLED: "true", PILOT_MAX_PAYOUT_INR_PAISE: "20000", PILOT_DAILY_MAX_USDC_MICROS: "3000000", LEGAL_APPROVAL_REF: "x", PROVIDER_APPROVAL_REF: "y" };

/* ------------------------------------------------------------------ scripted TinyFish */

type Kind = "preflight" | "execute" | "reconcile";
type Step = { status?: TfRun["status"]; result?: Record<string, unknown> | null; throwOnQueue?: boolean; reject?: boolean };
type Script = Partial<Record<Kind, (goal: string, n: number) => Step>>;

/** In-memory script of the TinyFish API. Labelled "tinyfish" only because the core refuses "simulated" ports outside DEMO. */
class ScriptedPort implements TinyFishPort {
  readonly kind = "tinyfish" as const;
  calls: Record<Kind, number> = { preflight: 0, execute: 0, reconcile: 0 };
  queued: Array<{ kind: Kind; params: TfQueueParams }> = [];
  runs = new Map<string, TfRun>();
  constructor(private script: Script) {}
  private kindOf(goal: string): Kind {
    return /capability check/.test(goal) ? "preflight" : /order reconciliation/.test(goal) ? "reconcile" : "execute";
  }
  async queue(p: TfQueueParams) {
    const k = this.kindOf(p.goal);
    const n = ++this.calls[k];
    this.queued.push({ kind: k, params: p });
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

const preflightOk = (): Step => ({ result: { account_authenticated: true, login_page_shown: false, account_identifier: "ops-lol-account", pay_ui_available: false, sell_ui_available: true, visible_usdc_balance: "5.00", visible_limits: "", wallet_signature_required: false, blocker: "", observed_url: `${ORIGIN}/sell` } });
const amountOf = (g: string) => /offramp-amount = ([0-9.]+) USDC/.exec(g)?.[1] ?? "";
const upiOf = (g: string) => /one-time-upi-id = "([^"]+)"/.exec(g)?.[1] ?? "";
const sellOk = (g: string, over: Record<string, unknown> = {}): Step => ({
  result: { action: "submitted", submitted: true, place_order_clicks: "1", final_url: `${ORIGIN}/orders/91`, preview_reached: true, entered_usdc_amount: amountOf(g), entered_upi_id: upiOf(g), expected_inr_payout: "₹55.10", provider_order_id: "LOL-91", visible_recipient: upiOf(g), visible_inr: "₹55.10", visible_usdc: `${amountOf(g)} USDC`, provider_order_status: "PLACED", blocking_issue: "", evidence_summary: "order placed", ...over },
});
const reconcileSeen = (status: string, vpa: string, usdc = "0.611112"): Step => ({ result: { order_found: true, provider_order_id: "LOL-91", provider_order_status: status, visible_recipient: vpa, visible_inr: "INR 55.10", visible_usdc: usdc, provider_reference: "", observed_url: `${ORIGIN}/orders/91`, blocker: "" } });

/* ------------------------------------------------------------------ harness helpers */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(script: Script = {}) {
  const port = new ScriptedPort(script);
  const deps: TfDeps = { port, web: WEB };
  h = await makeHarness();
  return { port, deps };
}

/** A HACKATHON_TESTNET context on the same isolated DB + envelope, with the given pilot env. */
function testnetCtx(hh: Harness, extra: Record<string, string> = {}): CoreContext {
  const cfg = loadConfig({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", DATABASE_URL: hh.ctx.cfg.databaseUrl, ZEB_TOKEN_SECRET: hh.ctx.cfg.tokenSecret, ZEB_LOCAL_KEKS: hh.ctx.cfg.kms.keks, ZEB_ACTIVE_KEK: hh.ctx.cfg.kms.activeKek, REQUIRED_CONFIRMATIONS: "1", ...extra });
  return { ...hh.ctx, env: "testnet", caps: environmentCapabilities("testnet"), cfg };
}

/** Real Scan & Pay checkout through the API (demo), cloned into the testnet environment with its consent snapshot. */
async function testnetCheckout(hh: Harness, vpa: string, inrPaise: string) {
  const c = new Client(hh.app);
  const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise, privacyPreference: "shielded" }, key: key() });
  const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa, source: "manual" }, payeeConfirmed: true }, key: key() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const src = r.json.checkout.id as string;
  const pi = (await hh.db.query(`SELECT * FROM payment_intents WHERE id=$1`, [src])).rows[0];
  const qr = (await hh.db.query(`SELECT * FROM quotes WHERE id=$1`, [pi.quote_id])).rows[0] as QuoteRow;
  const za = (await hh.db.query(`SELECT * FROM zcash_addresses WHERE intent_id=$1`, [src])).rows[0];
  const au = (await hh.db.query(`SELECT * FROM payout_authorizations WHERE intent_id=$1`, [src])).rows[0];
  const id = newId("intent");
  const zid = newId("address");
  const quote = { ...qr, id: newId("quote"), environment: "testnet", consumed_by: null } as QuoteRow;
  quote.inputs_hash = quoteInputsHash(quote);
  const address = `utest1${createHash("sha256").update(id).digest("hex")}${createHash("sha256").update(zid).digest("hex")}`;
  await hh.db.query(`INSERT INTO quotes SELECT * FROM json_populate_record(NULL::quotes,$1::json)`, [JSON.stringify(quote)]);
  await hh.db.query(`INSERT INTO payment_intents SELECT * FROM json_populate_record(NULL::payment_intents,$1::json)`, [JSON.stringify({ ...pi, id, environment: "testnet", quote_id: quote.id, zcash_address_id: null, recipient_vpa_ct: await hh.ctx.envelope.seal(vpa, `payment_intents:${id}:recipient_vpa`) })]);
  await hh.db.query(`INSERT INTO zcash_addresses SELECT * FROM json_populate_record(NULL::zcash_addresses,$1::json)`, [JSON.stringify({ ...za, id: zid, intent_id: id, environment: "testnet", network: "testnet", address, memo_code: null })]);
  await hh.db.query(`UPDATE payment_intents SET zcash_address_id=$2 WHERE id=$1`, [id, zid]);
  await hh.db.query(`INSERT INTO payout_authorizations SELECT * FROM json_populate_record(NULL::payout_authorizations,$1::json)`, [JSON.stringify({ ...au, id: newId("approval").replace(/^apr_/, "auth_"), environment: "testnet", intent_id: id })]);
  return { id, address, zat: qr.zec_zatoshis as string, vpa };
}

function confirmed(i: { id: string; address: string; zat: string }, conf = 1): ScannerEvent {
  const txid = createHash("sha256").update(`tx:${i.id}`).digest("hex");
  return { eventId: `${txid}:${conf}`, kind: "note_confirmed", network: "testnet", pool: "ironwood", txid, outputRef: `${txid}:0`, valueZatoshis: i.zat, address: i.address, blockHeight: 4_600_000, blockHash: null, confirmations: conf, scanVersion: "isolated-testnet-demo" };
}

/** The worker loop for testnet-environment payout jobs (back-off timers skipped). */
async function runTestnet(ctx: CoreContext, deps: TfDeps, rounds = 12) {
  const handlers = buildHandlers(null, deps);
  for (let i = 0; i < rounds; i++) {
    await ctx.db.query(`UPDATE jobs SET run_at=now() WHERE environment='testnet' AND kind='tfpayout.advance' AND state IN ('queued','failed')`);
    const jobs = (await claim(ctx, "it-testnet-worker", 20)).filter((j) => j.kind === "tfpayout.advance");
    if (!jobs.length) break;
    for (const j of jobs) await runJob(ctx, handlers, j, "it-testnet-worker");
  }
}

const cmdOf = async (intentId: string) => (await h!.db.query(`SELECT * FROM payout_commands WHERE source_intent_id=$1`, [intentId])).rows[0];
const stateOf = async (id: string) => (await h!.db.query(`SELECT state, state_reason, held, approved_by FROM payout_commands WHERE id=$1`, [id])).rows[0] as { state: string; state_reason: string | null; held: boolean; approved_by: string | null };
const payoutStatus = async (intentId: string) => (await h!.db.query(`SELECT payout_status FROM payment_intents WHERE id=$1`, [intentId])).rows[0].payout_status as string;
const eventTypes = async (intentId: string) => (await h!.db.query(`SELECT event_type, data FROM resource_events WHERE resource=$1 ORDER BY id`, [`checkout:${intentId}`])).rows as Array<{ event_type: string; data: { label?: string; detail?: string } }>;
const testnetCurrencies = async () => (await h!.db.query(`SELECT DISTINCT p.currency FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.environment='testnet'`)).rows.map((r) => r.currency);
const backdateReconcile = (id: string) => h!.db.query(`UPDATE payout_attempts SET updated_at=now()-interval '2 minutes' WHERE payout_id=$1 AND kind='reconcile'`, [id]);

/** Independent settlement evidence: only the separate evidence-review process writes this (never a browser run). */
async function settlementEvidence(id: string, vpa: string) {
  await h!.db.query(
    `INSERT INTO payout_settlement_evidence(payout_id,command_hash,provider_order_id,account_fingerprint,recipient_hash,inr_paise,actual_usdc_micros,outcome,debit_reference,bank_reference,evidence_digest,reviewed_by,second_reviewer,verified_at)
     SELECT id,command_hash,'LOL-91',account_fingerprint,$2,requested_inr_paise,max_usdc_debit_micros,'delivered','isolated-debit-fixture','isolated-bank-fixture',$3,'fixture-reviewer-one','fixture-reviewer-two',now() FROM payout_commands WHERE id=$1`,
    [id, createHash("sha256").update(vpa.toLowerCase()).digest("hex"), "b".repeat(64)],
  );
}

/* ------------------------------------------------------------------ config */

describe("TESTNET_LIVE_PAYOUT_DEMO config (strict opt-in)", () => {
  const BASE = { DATABASE_URL: "postgres://unused@127.0.0.1/zebscan_cfg_test", ZEB_TOKEN_SECRET: "s".repeat(40), ZEB_LOCAL_KEKS: `k1:${Buffer.alloc(32, 7).toString("base64")}`, ZEB_ACTIVE_KEK: "k1" };
  const cfg = (env: Record<string, string>) => loadConfig({ ...BASE, ...env });

  it("defaults off; live-payout flags and caps alone never open testnet payouts", () => {
    const off = cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET" });
    expect(off.pilot.testnetLivePayoutDemo).toBe(false);
    expect(liveDemoPayoutsEnabled(off)).toBe(false);
    expect(liveDemoPayoutsEnabled(cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", ...CAPS_WITHOUT_FLAG }))).toBe(false);
    expect(liveDemoPayoutsEnabled(cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", ...GATE_ON }))).toBe(true);
    expect(cfg({ ZEB_ENVIRONMENT: "DEMO", TESTNET_LIVE_PAYOUT_DEMO: "false" }).pilot.testnetLivePayoutDemo).toBe(false);
  });

  it("parses the flag strictly", () => {
    for (const bad of ["TRUE", "1", "yes", "true "]) expect(() => cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", ...GATE_ON, TESTNET_LIVE_PAYOUT_DEMO: bad }), bad).toThrow(/exactly "true" or "false"/);
  });

  it.each(["DEMO", "MAINNET_READONLY", "CONTROLLED_LIVE_PILOT"])("rejects TESTNET_LIVE_PAYOUT_DEMO=true in %s", (environment) => {
    expect(() => cfg({ ZEB_ENVIRONMENT: environment, ...GATE_ON })).toThrow(/only permitted in HACKATHON_TESTNET/);
  });

  it("requires LIVE_PAYOUTS_ENABLED and rejects caps of zero or above the demo limits (Rs 200 / 3 USDC)", () => {
    const t = (x: Record<string, string>) => () => cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", ...GATE_ON, ...x });
    expect(TESTNET_LIVE_DEMO_LIMITS).toEqual({ maxPayoutInrPaise: 20_000n, dailyMaxUsdcMicros: 3_000_000n });
    expect(t({ LIVE_PAYOUTS_ENABLED: "false" })).toThrow(/LIVE_PAYOUTS_ENABLED=true/);
    expect(t({ PILOT_MAX_PAYOUT_INR_PAISE: "0" })).toThrow(/PILOT_MAX_PAYOUT_INR_PAISE/);
    expect(t({ PILOT_MAX_PAYOUT_INR_PAISE: "20001" })).toThrow(/PILOT_MAX_PAYOUT_INR_PAISE/);
    expect(t({ PILOT_DAILY_MAX_USDC_MICROS: "0" })).toThrow(/PILOT_DAILY_MAX_USDC_MICROS/);
    expect(t({ PILOT_DAILY_MAX_USDC_MICROS: "3000001" })).toThrow(/PILOT_DAILY_MAX_USDC_MICROS/);
    expect(t({ PILOT_MAX_PAYOUT_INR_PAISE: "20000", PILOT_DAILY_MAX_USDC_MICROS: "3000000" })).not.toThrow();
  });

  it("the runtime gate re-checks a hand-built config (no bypass by mutation)", () => {
    const on = cfg({ ZEB_ENVIRONMENT: "HACKATHON_TESTNET", ...GATE_ON });
    expect(liveDemoPayoutsEnabled({ ...on, pilot: { ...on.pilot, maxPayoutInrPaise: 50_000n } })).toBe(false);
    expect(liveDemoPayoutsEnabled({ ...on, pilot: { ...on.pilot, dailyMaxUsdcMicros: 10_000_000n } })).toBe(false);
    expect(liveDemoPayoutsEnabled({ ...on, pilot: { ...on.pilot, livePayoutsEnabled: false } })).toBe(false);
    expect(liveDemoPayoutsEnabled({ ...on, environment: "mainnet-enabled" })).toBe(false);
  });
});

/* ------------------------------------------------------------------ SELL evaluation (pure) */

describe("app.p2p.lol SELL observation evaluation", () => {
  it("only an exact single SELL to the approved UPI with an INR payout >= the authorized INR passes; mismatches are urgent", () => {
    const terms = { vpa: "shop.demo@okaxis", inrPaise: 5_000n, maxUsdc: 611_112n, variance: 0n, sellUsdc: 611_112n };
    const g = `offramp-amount = ${usdcInputText(611_112n)} USDC; one-time-upi-id = "shop.demo@okaxis".`;
    const ok = sellOk(g).result!;
    expect(evaluateExecution(ok, terms, WEB)).toMatchObject({ ok: true, usdc: 611_112n });
    expect(evaluateExecution({ ...ok, visible_inr: "₹50.00" }, terms, WEB).ok).toBe(true); // exactly the authorized INR
    for (const bad of [
      { entered_upi_id: "shop.demo@okicici" },
      { visible_recipient: "attacker@okaxis" },
      { entered_usdc_amount: "0.62" },
      { visible_usdc: "0.7 USDC" },
      { place_order_clicks: "more_than_1" },
      { place_order_clicks: "0" },
      { visible_inr: "₹49.99" },
      { final_url: "https://app.p2p.lol.evil.example/orders/91" },
    ])
      expect(evaluateExecution({ ...ok, ...bad }, terms, WEB), JSON.stringify(bad)).toMatchObject({ ok: false, urgent: true });
    expect(evaluateExecution({ ...ok, provider_order_id: "" }, terms, WEB)).toMatchObject({ ok: false, urgent: false });
    // "stopped" is an untrusted claim: never success, reconciliation decides
    expect(evaluateExecution({ ...ok, action: "stopped", submitted: false, place_order_clicks: "0", provider_order_id: "", blocking_issue: "login page shown" }, terms, WEB)).toMatchObject({ ok: false, urgent: false });
    expect(evaluateExecution({ ...ok, action: "stopped", submitted: false, place_order_clicks: "1" }, terms, WEB)).toMatchObject({ ok: false, urgent: true });
    // the generic PAY-shaped observation (no typed fields / click count) is refused for a SELL command
    const { place_order_clicks: _c, entered_upi_id: _u, entered_usdc_amount: _a, ...payShaped } = ok;
    expect(evaluateExecution(payShaped, terms, WEB).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ gate OFF */

describe("TESTNET_LIVE_PAYOUT_DEMO off: HACKATHON_TESTNET behaves exactly as before", () => {
  it("acceptance emits payout.disabled and never creates an executable command, even with live payouts + caps set", async () => {
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g) });
    const ctx = testnetCtx(h!, CAPS_WITHOUT_FLAG);
    expect(testnetLiveDemo(ctx)).toBe(false);
    const i = await testnetCheckout(h!, "off.gate@okaxis", "5000");
    await ingestScannerEvent(ctx, confirmed(i));
    await ingestScannerEvent(ctx, confirmed(i, 2)); // replay with more confirmations: bookkeeping only
    expect((await h!.db.query(`SELECT status FROM payment_intents WHERE id=$1`, [i.id])).rows[0].status).toBe("deposit_accepted");
    expect((await h!.db.query(`SELECT 1 FROM payout_commands WHERE environment='testnet'`)).rowCount).toBe(0);
    const ev = await eventTypes(i.id);
    expect(ev.map((e) => e.event_type)).toContain("payout.disabled");
    expect(ev.map((e) => e.event_type)).not.toContain("payout.payout_queued");
    expect(await payoutStatus(i.id)).toBe("not_started");
    expect(await testnetCurrencies()).toEqual(["ZEC"]);
    expect((await h!.db.query(`SELECT 1 FROM receipts WHERE intent_id=$1`, [i.id])).rowCount).toBe(1);
    await runTestnet(ctx, deps);
    expect(port.calls).toEqual({ preflight: 0, execute: 0, reconcile: 0 });
    // the command constructor itself refuses testnet without the gate
    await expect(tx(h!.db, (t) => createPayoutCommand(t, ctx, { flow: "SCAN_PAY", intentId: i.id, vpa: "off.gate@okaxis", inrPaise: 5000n, maxUsdcMicros: 1n, quoteId: null, authorizationId: "auth_x", reservedTreasuryId: null }))).rejects.toThrow(/HACKATHON_TESTNET never executes payouts/);
    const r = await payoutReadiness(ctx, deps);
    expect(r.eligible_for_payout).toBe(false);
    expect(r.reasons).toContain("HACKATHON_TESTNET never executes INR payouts");
  });

  it("public config: liveDemoPayouts and the funding disclaimer appear only when the gate is on", async () => {
    await setup();
    health.lastP2POk = Date.now(); // skip the live INR reference probe (no network in tests)
    resetReadinessCache();
    const off = PublicConfigZ.parse(await getPublicConfig({ ctx: testnetCtx(h!) } as never));
    expect(off.liveDemoPayouts).toBe(false);
    expect(off.disclaimers[0]).toMatch(/No INR is ever paid out/);
    resetReadinessCache();
    const on = PublicConfigZ.parse(await getPublicConfig({ ctx: testnetCtx(h!, GATE_ON) } as never));
    expect(on.liveDemoPayouts).toBe(true);
    expect(on.disclaimers[0]).toContain("INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet payment only authorizes it.");
    expect(on.disclaimers[0]).toContain("at most INR 200.00 per payment");
    resetReadinessCache();
    expect(PublicConfigZ.parse(await getPublicConfig({ ctx: h!.ctx } as never)).liveDemoPayouts).toBe(false); // demo env
    const { liveDemoPayouts: _x, ...olderApi } = off;
    expect(PublicConfigZ.parse(olderApi).liveDemoPayouts).toBe(false); // older API without the field = no live payouts
  });
});

/* ------------------------------------------------------------------ gate ON */

describe("TESTNET_LIVE_PAYOUT_DEMO on: strict rail end to end", () => {
  const VPA = "demo.payee@okaxis";

  it("EXECUTE_AFTER_APPROVAL command; no execution before a hash-bound approval; exactly one SELL; completion only via reconcile + evidence", async () => {
    let providerStatus = "PLACED";
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g, { provider_order_status: "COMPLETED" }), reconcile: () => reconcileSeen(providerStatus, VPA) });
    const ctx = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, VPA, "5000");
    await ingestScannerEvent(ctx, confirmed(i));

    const cmd = await cmdOf(i.id);
    expect(cmd).toMatchObject({ environment: "testnet", flow: "SCAN_PAY", mode: "EXECUTE_AFTER_APPROVAL", state: "CREATED", reserved_treasury_id: null, requested_inr_paise: "5000", held: false });
    const ev = await eventTypes(i.id);
    expect(ev.map((e) => e.event_type)).not.toContain("payout.disabled");
    expect(ev.find((e) => e.event_type === "payout.payout_queued")?.data.detail).toContain("INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet payment only authorizes it.");
    expect(await payoutStatus(i.id)).toBe("payout_queued");
    await expect(h!.db.query(`UPDATE payout_commands SET requested_inr_paise = requested_inr_paise + 1 WHERE id=$1`, [cmd.id])).rejects.toThrow(/immutable/);

    // policy → read-only preflight (SELL UI; PAY UI not required) → operator approval required
    await runTestnet(ctx, deps);
    expect((await stateOf(cmd.id)).state).toBe("OPERATOR_APPROVAL_REQUIRED");
    expect(port.calls).toEqual({ preflight: 1, execute: 0, reconcile: 0 });

    // without approval nothing executes, however often it is advanced
    for (let k = 0; k < 3; k++) await advanceTfPayout(ctx, deps, cmd.id);
    await enqueueJob(h!.db, "testnet", "tfpayout.advance", cmd.id, { id: cmd.id });
    await runTestnet(ctx, deps);
    expect((await stateOf(cmd.id)).state).toBe("OPERATOR_APPROVAL_REQUIRED");
    expect(port.calls.execute).toBe(0);

    // approval is bound to the reviewed hash
    await expect(approvePayout(ctx, cmd.id, OPERATOR, "0".repeat(64))).rejects.toThrow(/differ/);
    expect((await stateOf(cmd.id)).approved_by).toBeNull();
    await approvePayout(ctx, cmd.id, OPERATOR, cmd.command_hash);
    await runTestnet(ctx, deps);

    // exactly one execute run, an app.p2p.lol SELL of the authorized max debit to this UPI ID
    expect(port.calls.execute).toBe(1);
    const exec = port.queued.find((q) => q.kind === "execute")!;
    expect(exec.params.url).toBe("https://app.p2p.lol/");
    expect(exec.params.goal).toContain(`offramp-amount = ${usdcInputText(BigInt(cmd.max_usdc_debit_micros))} USDC`);
    expect(exec.params.goal).toContain(`one-time-upi-id = "${VPA}"`);
    expect(exec.params.goal).toContain("https://app.p2p.lol/sell/preview");
    expect(exec.params.goal).toMatch(/click "Place Order" exactly once/);
    expect(exec.params.goal).toMatch(/at least INR 50\.00/);
    expect(exec.params.goal).toMatch(/Never place a second order/);
    expect(exec.params.goal).toMatch(/Never enter passwords, seed phrases or OTPs/);
    expect(Object.keys((exec.params.output_schema as { properties: object }).properties)).toEqual(expect.arrayContaining(["place_order_clicks", "entered_upi_id", "entered_usdc_amount", "expected_inr_payout"]));

    // the agent claiming COMPLETED is not success: only the order submission is observed
    expect((await stateOf(cmd.id)).state).toBe("ORDER_SUBMISSION_OBSERVED");
    expect(await payoutStatus(i.id)).toBe("placed");
    expect(port.calls.reconcile).toBeGreaterThanOrEqual(1); // separate read-only reconciliation run

    // provider shows COMPLETED on reconciliation: reported, still not completed without independent evidence
    providerStatus = "COMPLETED";
    await backdateReconcile(cmd.id);
    await runTestnet(ctx, deps);
    expect((await stateOf(cmd.id)).state).toBe("FIAT_TRANSFER_REPORTED");
    expect(await payoutStatus(i.id)).toBe("inr_processing");

    // independent settlement evidence + read-only reconciliation → RECONCILED
    await settlementEvidence(cmd.id, VPA);
    await backdateReconcile(cmd.id);
    await requestReconcile(ctx, deps, cmd.id, "fixture-reviewer");
    await requestReconcile(ctx, deps, cmd.id, "fixture-reviewer");
    await runTestnet(ctx, deps);
    expect((await stateOf(cmd.id)).state).toBe("RECONCILED");
    expect(await payoutStatus(i.id)).toBe("completed");
    expect(port.calls.execute).toBe(1);
    expect((await h!.db.query(`SELECT count(*)::int AS n FROM payout_attempts WHERE payout_id=$1 AND kind='execute'`, [cmd.id])).rows[0].n).toBe(1);
    // testnet books stay ZEC-only (TAZ has no value; the INR came from the operator's own USDC)
    expect(await testnetCurrencies()).toEqual(["ZEC"]);
    expect((await reconcile(ctx, "tf")).checks.filter((x) => x.status === "FAIL")).toEqual([]);
    const pub = await checkoutPublic(h!.db, ctx, i.id);
    expect(pub.payout?.status).toBe("completed");
    expect(JSON.stringify(pub)).not.toMatch(/run_|LOL-91|tinyfish/i); // no run ids / provider internals on public payloads
  });

  it("over the per-order cap → PREFLIGHT_BLOCKED with a clear reason; never preflighted, approvable or executed", async () => {
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g) });
    const ctx = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, "big.payment@okaxis", "25000");
    await ingestScannerEvent(ctx, confirmed(i));
    const cmd = await cmdOf(i.id);
    expect(cmd.mode).toBe("EXECUTE_AFTER_APPROVAL");
    await runTestnet(ctx, deps);
    const s = await stateOf(cmd.id);
    expect(s.state).toBe("PREFLIGHT_BLOCKED");
    expect(s.state_reason).toMatch(/per-order cap: INR 250\.00 > INR 200\.00 \(PILOT_MAX_PAYOUT_INR_PAISE\)/);
    expect(port.calls).toEqual({ preflight: 0, execute: 0, reconcile: 0 });
    await expect(approvePayout(ctx, cmd.id, OPERATOR, cmd.command_hash)).rejects.toThrow(/PREFLIGHT_BLOCKED/);
    expect(await payoutStatus(i.id)).toBe("not_liquid");
  });

  it("daily USDC cap: the payment that would exceed 3 USDC in 24h is blocked", async () => {
    const { port, deps } = await setup({ preflight: preflightOk });
    const ctx = testnetCtx(h!, GATE_ON);
    const a = await testnetCheckout(h!, "first.daily@okaxis", "15000");
    await ingestScannerEvent(ctx, confirmed(a));
    await runTestnet(ctx, deps);
    const ca = await cmdOf(a.id);
    expect((await stateOf(ca.id)).state).toBe("OPERATOR_APPROVAL_REQUIRED");
    const b = await testnetCheckout(h!, "second.daily@okaxis", "15000");
    await ingestScannerEvent(ctx, confirmed(b));
    await runTestnet(ctx, deps);
    const cb = await cmdOf(b.id);
    expect(BigInt(ca.max_usdc_debit_micros) + BigInt(cb.max_usdc_debit_micros)).toBeGreaterThan(3_000_000n);
    const s = await stateOf(cb.id);
    expect(s.state).toBe("PREFLIGHT_BLOCKED");
    expect(s.state_reason).toMatch(/daily USDC exposure cap reached/);
    expect(port.calls.preflight).toBe(1);
    expect(port.calls.execute).toBe(0);
  });

  it.each([
    ["the execute run FAILED after a possible click", { status: "FAILED" as const }],
    ["the queue call errored ambiguously", { throwOnQueue: true }],
  ])("%s → OUTCOME_UNKNOWN_REVIEW, lease kept, never retried", async (_name, step) => {
    const { port, deps } = await setup({ preflight: preflightOk, execute: () => step });
    const ctx = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, "ambiguous.payee@okaxis", "5000");
    await ingestScannerEvent(ctx, confirmed(i));
    await runTestnet(ctx, deps);
    const cmd = await cmdOf(i.id);
    await approvePayout(ctx, cmd.id, OPERATOR, cmd.command_hash);
    await runTestnet(ctx, deps);
    expect((await stateOf(cmd.id)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    expect(port.calls.execute).toBe(1);
    for (let k = 0; k < 3; k++) await advanceTfPayout(ctx, deps, cmd.id);
    await enqueueJob(h!.db, "testnet", "tfpayout.advance", cmd.id, { id: cmd.id });
    await runTestnet(ctx, deps);
    expect(port.calls.execute).toBe(1);
    expect((await stateOf(cmd.id)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    expect((await h!.db.query(`SELECT count(*)::int AS n FROM payout_attempts WHERE payout_id=$1 AND kind='execute'`, [cmd.id])).rows[0].n).toBe(1);
    expect((await h!.db.query(`SELECT severity FROM exceptions WHERE environment='testnet' AND kind='payout_outcome_unknown'`)).rows[0]?.severity).toBe("urgent");
    expect((await h!.db.query(`SELECT payout_id FROM p2p_account_leases WHERE environment='testnet'`)).rows[0].payout_id).toBe(cmd.id);
    await expect(markVerifiedNotSubmitted(ctx, cmd.id, "apr_fixture")).rejects.toThrow();
    expect(await payoutStatus(i.id)).toBe("manual_review");
  });

  it("turning the gate off after approval stops execution: held, zero execute calls", async () => {
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g) });
    const on = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, "gate.switch@okaxis", "5000");
    await ingestScannerEvent(on, confirmed(i));
    await runTestnet(on, deps);
    const cmd = await cmdOf(i.id);
    await approvePayout(on, cmd.id, OPERATOR, cmd.command_hash);
    await runTestnet(testnetCtx(h!, CAPS_WITHOUT_FLAG), deps);
    expect(port.calls.execute).toBe(0);
    expect((await stateOf(cmd.id)).held).toBe(true);
  });

  it("a checkout already touched by scripts/settle-p2plol.ts (same flag, separate SELL path) is never paid again by the worker rail", async () => {
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g) });
    const ctx = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, "script.paid@okaxis", "5000");
    await ingestScannerEvent(ctx, confirmed(i));
    await runTestnet(ctx, deps);
    const cmd = await cmdOf(i.id);
    expect((await stateOf(cmd.id)).state).toBe("OPERATOR_APPROVAL_REQUIRED");
    // what settle-p2plol.ts emits right before its own Place Order run
    await emitResource(h!.db, "testnet", `checkout:${i.id}`, "payout.live_demo.authorized", { label: "INR payout authorized" });
    await approvePayout(ctx, cmd.id, OPERATOR, cmd.command_hash);
    await runTestnet(ctx, deps);
    expect(port.calls.execute).toBe(0);
    const s = await stateOf(cmd.id);
    expect(s.held).toBe(true);
    expect(s.state_reason).toMatch(/settle-p2plol/);
  });

  it("a payout left in OUTCOME_UNKNOWN_REVIEW keeps the P2P.lol account lease: a new checkout's payout waits and never executes", async () => {
    const stopped = (): Step => ({ result: { ...sellOk("").result!, action: "stopped", submitted: false, place_order_clicks: "0", provider_order_id: "", blocking_issue: "expected INR payout below the minimum" } });
    const { port, deps } = await setup({ preflight: preflightOk, execute: stopped });
    const ctx = testnetCtx(h!, GATE_ON);
    const a = await testnetCheckout(h!, "first.stuck@okaxis", "5000");
    await ingestScannerEvent(ctx, confirmed(a));
    await runTestnet(ctx, deps);
    const ca = await cmdOf(a.id);
    await approvePayout(ctx, ca.id, OPERATOR, ca.command_hash);
    await runTestnet(ctx, deps);
    expect((await stateOf(ca.id)).state).toBe("OUTCOME_UNKNOWN_REVIEW");
    await expect(markVerifiedNotSubmitted(ctx, ca.id, "apr_fixture")).rejects.toThrow(); // no in-app release outside DEMO
    const b = await testnetCheckout(h!, "second.waits@okaxis", "5000");
    await ingestScannerEvent(ctx, confirmed(b));
    await runTestnet(ctx, deps);
    const cb = await cmdOf(b.id);
    await approvePayout(ctx, cb.id, OPERATOR, cb.command_hash);
    await runTestnet(ctx, deps);
    expect((await stateOf(cb.id)).state).toBe("QUEUED");
    expect(port.calls.execute).toBe(1);
    expect((await h!.db.query(`SELECT payout_id FROM p2p_account_leases WHERE environment='testnet'`)).rows[0].payout_id).toBe(ca.id);
  });

  it("operator CLI functions: full terms, wrong hash refused, rail required, never races the worker, one execute", async () => {
    const VPA2 = "cli.payee@okaxis";
    const { port, deps } = await setup({ preflight: preflightOk, execute: (g) => sellOk(g), reconcile: () => reconcileSeen("PLACED", VPA2) });
    const ctx = testnetCtx(h!, GATE_ON);
    const i = await testnetCheckout(h!, VPA2, "5000");
    await ingestScannerEvent(ctx, confirmed(i));
    await runTestnet(ctx, deps);
    const [v] = await listPendingPayoutCommands(ctx);
    expect(v).toMatchObject({ state: "OPERATOR_APPROVAL_REQUIRED", approvable: true, hashVerified: true, flow: "SCAN_PAY", environment: "testnet", mode: "EXECUTE_AFTER_APPROVAL", recipientVpa: VPA2, inr: "50.00", minInr: "50.00", checkoutId: i.id });
    expect(v!.sellUsdc).toBe(usdcInputText(BigInt(v!.maxUsdcDebitMicros)));

    await expect(approvePayoutAsOperator(ctx, v!.id, "f".repeat(64), "demo-operator")).rejects.toThrow(/hash mismatch/);
    await expect(approvePayoutAsOperator(ctx, v!.id, v!.commandHash, "bad name!")).rejects.toThrow(/operator/);
    // no rail configured: refuses without advancing and without recording a rail exception on the payment
    const none = await advancePayoutAsOperator(ctx, { port: null, web: null }, v!.id, "cli-test");
    expect(none.claimed).toBe(false);
    expect(none.error).toMatch(/rail not ready/);
    expect((await h!.db.query(`SELECT 1 FROM exceptions WHERE kind='payout_rail_unavailable'`)).rowCount).toBe(0);
    // advancing before approval changes nothing
    await advancePayoutAsOperator(ctx, deps, v!.id, "cli-test");
    expect((await stateOf(v!.id)).state).toBe("OPERATOR_APPROVAL_REQUIRED");
    expect(port.calls.execute).toBe(0);

    const approved = await approvePayoutAsOperator(ctx, v!.id, v!.commandHash, "demo-operator");
    expect(approved.approvedBy).toBe("cli:demo-operator");
    // a worker holding this payout's job lease → the CLI runs nothing
    await h!.db.query(`UPDATE jobs SET state='running', lease_owner='w-other', lease_expires_at=now()+interval '5 minutes' WHERE environment='testnet' AND kind='tfpayout.advance' AND dedupe_key=$1 AND state IN ('queued','failed')`, [v!.id]);
    const busy = await advancePayoutAsOperator(ctx, deps, v!.id, "cli-test");
    expect(busy.claimed).toBe(false);
    expect(port.calls.execute).toBe(0);
    await h!.db.query(`UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL WHERE environment='testnet' AND kind='tfpayout.advance' AND dedupe_key=$1 AND state='running'`, [v!.id]);
    // one pass from "approved" starts exactly one execute run
    const r = await advancePayoutAsOperator(ctx, deps, v!.id, "cli-test");
    expect(r.error).toBeNull();
    expect(r.steps.map((s) => s.state)).toEqual(["QUEUED", "AGENT_RUNNING"]);
    expect(port.calls.execute).toBe(1);
    await advancePayoutAsOperator(ctx, deps, v!.id, "cli-test");
    await advancePayoutAsOperator(ctx, deps, v!.id, "cli-test");
    expect((await stateOf(v!.id)).state).toBe("ORDER_SUBMISSION_OBSERVED");
    expect(port.calls.execute).toBe(1);
  });
});
