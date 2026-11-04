/**
 * P2P_TINYFISH_WEB payout rail — financial state machine (delta spec §5).
 *
 *  - The payout command (recipient, INR, max USDC debit, variance, flow, authorization) is immutable
 *    once created (DB trigger). Any change needs a new command + new authorization.
 *  - Every TinyFish observation is UNTRUSTED: validated with Zod, origin-allowlisted, and compared
 *    field-by-field against the command. A run finishing (`COMPLETED`) is never payment success.
 *  - Browser runs can report progress only. Final settlement requires independent
 *    provider/debit/bank evidence, bound to immutable terms and reviewed outside TinyFish.
 *  - No blind retry: anything ambiguous after a possible final click → OUTCOME_UNKNOWN_REVIEW, lease
 *    kept, payout locked. Only reconciliation (order found) or an operator-verified "never
 *    submitted" decision (dual control) leaves that state.
 *  - One active financial run per operational P2P account (lease + monotonically increasing
 *    fencing token); one live execute attempt per payout (unique index).
 *  - Pilot policy: operator approval always required, unattended limit 0, per-order and daily caps.
 */
import { createHash } from "node:crypto";
import { many, maybeOne, one, tx, type Tx } from "@zeb/db";
import { DomainError, maskVpa, newId, payoutMachine, tfPayoutMachine, withdrawalMachine, type PayoutStatus, type TfPayoutState, type WithdrawalStatus } from "@zeb/domain";
import { postJournal, treasury } from "@zeb/ledger";
import {
  EXECUTE_SCHEMA,
  ExecuteObservation,
  PREFLIGHT_SCHEMA,
  PreflightObservation,
  RECONCILE_SCHEMA,
  ReconcileObservation,
  SELL_EXECUTE_SCHEMA,
  SellExecuteObservation,
  accountFingerprint,
  buildExecuteGoal,
  buildPreflightGoal,
  buildReconcileGoal,
  formatInrPaise,
  formatUsdcMicros,
  isTrustedOrigin,
  parseVisibleInr,
  parseVisibleUsdc,
  sameVpa,
  type P2PWebConfig,
  type TfRun,
  type TinyFishPort,
} from "@zeb/providers";
import { canonicalJson } from "@zeb/security";
import { liveDemoPayoutsEnabled } from "./config";
import type { CoreContext } from "./context";
import { audit, emitResource, enqueueJob, raiseException } from "./events";
import { finalizeWithdrawal, restoreWithdrawal, type WithdrawalRow } from "./withdrawals";

export interface TfDeps {
  port: TinyFishPort | null;
  web: P2PWebConfig | null;
}

export interface PayoutCommandRow {
  id: string;
  environment: string;
  flow: "SCAN_PAY" | "MERCHANT_WITHDRAWAL";
  mode: "READ_ONLY" | "PREPARE_ONLY" | "EXECUTE_AFTER_APPROVAL";
  recipient_vpa_ct: string;
  recipient_vpa_masked: string;
  requested_inr_paise: string;
  max_usdc_debit_micros: string;
  max_fiat_variance_paise: string;
  quote_id: string | null;
  source_intent_id: string | null;
  withdrawal_id: string | null;
  authorization_id: string;
  reserved_treasury_id: string | null;
  command_hash: string;
  state: TfPayoutState;
  state_reason: string | null;
  state_version: number;
  account_fingerprint: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  approval_expires_at: Date | null;
  held: boolean;
  created_at: Date;
  updated_at: Date;
}

/* ================================================================== pure evaluators */

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

export function evaluatePreflight(raw: unknown, web: P2PWebConfig, need: { flow: "SCAN_PAY" | "MERCHANT_WITHDRAWAL" | null; usdcMicros: bigint | null; via?: "PAY" | "SELL" }): Verdict & { obs: PreflightObservation | null; visibleUsdcMicros: bigint | null } {
  const parsed = PreflightObservation.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: ["observation did not match the expected schema"], obs: null, visibleUsdcMicros: null };
  const o = parsed.data;
  const reasons: string[] = [];
  if (!isTrustedOrigin(o.observed_url, web)) reasons.push("final page was not on an allowlisted P2P.me origin");
  if (o.login_page_shown || !o.account_authenticated) reasons.push("profile is not authenticated (login page shown)");
  // `via` = the provider UI flow that will actually execute (testnet live demo: Scan & Pay executed as a SELL).
  if ((need.via ? need.via === "PAY" : need.flow !== "MERCHANT_WITHDRAWAL") && !o.pay_ui_available) reasons.push("PAY (Scan & Pay) flow not available");
  if ((need.via ? need.via === "SELL" : need.flow !== "SCAN_PAY") && !o.sell_ui_available) reasons.push("SELL flow not available");
  if (o.wallet_signature_required) reasons.push("orders require a wallet signature/extension/OTP that a hosted browser cannot provide");
  if (o.blocker.trim()) reasons.push(`provider blocker: ${o.blocker.trim().slice(0, 160)}`);
  const bal = o.visible_usdc_balance ? parseVisibleUsdc(o.visible_usdc_balance) : null;
  if (need.usdcMicros !== null) {
    if (bal === null) reasons.push("spendable USDC balance not visible");
    else if (bal < need.usdcMicros) reasons.push("visible USDC balance below the reserved maximum debit");
  }
  return { ok: reasons.length === 0, reasons, obs: o, visibleUsdcMicros: bal };
}

/** Command terms used by the evaluators. `sellUsdc` set ⇒ executed as an app.p2p.lol SELL of exactly that USDC amount. */
export interface EvalTerms {
  vpa: string;
  inrPaise: bigint;
  maxUsdc: bigint;
  variance: bigint;
  sellUsdc?: bigint;
}

/**
 * SELL by USDC amount: the agent must have typed exactly the approved amount and UPI ID, clicked
 * "Place Order" exactly once, and the order must show the same recipient, a USDC debit within the
 * authorized maximum and an INR payout of at least the authorized INR (minus the command variance).
 */
function evaluateSellExecution(raw: unknown, cmd: EvalTerms & { sellUsdc: bigint }, web: P2PWebConfig): Verdict & { obs: ExecuteObservation | null; urgent: boolean; usdc: bigint | null } {
  const parsed = SellExecuteObservation.safeParse(raw);
  if (!parsed.success) return { ok: false, urgent: false, reasons: ["observation did not match the expected schema"], obs: null, usdc: null };
  const o = parsed.data;
  const reasons: string[] = [];
  if (!isTrustedOrigin(o.final_url, web)) reasons.push("final page was not on an allowlisted P2P.me origin");
  if (o.place_order_clicks === "more_than_1") reasons.push("Place Order was clicked more than once (possible duplicate order)");
  if (!o.submitted) {
    // Untrusted claim: reconciliation must verify that no order exists.
    if (o.place_order_clicks !== "0") reasons.push("agent reports not submitted but also reports a Place Order click");
    reasons.push(`agent reports not submitted${o.blocking_issue ? `: ${o.blocking_issue.slice(0, 160)}` : ""}`);
    return { ok: false, urgent: o.place_order_clicks !== "0", reasons, obs: o, usdc: null };
  }
  if (o.place_order_clicks !== "1") reasons.push(`Place Order click count ${o.place_order_clicks} is not exactly 1`);
  if (!o.provider_order_id.trim()) reasons.push("no provider order id observed");
  if (!sameVpa(o.entered_upi_id, cmd.vpa)) reasons.push("entered UPI ID differs from the authorized VPA");
  if (!sameVpa(o.visible_recipient, cmd.vpa)) reasons.push("visible recipient differs from the authorized VPA");
  if (parseVisibleUsdc(o.entered_usdc_amount) !== cmd.sellUsdc) reasons.push("entered USDC amount differs from the approved sell amount");
  const usdc = parseVisibleUsdc(o.visible_usdc);
  if (usdc === null) reasons.push("visible USDC debit unparseable");
  else if (usdc > cmd.maxUsdc) reasons.push("visible USDC debit exceeds the authorized maximum");
  const inr = parseVisibleInr(o.visible_inr);
  if (inr === null) reasons.push("visible INR payout unparseable");
  else if (inr < cmd.inrPaise - cmd.variance) reasons.push("visible INR payout is below the authorized amount");
  const mismatchAfterSubmit = reasons.some((r) => /differs|exceeds|allowlisted|below|more than once|not exactly 1/.test(r));
  return { ok: reasons.length === 0, urgent: mismatchAfterSubmit, reasons, obs: o, usdc };
}

export function evaluateExecution(raw: unknown, cmd: EvalTerms, web: P2PWebConfig): Verdict & { obs: ExecuteObservation | null; urgent: boolean; usdc: bigint | null } {
  if (cmd.sellUsdc !== undefined) return evaluateSellExecution(raw, { ...cmd, sellUsdc: cmd.sellUsdc }, web);
  const parsed = ExecuteObservation.safeParse(raw);
  if (!parsed.success) return { ok: false, urgent: false, reasons: ["observation did not match the expected schema"], obs: null, usdc: null };
  const o = parsed.data;
  const reasons: string[] = [];
  if (!isTrustedOrigin(o.final_url, web)) reasons.push("final page was not on an allowlisted P2P.me origin");
  if (!o.submitted) {
    // The agent says it stopped. That is an untrusted claim: reconciliation must verify no order exists.
    reasons.push(`agent reports not submitted${o.blocking_issue ? `: ${o.blocking_issue.slice(0, 160)}` : ""}`);
    return { ok: false, urgent: false, reasons, obs: o, usdc: null };
  }
  if (!o.provider_order_id.trim()) reasons.push("no provider order id observed");
  if (!sameVpa(o.visible_recipient, cmd.vpa)) reasons.push("visible recipient differs from the authorized VPA");
  const inr = parseVisibleInr(o.visible_inr);
  if (inr === null) reasons.push("visible INR amount unparseable");
  else if ((inr > cmd.inrPaise ? inr - cmd.inrPaise : cmd.inrPaise - inr) > cmd.variance) reasons.push("visible INR amount differs from the authorized amount");
  const usdc = parseVisibleUsdc(o.visible_usdc);
  if (usdc === null) reasons.push("visible USDC debit unparseable");
  else if (usdc > cmd.maxUsdc) reasons.push("visible USDC debit exceeds the authorized maximum");
  const mismatchAfterSubmit = reasons.some((r) => /differs|exceeds|allowlisted/.test(r));
  return { ok: reasons.length === 0, urgent: mismatchAfterSubmit, reasons, obs: o, usdc };
}

export type ReconcileVerdict =
  | { kind: "status"; status: "PLACED" | "ACCEPTED" | "PAID" | "COMPLETED" | "CANCELLED" | "DISPUTED" | "UNKNOWN"; orderId: string; usdc: bigint | null; reference: string }
  | { kind: "not_found" }
  | { kind: "invalid"; reasons: string[]; urgent: boolean };

export function evaluateReconcile(raw: unknown, cmd: EvalTerms, knownOrderId: string | null, web: P2PWebConfig): ReconcileVerdict {
  const parsed = ReconcileObservation.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", reasons: ["observation did not match the expected schema"], urgent: false };
  const o = parsed.data;
  if (!isTrustedOrigin(o.observed_url, web)) return { kind: "invalid", reasons: ["final page was not on an allowlisted P2P.me origin"], urgent: false };
  if (!o.order_found) return { kind: "not_found" };
  const reasons: string[] = [];
  if (knownOrderId && o.provider_order_id.trim() !== knownOrderId) reasons.push("order id differs from the recorded order");
  if (!o.provider_order_id.trim()) reasons.push("missing provider order id");
  if (!sameVpa(o.visible_recipient, cmd.vpa)) reasons.push("recipient differs");
  const inr = parseVisibleInr(o.visible_inr);
  if (cmd.sellUsdc !== undefined) {
    // SELL by USDC amount: the INR is the provider's conversion; it may exceed but never undercut the authorized INR.
    if (inr === null || inr < cmd.inrPaise - cmd.variance) reasons.push("INR payout below the authorized amount");
  } else if (inr === null || (inr > cmd.inrPaise ? inr - cmd.inrPaise : cmd.inrPaise - inr) > cmd.variance) reasons.push("INR amount differs");
  const usdc = parseVisibleUsdc(o.visible_usdc);
  if (usdc !== null && usdc > cmd.maxUsdc) reasons.push("USDC debit exceeds the authorized maximum");
  if (o.provider_order_status === "COMPLETED" && (usdc === null || usdc <= 0n)) reasons.push("completed observation lacks exact positive USDC debit");
  if (reasons.length) return { kind: "invalid", reasons, urgent: true };
  return { kind: "status", status: o.provider_order_status, orderId: o.provider_order_id.trim(), usdc, reference: o.provider_reference ?? "" };
}

/* ================================================================== command creation */

export function commandHash(c: { flow: string; vpa: string; inrPaise: bigint; maxUsdc: bigint; variance: bigint; authorizationId: string; quoteId: string | null; environment: string }): string {
  return createHash("sha256")
    .update(canonicalJson({ ...c, vpa: c.vpa.toLowerCase(), inrPaise: c.inrPaise.toString(), maxUsdc: c.maxUsdc.toString(), variance: c.variance.toString() }))
    .digest("hex");
}

export async function recordAuthorization(t: Tx, ctx: CoreContext, a: { intentId?: string | null; withdrawalId?: string | null; terms: Record<string, unknown>; actor: string }): Promise<string> {
  const id = newId("approval").replace(/^apr_/, "auth_");
  const body = canonicalJson(a.terms);
  await t.query(`INSERT INTO payout_authorizations(id, environment, intent_id, withdrawal_id, terms, terms_hash, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id,
    ctx.env,
    a.intentId ?? null,
    a.withdrawalId ?? null,
    body,
    createHash("sha256").update(body).digest("hex"),
    a.actor,
  ]);
  return id;
}

export async function createPayoutCommand(
  t: Tx,
  ctx: CoreContext,
  c: { flow: "SCAN_PAY" | "MERCHANT_WITHDRAWAL"; intentId?: string; withdrawalId?: string; vpa: string; inrPaise: bigint; maxUsdcMicros: bigint; quoteId: string | null; authorizationId: string; reservedTreasuryId: string | null },
): Promise<string> {
  // HACKATHON_TESTNET never executes payouts — except the strict TESTNET_LIVE_PAYOUT_DEMO opt-in, Scan & Pay only.
  if (ctx.env === "testnet" && !(testnetLiveDemo(ctx) && c.flow === "SCAN_PAY")) throw new DomainError("FEATURE_UNAVAILABLE", "HACKATHON_TESTNET never executes payouts");
  const mode = ctx.env === "mainnet-enabled" || ctx.env === "demo" || ctx.env === "testnet" ? "EXECUTE_AFTER_APPROVAL" : "READ_ONLY";
  const id = newId("order").replace(/^ord_/, "pay_");
  const variance = 0n; // policy: exact INR; any override requires a new explicit authorization
  const hash = commandHash({ flow: c.flow, vpa: c.vpa, inrPaise: c.inrPaise, maxUsdc: c.maxUsdcMicros, variance, authorizationId: c.authorizationId, quoteId: c.quoteId, environment: ctx.env });
  await t.query(
    `INSERT INTO payout_commands(id, environment, flow, mode, recipient_vpa_ct, recipient_vpa_masked, requested_inr_paise, max_usdc_debit_micros, max_fiat_variance_paise,
       quote_id, source_intent_id, withdrawal_id, authorization_id, reserved_treasury_id, command_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, ctx.env, c.flow, mode, await ctx.envelope.seal(c.vpa, `payout_commands:${id}:vpa`), maskVpa(c.vpa), c.inrPaise.toString(), c.maxUsdcMicros.toString(), variance.toString(), c.quoteId, c.intentId ?? null, c.withdrawalId ?? null, c.authorizationId, c.reservedTreasuryId, hash],
  );
  await enqueueJob(t, ctx.env, "tfpayout.advance", id, { id });
  await audit(t, ctx.env, { actorType: "system", action: "payout_command.create", target: id, details: { flow: c.flow, mode } });
  return id;
}

/* ================================================================== TESTNET_LIVE_PAYOUT_DEMO */

/** The strict testnet live payout demo gate (see liveDemoPayoutsEnabled in config.ts). */
export function testnetLiveDemo(ctx: CoreContext): boolean {
  return ctx.env === "testnet" && liveDemoPayoutsEnabled(ctx.cfg);
}

/** Honest framing shown wherever the demo payout appears. */
export const TESTNET_DEMO_FUNDING_NOTE = "INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet payment only authorizes it.";

/**
 * TESTNET_LIVE_PAYOUT_DEMO, called from deposit acceptance (same transaction) for a confirmed testnet
 * Scan & Pay payment. The TAZ payment only AUTHORIZES an operator-approved INR payout that Zeb Scan
 * pays from its OWN pre-funded P2P.lol USDC: TAZ has no value and is never booked as INR, and no Zeb
 * Scan treasury exists on testnet. From here on the normal strict rail applies (immutable command +
 * hash → policy caps → read-only preflight → operator approval → one execute attempt → read-only
 * reconciliation). Never throws for a missing prerequisite: deposit acceptance must not roll back.
 */
export async function queueTestnetDemoPayout(
  t: Tx,
  ctx: CoreContext,
  intent: { id: string; mode: string; payout_status: string; recipient_vpa_ct: string | null },
  quote: { id: string; inr_paise: string; required_usdc_micros: string },
): Promise<string | null> {
  const unavailable = async (why: string) => {
    await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.disabled", { label: "ZEC confirmed on testnet", detail: `The INR payout demo could not be prepared (${why}). Nothing was sent to the UPI ID.` });
    await raiseException(t, ctx.env, { kind: "testnet_demo_payout_unavailable", severity: "warning", intentId: intent.id, details: { reason: why } });
    return null;
  };
  if (!testnetLiveDemo(ctx) || intent.mode !== "scan_pay") throw new DomainError("FEATURE_UNAVAILABLE", "HACKATHON_TESTNET never executes payouts");
  if (!intent.recipient_vpa_ct) return unavailable("no UPI recipient on this checkout");
  if (intent.payout_status !== "not_started") return unavailable(`payout already ${intent.payout_status}`);
  const auth = await maybeOne<{ id: string }>(t, `SELECT id FROM payout_authorizations WHERE intent_id=$1 AND environment=$2 ORDER BY created_at LIMIT 1`, [intent.id, ctx.env]);
  if (!auth) return unavailable("no payer authorization snapshot");
  // Savepoint: a failure here must never roll back the (already verified) deposit acceptance.
  await t.query("SAVEPOINT testnet_demo_payout");
  try {
    const vpa = await ctx.envelope.open(intent.recipient_vpa_ct, `payment_intents:${intent.id}:recipient_vpa`);
    payoutMachine.assert("not_started", "payout_queued");
    await t.query(`UPDATE payment_intents SET payout_status='payout_queued', updated_at=now() WHERE id=$1`, [intent.id]);
    const id = await createPayoutCommand(t, ctx, { flow: "SCAN_PAY", intentId: intent.id, vpa, inrPaise: BigInt(quote.inr_paise), maxUsdcMicros: BigInt(quote.required_usdc_micros), quoteId: quote.id, authorizationId: auth.id, reservedTreasuryId: null });
    await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.payout_queued", { label: "Testnet ZEC confirmed — INR payout authorized", detail: `${TESTNET_DEMO_FUNDING_NOTE} An operator approves every payout before anything is submitted.` });
    await audit(t, ctx.env, { actorType: "system", action: "payout.testnet_demo_authorized", target: id, details: { intentId: intent.id, fundedBy: "operator-prefunded-p2p.lol-usdc" } });
    await t.query("RELEASE SAVEPOINT testnet_demo_payout");
    return id;
  } catch (e) {
    await t.query("ROLLBACK TO SAVEPOINT testnet_demo_payout");
    return unavailable(`could not create the payout command: ${(e as Error).message.slice(0, 120)}`);
  }
}

/* ================================================================== mirror onto intent / withdrawal */

const SCAN_PATH: PayoutStatus[] = ["payout_queued", "order_placing", "placed", "merchant_accepted", "usdc_escrowed", "inr_processing", "provider_completed", "payout_reconciled", "completed"];
const WD_PATH: WithdrawalStatus[] = ["awaiting_provider", "order_placing", "placed", "merchant_accepted", "usdc_escrowed", "inr_processing", "provider_completed"];

const LABEL: Partial<Record<TfPayoutState, string>> = {
  OPERATOR_APPROVAL_REQUIRED: "Waiting for operator approval",
  QUEUED: "Payout queued",
  AGENT_RUNNING: "Submitting payout with the provider",
  ORDER_SUBMISSION_OBSERVED: "Payout submitted",
  PROVIDER_ACCEPTED: "Finding a payout provider — accepted",
  FIAT_TRANSFER_REPORTED: "Waiting for INR confirmation",
  PROVIDER_COMPLETED_VERIFIED: "Provider shows the order completed — reconciling",
  RECONCILED: "Completed",
  OUTCOME_UNKNOWN_REVIEW: "Needs review",
  PREFLIGHT_BLOCKED: "Payout currently unavailable",
  PROVIDER_CANCELLED: "Provider cancelled the order",
  PROVIDER_DISPUTED: "Disputed — under review",
  PAYOUT_FAILED_RECOVERY: "Payout failed — recovery in progress",
  REFUND_PENDING: "Refund pending",
};

async function mirror(t: Tx, ctx: CoreContext, cmd: PayoutCommandRow, state: TfPayoutState) {
  if (cmd.flow === "SCAN_PAY" && cmd.source_intent_id) {
    const target: PayoutStatus | null =
      state === "ORDER_SUBMISSION_OBSERVED" ? "placed"
      : state === "PROVIDER_ACCEPTED" ? "merchant_accepted"
      : state === "FIAT_TRANSFER_REPORTED" ? "inr_processing"
      : state === "PROVIDER_COMPLETED_VERIFIED" ? "provider_completed"
      : state === "RECONCILED" ? "completed"
      : state === "PROVIDER_DISPUTED" ? "disputed"
      : state === "OUTCOME_UNKNOWN_REVIEW" ? "manual_review"
      : state === "PREFLIGHT_BLOCKED" ? "not_liquid"
      : state === "REFUND_PENDING" || state === "PAYOUT_FAILED_RECOVERY" ? "refund_queued"
      : null;
    if (target) {
      const row = await one<{ payout_status: PayoutStatus }>(t, `SELECT payout_status FROM payment_intents WHERE id=$1 FOR UPDATE`, [cmd.source_intent_id]);
      let cur = row.payout_status;
      const set = async (to: PayoutStatus) => {
        await t.query(`UPDATE payment_intents SET payout_status=$2, status_version=status_version+1, updated_at=now() WHERE id=$1`, [cmd.source_intent_id, to]);
        cur = to;
      };
      const ti = SCAN_PATH.indexOf(target);
      if (ti >= 0 && SCAN_PATH.indexOf(cur) >= 0) for (let k = SCAN_PATH.indexOf(cur) + 1; k <= ti; k++) await set(SCAN_PATH[k]!);
      else if (payoutMachine.can(cur, target)) await set(target);
    }
    await emitResource(t, ctx.env, `checkout:${cmd.source_intent_id}`, `payout.${state.toLowerCase()}`, { label: LABEL[state] ?? state.replace(/_/g, " ").toLowerCase() });
  } else if (cmd.withdrawal_id) {
    const target: WithdrawalStatus | null =
      state === "ORDER_SUBMISSION_OBSERVED" ? "placed"
      : state === "PROVIDER_ACCEPTED" ? "merchant_accepted"
      : state === "FIAT_TRANSFER_REPORTED" ? "inr_processing"
      : state === "PROVIDER_COMPLETED_VERIFIED" ? "provider_completed"
      : state === "PROVIDER_DISPUTED" ? "disputed"
      : state === "OUTCOME_UNKNOWN_REVIEW" ? "manual_review"
      : state === "PREFLIGHT_BLOCKED" ? "failed_recoverable"
      : null;
    if (target) {
      const w = await one<{ status: WithdrawalStatus }>(t, `SELECT status FROM withdrawals WHERE id=$1 FOR UPDATE`, [cmd.withdrawal_id]);
      let cur = w.status;
      const set = async (to: WithdrawalStatus) => {
        await t.query(`UPDATE withdrawals SET status=$2, version=version+1, updated_at=now() WHERE id=$1`, [cmd.withdrawal_id, to]);
        cur = to;
      };
      const ti = WD_PATH.indexOf(target);
      if (ti >= 0 && WD_PATH.indexOf(cur) >= 0) for (let k = WD_PATH.indexOf(cur) + 1; k <= ti; k++) await set(WD_PATH[k]!);
      else if (withdrawalMachine.can(cur, target)) await set(target);
    }
    await emitResource(t, ctx.env, `withdrawal:${cmd.withdrawal_id}`, `withdrawal.${state.toLowerCase()}`, { label: LABEL[state] ?? state.replace(/_/g, " ").toLowerCase() });
  }
}

async function setState(t: Tx, ctx: CoreContext, cmd: PayoutCommandRow, to: TfPayoutState, reason?: string): Promise<PayoutCommandRow> {
  tfPayoutMachine.assert(cmd.state, to, { payoutId: cmd.id });
  const r = await t.query<PayoutCommandRow>(
    `UPDATE payout_commands SET state=$3, state_reason=$4, state_version=state_version+1, updated_at=now() WHERE id=$1 AND state_version=$2 RETURNING *`,
    [cmd.id, cmd.state_version, to, reason ?? null],
  );
  if (r.rowCount !== 1) throw new DomainError("STATE_CONCURRENT_MODIFICATION", "payout command changed concurrently", undefined, { status: 409, retryable: true });
  await mirror(t, ctx, cmd, to);
  await audit(t, ctx.env, { actorType: "system", action: `payout.${to}`, target: cmd.id, details: { from: cmd.state, reason } });
  return r.rows[0]!;
}

/* ================================================================== leases */

async function acquireLease(t: Tx, ctx: CoreContext, fp: string, payoutId: string): Promise<bigint | null> {
  const r = await t.query<{ fencing_token: string }>(
    `INSERT INTO p2p_account_leases(environment, account_fingerprint, payout_id, fencing_token) VALUES ($1,$2,$3,1)
     ON CONFLICT (environment, account_fingerprint) DO UPDATE SET payout_id=EXCLUDED.payout_id, fencing_token=p2p_account_leases.fencing_token+1
       WHERE p2p_account_leases.payout_id IS NULL OR p2p_account_leases.payout_id = EXCLUDED.payout_id
     RETURNING fencing_token`,
    [ctx.env, fp, payoutId],
  );
  return r.rows[0] ? BigInt(r.rows[0].fencing_token) : null;
}

async function releaseLease(t: Tx, ctx: CoreContext, fp: string | null, payoutId: string) {
  if (!fp) return;
  await t.query(`UPDATE p2p_account_leases SET payout_id=NULL WHERE environment=$1 AND account_fingerprint=$2 AND payout_id=$3`, [ctx.env, fp, payoutId]);
}

/* ================================================================== capability preflight */

export interface CapabilityReport {
  id: string;
  status: "PASS" | "BLOCKED";
  reasons: string[];
  runId: string | null;
  observedUrl: string | null;
  accountFingerprint: string | null;
  createdAt: string;
}

export function railReady(ctx: CoreContext, deps: TfDeps): string | null {
  if (!deps.port) return "TINYFISH_API_KEY not configured";
  if (!deps.web) return "P2P_ALLOWED_START_URL not configured";
  if (deps.port.kind === "simulated" && ctx.env !== "demo") return "simulated TinyFish port refused outside DEMO";
  return null;
}

async function waitRun(port: TinyFishPort, runId: string, maxMs: number): Promise<TfRun> {
  const start = Date.now();
  let delay = 2_000;
  for (;;) {
    const r = await port.get(runId);
    if (r.status === "COMPLETED" || r.status === "FAILED" || r.status === "CANCELLED") return r;
    if (Date.now() - start > maxMs) return r;
    await new Promise((res) => setTimeout(res, delay + Math.floor(Math.random() * 500)));
    delay = Math.min(delay * 1.5, 10_000);
  }
}

/** Read-only P2P capability probe (admin/CLI). Writes a p2p_capability_reports row. Never moves money. */
export async function runCapabilityPreflight(ctx: CoreContext, deps: TfDeps, opts: { wait?: boolean; requestedBy?: string } = {}): Promise<CapabilityReport> {
  const id = newId("audit").replace(/^aud_/, "cap_");
  const reasons: string[] = [];
  let runId: string | null = null;
  let obs: unknown = null;
  let observedUrl: string | null = null;
  let fp: string | null = null;
  let balance: bigint | null = null;
  const blocked = railReady(ctx, deps);
  if (blocked) reasons.push(blocked);
  else {
    const ref = `capability-${id}`;
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
    if (!q.run_id) reasons.push(`TinyFish rejected the run: ${q.error?.message ?? "unknown"}`);
    else {
      runId = q.run_id;
      const run = opts.wait === false ? await deps.port!.get(runId) : await waitRun(deps.port!, runId, (ctx.cfg.pilot.runMaxDurationSec + 60) * 1000);
      if (run.status !== "COMPLETED") reasons.push(`run ${run.status}${run.error ? `: ${run.error.message.slice(0, 160)}` : ""} — a non-completed run is not readiness`);
      else {
        const v = evaluatePreflight(run.result, deps.web!, { flow: null, usdcMicros: 1n });
        obs = v.obs;
        observedUrl = v.obs?.observed_url ?? null;
        balance = v.visibleUsdcMicros;
        reasons.push(...v.reasons);
        if (v.obs?.account_identifier) fp = accountFingerprint(v.obs.account_identifier, ctx.cfg.tokenSecret);
        else if (v.ok) reasons.push("no stable account identifier visible");
      }
    }
  }
  const status = reasons.length ? "BLOCKED" : "PASS";
  // Redact: keep booleans/limits/blocker text; balance stored separately; account identifier replaced by fingerprint.
  const redacted = obs && typeof obs === "object" ? { ...(obs as Record<string, unknown>), account_identifier: fp ? `fp:${fp}` : "", visible_usdc_balance: balance !== null ? "[stored separately]" : "" } : {};
  const row = await one<{ created_at: Date }>(
    ctx.db,
    `INSERT INTO p2p_capability_reports(id, environment, account_fingerprint, run_id, status, reasons, observation, observed_url, visible_usdc_micros, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval) RETURNING created_at`,
    [id, ctx.env, fp, runId, status, reasons, JSON.stringify(redacted), observedUrl, balance?.toString() ?? null, String(ctx.cfg.pilot.capabilityMaxAgeSec)],
  );
  await audit(ctx.db, ctx.env, { actorType: opts.requestedBy ? "operator" : "system", actorId: opts.requestedBy ?? null, action: "p2p.preflight", target: id, details: { status, reasons } });
  return { id, status, reasons, runId, observedUrl, accountFingerprint: fp, createdAt: new Date(row.created_at).toISOString() };
}

export async function latestCapability(ctx: CoreContext): Promise<{ status: string; reasons: string[]; account_fingerprint: string | null; visible_usdc_micros: string | null; created_at: Date; expires_at: Date; fresh: boolean } | null> {
  const r = await maybeOne<{ status: string; reasons: string[]; account_fingerprint: string | null; visible_usdc_micros: string | null; created_at: Date; expires_at: Date }>(
    ctx.db,
    `SELECT status, reasons, account_fingerprint, visible_usdc_micros, created_at, expires_at FROM p2p_capability_reports WHERE environment=$1 ORDER BY created_at DESC LIMIT 1`,
    [ctx.env],
  );
  return r ? { ...r, fresh: new Date(r.expires_at) > ctx.now() } : null;
}

/** Public, sanitized: eligible_for_payout is strictly false until a fresh PASS report exists AND live payouts are enabled. */
export async function payoutReadiness(ctx: CoreContext, deps: TfDeps) {
  const cap = await latestCapability(ctx);
  const reasons: string[] = [];
  const rail = railReady(ctx, deps);
  // TESTNET_LIVE_PAYOUT_DEMO replaces the treasury requirement with the operator's own pre-funded P2P.lol USDC.
  const demoLive = testnetLiveDemo(ctx);
  if (ctx.env !== "demo" && !demoLive) reasons.push("independent spendable-capacity and settlement verification are not provisioned");
  if (ctx.env === "testnet" && !demoLive) reasons.push("HACKATHON_TESTNET never executes INR payouts");
  if (ctx.env === "mainnet-readonly") reasons.push("MAINNET_READONLY: no fund movement");
  if (rail) reasons.push(rail);
  if (!cap) reasons.push("no P2P capability report yet");
  else if (cap.status !== "PASS") reasons.push("latest P2P capability report is BLOCKED");
  else if (!cap.fresh) reasons.push("P2P capability report is stale");
  if ((ctx.env === "mainnet-enabled" || demoLive) && !ctx.cfg.pilot.livePayoutsEnabled) reasons.push("live payouts are disabled by policy");
  if ((ctx.env === "mainnet-enabled" || demoLive) && ctx.cfg.pilot.maxPayoutInrPaise === 0n) reasons.push("pilot per-order cap is 0");
  if (demoLive && (!ctx.cfg.approvals.legal || !ctx.cfg.approvals.provider)) reasons.push("legal/provider approval references missing (LEGAL_APPROVAL_REF / PROVIDER_APPROVAL_REF)");
  return { rail: "P2P_TINYFISH_WEB", eligible_for_payout: reasons.length === 0, reasons, lastCheckedAt: cap ? new Date(cap.created_at).toISOString() : null };
}

/* ================================================================== driver */

type Next = { rerunInMs: number | null };

async function load(t: Tx, id: string): Promise<PayoutCommandRow> {
  return one<PayoutCommandRow>(t, `SELECT * FROM payout_commands WHERE id=$1 FOR UPDATE`, [id]);
}

function cmdTerms(_ctx: CoreContext, cmd: PayoutCommandRow, vpa: string): EvalTerms {
  const maxUsdc = BigInt(cmd.max_usdc_debit_micros);
  // Testnet commands exist only under TESTNET_LIVE_PAYOUT_DEMO and execute as an app.p2p.lol SELL of exactly
  // the authorized maximum USDC debit (derived from the immutable, hashed terms — never from page or agent text).
  const sell = cmd.environment === "testnet" ? { sellUsdc: maxUsdc } : {};
  return { vpa, inrPaise: BigInt(cmd.requested_inr_paise), maxUsdc, variance: BigInt(cmd.max_fiat_variance_paise), ...sell };
}

async function startRun(ctx: CoreContext, deps: TfDeps, cmd: PayoutCommandRow, kind: "preflight" | "execute" | "reconcile", goal: string, schema: Record<string, unknown>, fencing?: bigint): Promise<{ runId: string | null; outcome: "queued" | "rejected" | "error"; message?: string }> {
  // Persist the attempt BEFORE queueing so a crash between queue and persist is detectable.
  const attemptId = newId("job").replace(/^job_/, "att_");
  const blocked = await tx(ctx.db, async (t) => {
    if (kind === "execute") {
      const c = await load(t, cmd.id);
      const reasons = await executionBlockers(t, ctx, deps, c, fencing);
      if (reasons.length) {
        await t.query(`UPDATE payout_commands SET held=true, hold_reason=$2, state_reason=$2, updated_at=now() WHERE id=$1`, [c.id, reasons.join("; ")]);
        await releaseLease(t, ctx, c.account_fingerprint, c.id);
        await audit(t, ctx.env, { actorType: "system", action: "payout.execution_blocked", target: c.id, details: { reasons } });
        return reasons.join("; ");
      }
      // Claim the exact command and persist the attempt before releasing DB locks.
      // No external call runs inside this transaction. A crash is ambiguous, never retried.
      await setState(t, ctx, c, "AGENT_RUNNING");
    }
    await t.query(`INSERT INTO payout_attempts(id, payout_id, kind, command_hash, fencing_token) VALUES ($1,$2,$3,$4,$5)`, [attemptId, cmd.id, kind, cmd.command_hash, fencing?.toString() ?? null]);
    return null;
  });
  if (blocked) return { runId: null, outcome: "rejected", message: blocked };
  try {
    const q = await deps.port!.queue({
      url: deps.web!.startUrl,
      goal,
      use_profile: true,
      ...(deps.web!.profileId ? { profile_id: deps.web!.profileId } : {}),
      use_vault: false,
      agent_config: { mode: "strict", max_steps: ctx.cfg.pilot.runMaxSteps, max_duration_seconds: ctx.cfg.pilot.runMaxDurationSec },
      capture_config: { screenshots: true },
      output_schema: schema,
    });
    if (!q.run_id) {
      await ctx.db.query(`UPDATE payout_attempts SET status='queue_rejected', outcome='queue_rejected', updated_at=now() WHERE id=$1`, [attemptId]);
      return { runId: null, outcome: "rejected", message: q.error?.message };
    }
    await ctx.db.query(`UPDATE payout_attempts SET status='queued', run_id=$2, updated_at=now() WHERE id=$1`, [attemptId, q.run_id]);
    return { runId: q.run_id, outcome: "queued" };
  } catch (e) {
    await ctx.db.query(`UPDATE payout_attempts SET status='queue_error', updated_at=now() WHERE id=$1`, [attemptId]);
    return { runId: null, outcome: "error", message: (e as Error).message };
  }
}

async function executionBlockers(t: Tx, ctx: CoreContext, deps: TfDeps, c: PayoutCommandRow, fencing?: bigint): Promise<string[]> {
  const reasons: string[] = [];
  const now = ctx.now();
  if (c.environment !== ctx.env || c.mode !== "EXECUTE_AFTER_APPROVAL" || c.state !== "QUEUED" || c.held) reasons.push("command is not executable");
  // TESTNET_LIVE_PAYOUT_DEMO: paid from the operator's OWN pre-funded P2P.lol USDC (the TAZ payment only
  // authorizes it). It replaces ONLY the treasury / production-capacity requirements below; every other
  // check (approval, caps, pause, hash, authorization, finality, fresh preflight, lease) still applies.
  const demoLive = c.environment === "testnet" && testnetLiveDemo(ctx);
  if (ctx.env !== "demo") {
    if (demoLive) {
      if (c.flow !== "SCAN_PAY") reasons.push("testnet live demo pays Scan & Pay only");
      // scripts/settle-p2plol.ts is a separate app.p2p.lol SELL path for the same checkouts, armed by the same flag
      // but outside payout_commands (no hash-bound approval, lease or daily cap). Never pay one checkout through both.
      if (c.source_intent_id && (await maybeOne(t, `SELECT 1 FROM resource_events WHERE environment=$1 AND resource=$2 AND starts_with(event_type, 'payout.live_demo.') LIMIT 1`, [ctx.env, `checkout:${c.source_intent_id}`]))) reasons.push("checkout already handled by the separate scripts/settle-p2plol.ts settlement; refusing a second payout");
    } else {
      // A browser balance is not authenticated spendable reserves. No production
      // capacity authority is provisioned yet, regardless of configured credentials.
      reasons.push("independent spendable-capacity verification is not provisioned");
      if (ctx.env !== "mainnet-enabled" || !ctx.caps.canSubmitTransactions || !ctx.cfg.pilot.livePayoutsEnabled) reasons.push("live money movement disabled");
    }
    if (!ctx.cfg.approvals.legal || !ctx.cfg.approvals.provider) reasons.push("legal/provider approval missing");
    if (BigInt(c.requested_inr_paise) > ctx.cfg.pilot.maxPayoutInrPaise) reasons.push("per-order cap exceeded");
    const daily = await one<{ total: string }>(t, `SELECT coalesce(sum(max_usdc_debit_micros),0) AS total FROM payout_commands WHERE environment=$1 AND created_at > now()-interval '1 day' AND state NOT IN ('PREFLIGHT_BLOCKED','EXPIRED','USER_ABORTED','REFUNDED')`, [ctx.env]);
    if (BigInt(daily.total) > ctx.cfg.pilot.dailyMaxUsdcMicros) reasons.push("daily exposure cap exceeded");
  } else if (deps.port?.kind !== "simulated") reasons.push("demo may only use an isolated simulated port");
  if (!c.approved_by || !c.approval_expires_at || new Date(c.approval_expires_at) <= now) reasons.push("operator approval missing or expired");
  const gates = await many<{ feature: string }>(t, `SELECT feature FROM feature_gates WHERE environment=$1 AND NOT enabled AND feature = ANY($2) FOR SHARE`, [ctx.env, ["all", "payouts", c.flow === "SCAN_PAY" ? "scanPay" : "withdrawals"]]);
  if (gates.length) reasons.push("global or product pause enabled");
  const vpa = await ctx.envelope.open(c.recipient_vpa_ct, `payout_commands:${c.id}:vpa`);
  if (commandHash({ flow: c.flow, vpa, inrPaise: BigInt(c.requested_inr_paise), maxUsdc: BigInt(c.max_usdc_debit_micros), variance: BigInt(c.max_fiat_variance_paise), authorizationId: c.authorization_id, quoteId: c.quote_id, environment: ctx.env }) !== c.command_hash) reasons.push("immutable terms hash mismatch");
  const auth = await maybeOne(t, `SELECT 1 FROM payout_authorizations WHERE id=$1 AND environment=$2 AND intent_id IS NOT DISTINCT FROM $3 AND withdrawal_id IS NOT DISTINCT FROM $4`, [c.authorization_id, ctx.env, c.source_intent_id, c.withdrawal_id]);
  if (!auth) reasons.push("payer authorization does not bind this obligation");
  const obligation = c.source_intent_id ?? c.withdrawal_id!;
  if (demoLive) {
    // No Zeb Scan treasury exists on testnet; the fresh read-only preflight below must have seen a
    // spendable P2P.lol USDC balance >= the max debit, and the per-order/daily caps above bound exposure.
    if (c.reserved_treasury_id) reasons.push("testnet live demo command must not reference a treasury reserve");
  } else {
    const alloc = await treasury.activeAllocation(t, ctx.env, obligation, false);
    if (!alloc || alloc.id !== c.reserved_treasury_id || BigInt(alloc.amount_micros) < BigInt(c.max_usdc_debit_micros)) reasons.push("exact reserve unavailable");
    const capacity = await treasury.treasuryCapacity(t, ctx.env, { inventoryMaxAgeMs: ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000, bufferMicros: 0n }, now);
    if (capacity.stale || capacity.activeMicros > capacity.inventoryMicros) reasons.push("capacity stale or below obligations");
  }
  const sources = c.source_intent_id ? [c.source_intent_id] : (await many<{ intent_id: string }>(t, `SELECT DISTINCT coalesce(c.intent_id,p.intent_id) AS intent_id FROM merchant_credits c LEFT JOIN merchant_credits p ON p.id=c.parent_credit_id WHERE c.withdrawal_id=$1`, [c.withdrawal_id])).map((r) => r.intent_id);
  if (!sources.length) reasons.push("source deposits unavailable");
  for (const id of sources) {
    const source = await maybeOne(t, `SELECT 1 FROM payment_intents WHERE id=$1 AND environment=$2 AND status='deposit_accepted' FOR SHARE`, [id, ctx.env]);
    const bad = await maybeOne(t, `SELECT 1 FROM deposit_observations WHERE intent_id=$1 AND accepted AND (NOT canonical OR NOT mined OR confirmations<$2)`, [id, ctx.cfg.policy.requiredConfirmations]);
    const accepted = await maybeOne(t, `SELECT 1 FROM deposit_observations WHERE intent_id=$1 AND accepted`, [id]);
    if (!source || bad || !accepted) reasons.push("source deposit is not canonical and final");
    if (await maybeOne(t, `SELECT 1 FROM exceptions WHERE intent_id=$1 AND status='open' AND severity <> 'info'`, [id])) reasons.push("source under exception review");
  }
  if (ctx.env === "mainnet-enabled" && c.flow === "SCAN_PAY" && c.source_intent_id) {
    // The 1-confirmation preparation must exist, be READY and not held by a reorg/pause (it never authorizes by itself).
    const prep = await maybeOne<{ state: string }>(t, `SELECT state FROM payout_preparations WHERE environment=$1 AND intent_id=$2 FOR SHARE`, [ctx.env, c.source_intent_id]);
    if (prep?.state !== "READY") reasons.push(`P2P preparation is not ready (${prep?.state ?? "missing"})`);
  }
  const preflight = await maybeOne<{ created_at: Date }>(t, `SELECT created_at FROM payout_attempts WHERE payout_id=$1 AND kind='preflight' AND outcome='pass' ORDER BY created_at DESC LIMIT 1`, [c.id]);
  if (!c.account_fingerprint || !preflight || now.getTime()-new Date(preflight.created_at).getTime() > ctx.cfg.pilot.capabilityMaxAgeSec*1000) reasons.push("account/session preflight stale");
  const lease = await maybeOne<{ fencing_token: string }>(t, `SELECT fencing_token FROM p2p_account_leases WHERE environment=$1 AND account_fingerprint=$2 AND payout_id=$3 FOR UPDATE`, [ctx.env, c.account_fingerprint, c.id]);
  if (!lease || fencing === undefined || BigInt(lease.fencing_token) !== fencing) reasons.push("account lease lost");
  return reasons;
}

async function latestAttempt(ctx: CoreContext, payoutId: string, kind: string) {
  return maybeOne<{ id: string; run_id: string | null; status: string; outcome: string | null; created_at: Date; updated_at: Date }>(
    ctx.db,
    `SELECT id, run_id, status, outcome, created_at, updated_at FROM payout_attempts WHERE payout_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1`,
    [payoutId, kind],
  );
}

export async function advanceTfPayout(ctx: CoreContext, deps: TfDeps, payoutId: string): Promise<Next> {
  const cmd0 = await maybeOne<PayoutCommandRow>(ctx.db, `SELECT * FROM payout_commands WHERE id=$1 AND environment=$2`, [payoutId, ctx.env]);
  if (!cmd0 || cmd0.held) return { rerunInMs: null };
  const rail = railReady(ctx, deps);
  if (rail && !["RECONCILED", "REFUNDED"].includes(cmd0.state)) {
    await tx(ctx.db, (t) => raiseException(t, ctx.env, { kind: "payout_rail_unavailable", severity: "warning", ...(cmd0.source_intent_id ? { intentId: cmd0.source_intent_id } : { withdrawalId: cmd0.withdrawal_id }), details: { reason: rail } }));
    return { rerunInMs: 300_000 };
  }
  const vpa = await ctx.envelope.open(cmd0.recipient_vpa_ct, `payout_commands:${cmd0.id}:vpa`);
  const terms = cmdTerms(ctx, cmd0, vpa);
  const p = ctx.cfg.pilot;

  switch (cmd0.state) {
    case "CREATED": {
      const reasons: string[] = [];
      if (cmd0.mode !== "EXECUTE_AFTER_APPROVAL") reasons.push(`mode ${cmd0.mode} never executes`);
      const demoLive = testnetLiveDemo(ctx);
      if (ctx.env === "testnet") {
        if (!demoLive) reasons.push("HACKATHON_TESTNET never executes INR payouts (TESTNET_LIVE_PAYOUT_DEMO is off)");
        if (cmd0.flow !== "SCAN_PAY") reasons.push("testnet live demo pays Scan & Pay only");
      }
      if (ctx.env === "mainnet-enabled" || demoLive) {
        if (!p.livePayoutsEnabled) reasons.push("live payouts disabled by policy");
        if (terms.inrPaise > p.maxPayoutInrPaise) reasons.push(demoLive ? `amount above pilot per-order cap: INR ${formatInrPaise(terms.inrPaise)} > INR ${formatInrPaise(p.maxPayoutInrPaise)} (PILOT_MAX_PAYOUT_INR_PAISE)` : "amount above pilot per-order cap");
        const day = await one<{ total: string | null }>(ctx.db, `SELECT sum(max_usdc_debit_micros) AS total FROM payout_commands WHERE environment=$1 AND created_at > now() - interval '1 day' AND state NOT IN ('PREFLIGHT_BLOCKED','EXPIRED','USER_ABORTED','REFUNDED')`, [ctx.env]);
        if (BigInt(day.total ?? "0") > p.dailyMaxUsdcMicros) reasons.push(demoLive ? `daily USDC exposure cap reached: ${formatUsdcMicros(BigInt(day.total ?? "0"))} > ${formatUsdcMicros(p.dailyMaxUsdcMicros)} USDC (PILOT_DAILY_MAX_USDC_MICROS)` : "daily USDC exposure cap reached");
      }
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        await setState(t, ctx, c, reasons.length ? "PREFLIGHT_BLOCKED" : "POLICY_CHECKED", reasons.join("; ") || undefined);
      });
      return { rerunInMs: reasons.length ? null : 0 };
    }
    case "POLICY_CHECKED": {
      if (cmd0.environment === "testnet") {
        // TESTNET_LIVE_PAYOUT_DEMO: no Zeb Scan treasury on testnet. Funding = the operator's own pre-funded
        // P2P.lol USDC; the read-only preflight must see a spendable balance >= the max debit before approval.
        const on = testnetLiveDemo(ctx);
        await tx(ctx.db, async (t) => {
          const c = await load(t, payoutId);
          if (!on) await setState(t, ctx, c, "PREFLIGHT_BLOCKED", "TESTNET_LIVE_PAYOUT_DEMO is off");
          else await setState(t, ctx, c, "LIQUIDITY_RESERVED", "testnet live demo: operator-funded P2P.lol USDC (no Zeb Scan treasury); balance checked by the read-only preflight");
        });
        return { rerunInMs: on ? 0 : null };
      }
      const obligation = cmd0.source_intent_id ?? cmd0.withdrawal_id!;
      const alloc = await treasury.activeAllocation(ctx.db, ctx.env, obligation, false);
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        if (!alloc || BigInt(alloc.amount_micros) < terms.maxUsdc) await setState(t, ctx, c, "PREFLIGHT_BLOCKED", "USDC not reserved for the maximum debit");
        else await setState(t, ctx, c, "LIQUIDITY_RESERVED");
      });
      return { rerunInMs: 0 };
    }
    case "LIQUIDITY_RESERVED": {
      const goal = buildPreflightGoal(`payout-${cmd0.id}`);
      const r = await startRun(ctx, deps, cmd0, "preflight", goal, PREFLIGHT_SCHEMA as unknown as Record<string, unknown>);
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        if (r.outcome === "queued") await setState(t, ctx, c, "READONLY_PREFLIGHT_RUNNING");
        else await setState(t, ctx, c, "PREFLIGHT_BLOCKED", `read-only preflight could not start: ${r.message ?? r.outcome}`);
      });
      return { rerunInMs: 5_000 };
    }
    case "READONLY_PREFLIGHT_RUNNING": {
      const a = await latestAttempt(ctx, payoutId, "preflight");
      const run = await deps.port!.get(a!.run_id!);
      if (run.status === "PENDING" || run.status === "RUNNING") return { rerunInMs: 5_000 };
      const v = run.status === "COMPLETED" ? evaluatePreflight(run.result, deps.web!, { flow: cmd0.flow, usdcMicros: terms.maxUsdc, ...(terms.sellUsdc !== undefined ? { via: "SELL" as const } : {}) }) : { ok: false, reasons: [`preflight run ${run.status}`], obs: null, visibleUsdcMicros: null };
      const fp = v.obs?.account_identifier ? accountFingerprint(v.obs.account_identifier, ctx.cfg.tokenSecret) : null;
      if (v.ok && !fp) v.reasons.push("no stable account identifier visible");
      await ctx.db.query(`UPDATE payout_attempts SET status=$2, observation=$3, outcome=$4, updated_at=now() WHERE id=$1`, [a!.id, run.status === "COMPLETED" ? "completed" : "failed", JSON.stringify({ reasons: v.reasons }), v.ok && fp ? "pass" : "blocked"]);
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        if (v.ok && fp) {
          await t.query(`UPDATE payout_commands SET account_fingerprint=$2 WHERE id=$1`, [c.id, fp]);
          const c2 = await setState(t, ctx, { ...c, account_fingerprint: fp }, "PREFLIGHT_VERIFIED");
          await setState(t, ctx, c2, "OPERATOR_APPROVAL_REQUIRED", "pilot policy: every payout needs explicit operator approval");
        } else await setState(t, ctx, c, "PREFLIGHT_BLOCKED", v.reasons.join("; "));
      });
      return { rerunInMs: null }; // resumes on operator approval
    }
    case "OPERATOR_APPROVAL_REQUIRED": {
      if (!cmd0.approved_by || !cmd0.approval_expires_at) return { rerunInMs: null };
      if (new Date(cmd0.approval_expires_at) < ctx.now()) {
        await tx(ctx.db, async (t) => setState(t, ctx, await load(t, payoutId), "EXPIRED", "operator approval expired before execution"));
        return { rerunInMs: null };
      }
      await tx(ctx.db, async (t) => setState(t, ctx, await load(t, payoutId), "QUEUED"));
      return { rerunInMs: 0 };
    }
    case "QUEUED": {
      // Serialize per operational account; fencing token recorded on the attempt.
      const fencing = await tx(ctx.db, (t) => acquireLease(t, ctx, cmd0.account_fingerprint!, cmd0.id));
      if (fencing === null) return { rerunInMs: 15_000 }; // another payout holds this account
      const existing = await latestAttempt(ctx, payoutId, "execute");
      if (existing && existing.outcome !== "queue_rejected" && existing.outcome !== "verified_not_submitted") {
        // An execute attempt already exists: never queue a second one.
        await tx(ctx.db, async (t) => setState(t, ctx, await load(t, payoutId), existing.run_id ? "AGENT_RUNNING" : "OUTCOME_UNKNOWN_REVIEW", existing.run_id ? undefined : "execute attempt persisted without a confirmed run id"));
        return { rerunInMs: 5_000 };
      }
      // Testnet live demo: app.p2p.lol SELL of exactly the authorized max USDC debit to this command's UPI ID;
      // the provider-displayed INR payout must be at least the authorized INR (minus the command variance).
      const sell = terms.sellUsdc !== undefined ? { sell: { usdcMicros: terms.sellUsdc, minInrPaise: terms.inrPaise - terms.variance } } : {};
      const goal = buildExecuteGoal({ payoutId: cmd0.id, flow: cmd0.flow, recipientVpa: vpa, inrPaise: terms.inrPaise, maxUsdcDebitMicros: terms.maxUsdc, commit: true, ...sell }, deps.web!);
      const r = await startRun(ctx, deps, cmd0, "execute", goal, (terms.sellUsdc !== undefined ? SELL_EXECUTE_SCHEMA : EXECUTE_SCHEMA) as unknown as Record<string, unknown>, fencing);
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        if (r.outcome === "queued") { if (c.state !== "AGENT_RUNNING") await setState(t, ctx, c, "AGENT_RUNNING"); }
        else if (r.outcome === "rejected") {
          // The API explicitly refused to start the run: nothing was submitted.
          await releaseLease(t, ctx, c.account_fingerprint, c.id);
          await setState(t, ctx, c, "AGENT_FAILED_BEFORE_COMMIT", `TinyFish rejected the run: ${r.message ?? ""}`.slice(0, 300));
        } else await setState(t, ctx, c, "OUTCOME_UNKNOWN_REVIEW", `queue call failed ambiguously (${(r.message ?? "").slice(0, 120)}); search runs by reference before any retry`);
      });
      if (r.outcome === "error") await tx(ctx.db, (t) => raiseException(t, ctx.env, { kind: "payout_outcome_unknown", severity: "urgent", ...(cmd0.source_intent_id ? { intentId: cmd0.source_intent_id } : { withdrawalId: cmd0.withdrawal_id }), details: { payoutId } }));
      return { rerunInMs: 5_000 };
    }
    case "AGENT_RUNNING": {
      const a = await latestAttempt(ctx, payoutId, "execute");
      const run = await deps.port!.get(a!.run_id!);
      if (run.status === "PENDING" || run.status === "RUNNING") {
        const ageMs = ctx.now().getTime() - new Date(a!.created_at).getTime();
        if (ageMs < (p.runMaxDurationSec + 300) * 1000) return { rerunInMs: 5_000 };
      }
      const v = run.status === "COMPLETED" ? evaluateExecution(run.result, terms, deps.web!) : { ok: false, urgent: false, reasons: [`execute run ${run.status}`], obs: null, usdc: null };
      await ctx.db.query(`UPDATE payout_attempts SET status=$2, observation=$3, outcome=$4, updated_at=now() WHERE id=$1`, [a!.id, run.status === "COMPLETED" ? "completed" : run.status === "FAILED" || run.status === "CANCELLED" ? "failed" : "running", JSON.stringify({ reasons: v.reasons, submitted: v.obs?.submitted ?? null, status: v.obs?.provider_order_status ?? null }), v.ok ? "order_observed" : "unknown"]);
      await tx(ctx.db, async (t) => {
        const c = await load(t, payoutId);
        if (v.ok && v.obs) {
          await t.query(
            `INSERT INTO provider_orders(payout_id, provider_order_id, provider_status, visible_recipient_masked, visible_inr_paise, visible_usdc_micros) VALUES ($1,$2,$3,$4,$5,$6)`,
            [c.id, v.obs.provider_order_id.trim(), v.obs.provider_order_status, maskVpa(vpa), terms.inrPaise.toString(), v.usdc?.toString() ?? null],
          );
          await releaseLease(t, ctx, c.account_fingerprint, c.id);
          await setState(t, ctx, c, "ORDER_SUBMISSION_OBSERVED", `run ${run.run_id}`);
        } else {
          // Lease stays held: no other payout may run on this account until a human resolves it.
          await setState(t, ctx, c, "OUTCOME_UNKNOWN_REVIEW", v.reasons.join("; ").slice(0, 400));
          await raiseException(t, ctx.env, { kind: v.urgent ? "payout_mismatch_after_submit" : "payout_outcome_unknown", severity: "urgent", ...(c.source_intent_id ? { intentId: c.source_intent_id } : { withdrawalId: c.withdrawal_id }), details: { payoutId: c.id, reasons: v.reasons } });
        }
      });
      return { rerunInMs: 30_000 };
    }
    case "ORDER_SUBMISSION_OBSERVED":
    case "PROVIDER_ACCEPTED":
    case "FIAT_TRANSFER_REPORTED":
    case "PROVIDER_DISPUTED":
      return reconcileStep(ctx, deps, cmd0, terms);
    case "PROVIDER_COMPLETED_VERIFIED":
      return { rerunInMs: await tx(ctx.db, async (t) => await independentlyVerified(t, ctx, cmd0, "delivered") ? (await settle(t, ctx, await load(t, payoutId)), null) : 300_000) };
    case "PROVIDER_CANCELLED":
      return { rerunInMs: await tx(ctx.db, async (t) => await independentlyVerified(t, ctx, cmd0, "cancelled_no_debit") ? (await recover(t, ctx, await load(t, payoutId), "independently verified cancellation without debit"), null) : 300_000) };
    default:
      return { rerunInMs: null }; // terminal / waiting for an operator
  }
}

/** Read-only reconciliation of the recorded provider order (never submits anything). */
async function reconcileStep(ctx: CoreContext, deps: TfDeps, cmd: PayoutCommandRow, terms: ReturnType<typeof cmdTerms>): Promise<Next> {
  const order = await maybeOne<{ provider_order_id: string }>(ctx.db, `SELECT provider_order_id FROM provider_orders WHERE payout_id=$1`, [cmd.id]);
  const a = await latestAttempt(ctx, cmd.id, "reconcile");
  if (!a || a.status === "completed" || a.status === "failed" || a.status === "queue_rejected" || a.status === "queue_error") {
    if (a && ctx.now().getTime() - new Date(a.updated_at).getTime() < 60_000) return { rerunInMs: 60_000 }; // bounded polling cadence
    await startRun(ctx, deps, cmd, "reconcile", buildReconcileGoal({ payoutId: cmd.id, providerOrderId: order?.provider_order_id }), RECONCILE_SCHEMA as unknown as Record<string, unknown>);
    return { rerunInMs: 10_000 };
  }
  if (!a.run_id) return { rerunInMs: 60_000 };
  const run = await deps.port!.get(a.run_id);
  if (run.status === "PENDING" || run.status === "RUNNING") return { rerunInMs: 10_000 };
  const v = run.status === "COMPLETED" ? evaluateReconcile(run.result, terms, order?.provider_order_id ?? null, deps.web!) : ({ kind: "invalid", reasons: [`reconcile run ${run.status}`], urgent: false } as const);
  await ctx.db.query(`UPDATE payout_attempts SET status=$2, observation=$3, outcome=$4, updated_at=now() WHERE id=$1`, [a.id, run.status === "COMPLETED" ? "completed" : "failed", JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), v.kind]);
  await tx(ctx.db, async (t) => {
    const c = await load(t, cmd.id);
    if (v.kind === "invalid") {
      if (v.urgent) {
        await setState(t, ctx, c, "OUTCOME_UNKNOWN_REVIEW", v.reasons.join("; "));
        await raiseException(t, ctx.env, { kind: "payout_reconcile_mismatch", severity: "urgent", ...(c.source_intent_id ? { intentId: c.source_intent_id } : { withdrawalId: c.withdrawal_id }), details: { payoutId: c.id, reasons: v.reasons } });
      }
      return; // non-urgent invalid read: just retry later
    }
    if (v.kind === "not_found") {
      if (c.state !== "OUTCOME_UNKNOWN_REVIEW" && order) {
        await setState(t, ctx, c, "OUTCOME_UNKNOWN_REVIEW", "recorded provider order not found on reconciliation");
        await raiseException(t, ctx.env, { kind: "payout_order_missing", severity: "urgent", ...(c.source_intent_id ? { intentId: c.source_intent_id } : { withdrawalId: c.withdrawal_id }), details: { payoutId: c.id } });
      }
      return;
    }
    if (!order) {
      // Order discovered by reconciliation after an unknown outcome: record it, then continue.
      await t.query(`INSERT INTO provider_orders(payout_id, provider_order_id, provider_status, visible_inr_paise, visible_usdc_micros) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (payout_id) DO NOTHING`, [c.id, v.orderId, v.status, terms.inrPaise.toString(), v.usdc?.toString() ?? null]);
      await releaseLease(t, ctx, c.account_fingerprint, c.id);
    }
    await t.query(`UPDATE provider_orders SET provider_status=$2, visible_usdc_micros=coalesce($3, visible_usdc_micros), provider_reference=nullif($4,''), updated_at=now() WHERE payout_id=$1`, [c.id, v.status, v.usdc?.toString() ?? null, v.reference]);
    const delivered = v.status === "COMPLETED" && await independentlyVerified(t, ctx, c, "delivered");
    const cancelled = v.status === "CANCELLED" && await independentlyVerified(t, ctx, c, "cancelled_no_debit");
    const target: TfPayoutState | null =
      v.status === "ACCEPTED" ? "PROVIDER_ACCEPTED" : v.status === "PAID" || (v.status === "COMPLETED" && !delivered) ? "FIAT_TRANSFER_REPORTED" : delivered ? "PROVIDER_COMPLETED_VERIFIED" : cancelled ? "PROVIDER_CANCELLED" : v.status === "CANCELLED" ? "OUTCOME_UNKNOWN_REVIEW" : v.status === "DISPUTED" ? "PROVIDER_DISPUTED" : v.status === "PLACED" && c.state === "OUTCOME_UNKNOWN_REVIEW" ? "ORDER_SUBMISSION_OBSERVED" : null;
    if (target && target !== c.state && tfPayoutMachine.can(c.state, target)) await setState(t, ctx, c, target, `reconciled via run ${run.run_id}`);
  });
  return { rerunInMs: 30_000 };
}

/** PROVIDER_COMPLETED_VERIFIED → RECONCILED: ledger reflects USDC leaving and the INR obligation settled. */
async function independentlyVerified(t: Tx, ctx: CoreContext, cmd: PayoutCommandRow, outcome: string): Promise<boolean> {
  const vpa = await ctx.envelope.open(cmd.recipient_vpa_ct, `payout_commands:${cmd.id}:vpa`);
  const e = await maybeOne(t, `SELECT 1 FROM payout_settlement_evidence e JOIN provider_orders o ON o.payout_id=e.payout_id AND o.provider_order_id=e.provider_order_id WHERE e.payout_id=$1 AND e.command_hash=$2 AND e.account_fingerprint=$3 AND e.recipient_hash=$4 AND e.inr_paise=$5 AND e.actual_usdc_micros<=$6 AND e.outcome=$7 AND e.verified_at<=now()`, [cmd.id, cmd.command_hash, cmd.account_fingerprint, createHash("sha256").update(vpa.toLowerCase()).digest("hex"), cmd.requested_inr_paise, cmd.max_usdc_debit_micros, outcome]);
  return !!e;
}

async function settle(t: Tx, ctx: CoreContext, cmd: PayoutCommandRow) {
  if (!await independentlyVerified(t, ctx, cmd, "delivered")) throw new DomainError("PAYOUT_EVIDENCE_REQUIRED", "Independent provider, exact debit and bank evidence required");
  if (cmd.environment === "testnet") {
    // TESTNET_LIVE_PAYOUT_DEMO: paid from the operator's own P2P.lol USDC, outside Zeb Scan's books. TAZ has no
    // value, so no INR obligation or USDC treasury asset was ever booked; testnet books stay ZEC-only.
    await setState(t, ctx, cmd, "RECONCILED", "operator-funded testnet demo payout: independent settlement evidence verified");
    return;
  }
  const order = await one<{ actual_usdc_micros: string; provider_order_id: string }>(t, `SELECT actual_usdc_micros, provider_order_id FROM payout_settlement_evidence WHERE payout_id=$1`, [cmd.id]);
  const usdc = BigInt(order.actual_usdc_micros);
  await postJournal(t, ctx.env, {
    eventId: `tf_settle:${cmd.id}`,
    kind: "usdc_settled",
    memo: `P2P web order ${order.provider_order_id} settled (provider-reported, reconciled)`,
    lines: [
      { account: "usdc_settlement_outflow", debit: usdc },
      { account: "base_usdc_asset", credit: usdc },
    ],
  });
  const obligation = cmd.source_intent_id ?? cmd.withdrawal_id!;
  await treasury.setState(t, ctx.env, obligation, "consumed");
  if (cmd.flow === "SCAN_PAY") {
    await postJournal(t, ctx.env, {
      eventId: `payout_complete:${cmd.source_intent_id}`,
      kind: "payout_completed",
      memo: `Scan & Pay ${cmd.source_intent_id} delivered by provider`,
      lines: [
        { account: "payout_pending_to_recipient", debit: BigInt(cmd.requested_inr_paise) },
        { account: "crypto_inventory_valuation", credit: BigInt(cmd.requested_inr_paise) },
      ],
    });
    await setState(t, ctx, cmd, "RECONCILED");
  } else {
    const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [cmd.withdrawal_id]);
    await finalizeWithdrawal(t, ctx, w);
    await setState(t, ctx, cmd, "RECONCILED");
  }
}

/** Provider cancelled / verified-never-submitted: restore value exactly once. */
async function recover(t: Tx, ctx: CoreContext, cmd: PayoutCommandRow, reason: string) {
  const c = await setState(t, ctx, cmd, "PAYOUT_FAILED_RECOVERY", reason);
  await releaseLease(t, ctx, c.account_fingerprint, c.id);
  if (c.flow === "MERCHANT_WITHDRAWAL") {
    const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [c.withdrawal_id]);
    if (w.status !== "failed_recoverable") {
      if (withdrawalMachine.can(w.status, "failed_recoverable")) await t.query(`UPDATE withdrawals SET status='failed_recoverable', version=version+1 WHERE id=$1`, [w.id]);
    }
    const fresh = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1`, [w.id]);
    if (fresh.status === "failed_recoverable") await restoreWithdrawal(t, ctx, fresh, reason);
  } else {
    // Scan & Pay: the ZEC is held as a refund liability; refunds need the isolated spend-capable wallet.
    await setState(t, ctx, c, "REFUND_PENDING", "refund requires the isolated spend-capable Zcash wallet and operator approval");
    await raiseException(t, ctx.env, { kind: "scan_pay_refund_required", severity: "urgent", intentId: c.source_intent_id, details: { payoutId: c.id } });
  }
}

/* ================================================================== operator actions */

export async function approvePayout(ctx: CoreContext, payoutId: string, operatorId: string, expectedHash: string): Promise<void> {
  await tx(ctx.db, async (t) => {
    const c = await load(t, payoutId);
    if (c.environment !== ctx.env) throw new DomainError("SYSTEM_ENVIRONMENT_MISMATCH", "wrong environment", undefined, { status: 409 });
    if (c.state !== "OPERATOR_APPROVAL_REQUIRED") throw new DomainError("STATE_NOT_AWAITING_APPROVAL", `payout is ${c.state}`, undefined, { status: 409, currentStatus: c.state });
    if (c.command_hash !== expectedHash) throw new DomainError("STATE_COMMAND_CHANGED", "the payout terms differ from what was reviewed", undefined, { status: 409 });
    if (c.held) throw new DomainError("STATE_HELD", "payout is on hold", undefined, { status: 409 });
    await t.query(`UPDATE payout_commands SET approved_by=$2, approved_at=now(), approval_expires_at=now() + ($3 || ' seconds')::interval, updated_at=now() WHERE id=$1`, [payoutId, operatorId, String(ctx.cfg.pilot.approvalTtlSec)]);
    await enqueueJob(t, ctx.env, "tfpayout.advance", payoutId, { id: payoutId });
    await audit(t, ctx.env, { actorType: "operator", actorId: operatorId, action: "payout.approve", target: payoutId, details: { commandHash: c.command_hash } });
  });
}

export async function holdPayout(ctx: CoreContext, payoutId: string, operatorId: string, reason: string): Promise<void> {
  await ctx.db.query(`UPDATE payout_commands SET held=true, hold_reason=$2, updated_at=now() WHERE id=$1 AND environment=$3`, [payoutId, reason.slice(0, 300), ctx.env]);
  await audit(ctx.db, ctx.env, { actorType: "operator", actorId: operatorId, action: "payout.hold", target: payoutId, details: { reason } });
}

/** Operator-requested read-only reconciliation (no new payment is ever started). */
export async function requestReconcile(ctx: CoreContext, deps: TfDeps, payoutId: string, operatorId: string): Promise<Next> {
  const c = await maybeOne<PayoutCommandRow>(ctx.db, `SELECT * FROM payout_commands WHERE id=$1 AND environment=$2`, [payoutId, ctx.env]);
  if (!c) throw new DomainError("NOT_FOUND", "payout not found", undefined, { status: 404 });
  await audit(ctx.db, ctx.env, { actorType: "operator", actorId: operatorId, action: "payout.reconcile", target: payoutId });
  const vpa = await ctx.envelope.open(c.recipient_vpa_ct, `payout_commands:${c.id}:vpa`);
  return reconcileStep(ctx, deps, c, cmdTerms(ctx, c, vpa));
}

/** Dual-control decision after reconciliation proves no order exists: the slot may be retried. */
export async function markVerifiedNotSubmitted(ctx: CoreContext, payoutId: string, approvalId: string): Promise<void> {
  if(ctx.env!=='demo') throw new DomainError('FEATURE_UNAVAILABLE','Retry requires independently verified non-submission and no-debit evidence; browser absence is insufficient',undefined,{status:409});
  await tx(ctx.db, async (t) => {
    const c = await load(t, payoutId);
    const rec = await maybeOne<{ outcome: string | null }>(t, `SELECT outcome FROM payout_attempts WHERE payout_id=$1 AND kind='reconcile' ORDER BY created_at DESC LIMIT 1`, [payoutId]);
    if (rec?.outcome !== "not_found") throw new DomainError("STATE_RECONCILE_REQUIRED", "a read-only reconciliation reporting no order is required first", undefined, { status: 409 });
    await t.query(`UPDATE payout_attempts SET outcome='verified_not_submitted', updated_at=now() WHERE payout_id=$1 AND kind='execute'`, [payoutId]);
    await releaseLease(t, ctx, c.account_fingerprint, c.id);
    await setState(t, ctx, c, "AGENT_FAILED_BEFORE_COMMIT", `operator-verified not submitted (${approvalId})`);
    await audit(t, ctx.env, { actorType: "operator", action: "payout.verified_not_submitted", target: payoutId, details: { approvalId } });
  });
}

export async function listPayoutCommands(ctx: CoreContext, limit = 50) {
  return many(ctx.db, `SELECT id, flow, mode, recipient_vpa_masked, requested_inr_paise, max_usdc_debit_micros, state, state_reason, held, command_hash, approved_by, created_at, updated_at FROM payout_commands WHERE environment=$1 ORDER BY created_at DESC LIMIT $2`, [ctx.env, limit]);
}
