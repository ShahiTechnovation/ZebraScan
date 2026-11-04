/**
 * Mainnet 1-confirmation P2P preparation (P2P_INIT_CONFIRMATIONS=1) under fault injection.
 * Isolated _test database only: mainnet-enabled rows are cloned from demo checkouts (same approach as
 * testnet-live-demo.test.ts); TinyFish is a scripted in-memory port. No chain, provider or network call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { tx } from "@zeb/db";
import { advanceP2pPreparation, buildHandlers, claim, holdP2pPreparation, ingestScannerEvent, loadConfig, quoteInputsHash, runJob, type CoreContext, type QuoteRow, type ScannerEvent, type TfDeps } from "@zeb/core";
import { environmentCapabilities, newId } from "@zeb/domain";
import { validateP2PWebConfig, type TfQueueParams, type TfRun, type TinyFishPort } from "@zeb/providers";
import { Client, key, makeHarness, type Harness } from "../integration/harness";

const WEB = validateP2PWebConfig("https://app.p2p.lol/");
const ORIGIN = "https://app.p2p.lol";

type Kind = "preflight" | "execute" | "reconcile";
type Step = { status?: TfRun["status"]; result?: Record<string, unknown> | null; throwOnQueue?: boolean; reject?: boolean };
type Script = Partial<Record<Kind, (goal: string, n: number) => Step>>;

/** In-memory TinyFish script. Labelled "tinyfish" only because core refuses "simulated" ports outside DEMO. */
class ScriptedPort implements TinyFishPort {
  readonly kind = "tinyfish" as const;
  calls: Record<Kind, number> = { preflight: 0, execute: 0, reconcile: 0 };
  runs = new Map<string, TfRun>();
  searched: string[] = [];
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
  async listByGoal(goal: string) {
    this.searched.push(goal);
    return [];
  }
}

const preflightOk = (): Step => ({ result: { account_authenticated: true, login_page_shown: false, account_identifier: "ops-account", pay_ui_available: true, sell_ui_available: true, visible_usdc_balance: "500.00", visible_limits: "", wallet_signature_required: false, blocker: "", observed_url: `${ORIGIN}/pay` } });

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function mainCtx(hh: Harness, extra: Record<string, string> = {}): CoreContext {
  const cfg = loadConfig({ ZEB_ENVIRONMENT: "CONTROLLED_LIVE_PILOT", DATABASE_URL: hh.ctx.cfg.databaseUrl, ZEB_TOKEN_SECRET: hh.ctx.cfg.tokenSecret, ZEB_LOCAL_KEKS: hh.ctx.cfg.kms.keks, ZEB_ACTIVE_KEK: hh.ctx.cfg.kms.activeKek, INTERNAL_HMAC_SECRET: "x".repeat(40), ...extra });
  return { ...hh.ctx, env: "mainnet-enabled", caps: environmentCapabilities("mainnet-enabled"), cfg };
}

async function setScanner(hh: Harness, over: { status?: string; ironwood?: boolean } = {}) {
  await hh.db.query(
    `INSERT INTO scanner_state(environment, network, tip_height, scanned_height, tip_observed_at, ironwood_supported, status, updated_at) VALUES ('mainnet-enabled','mainnet',3600000,3600000,now(),$1,$2,now())
     ON CONFLICT (environment, network) DO UPDATE SET tip_height=3600000, scanned_height=3600000, tip_observed_at=now(), ironwood_supported=$1, status=$2, updated_at=now()`,
    [over.ironwood ?? true, over.status ?? "synced"],
  );
}

async function mainnetCheckout(hh: Harness, vpa: string, inrPaise: string) {
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
  const quote = { ...qr, id: newId("quote"), environment: "mainnet-enabled", consumed_by: null } as QuoteRow;
  quote.inputs_hash = quoteInputsHash(quote);
  const address = `u1${createHash("sha256").update(id).digest("hex")}${createHash("sha256").update(zid).digest("hex")}`;
  await hh.db.query(`INSERT INTO quotes SELECT * FROM json_populate_record(NULL::quotes,$1::json)`, [JSON.stringify(quote)]);
  await hh.db.query(`INSERT INTO payment_intents SELECT * FROM json_populate_record(NULL::payment_intents,$1::json)`, [JSON.stringify({ ...pi, id, environment: "mainnet-enabled", quote_id: quote.id, zcash_address_id: null, recipient_vpa_ct: await hh.ctx.envelope.seal(vpa, `payment_intents:${id}:recipient_vpa`) })]);
  await hh.db.query(`INSERT INTO zcash_addresses SELECT * FROM json_populate_record(NULL::zcash_addresses,$1::json)`, [JSON.stringify({ ...za, id: zid, intent_id: id, environment: "mainnet-enabled", network: "mainnet", address, memo_code: null })]);
  await hh.db.query(`UPDATE payment_intents SET zcash_address_id=$2 WHERE id=$1`, [id, zid]);
  await hh.db.query(`INSERT INTO payout_authorizations SELECT * FROM json_populate_record(NULL::payout_authorizations,$1::json)`, [JSON.stringify({ ...au, id: newId("approval").replace(/^apr_/, "auth_"), environment: "mainnet-enabled", intent_id: id })]);
  return { id, address, zat: qr.zec_zatoshis as string };
}

let seq = 0;
function ev(i: { id: string; address: string; zat: string }, conf: number, kind: ScannerEvent["kind"] = conf > 0 ? "note_confirmed" : "note_seen"): ScannerEvent {
  const txid = createHash("sha256").update(`tx:${i.id}`).digest("hex");
  return { eventId: `${txid}:${kind}:${conf}:${++seq}`, kind, network: "mainnet", pool: "ironwood", txid, outputRef: `${txid}:0`, valueZatoshis: i.zat, address: i.address, blockHeight: conf > 0 || kind === "note_reorged" ? 3_600_000 : null, blockHash: null, confirmations: conf, scanVersion: "isolated-fixture" };
}

const preps = async (id: string) => (await h!.db.query(`SELECT * FROM payout_preparations WHERE intent_id=$1`, [id])).rows;
const prepJobs = async (id: string) => (await h!.db.query(`SELECT * FROM jobs WHERE kind='p2p.prepare' AND dedupe_key=$1`, [id])).rows;
const status = async (id: string) => (await h!.db.query(`SELECT status, payout_status FROM payment_intents WHERE id=$1`, [id])).rows[0] as { status: string; payout_status: string };
const noCommands = async () => expect((await h!.db.query(`SELECT 1 FROM payout_commands`)).rowCount).toBe(0);

const GATES = { P2P_INIT_CONFIRMATIONS: "1", REQUIRED_CONFIRMATIONS: "10" };

async function setup(script: Script = { preflight: () => preflightOk() }, extra: Record<string, string> = GATES) {
  const port = new ScriptedPort(script);
  const deps: TfDeps = { port, web: WEB };
  h = await makeHarness();
  const ctx = mainCtx(h, extra);
  await setScanner(h);
  const i = await mainnetCheckout(h, "shop@okaxis", "50000");
  return { port, deps, ctx, i };
}

describe("config", () => {
  it("defaults to 1, keeps 10 for settlement, refuses init > required", () => {
    const base = { DATABASE_URL: "postgres://u@127.0.0.1/x_test", ZEB_TOKEN_SECRET: "s".repeat(40), ZEB_LOCAL_KEKS: `k1:${Buffer.alloc(32, 7).toString("base64")}`, ZEB_ACTIVE_KEK: "k1", ZEB_ENVIRONMENT: "CONTROLLED_LIVE_PILOT" };
    expect(loadConfig(base).policy.p2pInitConfirmations).toBe(1);
    expect(loadConfig(base).policy.requiredConfirmations).toBe(10);
    expect(() => loadConfig({ ...base, P2P_INIT_CONFIRMATIONS: "11" })).toThrow(/P2P_INIT_CONFIRMATIONS/);
  });
});

describe("1-confirmation P2P preparation", () => {
  it("zero confirmations (mempool) → no preparation, no job, no TinyFish", async () => {
    const { ctx, i, port } = await setup();
    await ingestScannerEvent(ctx, ev(i, 0));
    expect(await preps(i.id)).toHaveLength(0);
    expect(await prepJobs(i.id)).toHaveLength(0);
    expect(port.calls.preflight).toBe(0);
  });

  it("one confirmation → exactly one preparation + one job; checkout NOT accepted, no payout command, no accepted journal", async () => {
    const { ctx, i } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    const p = await preps(i.id);
    expect(p).toHaveLength(1);
    expect(p[0].state).toBe("PENDING");
    expect(p[0].provider_draft_ref).toBeNull();
    expect(p[0].vpa_masked).not.toContain("shop@okaxis");
    expect(await prepJobs(i.id)).toHaveLength(1);
    expect(await status(i.id)).toEqual({ status: "confirming", payout_status: "not_started" });
    await noCommands();
    expect((await h!.db.query(`SELECT 1 FROM ledger_journals WHERE event_id LIKE $1`, [`deposit_accepted:${i.id}%`])).rowCount).toBe(0);
  });

  it("duplicate and replayed one-confirmation events → still one preparation and one job", async () => {
    const { ctx, i } = await setup();
    const e = ev(i, 1);
    await ingestScannerEvent(ctx, e);
    await ingestScannerEvent(ctx, e);
    await ingestScannerEvent(ctx, ev(i, 1));
    await ingestScannerEvent(ctx, ev(i, 2));
    expect(await preps(i.id)).toHaveLength(1);
    expect(await prepJobs(i.id)).toHaveLength(1);
  });

  it("the job runs TinyFish once (read-only preflight) → READY; restarts and replays never queue a second run", async () => {
    const { ctx, i, port, deps } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    expect((await advanceP2pPreparation(ctx, deps, i.id)).rerunInMs).toBe(5_000);
    expect(port.calls.preflight).toBe(1);
    expect((await preps(i.id))[0].tinyfish_run_id).toMatch(/^run_preflight_/);
    await advanceP2pPreparation(ctx, deps, i.id);
    await advanceP2pPreparation(ctx, deps, i.id);
    expect(port.calls.preflight).toBe(1);
    expect(port.calls.execute).toBe(0);
    const p = (await preps(i.id))[0];
    expect(p.state).toBe("READY");
    expect(p.provider_draft_ref).toBeNull();
    expect(await status(i.id)).toEqual({ status: "confirming", payout_status: "not_started" });
    await noCommands();
  });

  it("the outbox job is consumed by the registered worker handler", async () => {
    const { ctx, i, port, deps } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    const handlers = buildHandlers(null, deps);
    await h!.db.query(`UPDATE jobs SET run_at=now() WHERE kind='p2p.prepare'`);
    const jobs = (await claim(ctx, "w1", 20)).filter((j) => j.kind === "p2p.prepare");
    expect(jobs).toHaveLength(1);
    await runJob(ctx, handlers, jobs[0]!, "w1");
    expect(port.calls.preflight).toBe(1);
  });

  it("TinyFish unavailable → stays PENDING/retryable, no run", async () => {
    const { ctx, i } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    expect((await advanceP2pPreparation(ctx, { port: null, web: null }, i.id)).rerunInMs).toBe(300_000);
    const p = (await preps(i.id))[0];
    expect(p.state).toBe("PENDING");
    expect(p.state_reason).toMatch(/unavailable/);
    expect(p.tinyfish_run_id).toBeNull();
  });

  it("preflight failure (login page) → BLOCKED; no money movement and no payout command", async () => {
    const { ctx, i, deps, port } = await setup({ preflight: () => ({ result: { ...(preflightOk().result as object), account_authenticated: false, login_page_shown: true } }) });
    await ingestScannerEvent(ctx, ev(i, 1));
    await advanceP2pPreparation(ctx, deps, i.id);
    await advanceP2pPreparation(ctx, deps, i.id);
    expect((await preps(i.id))[0].state).toBe("BLOCKED");
    expect(port.calls.execute).toBe(0);
    await noCommands();
  });

  it("ambiguous queue error → the next pass searches runs by reference before any retry", async () => {
    let throwOnce = true;
    const { ctx, i, deps, port } = await setup({ preflight: () => { if (throwOnce) { throwOnce = false; return { throwOnQueue: true }; } return preflightOk(); } });
    await ingestScannerEvent(ctx, ev(i, 1));
    expect((await advanceP2pPreparation(ctx, deps, i.id)).rerunInMs).toBe(30_000);
    expect((await preps(i.id))[0].tinyfish_run_id).toBeNull();
    await advanceP2pPreparation(ctx, deps, i.id);
    expect(port.searched[0]).toBe(`prep-${i.id}`);
  });

  it("stale or Ironwood-incapable scanner → no preparation is created and TinyFish is never triggered", async () => {
    const { ctx, i, port } = await setup();
    await setScanner(h!, { status: "syncing" });
    await ingestScannerEvent(ctx, ev(i, 1));
    expect(await preps(i.id)).toHaveLength(0);
    await setScanner(h!, { ironwood: false });
    await ingestScannerEvent(ctx, ev(i, 2));
    expect(await preps(i.id)).toHaveLength(0);
    expect(port.calls.preflight).toBe(0);
  });

  it("scanner degrading after queueing → the job waits and never calls TinyFish", async () => {
    const { ctx, i, port, deps } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    await setScanner(h!, { status: "error" });
    expect((await advanceP2pPreparation(ctx, deps, i.id)).rerunInMs).toBe(30_000);
    expect(port.calls.preflight).toBe(0);
  });

  it("reorg after one confirmation → HELD and TinyFish not called; a later re-confirmation does not silently resume it", async () => {
    const { ctx, i, port, deps } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    await ingestScannerEvent(ctx, ev(i, 0, "note_reorged"));
    expect((await preps(i.id))[0].state).toBe("HELD");
    await advanceP2pPreparation(ctx, deps, i.id);
    expect(port.calls.preflight).toBe(0);
    await ingestScannerEvent(ctx, ev(i, 1));
    expect((await preps(i.id))[0].state).toBe("HELD"); // checkout is in chain_reorg_review; needs a human
    expect(await preps(i.id)).toHaveLength(1);
    expect((await status(i.id)).status).toBe("chain_reorg_review");
    expect(port.calls.preflight).toBe(0);
  });

  it("reorg after the preflight is READY → HELD; nothing executes", async () => {
    const { ctx, i, deps, port } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    await advanceP2pPreparation(ctx, deps, i.id);
    await advanceP2pPreparation(ctx, deps, i.id);
    expect((await preps(i.id))[0].state).toBe("READY");
    await ingestScannerEvent(ctx, ev(i, 0, "note_reorged"));
    expect((await preps(i.id))[0].state).toBe("HELD");
    expect(port.calls.execute).toBe(0);
  });

  it("payouts pause blocks a queued preparation before TinyFish", async () => {
    const { ctx, i, port, deps } = await setup();
    await ingestScannerEvent(ctx, ev(i, 1));
    await h!.db.query(`INSERT INTO feature_gates(environment, feature, enabled, reason, updated_by) VALUES ('mainnet-enabled','payouts',false,'ops','test') ON CONFLICT (environment, feature) DO UPDATE SET enabled=false`);
    await advanceP2pPreparation(ctx, deps, i.id);
    expect((await preps(i.id))[0].state).toBe("HELD");
    expect(port.calls.preflight).toBe(0);
  });

  it("hold on a checkout without a preparation is a no-op", async () => {
    const { ctx, i } = await setup();
    await tx(ctx.db, (t) => holdP2pPreparation(t, ctx, i.id, "x"));
    expect(await preps(i.id)).toHaveLength(0);
  });

  it("demo never creates preparations", async () => {
    h = await makeHarness();
    const c = new Client(h.app);
    const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "50000", privacyPreference: "shielded" }, key: key() });
    const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "shop@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    expect(r.status).toBe(201);
    expect((await h.db.query(`SELECT 1 FROM payout_preparations`)).rowCount).toBe(0);
  });
});
