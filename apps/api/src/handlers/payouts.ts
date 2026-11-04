/** P2P web-automation payout endpoints (operator realm) + sanitized public readiness. */
import { many, maybeOne } from "@zeb/db";
import { DomainError, notFound } from "@zeb/domain";
import { approvePayout, enqueueJob, holdPayout, listPayoutCommands, markVerifiedNotSubmitted, payoutReadiness, requestReconcile, type TfDeps } from "@zeb/core";
import type { AnyReq, Handler } from "../http";
import { dualControl } from "./ops";

let deps: TfDeps = { port: null, web: null };
export function setTfDeps(d: TfDeps) {
  deps = d;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
type Row = { id: string; flow: "SCAN_PAY"; mode: string; recipient_vpa_masked: string; requested_inr_paise: string; max_usdc_debit_micros: string; state: string; state_reason: string | null; held: boolean; command_hash: string; approved_by: string | null; created_at: Date; updated_at: Date };
const dto = (r: Row) => ({
  id: r.id,
  flow: r.flow,
  mode: r.mode,
  recipientVpaMasked: r.recipient_vpa_masked,
  requestedInrPaise: r.requested_inr_paise,
  maxUsdcDebitMicros: r.max_usdc_debit_micros,
  state: r.state,
  stateReason: r.state_reason,
  held: r.held,
  commandHash: r.command_hash,
  approvedBy: r.approved_by,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export const getP2PReadiness: Handler = async (req) => payoutReadiness(req.ctx, deps);

export const adminP2PPreflight: Handler = async (req) => {
  // Read-only probe runs in the worker (never tied to this HTTP request's lifetime).
  await enqueueJob(req.ctx.db, req.ctx.env, "p2p.preflight", `manual:${Date.now()}`, { requestedBy: req.principal!.userId });
  return { queued: true as const };
};

export const adminP2PCapabilities: Handler = async (req) => {
  const rows = await many<{ id: string; status: "PASS"; reasons: string[]; run_id: string | null; observed_url: string | null; account_fingerprint: string | null; created_at: Date }>(
    req.ctx.db,
    `SELECT id, status, reasons, run_id, observed_url, account_fingerprint, created_at FROM p2p_capability_reports WHERE environment=$1 ORDER BY created_at DESC LIMIT 20`,
    [req.ctx.env],
  );
  return {
    items: rows.map((r) => ({ id: r.id, status: r.status, reasons: r.reasons, runId: r.run_id, observedUrl: r.observed_url, accountFingerprint: r.account_fingerprint, createdAt: iso(r.created_at)! })),
    readiness: await payoutReadiness(req.ctx, deps),
  };
};

export const adminListPayouts: Handler = async (req) => ({ items: ((await listPayoutCommands(req.ctx)) as Row[]).map(dto) });

export const adminGetPayout: Handler = async (req: AnyReq) => {
  const r = await maybeOne<Row>(req.ctx.db, `SELECT * FROM payout_commands WHERE id=$1 AND environment=$2`, [req.params.id, req.ctx.env]);
  if (!r) throw notFound("payout", req.params.id);
  const attempts = await many<{ id: string; kind: string; run_id: string | null; status: string; outcome: string | null; created_at: Date }>(req.ctx.db, `SELECT id, kind, run_id, status, outcome, created_at FROM payout_attempts WHERE payout_id=$1 ORDER BY created_at`, [r.id]);
  const order = await maybeOne<{ provider_order_id: string; provider_status: string; verified_at: Date | null }>(req.ctx.db, `SELECT provider_order_id, provider_status, verified_at FROM provider_orders WHERE payout_id=$1`, [r.id]);
  return {
    ...dto(r),
    attempts: attempts.map((a) => ({ id: a.id, kind: a.kind, runId: a.run_id, status: a.status, outcome: a.outcome, createdAt: iso(a.created_at)! })),
    providerOrder: order ? { providerOrderId: order.provider_order_id, providerStatus: order.provider_status, verifiedAt: iso(order.verified_at) } : null,
  };
};

export const adminApprovePayout: Handler = async (req: AnyReq) => {
  await approvePayout(req.ctx, req.params.id, req.principal!.userId, (req.body as { commandHash: string }).commandHash);
  return { ok: true };
};

export const adminReconcilePayout: Handler = async (req: AnyReq) => {
  if (!deps.port || !deps.web) throw new DomainError("FEATURE_UNAVAILABLE", "TinyFish rail not configured", undefined, { status: 422 });
  await requestReconcile(req.ctx, deps, req.params.id, req.principal!.userId);
  return { ok: true };
};

export const adminHoldPayout: Handler = async (req: AnyReq) => {
  await holdPayout(req.ctx, req.params.id, req.principal!.userId, (req.body as { reason: string }).reason);
  return { ok: true };
};

export const adminPayoutNotSubmitted: Handler = async (req: AnyReq) => {
  const b = req.body as { reason: string; approvalId?: string };
  return dualControl(req, "payout.verified_not_submitted", req.params.id, { reason: b.reason }, b.approvalId, () => markVerifiedNotSubmitted(req.ctx, req.params.id, b.approvalId!));
};
