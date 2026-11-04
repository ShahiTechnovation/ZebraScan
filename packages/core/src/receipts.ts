/**
 * Receipts: the payload (historical display amounts) is immutable and HMAC-hashed at issue time.
 * The displayed STATUS is computed live from current state, so a receipt never claims more than
 * is true (e.g. "INR payout pending" until the payout is reconciled). Receipts never contain the
 * full UPI ID, Zcash address, viewing keys or txids of shielded payments.
 */
import { maybeOne, one, type Queryable, type Tx } from "@zeb/db";
import { newId, notFound } from "@zeb/domain";
import { canonicalJson, hmacHex } from "@zeb/security";
import type { CoreContext } from "./context";
import { emitResource } from "./events";
import { PAYOUT_HONEST } from "./intents";

export async function issuePaymentReceipt(t: Tx, ctx: CoreContext, intentId: string): Promise<string> {
  const existing = await maybeOne<{ id: string }>(t, `SELECT id FROM receipts WHERE intent_id=$1`, [intentId]);
  if (existing) return existing.id;
  const i = await one<{ mode: string; merchant_id: string | null; quote_id: string; privacy_mode: string; recipient_vpa_masked: string | null; link_id: string | null; accepted_at: Date }>(
    t,
    `SELECT mode, merchant_id, quote_id, privacy_mode, recipient_vpa_masked, link_id, accepted_at FROM payment_intents WHERE id=$1`,
    [intentId],
  );
  const q = await one<{ inr_paise: string; platform_fee_inr_paise: string; zec_zatoshis: string }>(t, `SELECT inr_paise, platform_fee_inr_paise, zec_zatoshis FROM quotes WHERE id=$1`, [i.quote_id]);
  const m = i.merchant_id ? await maybeOne<{ display_name: string; preferences: { showZecOnReceipts?: boolean } }>(t, `SELECT display_name, preferences FROM merchants WHERE id=$1`, [i.merchant_id]) : null;
  const link = i.link_id ? await maybeOne<{ title: string }>(t, `SELECT title FROM payment_links WHERE id=$1`, [i.link_id]) : null;
  const id = newId("receipt");
  const payload = {
    id,
    kind: "payment",
    environment: ctx.env,
    label: ctx.caps.label,
    issuedAt: new Date(i.accepted_at ?? ctx.now()).toISOString(),
    mode: i.mode,
    inrPaise: q.inr_paise,
    totalInrPaise: (BigInt(q.inr_paise) + BigInt(q.platform_fee_inr_paise)).toString(),
    zecZatoshis: m && m.preferences?.showZecOnReceipts === false ? null : q.zec_zatoshis,
    privacyMode: i.privacy_mode,
    merchantName: m?.display_name ?? null,
    recipientVpaMasked: i.recipient_vpa_masked,
    title: link?.title ?? (i.mode === "scan_pay" ? "Scan & Pay" : i.mode === "terminal" ? "Terminal payment" : i.mode === "counter_qr" ? "Counter payment" : "Payment link"),
    verification: ctx.caps.realChainAddresses ? "wallet_verified" : "simulated",
  };
  const hash = hmacHex(ctx.cfg.tokenSecret, `receipt:${canonicalJson(payload)}`);
  await t.query(`INSERT INTO receipts(id, environment, intent_id, merchant_id, kind, payload, validation_hash) VALUES ($1,$2,$3,$4,'payment',$5,$6)`, [
    id,
    ctx.env,
    intentId,
    i.merchant_id,
    JSON.stringify(payload),
    hash,
  ]);
  await t.query(`UPDATE payment_intents SET receipt_id=$2 WHERE id=$1`, [intentId, id]);
  await emitResource(t, ctx.env, `checkout:${intentId}`, "receipt.issued", { label: "Receipt issued", receiptId: id });
  return id;
}

export async function receiptView(q: Queryable, ctx: CoreContext, id: string) {
  const r = await maybeOne<{ id: string; kind: string; intent_id: string | null; withdrawal_id: string | null; merchant_id: string | null; payload: Record<string, unknown>; validation_hash: string; environment: string }>(
    q,
    `SELECT * FROM receipts WHERE id=$1 AND environment=$2`,
    [id, ctx.env],
  );
  if (!r) throw notFound("receipt", id);
  let status = "issued";
  let statusNote = "";
  if (r.intent_id) {
    const i = await one<{ mode: string; status: string; payout_status: string }>(q, `SELECT mode, status, payout_status FROM payment_intents WHERE id=$1`, [r.intent_id]);
    if (ctx.env === "testnet") {
      status = i.status === "deposit_accepted" ? "zec_confirmed_testnet" : i.status;
      statusNote = i.status === "deposit_accepted" ? "ZEC received and verified on testnet. INR is a nonredeemable reference amount. INR payouts and withdrawals are disabled." : `Testnet payment status: ${i.status}.`;
    } else if (i.mode === "scan_pay") {
      status = i.payout_status === "completed" ? "completed" : i.status === "deposit_accepted" ? `zec_received/${i.payout_status}` : i.status;
      statusNote = i.payout_status === "completed" ? PAYOUT_HONEST.completed! : `ZEC received. INR payout: ${PAYOUT_HONEST[i.payout_status] ?? i.payout_status}.`;
    } else {
      status = i.status === "deposit_accepted" ? "credited" : i.status;
      statusNote = i.status === "deposit_accepted" ? "ZEC received and the merchant was credited an INR-denominated platform balance (not a bank transfer)." : `Payment status: ${i.status}.`;
    }
  }
  const p = r.payload as Record<string, string | null>;
  return {
    id: r.id,
    kind: r.kind as "payment",
    environment: ctx.env,
    label: ctx.caps.label,
    issuedAt: p.issuedAt!,
    status,
    statusNote,
    inrPaise: p.inrPaise!,
    totalInrPaise: p.totalInrPaise ?? null,
    zecZatoshis: p.zecZatoshis ?? null,
    privacyMode: (p.privacyMode as "shielded") ?? null,
    merchantName: p.merchantName ?? null,
    recipientVpaMasked: p.recipientVpaMasked ?? null,
    title: p.title!,
    verification: p.verification as "wallet_verified",
    validationHash: r.validation_hash,
    _scope: { intentId: r.intent_id, merchantId: r.merchant_id },
  };
}
