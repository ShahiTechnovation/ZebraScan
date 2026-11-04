/**
 * Operator tooling for payout commands (scripts/payout-approve.ts). Nothing here moves money by itself:
 *  - listing is read-only (terms are decrypted for the operator's terminal and the hash is recomputed);
 *  - approval records an operator decision bound to the exact commandHash (approvePayout, TTL);
 *  - advancing runs one pass of the strict state machine under the SAME per-payout job lease the
 *    worker uses, so a CLI and a worker can never advance the same payout concurrently.
 *
 * TESTNET_LIVE_PAYOUT_DEMO framing: INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the
 * testnet payment only authorizes it. TAZ has no value.
 */
import { many, maybeOne, one } from "@zeb/db";
import { DomainError } from "@zeb/domain";
import { formatInrPaise, formatUsdcMicros, usdcInputText } from "@zeb/providers";
import type { CoreContext } from "./context";
import { enqueueJob } from "./events";
import { runJob, type JobRow } from "./jobs";
import { advanceTfPayout, approvePayout, commandHash, holdPayout, railReady, testnetLiveDemo, type PayoutCommandRow, type TfDeps } from "./tfpayouts";

export interface PayoutTermsView {
  id: string;
  environment: string;
  flow: string;
  mode: string;
  state: string;
  stateReason: string | null;
  held: boolean;
  holdReason: string | null;
  approvable: boolean;
  recipientVpa: string;
  recipientVpaMasked: string;
  inr: string;
  inrPaise: string;
  maxUsdc: string;
  maxUsdcDebitMicros: string;
  /** Testnet live demo: exact USDC amount the app.p2p.lol SELL enters ("offramp-amount"). */
  sellUsdc: string | null;
  /** Minimum provider-displayed INR payout accepted (authorized INR minus the command variance). */
  minInr: string;
  commandHash: string;
  hashVerified: boolean;
  checkoutId: string | null;
  withdrawalId: string | null;
  authorizationId: string;
  approvedBy: string | null;
  approvalExpiresAt: string | null;
  createdAt: string;
  attempts: Array<{ kind: string; status: string; outcome: string | null; runId: string | null; createdAt: string }>;
  providerOrder: { id: string; status: string } | null;
}

export interface PayoutPolicyView {
  environment: string;
  liveDemo: boolean;
  livePayoutsEnabled: boolean;
  perOrderCapInr: string;
  dailyCapUsdc: string;
  usedLast24hUsdc: string;
  approvalTtlSec: number;
  legalApprovalRef: boolean;
  providerApprovalRef: boolean;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export async function describePayoutCommand(ctx: CoreContext, payoutId: string): Promise<PayoutTermsView | null> {
  const c = await maybeOne<PayoutCommandRow & { hold_reason: string | null }>(ctx.db, `SELECT * FROM payout_commands WHERE id=$1 AND environment=$2`, [payoutId, ctx.env]);
  return c ? view(ctx, c) : null;
}

async function view(ctx: CoreContext, c: PayoutCommandRow & { hold_reason: string | null }): Promise<PayoutTermsView> {
  const vpa = await ctx.envelope.open(c.recipient_vpa_ct, `payout_commands:${c.id}:vpa`);
  const inr = BigInt(c.requested_inr_paise);
  const max = BigInt(c.max_usdc_debit_micros);
  const variance = BigInt(c.max_fiat_variance_paise);
  const recomputed = commandHash({ flow: c.flow, vpa, inrPaise: inr, maxUsdc: max, variance, authorizationId: c.authorization_id, quoteId: c.quote_id, environment: c.environment });
  const attempts = await many<{ kind: string; status: string; outcome: string | null; run_id: string | null; created_at: Date }>(ctx.db, `SELECT kind, status, outcome, run_id, created_at FROM payout_attempts WHERE payout_id=$1 ORDER BY created_at`, [c.id]);
  const order = await maybeOne<{ provider_order_id: string; provider_status: string }>(ctx.db, `SELECT provider_order_id, provider_status FROM provider_orders WHERE payout_id=$1`, [c.id]);
  return {
    id: c.id,
    environment: c.environment,
    flow: c.flow,
    mode: c.mode,
    state: c.state,
    stateReason: c.state_reason,
    held: c.held,
    holdReason: c.hold_reason,
    approvable: c.state === "OPERATOR_APPROVAL_REQUIRED" && !c.held && recomputed === c.command_hash,
    recipientVpa: vpa,
    recipientVpaMasked: c.recipient_vpa_masked,
    inr: formatInrPaise(inr),
    inrPaise: c.requested_inr_paise.toString(),
    maxUsdc: formatUsdcMicros(max),
    maxUsdcDebitMicros: c.max_usdc_debit_micros.toString(),
    sellUsdc: c.environment === "testnet" ? usdcInputText(max) : null,
    minInr: formatInrPaise(inr - variance),
    commandHash: c.command_hash,
    hashVerified: recomputed === c.command_hash,
    checkoutId: c.source_intent_id,
    withdrawalId: c.withdrawal_id,
    authorizationId: c.authorization_id,
    approvedBy: c.approved_by,
    approvalExpiresAt: iso(c.approval_expires_at),
    createdAt: iso(c.created_at)!,
    attempts: attempts.map((a) => ({ kind: a.kind, status: a.status, outcome: a.outcome, runId: a.run_id, createdAt: iso(a.created_at)! })),
    providerOrder: order ? { id: order.provider_order_id, status: order.provider_status } : null,
  };
}

/** Non-terminal payout commands, newest first (read-only). */
export async function listPendingPayoutCommands(ctx: CoreContext, limit = 25): Promise<PayoutTermsView[]> {
  const rows = await many<PayoutCommandRow & { hold_reason: string | null }>(
    ctx.db,
    `SELECT * FROM payout_commands WHERE environment=$1 AND state NOT IN ('RECONCILED','REFUNDED') ORDER BY created_at DESC LIMIT $2`,
    [ctx.env, limit],
  );
  return Promise.all(rows.map((r) => view(ctx, r)));
}

export async function payoutPolicyView(ctx: CoreContext): Promise<PayoutPolicyView> {
  const day = await one<{ total: string | null }>(ctx.db, `SELECT sum(max_usdc_debit_micros) AS total FROM payout_commands WHERE environment=$1 AND created_at > now() - interval '1 day' AND state NOT IN ('PREFLIGHT_BLOCKED','EXPIRED','USER_ABORTED','REFUNDED')`, [ctx.env]);
  const p = ctx.cfg.pilot;
  return {
    environment: ctx.env,
    liveDemo: testnetLiveDemo(ctx),
    livePayoutsEnabled: p.livePayoutsEnabled,
    perOrderCapInr: formatInrPaise(p.maxPayoutInrPaise),
    dailyCapUsdc: formatUsdcMicros(p.dailyMaxUsdcMicros),
    usedLast24hUsdc: formatUsdcMicros(BigInt(day.total ?? "0")),
    approvalTtlSec: p.approvalTtlSec,
    legalApprovalRef: !!ctx.cfg.approvals.legal,
    providerApprovalRef: !!ctx.cfg.approvals.provider,
  };
}

const OPERATOR_RE = /^[A-Za-z0-9._@-]{2,64}$/;

/** Approve exactly one command: refused unless the stored terms reproduce the hash AND it equals the reviewed hash. */
export async function approvePayoutAsOperator(ctx: CoreContext, payoutId: string, expectedHash: string, operator: string): Promise<PayoutTermsView> {
  if (!OPERATOR_RE.test(operator)) throw new DomainError("VALIDATION_OPERATOR", "operator name must be 2-64 characters of [A-Za-z0-9._@-]");
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new DomainError("VALIDATION_HASH", "commandHash must be the 64-hex value shown by the listing");
  const before = await describePayoutCommand(ctx, payoutId);
  if (!before) throw new DomainError("NOT_FOUND", `payout ${payoutId} not found in ${ctx.env}`, undefined, { status: 404 });
  if (!before.hashVerified) throw new DomainError("STATE_COMMAND_CHANGED", "stored payout terms do not reproduce the command hash; refusing to approve", undefined, { status: 409 });
  if (before.commandHash !== expectedHash) throw new DomainError("STATE_COMMAND_CHANGED", "the payout terms differ from what was reviewed (command hash mismatch)", undefined, { status: 409 });
  await approvePayout(ctx, payoutId, `cli:${operator}`, expectedHash);
  return (await describePayoutCommand(ctx, payoutId))!;
}

/** Emergency stop (safe direction): the command is held and nothing else runs for it. */
export async function holdPayoutAsOperator(ctx: CoreContext, payoutId: string, operator: string, reason: string): Promise<void> {
  if (!OPERATOR_RE.test(operator)) throw new DomainError("VALIDATION_OPERATOR", "operator name must be 2-64 characters of [A-Za-z0-9._@-]");
  await holdPayout(ctx, payoutId, `cli:${operator}`, reason || "operator hold (CLI)");
}

export interface AdvanceOutcome {
  /** False when the worker currently holds this payout's job lease (nothing was run). */
  claimed: boolean;
  steps: Array<{ state: string; rerunInMs: number | null }>;
  error: string | null;
}

/**
 * One advance pass under the payout's job lease: advanceTfPayout is called once, and again only while
 * the state machine asks for an immediate continuation (rerunInMs === 0, e.g. approved → QUEUED →
 * execute). A step that waits on TinyFish or an operator ends the pass; the job is left queued for
 * the worker exactly like runJob would. Refuses to run without a configured rail, because an advance
 * without one records a rail-unavailable exception against the source payment.
 */
export async function advancePayoutAsOperator(ctx: CoreContext, deps: TfDeps, payoutId: string, owner: string, maxSteps = 5): Promise<AdvanceOutcome> {
  const exists = await maybeOne(ctx.db, `SELECT 1 FROM payout_commands WHERE id=$1 AND environment=$2`, [payoutId, ctx.env]);
  if (!exists) throw new DomainError("NOT_FOUND", `payout ${payoutId} not found in ${ctx.env}`, undefined, { status: 404 });
  const rail = railReady(ctx, deps);
  if (rail) return { claimed: false, steps: [], error: `payout rail not ready: ${rail} (nothing was advanced)` };
  const steps: AdvanceOutcome["steps"] = [];
  for (let i = 0; i < maxSteps; i++) {
    await enqueueJob(ctx.db, ctx.env, "tfpayout.advance", payoutId, { id: payoutId }); // keeps an existing active job row
    const claimed = await ctx.db.query<JobRow>(
      `UPDATE jobs SET state='running', lease_owner=$3, lease_expires_at=now() + interval '10 minutes', attempts=attempts+1, updated_at=now()
        WHERE id = (SELECT id FROM jobs WHERE environment=$1 AND kind='tfpayout.advance' AND dedupe_key=$2
                     AND (state IN ('queued','failed') OR (state='running' AND lease_expires_at < now()))
                     ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, dedupe_key, payload, attempts, max_attempts`,
      [ctx.env, payoutId, owner],
    );
    const job = claimed.rows[0];
    if (!job) return { claimed: steps.length > 0, steps, error: steps.length ? null : "the worker is advancing this payout right now (job lease held); nothing was run" };
    const out: { next: { rerunInMs: number | null } | null } = { next: null };
    await runJob(ctx, { "tfpayout.advance": async (c) => (out.next = await advanceTfPayout(c, deps, payoutId)) }, job, owner);
    const st = await one<{ state: string }>(ctx.db, `SELECT state FROM payout_commands WHERE id=$1`, [payoutId]);
    if (!out.next) {
      const j = await maybeOne<{ last_error: string | null }>(ctx.db, `SELECT last_error FROM jobs WHERE id=$1`, [job.id]);
      return { claimed: true, steps: [...steps, { state: st.state, rerunInMs: null }], error: j?.last_error ?? "advance failed" };
    }
    steps.push({ state: st.state, rerunInMs: out.next.rerunInMs });
    if (out.next.rerunInMs !== 0) break;
  }
  return { claimed: true, steps, error: null };
}
