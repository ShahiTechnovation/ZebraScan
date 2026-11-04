import { maybeOne, one } from "@zeb/db";
import { DomainError, notFound } from "@zeb/domain";
import { cancelIntent, checkoutPublic, createIntent, demoSimulate, refreshIntent, submitRefundDetails } from "@zeb/core";
import { checkoutAccess, type Handler, type Req, type AnyReq } from "../http";

async function created(req: AnyReq, r: Awaited<ReturnType<typeof createIntent>>) {
  return { checkout: await checkoutPublic(req.ctx.db, req.ctx, r.intent.id), accessToken: r.accessToken, accessExpiresAt: r.accessExpiresAt.toISOString() };
}

/** Payer subject: anonymous cookie id, or the signed-in user (merchant staff running a terminal). */
const subject = (req: AnyReq) => (req.principal ? `user:${req.principal.userId}` : `anon:${req.anonId}`);

export const createScanPayIntent: Handler = async (req: Req<object, object, { quoteId: string; payee: { vpa: string; payeeName?: string; source: string }; refundPreference: "manual_review"; customerNote?: string }>) => {
  const r = await createIntent(req.ctx, {
    mode: "scan_pay",
    quoteId: req.body.quoteId,
    payee: req.body.payee,
    refundPreference: req.body.refundPreference,
    customerNote: req.body.customerNote,
    accessSubject: subject(req),
    requestId: req.requestId,
  });
  return created(req, r);
};

export const getScanPayIntent: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  const c = await checkoutPublic(req.ctx.db, req.ctx, req.params.id);
  if (c.mode !== "scan_pay") throw notFound("scan & pay intent");
  return c;
};

export const cancelScanPayIntent: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  await cancelIntent(req.ctx, req.params.id, subject(req));
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export const createTerminalIntent: Handler = async (req: Req<object, object, { quoteId: string; customerNote?: string }>) => {
  const r = await createIntent(req.ctx, { mode: "terminal", quoteId: req.body.quoteId, merchantId: req.principal!.merchant!.id, customerNote: req.body.customerNote, accessSubject: subject(req), requestId: req.requestId });
  return created(req, r);
};

export const getTerminalIntent: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export const createCounterCheckout: Handler = async (req: Req<{ handle: string }, object, { quoteId: string; customerNote?: string }>) => {
  const m = await maybeOne<{ id: string }>(req.ctx.db, `SELECT id FROM merchants WHERE environment=$1 AND (counter_slug=$2 OR handle=$2) AND status <> 'closed'`, [req.ctx.env, req.params.handle]);
  if (!m) throw notFound("merchant");
  const r = await createIntent(req.ctx, { mode: "counter_qr", quoteId: req.body.quoteId, merchantId: m.id, customerNote: req.body.customerNote, accessSubject: subject(req), requestId: req.requestId });
  return created(req, r);
};

export const createLinkCheckout: Handler = async (req: Req<{ slug: string }, object, { quoteId: string; customerNote?: string }>) => {
  const l = await maybeOne<{ id: string; merchant_id: string; allow_note: boolean }>(req.ctx.db, `SELECT id, merchant_id, allow_note FROM payment_links WHERE environment=$1 AND slug=$2`, [req.ctx.env, req.params.slug]);
  if (!l) throw notFound("payment link");
  const r = await createIntent(req.ctx, {
    mode: "payment_link",
    quoteId: req.body.quoteId,
    merchantId: l.merchant_id,
    linkId: l.id,
    customerNote: l.allow_note ? req.body.customerNote : undefined,
    accessSubject: subject(req),
    requestId: req.requestId,
  });
  return created(req, r);
};

export const getCheckout: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export const refreshCheckout: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  const r = await refreshIntent(req.ctx, req.params.id, subject(req), req.requestId);
  return created(req, r);
};

export const submitRefundDetailsH: Handler = async (req: Req<{ id: string }, object, { zcashAddress: string }>) => {
  const who = await checkoutAccess(req, req.params.id);
  if (who !== "payer") throw new DomainError("AUTH_FORBIDDEN", "Only the payer can provide refund details", undefined, { status: 403 });
  await submitRefundDetails(req.ctx, req.params.id, req.body.zcashAddress, subject(req));
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export const demoSimulateDeposit: Handler = async (req: Req<{ id: string }, object, { kind: "exact"; confirmations: number }>) => {
  await checkoutAccess(req, req.params.id);
  await demoSimulate(req.ctx, req.params.id, req.body.kind, req.body.confirmations);
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export const demoAdvanceConfirmations: Handler = async (req: Req<{ id: string }>) => {
  await checkoutAccess(req, req.params.id);
  await demoSimulate(req.ctx, req.params.id, "advance");
  return checkoutPublic(req.ctx.db, req.ctx, req.params.id);
};

export async function intentMerchant(req: AnyReq, id: string): Promise<string | null> {
  const r = await one<{ merchant_id: string | null }>(req.ctx.db, `SELECT merchant_id FROM payment_intents WHERE id=$1`, [id]);
  return r.merchant_id;
}
