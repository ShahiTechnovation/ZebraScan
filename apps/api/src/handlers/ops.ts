/**
 * Operator endpoints (operator realm + MFA). Pausing is single-operator (safe direction);
 * resuming and exception decisions that move money require a second operator (dual control).
 */
import { many, maybeOne, one, tx } from "@zeb/db";
import { DomainError, newId, notFound } from "@zeb/domain";
import { audit, enqueueJob, readiness, restoreWithdrawal, transitionIntent, lockIntent, type WithdrawalRow } from "@zeb/core";
import { accountBalance, treasury } from "@zeb/ledger";
import { canonicalJson, sha256Hex } from "@zeb/security";
import type { Handler, Req, AnyReq } from "../http";
import { decodeCursor, encodeCursor } from "./paging";

const FEATURES = ["all", "scanPay", "terminal", "paymentLinks", "withdrawals"];

export const opsHealth: Handler = async (req) => {
  const r = await readiness(req.ctx, { fresh: true });
  const scanner = await maybeOne(req.ctx.db, `SELECT network, tip_height, scanned_height, status, ironwood_supported, nu7_active, gateway_version, last_error, updated_at FROM scanner_state WHERE environment=$1`, [req.ctx.env]);
  const jobs = await many<{ state: string; n: string }>(req.ctx.db, `SELECT state, count(*) AS n FROM jobs WHERE environment=$1 GROUP BY state`, [req.ctx.env]);
  return { environment: req.ctx.env, readiness: r, scanner, jobs: Object.fromEntries(jobs.map((j) => [j.state, Number(j.n)])), p2pConfigError: req.ctx.p2pConfigError };
};

export const opsTreasury: Handler = async (req) => {
  const { ctx } = req;
  const cap = await treasury.treasuryCapacity(ctx.db, ctx.env, { inventoryMaxAgeMs: ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000, bufferMicros: ctx.cfg.policy.treasuryBufferMicros }, ctx.now());
  const states = await many<{ state: string; total: string }>(ctx.db, `SELECT state, sum(amount_micros) AS total FROM treasury_allocations WHERE environment=$1 AND state IN ('held','in_flight') GROUP BY state`, [ctx.env]);
  const pendingZec = await one<{ total: string | null }>(ctx.db, `SELECT sum(value_zatoshis) AS total FROM deposit_observations WHERE environment=$1 AND canonical AND NOT accepted`, [ctx.env]);
  const queue = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM jobs WHERE environment=$1 AND kind='payout.advance' AND state IN ('queued','running','failed')`, [ctx.env]);
  const merchantLiab =
    (await accountBalance(ctx.db, ctx.env, "merchant_credits_locked")) + (await accountBalance(ctx.db, ctx.env, "merchant_credits_available")) + (await accountBalance(ctx.db, ctx.env, "merchant_credits_withdrawal_reserved"));
  const r = await readiness(ctx);
  return {
    at: ctx.now().toISOString(),
    environment: ctx.env,
    zecVaultZatoshis: (await accountBalance(ctx.db, ctx.env, "zcash_asset")).toString(),
    zecPendingZatoshis: pendingZec.total ?? "0",
    usdcInventoryMicros: cap.inventoryMicros.toString(),
    usdcInventoryObservedAt: cap.inventoryObservedAt ? new Date(cap.inventoryObservedAt).toISOString() : null,
    usdcHeldMicros: states.find((s) => s.state === "held")?.total ?? "0",
    usdcInFlightMicros: states.find((s) => s.state === "in_flight")?.total ?? "0",
    usdcFreeMicros: cap.freeMicros.toString(),
    merchantLiabilityInrPaise: merchantLiab.toString(),
    payoutLiabilityInrPaise: (await accountBalance(ctx.db, ctx.env, "payout_pending_to_recipient")).toString(),
    payoutQueue: Number(queue.n),
    stale: cap.stale,
    providerStatus: { priceFeed: r.priceFeed.reason ?? "ok", p2p: r.p2p.reason ?? "ok", scanner: r.scanner.reason ?? "ok", signer: r.signer.reason ?? "ok" },
  };
};

function pager(table: string, cols: string, extra = "") {
  return (async (req: Req<object, { cursor?: string; limit: number }>) => {
    const c = decodeCursor(req.query.cursor);
    const rows = await many<Record<string, unknown> & { created_at: Date; id: string }>(
      req.ctx.db,
      `SELECT ${cols}, created_at, id::text AS id FROM ${table} WHERE environment=$1 ${extra} AND ($2::timestamptz IS NULL OR (created_at, id::text) < ($2, $3)) ORDER BY created_at DESC, id DESC LIMIT $4`,
      [req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
    );
    const page = rows.slice(0, req.query.limit);
    return { items: page, nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, String(page.at(-1)!.id)) : null };
  }) as Handler;
}

export const opsReconciliation = (async (req: Req<object, { cursor?: string; limit: number }>) => {
  const rows = await many(req.ctx.db, `SELECT id, kind, started_at AS created_at, finished_at, ok, result FROM reconciliation_runs WHERE environment=$1 ORDER BY started_at DESC LIMIT $2`, [req.ctx.env, req.query.limit]);
  return { items: rows, nextCursor: null };
}) as Handler;
export const opsJobs = pager("jobs", "kind, dedupe_key, state, attempts, run_at, last_error");
export const opsExceptions = pager("exceptions", "kind, severity, intent_id, withdrawal_id, order_id, details, status, decision", "AND status='open'");
export const opsAudit = pager("audit_log", "actor_type, actor_id, action, target, details, request_id");

async function setGate(req: AnyReq, feature: string, enabled: boolean, reason: string) {
  if (!FEATURES.includes(feature)) throw new DomainError("VALIDATION_FEATURE", `feature must be one of ${FEATURES.join(", ")}`);
  await req.ctx.db.query(
    `INSERT INTO feature_gates(environment, feature, enabled, reason, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (environment, feature) DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [req.ctx.env, feature, enabled, reason, req.principal!.userId],
  );
}

export const opsPause: Handler = async (req: Req<object, object, { reason: string; feature?: string }>) => {
  await setGate(req, req.body.feature ?? "all", false, req.body.reason);
  await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: req.principal!.userId, action: "ops.pause", target: req.body.feature ?? "all", details: { reason: req.body.reason }, requestId: req.requestId });
  return { ok: true };
};

/** Dual control: first call creates a pending approval; a DIFFERENT operator approves; then the action executes with approvalId. */
export async function dualControl(req: AnyReq, action: string, target: string, payload: Record<string, unknown>, approvalId: string | undefined, exec: () => Promise<void>) {
  const hash = sha256Hex(canonicalJson({ action, target, payload }));
  if (!approvalId) {
    const id = newId("approval");
    await req.ctx.db.query(
      `INSERT INTO ops_approvals(id, environment, action, target, payload, payload_hash, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '1 hour')`,
      [id, req.ctx.env, action, target, JSON.stringify(payload), hash, req.principal!.userId],
    );
    await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: req.principal!.userId, action: `${action}.requested`, target, details: payload, requestId: req.requestId });
    return { status: "pending_approval" as const, approvalId: id };
  }
  await tx(req.ctx.db, async (t) => {
    const a = await maybeOne<{ status: string; payload_hash: string; expires_at: Date; approved_by: string | null }>(t, `SELECT status, payload_hash, expires_at, approved_by FROM ops_approvals WHERE id=$1 AND environment=$2 FOR UPDATE`, [approvalId, req.ctx.env]);
    if (!a) throw notFound("approval");
    if (a.payload_hash !== hash) throw new DomainError("STATE_APPROVAL_MISMATCH", "Approval does not match this action", undefined, { status: 409 });
    if (a.status !== "approved" || !a.approved_by) throw new DomainError("STATE_APPROVAL_PENDING", "A second operator must approve first", undefined, { status: 409, currentStatus: a.status });
    if (new Date(a.expires_at) < req.ctx.now()) throw new DomainError("STATE_APPROVAL_EXPIRED", "Approval expired", undefined, { status: 409 });
    await t.query(`UPDATE ops_approvals SET status='executed' WHERE id=$1`, [approvalId]);
  });
  await exec();
  await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: req.principal!.userId, action: `${action}.executed`, target, details: { approvalId }, requestId: req.requestId });
  return { status: "executed" as const, approvalId };
}

export const opsResume: Handler = async (req: Req<object, object, { reason: string; feature?: string; approvalId?: string }>) => {
  const feature = req.body.feature ?? "all";
  return dualControl(req, "ops.resume", feature, { feature, reason: req.body.reason }, req.body.approvalId, () => setGate(req, feature, true, req.body.reason));
};

export const opsApprove: Handler = async (req: Req<{ id: string }>) => {
  const r = await req.ctx.db.query(
    `UPDATE ops_approvals SET status='approved', approved_by=$3, decided_at=now() WHERE id=$1 AND environment=$2 AND status='pending' AND requested_by <> $3 AND expires_at > now()`,
    [req.params.id, req.ctx.env, req.principal!.userId],
  );
  if (r.rowCount !== 1) throw new DomainError("STATE_APPROVAL_INVALID", "Approval not found, expired, already decided, or you requested it yourself", undefined, { status: 409 });
  await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: req.principal!.userId, action: "ops.approve", target: req.params.id, requestId: req.requestId });
  return { ok: true };
};

export const opsRetryJob: Handler = async (req: Req<{ id: string }, object, { reason: string }>) => {
  const r = await req.ctx.db.query(`UPDATE jobs SET state='queued', attempts=0, run_at=now(), last_error=NULL, updated_at=now() WHERE id=$1 AND environment=$2 AND state IN ('dead','failed')`, [req.params.id, req.ctx.env]);
  if (r.rowCount !== 1) throw new DomainError("STATE_JOB_NOT_RETRYABLE", "Job not found or not in a retryable state", undefined, { status: 409 });
  await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: req.principal!.userId, action: "ops.job_retry", target: req.params.id, details: { reason: req.body.reason }, requestId: req.requestId });
  return { ok: true };
};

export const opsDecideException: Handler = async (req: Req<{ id: string }, object, { decision: string; reason: string; approvalId?: string }>) => {
  const { ctx } = req;
  const e = await maybeOne<{ id: string; intent_id: string | null; withdrawal_id: string | null; status: string }>(ctx.db, `SELECT id, intent_id, withdrawal_id, status FROM exceptions WHERE id=$1 AND environment=$2`, [req.params.id, ctx.env]);
  if (!e || e.status !== "open") throw notFound("open exception", req.params.id);
  const execute = async () => {
    await tx(ctx.db, async (t) => {
      if (req.body.decision === "retry_payout") {
        if (e.intent_id) {
          await t.query(`UPDATE payment_intents SET payout_status='payout_queued', updated_at=now() WHERE id=$1 AND payout_status IN ('not_liquid','provider_failed','cancelled','provider_timeout','manual_review')`, [e.intent_id]);
          await enqueueJob(t, ctx.env, "payout.advance", `scan_pay:${e.intent_id}`, { kind: "scan_pay", id: e.intent_id });
        } else if (e.withdrawal_id) {
          await t.query(`UPDATE withdrawals SET status='awaiting_provider', version=version+1, updated_at=now() WHERE id=$1 AND status IN ('failed_recoverable','manual_review')`, [e.withdrawal_id]);
          await enqueueJob(t, ctx.env, "payout.advance", `withdrawal:${e.withdrawal_id}`, { kind: "withdrawal", id: e.withdrawal_id });
        }
      } else if (req.body.decision === "queue_refund" && e.intent_id) {
        const i = await lockIntent(t, ctx, e.intent_id);
        if (i.mode === "scan_pay" && i.status === "deposit_accepted") await t.query(`UPDATE payment_intents SET payout_status='refund_queued' WHERE id=$1`, [i.id]);
        else await transitionIntent(t, ctx, i, "refund_queued", { label: "Refund queued", detail: "An operator approved a refund. Refunds are sent by the isolated treasury signer after review." });
      } else if (req.body.decision === "reject" && e.withdrawal_id) {
        const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [e.withdrawal_id]);
        const inFlight = await maybeOne(t, `SELECT 1 FROM p2p_orders WHERE withdrawal_id=$1 AND status NOT IN ('cancelled_final','failed_final') AND place_tx_hash IS NOT NULL`, [w.id]);
        if (inFlight) throw new DomainError("STATE_ORDER_IN_FLIGHT", "An on-chain order may still be live; cannot restore credits", undefined, { status: 409 });
        await restoreWithdrawal(t, ctx, w, `operator decision: ${req.body.reason}`);
      } else if (req.body.decision === "reject" && e.intent_id) {
        const i = await lockIntent(t, ctx, e.intent_id);
        await transitionIntent(t, ctx, i, "rejected", { label: "Rejected after review", detail: req.body.reason });
      }
      await t.query(`UPDATE exceptions SET status='decided', decision=$2, decided_by=$3, approval_id=$4, decided_at=now() WHERE id=$1`, [e.id, req.body.decision, req.principal!.userId, req.body.approvalId ?? null]);
    });
  };
  if (req.body.decision === "close") {
    await execute();
    return { status: "executed" as const, approvalId: "" };
  }
  return dualControl(req, "ops.decide_exception", e.id, { decision: req.body.decision, reason: req.body.reason }, req.body.approvalId, execute);
};
