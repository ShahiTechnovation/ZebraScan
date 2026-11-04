/**
 * LIVE DEMO settlement: confirmed Zcash-testnet Scan & Pay checkout → TinyFish → app.p2p.lol SELL → INR to
 * the checkout's UPI ID. INR is paid from the operator's OWN pre-funded P2P.lol USDC; the testnet payment
 * only AUTHORIZES the payout (TAZ has no value).
 *
 * Uses the operator's TinyFish prompt (packages/providers/src/p2plol.ts); only amount + UPI are injected.
 *
 *   pnpm exec tsx scripts/settle-p2plol.ts --checkout <id> --preview                 # stops before Place Order
 *   pnpm exec tsx scripts/settle-p2plol.ts --checkout <id> --execute --confirm <code> # Place Order exactly once
 *   pnpm exec tsx scripts/settle-p2plol.ts --track <checkoutId>                       # read-only order status
 *   pnpm exec tsx scripts/settle-p2plol.ts --watch [--auto-authorize]                 # new accepted checkouts
 *
 * Gates: ZEB_ENVIRONMENT=HACKATHON_TESTNET, TESTNET_LIVE_PAYOUT_DEMO=true, checkout status deposit_accepted
 * with a canonical mined deposit, Scan & Pay only, USDC <= DEMO_MAX_USDC_MICROS (default 1.000000, hard max
 * 1.200000), one Place Order per checkout ever (var/settlements/<id>.lock, created exclusively before the
 * run), no automatic retries. `--execute` needs the confirm code printed by `--preview` (binds the exact
 * checkout, UPI, USDC and txid). `--auto-authorize` is the calling application's explicit authorization.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { buildContext, emitResource, loadConfig } from "@zeb/core";
import { createTinyFishPort } from "@zeb/providers";
import { buildP2PLolSellGoal, checkP2PLolResult, P2PLOL_RESULT_SCHEMA, P2PLOL_START_URL, type P2PLolResult } from "../packages/providers/src/p2plol";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k: string) => args.includes(`--${k}`);

const cfg = loadConfig();
if (cfg.environment !== "testnet") throw new Error("settle-p2plol runs only in HACKATHON_TESTNET");
if (process.env.TESTNET_LIVE_PAYOUT_DEMO !== "true") throw new Error("set TESTNET_LIVE_PAYOUT_DEMO=true to allow the live demo payout");
const apiKey = process.env.TINYFISH_API_KEY;
const profileId = process.env.TINYFISH_PROFILE_ID;
if (!apiKey || !profileId) throw new Error("TINYFISH_API_KEY and TINYFISH_PROFILE_ID are required");
const HARD_MAX = 1_200_000n;
const cap = BigInt(process.env.DEMO_MAX_USDC_MICROS ?? "1000000");
if (cap <= 0n || cap > HARD_MAX) throw new Error(`DEMO_MAX_USDC_MICROS must be in (0, ${HARD_MAX}]`);

const ctx = buildContext(cfg);
const tf = await createTinyFishPort(apiKey);
mkdirSync("var/settlements", { recursive: true });
const log = (m: string) => console.log(`[settle ${new Date().toISOString().slice(11, 19)}] ${m}`);

function usdcDecimal(micros: bigint): string {
  const s = (micros / 1_000_000n).toString();
  const f = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${s}.${f}` : s;
}

interface Terms {
  id: string;
  vpa: string;
  usdcMicros: bigint;
  usdc: string;
  inrPaise: string;
  txid: string;
  code: string;
}

async function loadTerms(id: string): Promise<Terms> {
  const r = await ctx.db.query<{ id: string; mode: string; status: string; environment: string; recipient_vpa_ct: string | null; required_usdc_micros: string; inr_paise: string }>(
    `SELECT pi.id, pi.mode, pi.status, pi.environment::text AS environment, pi.recipient_vpa_ct, q.required_usdc_micros::text AS required_usdc_micros, q.inr_paise::text AS inr_paise
       FROM payment_intents pi JOIN quotes q ON q.id = pi.quote_id WHERE pi.id = $1`,
    [id],
  );
  const i = r.rows[0];
  if (!i) throw new Error(`checkout ${id} not found`);
  if (i.environment !== "testnet" || i.mode !== "scan_pay") throw new Error("only testnet Scan & Pay checkouts can be settled");
  if (i.status !== "deposit_accepted") throw new Error(`checkout status is ${i.status}; ZEC must be confirmed first (deposit_accepted)`);
  const d = await ctx.db.query<{ txid: string }>(`SELECT txid FROM deposit_observations WHERE intent_id=$1 AND accepted AND canonical AND mined ORDER BY first_seen_at LIMIT 1`, [id]);
  const txid = d.rows[0]?.txid;
  if (!txid) throw new Error("no accepted canonical mined deposit for this checkout");
  if (!i.recipient_vpa_ct) throw new Error("checkout has no UPI recipient");
  const vpa = await ctx.envelope.open(i.recipient_vpa_ct, `payment_intents:${id}:recipient_vpa`);
  const usdcMicros = BigInt(i.required_usdc_micros);
  if (usdcMicros <= 0n) throw new Error("quote has no USDC amount");
  if (usdcMicros > cap) throw new Error(`USDC ${usdcDecimal(usdcMicros)} exceeds the demo cap ${usdcDecimal(cap)} (balance-limited). Create a smaller checkout.`);
  const usdc = usdcDecimal(usdcMicros);
  const code = createHash("sha256").update(`${id}|${vpa}|${usdc}|${txid}`).digest("hex").slice(0, 8);
  return { id, vpa, usdcMicros, usdc, inrPaise: i.inr_paise, txid, code };
}

async function runAgent(goal: string, maxSeconds: number): Promise<{ runId: string; raw: unknown; status: string }> {
  const q = await tf.queue({
    url: P2PLOL_START_URL,
    goal,
    use_profile: true,
    profile_id: profileId,
    use_vault: false,
    agent_config: { mode: "strict", max_steps: 80, max_duration_seconds: maxSeconds },
    capture_config: { screenshots: true },
    output_schema: P2PLOL_RESULT_SCHEMA as unknown as Record<string, unknown>,
  });
  if (!q.run_id) throw new Error(`TinyFish refused the run: ${q.error?.message}`);
  log(`TinyFish run ${q.run_id} started`);
  const deadline = Date.now() + (maxSeconds + 240) * 1000;
  let last = "";
  for (;;) {
    const r = await tf.get(q.run_id).catch((e) => ({ status: `poll-error ${(e as Error).message}`, result: null, num_of_steps: null }) as never);
    const st = `${r.status} steps=${r.num_of_steps ?? "?"}`;
    if (st !== last) {
      log(`run ${q.run_id}: ${st}`);
      last = st;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(String(r.status))) return { runId: q.run_id, raw: r.result, status: String(r.status) };
    if (Date.now() > deadline) return { runId: q.run_id, raw: r.result, status: "LOCAL_TIMEOUT" };
    await new Promise((res) => setTimeout(res, 10_000));
  }
}

function settlementFile(id: string) {
  return `var/settlements/${id}.json`;
}

async function preview(id: string) {
  const t = await loadTerms(id);
  log(`terms: checkout ${t.id} | txid ${t.txid.slice(0, 12)}… | sell ${t.usdc} USDC → ₹${(Number(t.inrPaise) / 100).toFixed(2)} to UPI ${t.vpa}`);
  const goal = buildP2PLolSellGoal({ offrampAmountUsdc: t.usdc, oneTimeUpiId: t.vpa, authorized: false, reference: `prev_${t.id.slice(3, 20)}`, targetInrPaise: BigInt(t.inrPaise) });
  const r = await runAgent(goal, 420);
  const c = checkP2PLolResult(r.raw, { offrampAmountUsdc: t.usdc, oneTimeUpiId: t.vpa, authorized: false, reference: "x0000" });
  const res = c.result;
  console.log(JSON.stringify({ phase: "preview", run: r.runId, runStatus: r.status, result: res, problems: c.problems }, null, 1));
  await emitResource(ctx.db, ctx.env, `checkout:${t.id}`, "payout.live_demo.preview", {
    label: "INR payout preview (P2P.lol)",
    detail: res ? `Sell ${t.usdc} USDC to the UPI ID; P2P.lol shows ${res.preview_inr || "no INR estimate"}. Waiting for operator authorization.` : "Preview failed.",
  });
  if (c.ok && res?.status === "AWAITING_AUTHORIZATION") {
    log(`PREVIEW OK. To place the order exactly once run:  --checkout ${t.id} --execute --confirm ${t.code}`);
  } else log(`PREVIEW NOT OK: ${res?.error || c.problems.join("; ") || r.status}`);
  return { t, ok: c.ok && res?.status === "AWAITING_AUTHORIZATION" };
}

async function execute(id: string, confirm: string | "auto") {
  const t = await loadTerms(id);
  if (confirm !== "auto" && confirm !== t.code) throw new Error("confirm code does not match these exact terms (checkout, UPI, USDC, txid); run --preview again");
  // Exactly-once: create the lock BEFORE the run; never deleted automatically.
  let fd: number;
  try {
    fd = openSync(`var/settlements/${t.id}.lock`, "wx");
  } catch {
    throw new Error(`checkout ${t.id} already has a Place Order attempt (var/settlements/${t.id}.lock). Never retried automatically; use --track.`);
  }
  writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), usdc: t.usdc, txid: t.txid, authorization: confirm === "auto" ? "calling-application(auto-authorize)" : "operator-confirm-code" }));
  closeSync(fd);
  await emitResource(ctx.db, ctx.env, `checkout:${t.id}`, "payout.live_demo.authorized", {
    label: "INR payout authorized",
    detail: `TinyFish is sending ₹${(Number(t.inrPaise) / 100).toFixed(2)} via P2P.lol (selling ${t.usdc} USDC) to the UPI ID. INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet payment only authorizes it.`,
  });
  log(`EXECUTING: TinyFish → P2P.lol: send ₹${(Number(t.inrPaise) / 100).toFixed(2)} (sell ${t.usdc} USDC) to UPI ${t.vpa} (one Place Order, no retries)`);
  const goal = buildP2PLolSellGoal({ offrampAmountUsdc: t.usdc, oneTimeUpiId: t.vpa, authorized: true, reference: `pay_${t.id.slice(3, 20)}`, targetInrPaise: BigInt(t.inrPaise) });
  const r = await runAgent(goal, 1500);
  const c = checkP2PLolResult(r.raw, { offrampAmountUsdc: t.usdc, oneTimeUpiId: t.vpa, authorized: true, reference: "x0000" });
  const res = c.result as P2PLolResult | null;
  const record = { checkout: t.id, txid: t.txid, usdc: t.usdc, upi: t.vpa, run: r.runId, runStatus: r.status, result: res, problems: c.problems, at: new Date().toISOString() };
  writeFileSync(settlementFile(t.id), JSON.stringify(record, null, 2));
  const sold = c.ok && res?.status === "SOLD";
  await emitResource(ctx.db, ctx.env, `checkout:${t.id}`, sold ? "payout.live_demo.sold" : "payout.live_demo.status", {
    label: sold ? `INR paid: ₹${res!.amount_paid} (P2P.lol order ${res!.order_id})` : `INR payout ${res?.status ?? r.status}${res?.order_id ? ` (P2P.lol order ${res.order_id})` : ""}`,
    detail: sold
      ? "P2P.lol order page shows SOLD with this INR amount. Paid from Zeb Scan's own P2P.lol USDC; the testnet payment only authorized it."
      : res?.error || c.problems.join("; ") || "Not confirmed. Never retried automatically; checking the same order only.",
  });
  console.log(JSON.stringify(apiResponse(res, r.status), null, 1));
}

/** The operator's response format. */
function apiResponse(res: P2PLolResult | null, runStatus: string) {
  if (res?.status === "SOLD" && res.success) return { success: true, code: 200, status: "SOLD", amount_paid: res.amount_paid, currency: "INR", order_id: res.order_id };
  if (res?.status === "PAYMENT_IN_PROGRESS") return { success: false, code: 202, status: "PAYMENT_IN_PROGRESS", amount_paid: null, currency: "INR", order_id: res.order_id, error: "Payment not yet confirmed" };
  return { success: false, code: res?.code && res.code >= 400 ? res.code : 500, status: res?.status ?? runStatus, amount_paid: null, currency: "INR", order_id: res?.order_id ?? null, error: res?.error || "Settlement did not complete" };
}

async function track(id: string) {
  const f = settlementFile(id);
  if (!existsSync(f)) throw new Error("no settlement record for this checkout");
  const rec = JSON.parse(readFileSync(f, "utf8")) as { result: P2PLolResult | null; usdc: string; upi: string };
  const orderId = rec.result?.order_id;
  if (!orderId || !/^\d+$/.test(orderId)) throw new Error("no order id recorded; inspect the TinyFish run in the dashboard");
  const goal = [
    "Read-only status check. Use TinyFish's active browser session (signed-in P2P.lol account). Do not click any button that creates, cancels or modifies an order; never place an order.",
    `Open https://app.p2p.lol/order/${orderId} and read the order status (PAYMENT_IN_PROGRESS, SOLD, FAILED, CANCELLED or EXPIRED). If SOLD, read the actual INR amount paid from the order details as a number.`,
    "Return JSON matching the output schema with place_order_clicked false and code 200 for SOLD, 202 for in progress, 4xx otherwise.",
  ].join("\n");
  const r = await runAgent(goal, 300);
  const res = r.raw as P2PLolResult | null;
  console.log(JSON.stringify(apiResponse(res, r.status), null, 1));
  if (res?.status === "SOLD" && res.success && typeof res.amount_paid === "number" && String(res.order_id) === orderId) {
    rec.result = { ...rec.result!, ...res };
    writeFileSync(f, JSON.stringify(rec, null, 2));
    await emitResource(ctx.db, ctx.env, `checkout:${id}`, "payout.live_demo.sold", { label: `INR paid: ₹${res.amount_paid} (P2P.lol order ${orderId})`, detail: "Order page shows SOLD." });
  }
}

async function watch(auto: boolean) {
  const since = new Date();
  log(`watching for confirmed testnet Scan & Pay checkouts CREATED after start (since ${since.toISOString()}), auto-authorize=${auto}`);
  const seen = new Set<string>();
  for (;;) {
    const r = await ctx.db.query<{ id: string }>(
      `SELECT id FROM payment_intents WHERE environment='testnet' AND mode='scan_pay' AND status='deposit_accepted' AND created_at >= $1 ORDER BY updated_at`,
      [since],
    );
    for (const { id } of r.rows) {
      if (seen.has(id) || existsSync(`var/settlements/${id}.lock`)) continue;
      seen.add(id);
      log(`confirmed checkout ${id}`);
      try {
        if (auto) await execute(id, "auto");
        else await preview(id);
      } catch (e) {
        log(`checkout ${id}: ${(e as Error).message}`);
      }
    }
    await new Promise((res) => setTimeout(res, 10_000));
  }
}

try {
  if (has("watch")) await watch(has("auto-authorize"));
  else if (arg("track")) await track(arg("track")!);
  else if (arg("checkout") && has("preview")) await preview(arg("checkout")!);
  else if (arg("checkout") && has("execute")) await execute(arg("checkout")!, arg("confirm") ?? "");
  else throw new Error("usage: --checkout <id> --preview | --checkout <id> --execute --confirm <code> | --track <id> | --watch [--auto-authorize]");
} finally {
  if (!has("watch")) await ctx.db.end();
}
