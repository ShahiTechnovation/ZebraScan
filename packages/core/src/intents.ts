/**
 * Payment intents (checkouts) for all four modes. One intent = one quote = one unique receiving
 * address = one USDC hold. Frontend callbacks never advance financial state; only scanner events do.
 */
import { many, maybeOne, one, tx, type Queryable, type Tx } from "@zeb/db";
import {
  addressMatchesNetwork,
  buildZip321,
  deriveLinkStatus,
  DomainError,
  intentMachine,
  maskVpa,
  newId,
  notFound,
  randomToken,
  validateVpa,
  type IntentStatus,
} from "@zeb/domain";
import { treasury } from "@zeb/ledger";
import { usesTreasury, type CoreContext } from "./context";
import { audit, emitResource, raiseException } from "./events";
import { recordAuthorization } from "./tfpayouts";
import { hmacHex } from "@zeb/security";
import { featureFor, readiness } from "./gates";
import { assertQuoteIntegrity, createQuote, quoteDto, type QuoteMode, type QuoteRow } from "./quotes";

export interface IntentRow {
  id: string;
  environment: string;
  mode: QuoteMode;
  merchant_id: string | null;
  link_id: string | null;
  quote_id: string;
  status: IntentStatus;
  payout_status: string;
  privacy_mode: "shielded" | "transparent";
  refund_preference: string;
  zcash_address_id: string;
  recipient_vpa_ct: string | null;
  recipient_vpa_masked: string | null;
  recipient_payee_name: string | null;
  customer_note: string;
  access_subject: string;
  access_generation: number;
  expires_at: Date;
  deposit_submission_deadline: Date;
  finality_deadline: Date;
  received_zatoshis: string;
  accepted_at: Date | null;
  exception_reason: string | null;
  receipt_id: string | null;
  refreshed_from: string | null;
  refreshed_to: string | null;
  status_version: number;
  created_at: Date;
  updated_at: Date;
}

export const holdPolicy = (ctx: CoreContext) => ({
  inventoryMaxAgeMs: ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000,
  bufferMicros: ctx.cfg.policy.treasuryBufferMicros,
});

export interface CreateIntentInput {
  mode: QuoteMode;
  quoteId: string;
  merchantId?: string | null;
  linkId?: string | null;
  payee?: { vpa: string; payeeName?: string; source: string } | null;
  refundPreference?: "manual_review" | "return_address";
  customerNote?: string;
  accessSubject: string;
  requestId?: string;
}

/** Reserve the next diversifier index in its own committed transaction: an index is never reused. */
async function burnAddressIndex(ctx: CoreContext, network: string, accountId: string): Promise<bigint> {
  return tx(ctx.db, async (t) => {
    await t.query(
      `INSERT INTO address_allocation_cursor(environment, network, account_id, next_index) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`,
      [ctx.env, network, accountId],
    );
    const row = await one<{ next_index: string }>(
      t,
      `SELECT next_index FROM address_allocation_cursor WHERE environment=$1 AND network=$2 AND account_id=$3 FOR UPDATE`,
      [ctx.env, network, accountId],
    );
    await t.query(`UPDATE address_allocation_cursor SET next_index = next_index + 1 WHERE environment=$1 AND network=$2 AND account_id=$3`, [ctx.env, network, accountId]);
    return BigInt(row.next_index);
  });
}

export async function createIntent(ctx: CoreContext, input: CreateIntentInput): Promise<{ intent: IntentRow; accessToken: string; accessExpiresAt: Date }> {
  const ready = await readiness(ctx);
  const feature = ready.features[featureFor(input.mode)];
  if (!feature.available) throw new DomainError("FEATURE_UNAVAILABLE", feature.reason ?? "This payment type is unavailable", undefined, { retryable: true });
  if (!ctx.allocator) throw new DomainError("WALLET_UNAVAILABLE", "No Zcash receiving wallet configured", undefined, { retryable: true });

  // Pre-validate quote outside the lock for a fast error, then re-check under lock.
  const pre = await maybeOne<QuoteRow>(ctx.db, `SELECT * FROM quotes WHERE id=$1 AND environment=$2`, [input.quoteId, ctx.env]);
  if (!pre) throw notFound("quote", input.quoteId);
  if (pre.payment_mode !== input.mode) throw new DomainError("QUOTE_MODE_MISMATCH", "Quote was created for a different payment type");
  if (pre.consumed_by) throw new DomainError("QUOTE_ALREADY_USED", "This quote already backs a checkout; request a new quote", undefined, { status: 409 });
  if (ctx.now() >= new Date(pre.expires_at)) throw new DomainError("QUOTE_EXPIRED", "Quote expired; request a new one");
  if (!pre.payment_eligible) throw new DomainError("QUOTE_NOT_ELIGIBLE", pre.disabled_reason ?? "Quote is not payable");
  assertQuoteIntegrity(pre);

  let vpa: string | null = null;
  if (input.mode === "scan_pay") {
    if (!input.payee) throw new DomainError("VALIDATION_PAYEE", "Scan & Pay requires a confirmed UPI payee");
    vpa = validateVpa(input.payee.vpa);
  } else if (!input.merchantId) throw new DomainError("VALIDATION_MERCHANT", "Merchant checkout requires a merchant");

  const network = ctx.env === "demo" ? "demo" : ctx.cfg.zcashNetwork!;
  const accountId = ctx.cfg.zcashGateway?.accountId ?? "demo";
  const intentId = newId("intent");
  const index = await burnAddressIndex(ctx, network, accountId);
  // Memo-matched watchers (zkool): one high-entropy ASCII code per invoice, carried in the encrypted memo.
  const memoCode = ctx.allocator.kind === "zkool" ? `ZEB-${randomToken(10).toUpperCase().slice(0, 16)}` : undefined;
  if (ctx.allocator.kind === "zkool" && pre.privacy_mode !== "shielded") throw new DomainError("QUOTE_PRIVACY_NOT_ALLOWED", "Memo-matched testnet invoices require a shielded payment");
  const addr = await ctx.allocator.allocate({ invoiceId: intentId, network: network as "testnet", privacyMode: pre.privacy_mode, diversifierIndex: index, amountZat: BigInt(pre.zec_zatoshis), memoCode });
  if (ctx.env !== "demo" && !addressMatchesNetwork(addr.address, ctx.cfg.zcashNetwork!)) throw new DomainError("WALLET_NETWORK_MISMATCH", "gateway returned an address for the wrong network");

  const created = await tx(ctx.db, async (t) => {
    const quote = await one<QuoteRow>(t, `SELECT * FROM quotes WHERE id=$1 AND environment=$2 FOR UPDATE`, [input.quoteId, ctx.env]);
    if (quote.consumed_by) throw new DomainError("QUOTE_ALREADY_USED", "This quote already backs a checkout", undefined, { status: 409 });
    if (ctx.now() >= new Date(quote.expires_at)) throw new DomainError("QUOTE_EXPIRED", "Quote expired; request a new one");

    let merchantLabel: string | null = null;
    if (input.merchantId) {
      const m = await maybeOne<{ status: string; receiving_enabled: boolean; display_name: string }>(t, `SELECT status, receiving_enabled, display_name FROM merchants WHERE id=$1 AND environment=$2 FOR SHARE`, [input.merchantId, ctx.env]);
      if (!m) throw notFound("merchant");
      if (!m.receiving_enabled) throw new DomainError("COMPLIANCE_RECEIVING_DISABLED", "This merchant is not accepting payments right now");
      if (["restricted", "suspended", "closed"].includes(m.status)) throw new DomainError("COMPLIANCE_MERCHANT_RESTRICTED", "This merchant cannot accept payments");
      if (ctx.env === "mainnet-enabled" && m.status !== "verified") throw new DomainError("COMPLIANCE_KYB_REQUIRED", "Merchant verification (KYB) must be completed before accepting live payments");
      merchantLabel = m.display_name;
    }
    if (input.mode === "payment_link") {
      const link = await maybeOne<{ merchant_id: string; revoked_at: Date | null; expires_at: Date | null; use_limit: number | null; successful_uses: number; reusable: boolean; amount_mode: string; fixed_inr_paise: string | null; min_inr_paise: string | null; max_inr_paise: string | null }>(
        t,
        `SELECT * FROM payment_links WHERE id=$1 AND environment=$2 FOR UPDATE`,
        [input.linkId, ctx.env],
      );
      if (!link || link.merchant_id !== input.merchantId) throw notFound("payment link");
      const status = deriveLinkStatus({ revokedAt: link.revoked_at, expiresAt: link.expires_at, useLimit: link.reusable ? link.use_limit : 1, successfulUses: link.successful_uses }, ctx.now());
      if (status !== "active") throw new DomainError(`STATE_LINK_${status.toUpperCase()}`, `This payment link is ${status}`, undefined, { status: 409, currentStatus: status });
      const amt = BigInt(quote.inr_paise);
      if (link.amount_mode === "fixed" && amt !== BigInt(link.fixed_inr_paise!)) throw new DomainError("QUOTE_AMOUNT_MISMATCH", "Quote amount does not match the link's fixed amount");
      if (link.min_inr_paise && amt < BigInt(link.min_inr_paise)) throw new DomainError("QUOTE_AMOUNT_TOO_LOW", "Amount is below this link's minimum");
      if (link.max_inr_paise && amt > BigInt(link.max_inr_paise)) throw new DomainError("QUOTE_AMOUNT_TOO_HIGH", "Amount is above this link's maximum");
    }

    if (usesTreasury(ctx)) await treasury.hold(t, ctx.env, { purpose: "deposit_hold", obligationId: intentId, amountMicros: BigInt(quote.required_usdc_micros), expiresAt: new Date(quote.finality_deadline) }, holdPolicy(ctx));

    const addressId = newId("address");
    await t.query(
      `INSERT INTO zcash_addresses(id, environment, network, account_id, diversifier_index, address, address_type, receivers, birthday_height, intent_id, wallet_id, memo_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [addressId, ctx.env, network, addr.accountId, addr.diversifierIndex, addr.address, addr.addressType, addr.receivers, addr.birthdayHeight, intentId, addr.walletId, addr.memoCode ?? null],
    );
    const vpaCt = vpa ? await ctx.envelope.seal(vpa, `payment_intents:${intentId}:recipient_vpa`) : null;
    const intent = await one<IntentRow>(
      t,
      `INSERT INTO payment_intents(id, environment, mode, merchant_id, link_id, quote_id, status, privacy_mode, refund_preference, zcash_address_id,
          recipient_vpa_ct, recipient_vpa_masked, recipient_payee_name, recipient_source, customer_note, access_subject,
          expires_at, deposit_submission_deadline, finality_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,'awaiting_zec',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        intentId,
        ctx.env,
        input.mode,
        input.merchantId ?? null,
        input.linkId ?? null,
        quote.id,
        quote.privacy_mode,
        input.refundPreference ?? "manual_review",
        addressId,
        vpaCt,
        vpa ? maskVpa(vpa) : null,
        input.payee?.payeeName?.replace(/[<>"'`]/g, "").slice(0, 80) ?? null,
        input.payee?.source ?? null,
        (input.customerNote ?? "").replace(/[<>]/g, "").slice(0, 140),
        input.accessSubject,
        quote.expires_at,
        quote.funding_deadline,
        quote.finality_deadline,
      ],
    );
    await t.query(`UPDATE quotes SET consumed_by=$1 WHERE id=$2`, [intentId, quote.id]);
    if (vpa) {
      // Immutable payer consent snapshot: recipient, INR, quote, fees and the refund fallback.
      await recordAuthorization(t, ctx, {
        intentId,
        actor: input.accessSubject,
        terms: {
          version: "payout-terms-v1",
          recipientVpaMasked: maskVpa(vpa),
          recipientFingerprint: hmacHex(ctx.cfg.tokenSecret, `vpa:${vpa.toLowerCase()}`),
          inrPaise: quote.inr_paise,
          zecZatoshis: quote.zec_zatoshis,
          platformFeeInrPaise: quote.platform_fee_inr_paise,
          estimatedP2PFeeUsdcMicros: quote.p2p_fee_usdc_micros,
          maxUsdcDebitMicros: quote.required_usdc_micros,
          quoteId: quote.id,
          fallback: "If the INR payout cannot be completed, the ZEC is held for a reviewed refund.",
        },
      });
    }
    await emitResource(t, ctx.env, `checkout:${intentId}`, "checkout.created", { status: "awaiting_zec", label: "Invoice created", detail: merchantLabel ? `Payment to ${merchantLabel}` : "Scan & Pay" });
    if (input.merchantId) await emitResource(t, ctx.env, `merchant:${input.merchantId}`, "checkout.created", { checkoutId: intentId });
    await audit(t, ctx.env, { actorType: input.mode === "terminal" ? "user" : "payer", actorId: input.accessSubject, action: "intent.create", target: intentId, details: { mode: input.mode }, requestId: input.requestId });
    return intent;
  });

  const accessExpiresAt = new Date(new Date(created.finality_deadline).getTime() + 30 * 86_400_000);
  const accessToken = ctx.tokens.sign({ scope: `checkout:${created.id}`, sub: created.access_subject, exp: Math.floor(accessExpiresAt.getTime() / 1000), gen: created.access_generation });
  return { intent: created, accessToken, accessExpiresAt };
}

export async function lockIntent(t: Tx, ctx: CoreContext, id: string): Promise<IntentRow> {
  const i = await maybeOne<IntentRow>(t, `SELECT * FROM payment_intents WHERE id=$1 AND environment=$2 FOR UPDATE`, [id, ctx.env]);
  if (!i) throw notFound("checkout", id);
  return i;
}

/** Validated status transition with optimistic version bump + SSE event. */
export async function transitionIntent(t: Tx, ctx: CoreContext, intent: IntentRow, to: IntentStatus, extra: { label: string; detail?: string; set?: Record<string, unknown> } ): Promise<IntentRow> {
  intentMachine.assert(intent.status, to, { intentId: intent.id });
  const sets = ["status=$3", "status_version=status_version+1", "updated_at=now()"];
  const vals: unknown[] = [intent.id, intent.status_version, to];
  for (const [k, v] of Object.entries(extra.set ?? {})) {
    vals.push(v);
    sets.push(`${k}=$${vals.length}`);
  }
  const r = await t.query(`UPDATE payment_intents SET ${sets.join(", ")} WHERE id=$1 AND status_version=$2 RETURNING *`, vals);
  if (r.rowCount !== 1) throw new DomainError("STATE_CONCURRENT_MODIFICATION", "checkout changed concurrently; retry", undefined, { status: 409, retryable: true });
  await emitResource(t, ctx.env, `checkout:${intent.id}`, `checkout.${to}`, { status: to, label: extra.label, ...(extra.detail ? { detail: extra.detail } : {}) });
  if (intent.merchant_id) await emitResource(t, ctx.env, `merchant:${intent.merchant_id}`, "checkout.updated", { checkoutId: intent.id, status: to });
  return r.rows[0] as IntentRow;
}

export async function cancelIntent(ctx: CoreContext, id: string, actor: string): Promise<void> {
  await tx(ctx.db, async (t) => {
    const i = await lockIntent(t, ctx, id);
    const deposits = await one<{ n: string }>(t, `SELECT count(*) AS n FROM deposit_observations WHERE intent_id=$1`, [id]);
    if (i.status !== "awaiting_zec" || deposits.n !== "0") {
      throw new DomainError("STATE_CANCEL_NOT_SAFE", "This checkout can no longer be cancelled because ZEC was detected or it already progressed", undefined, { status: 409, currentStatus: i.status });
    }
    await transitionIntent(t, ctx, i, "cancelled", { label: "Cancelled", detail: "The address stays monitored; any late ZEC will be routed to refund review." });
    await treasury.setState(t, ctx.env, id, "released");
    await audit(t, ctx.env, { actorType: "payer", actorId: actor, action: "intent.cancel", target: id });
  });
}

export async function refreshIntent(ctx: CoreContext, id: string, actor: string, requestId?: string) {
  const old = await maybeOne<IntentRow>(ctx.db, `SELECT * FROM payment_intents WHERE id=$1 AND environment=$2`, [id, ctx.env]);
  if (!old) throw notFound("checkout", id);
  const deposits = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM deposit_observations WHERE intent_id=$1`, [id]);
  if (!["awaiting_zec", "expired_without_funds", "cancelled"].includes(old.status) || deposits.n !== "0" || old.refreshed_to) {
    throw new DomainError("STATE_REFRESH_NOT_ALLOWED", "Only an unfunded checkout can be refreshed", undefined, { status: 409, currentStatus: old.status });
  }
  const oldQuote = await one<QuoteRow>(ctx.db, `SELECT * FROM quotes WHERE id=$1`, [old.quote_id]);
  const q = await createQuote(ctx, { mode: old.mode, inrPaise: BigInt(oldQuote.inr_paise), privacy: old.privacy_mode, allowTransparent: old.privacy_mode === "transparent" });
  let payee: CreateIntentInput["payee"] = null;
  if (old.recipient_vpa_ct) {
    payee = { vpa: await ctx.envelope.open(old.recipient_vpa_ct, `payment_intents:${old.id}:recipient_vpa`), payeeName: old.recipient_payee_name ?? undefined, source: "manual" };
  }
  const created = await createIntent(ctx, {
    mode: old.mode,
    quoteId: q.id,
    merchantId: old.merchant_id,
    linkId: old.link_id,
    payee,
    refundPreference: old.refund_preference as "manual_review",
    customerNote: old.customer_note,
    accessSubject: old.access_subject,
    requestId,
  });
  await tx(ctx.db, async (t) => {
    const cur = await lockIntent(t, ctx, id);
    if (cur.status === "awaiting_zec") {
      await transitionIntent(t, ctx, cur, "cancelled", { label: "Replaced by a new invoice", detail: `New checkout ${created.intent.id}`, set: { refreshed_to: created.intent.id } });
      await treasury.setState(t, ctx.env, id, "released");
    } else {
      await t.query(`UPDATE payment_intents SET refreshed_to=$2, updated_at=now() WHERE id=$1`, [id, created.intent.id]);
    }
    await t.query(`UPDATE payment_intents SET refreshed_from=$2 WHERE id=$1`, [created.intent.id, id]);
    await audit(t, ctx.env, { actorType: "payer", actorId: actor, action: "intent.refresh", target: id, details: { newIntent: created.intent.id } });
  });
  return created;
}

export async function submitRefundDetails(ctx: CoreContext, id: string, zcashAddress: string, actor: string) {
  const net = ctx.env === "demo" ? null : ctx.cfg.zcashNetwork;
  if (net && !addressMatchesNetwork(zcashAddress.trim(), net)) throw new DomainError("WALLET_REFUND_ADDRESS_INVALID", `Refund address must be a ${net} Zcash address`);
  await tx(ctx.db, async (t) => {
    const i = await lockIntent(t, ctx, id);
    const ct = await ctx.envelope.seal(zcashAddress.trim(), `payment_intents:${id}:refund_address`);
    await t.query(`UPDATE payment_intents SET refund_address_ct=$2, refund_preference='return_address', updated_at=now() WHERE id=$1`, [id, ct]);
    await emitResource(t, ctx.env, `checkout:${id}`, "refund.details_received", { label: "Refund address received", detail: "A reviewer will verify it before any refund is sent." });
    if (["late_deposit", "underpaid", "overpaid", "refund_queued", "manual_review"].includes(i.status)) {
      await raiseException(t, ctx.env, { kind: "refund_review", severity: "warning", intentId: id, details: { status: i.status } });
    }
    await audit(t, ctx.env, { actorType: "payer", actorId: actor, action: "intent.refund_details", target: id });
  });
}

/* ------------------------------------------------------------------ serialization */

const LABELS: Record<string, string> = {
  awaiting_zec: "Waiting for ZEC",
  deposit_seen: "ZEC detected (unconfirmed)",
  confirming: "Confirming on the Zcash chain",
  deposit_accepted: "ZEC received",
  expired_without_funds: "Expired — no ZEC received",
  late_deposit: "Late deposit — under review",
  underpaid: "Underpaid — under review",
  overpaid: "Overpaid — excess under review",
  chain_reorg_review: "Chain reorganisation — under review",
  manual_review: "Under manual review",
  refund_queued: "Refund queued",
  refunded: "Refunded",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const PAYOUT_HONEST: Record<string, string> = {
  not_started: "Payout not started",
  payout_queued: "Payout queued",
  order_placing: "Placing P2P order",
  placed: "Order placed — waiting for a liquidity provider",
  merchant_accepted: "Liquidity provider accepted",
  usdc_escrowed: "USDC escrowed with the P2P protocol",
  inr_processing: "INR transfer in progress (off-chain, by the liquidity provider)",
  provider_completed: "Provider marked the INR transfer complete — reconciling",
  payout_reconciled: "Reconciled",
  completed: "Completed — provider reported the INR transfer; this is not a bank statement",
  not_liquid: "No liquidity available — retrying or refunding",
  provider_timeout: "Provider did not respond in time",
  cancelled: "Order cancelled",
  provider_failed: "Provider failed",
  disputed: "Disputed — under review",
  manual_review: "Under manual review",
  refund_queued: "Refund queued",
};

export async function checkoutPublic(q: Queryable, ctx: CoreContext, id: string) {
  const i = await maybeOne<IntentRow>(q, `SELECT * FROM payment_intents WHERE id=$1 AND environment=$2`, [id, ctx.env]);
  if (!i) throw notFound("checkout", id);
  const quote = await one<QuoteRow>(q, `SELECT * FROM quotes WHERE id=$1`, [i.quote_id]);
  const addr = await one<{ id: string; address: string; network: string; address_type: string; memo_code: string | null }>(q, `SELECT id, address, network, address_type, memo_code FROM zcash_addresses WHERE id=$1`, [i.zcash_address_id]);
  const deps = await many<{ id: string; pool: string; value_zatoshis: string; confirmations: number; first_seen_at: Date; accepted: boolean; canonical: boolean; txid: string; updated_at: Date }>(
    q,
    `SELECT id, pool, value_zatoshis, confirmations, first_seen_at, accepted, canonical, txid, updated_at FROM deposit_observations WHERE intent_id=$1 ORDER BY first_seen_at`,
    [id],
  );
  const merchant = i.merchant_id
    ? await maybeOne<{ display_name: string; handle: string; status: string }>(q, `SELECT display_name, handle, status FROM merchants WHERE id=$1`, [i.merchant_id])
    : null;
  const link = i.link_id ? await maybeOne<{ slug: string; title: string }>(q, `SELECT slug, title FROM payment_links WHERE id=$1`, [i.link_id]) : null;
  const order = i.mode === "scan_pay" ? await maybeOne<{ onchain_order_id: string | null; status: string; updated_at: Date }>(q, `SELECT onchain_order_id, status, updated_at FROM p2p_orders WHERE intent_id=$1 ORDER BY attempt DESC LIMIT 1`, [id]) : null;
  const events = await many<{ id: string; created_at: Date; event_type: string; data: { label?: string; detail?: string } }>(
    q,
    `SELECT id, created_at, event_type, data FROM resource_events WHERE resource=$1 ORDER BY id`,
    [`checkout:${id}`],
  );
  const required = ctx.cfg.policy.requiredConfirmations;
  const canonicalDeps = deps.filter((d) => d.canonical);
  const maxConf = canonicalDeps.reduce((m, d) => Math.max(m, d.confirmations), 0);
  const payable = ctx.caps.realChainAddresses && addr.address_type !== "demo";
  return {
    id: i.id,
    mode: i.mode,
    environment: ctx.env,
    label: ctx.caps.label,
    merchant: merchant ? { displayName: merchant.display_name, handle: merchant.handle, verified: merchant.status === "verified" } : null,
    link: link ? { slug: link.slug, title: link.title } : null,
    quote: quoteDto(quote),
    zcash: {
      network: (addr.network === "demo" ? "demo" : addr.network) as "testnet",
      address: addr.address,
      zip321Uri: payable ? buildZip321(addr.address, BigInt(quote.zec_zatoshis), addr.memo_code ?? undefined) : `zebscan-demo://checkout/${i.id}?payable=false`,
      memo: payable ? addr.memo_code : null,
      payable,
      invoiceAddressId: addr.id,
      poolPreference: i.privacy_mode,
      currentConfirmations: maxConf,
      requiredConfirmations: required,
    },
    status: i.status,
    statusVersion: i.status_version,
    receivedZatoshis: i.received_zatoshis,
    exceptionReason: i.exception_reason,
    deposits: deps.map((d) => ({
      id: d.id,
      pool: d.pool,
      valueZatoshis: d.value_zatoshis,
      confirmations: d.confirmations,
      requiredConfirmations: required,
      firstSeenAt: new Date(d.first_seen_at).toISOString(),
      acceptedAt: d.accepted ? new Date(d.updated_at).toISOString() : null,
      canonical: d.canonical,
      publicTxid: d.pool === "transparent" && payable ? d.txid : null,
    })),
    recipient: i.recipient_vpa_masked ? { vpaMasked: i.recipient_vpa_masked, payeeName: i.recipient_payee_name } : null,
    payout:
      i.mode === "scan_pay"
        ? {
            status: i.payout_status,
            orderType: "PAY" as const,
            orderReference: order?.onchain_order_id ?? null,
            matching: i.payout_status === "placed",
            updatedAt: new Date(order?.updated_at ?? i.updated_at).toISOString(),
            honestStatus: PAYOUT_HONEST[i.payout_status] ?? i.payout_status,
          }
        : null,
    timeline: events.map((e) => ({ id: String(e.id), at: new Date(e.created_at).toISOString(), type: e.event_type, label: e.data.label ?? LABELS[e.event_type.replace(/^checkout\./, "")] ?? e.event_type, ...(e.data.detail ? { detail: e.data.detail } : {}) })),
    ...(deps[0] ? { paymentObservedAt: new Date(deps[0].first_seen_at).toISOString() } : {}),
    ...(i.receipt_id ? { receiptId: i.receipt_id } : {}),
    refreshedTo: i.refreshed_to,
    customerNote: i.customer_note,
    createdAt: new Date(i.created_at).toISOString(),
    accessPolicy: {
      canCancel: i.status === "awaiting_zec" && deps.length === 0,
      canRefresh: ["awaiting_zec", "expired_without_funds", "cancelled"].includes(i.status) && deps.length === 0 && !i.refreshed_to,
      canRequestRefund: ["late_deposit", "underpaid", "overpaid", "refund_queued", "manual_review", "chain_reorg_review"].includes(i.status),
    },
  };
}


export { LABELS as INTENT_LABELS, PAYOUT_HONEST };
