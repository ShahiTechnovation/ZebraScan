import { many, maybeOne } from "@zeb/db";
import { DomainError, newId, notFound } from "@zeb/domain";
import { audit, receiptView } from "@zeb/core";
import { canonicalJson, hmacHex } from "@zeb/security";
import { checkoutAccess, type Handler, type Req, type AnyReq } from "../http";
import { decodeCursor, encodeCursor } from "./paging";

async function scopedReceipt(req: AnyReq) {
  const r = await receiptView(req.ctx.db, req.ctx, req.params.id);
  const { _scope, ...view } = r;
  if (_scope.merchantId && req.principal?.merchant?.id === _scope.merchantId) return view;
  if (_scope.intentId) {
    await checkoutAccess(req, _scope.intentId); // throws 404 when not allowed
    return view;
  }
  throw notFound("receipt", req.params.id);
}

export const getReceipt: Handler = async (req: Req<{ id: string }>) => scopedReceipt(req);

export const downloadReceipt: Handler = async (req: Req<{ id: string }>) => {
  const receipt = await scopedReceipt(req);
  const signedAt = req.ctx.now().toISOString();
  return { receipt, signedAt, algorithm: "HMAC-SHA256" as const, signature: hmacHex(req.ctx.cfg.tokenSecret, `receipt-download:${signedAt}:${canonicalJson(receipt)}`) };
};

export const createSupportCase: Handler = async (req: Req<object, object, { category: string; reason: string; checkoutId?: string; withdrawalId?: string }>) => {
  const { ctx, body } = req;
  let merchantId: string | null = null;
  let openedByType: "merchant_user" | "payer_session" = "merchant_user";
  let openedBy: string;
  if (body.checkoutId) {
    const who = await checkoutAccess(req, body.checkoutId);
    const i = await maybeOne<{ merchant_id: string | null }>(ctx.db, `SELECT merchant_id FROM payment_intents WHERE id=$1`, [body.checkoutId]);
    merchantId = i?.merchant_id ?? null;
    openedByType = who === "payer" ? "payer_session" : "merchant_user";
    openedBy = who === "payer" ? `anon:${req.anonId}` : req.principal!.userId;
  } else {
    if (!req.principal?.merchant) throw new DomainError("AUTH_REQUIRED", "Sign in, or open the case from your checkout page", undefined, { status: 401 });
    merchantId = req.principal.merchant.id;
    openedBy = req.principal.userId;
    if (body.withdrawalId) {
      const w = await maybeOne(ctx.db, `SELECT 1 FROM withdrawals WHERE id=$1 AND merchant_id=$2`, [body.withdrawalId, merchantId]);
      if (!w) throw notFound("withdrawal");
    }
  }
  const id = newId("supportCase");
  await ctx.db.query(
    `INSERT INTO support_cases(id, environment, merchant_id, intent_id, withdrawal_id, opened_by_type, opened_by, category, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.env, merchantId, body.checkoutId ?? null, body.withdrawalId ?? null, openedByType, openedBy, body.category, body.reason.replace(/[<>]/g, "")],
  );
  await audit(ctx.db, ctx.env, { actorType: openedByType === "payer_session" ? "payer" : "user", actorId: openedBy, action: "support.open", target: id, requestId: req.requestId });
  return { id, category: body.category, status: "open", checkoutId: body.checkoutId ?? null, withdrawalId: body.withdrawalId ?? null, createdAt: ctx.now().toISOString() };
};

export const listSupportCases: Handler = async (req: Req<object, { cursor?: string; limit: number }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<{ id: string; category: string; status: string; intent_id: string | null; withdrawal_id: string | null; created_at: Date }>(
    req.ctx.db,
    `SELECT id, category, status, intent_id, withdrawal_id, created_at FROM support_cases WHERE merchant_id=$1 AND environment=$2 AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4)) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [req.principal!.merchant!.id, req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  return {
    items: page.map((r) => ({ id: r.id, category: r.category, status: r.status, checkoutId: r.intent_id, withdrawalId: r.withdrawal_id, createdAt: new Date(r.created_at).toISOString() })),
    nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
  };
};
