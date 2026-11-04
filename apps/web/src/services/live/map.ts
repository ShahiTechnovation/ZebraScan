/**
 * Map backend DTOs (exact integer-string money) into the UI's domain types. INR paise become
 * JS numbers only for display (safe: policy caps amounts far below 2^53); ZEC and USDC stay strings.
 * Rates (`usdMicroPerZec`, `inrPerUsdcMinor`) are display-only conversions of exact decimal strings.
 */
import type { CheckoutPublic, Quote } from "@zeb/contracts";
import type {
  CheckoutIntent,
  CreditStatus,
  DepositStatus,
  LedgerEntry,
  LedgerKind,
  Merchant,
  MerchantCredit,
  P2POrder,
  P2PStatus,
  PaymentLink,
  PaymentPrivacy,
  PaymentQuote,
  Receipt,
  TimelineEvent,
  Withdrawal,
  WithdrawalStatus,
} from "@/types/domain";

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
const num = (minor: string | null | undefined) => (minor === null || minor === undefined ? null : Number(minor));

/** "1301.62" → 1_301_620_000 (6-decimal micro), via string math. */
function decimalToScaled(text: string, decimals: number): number {
  const [w = "0", f = ""] = text.split(".");
  return Number(BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0"));
}

export function mapQuote(q: Quote, platformFeeBps: number): PaymentQuote {
  const inr = Number(q.inrPaise);
  const p2pFee = Number(q.estimatedP2PFeeInrPaise);
  const platformFee = Number(q.platformFeeInrPaise);
  return {
    id: q.id,
    createdAt: Date.parse(q.observedAt),
    expiresAt: Date.parse(q.expiresAt),
    source: q.environment === "demo" ? "demo" : "live",
    provider: q.priceSource,
    privacy: q.privacyMode,
    inrMinor: inr,
    // The P2P protocol charges a fixed small-order fee, not a percentage; show it as such (bps 0).
    protocolFeeBps: 0,
    platformFeeBps,
    protocolFeeInrMinor: p2pFee,
    platformFeeInrMinor: platformFee,
    totalInrMinor: inr + p2pFee + platformFee,
    inrPerUsdcMinor: decimalToScaled(q.inrPerUsdcRate, 2),
    usdMicroPerZec: decimalToScaled(q.zecUsdRate, 6),
    usdcMicro: q.requiredUsdcMicros,
    zecZat: q.zecZatoshis,
  };
}

const DEPOSIT: Record<string, DepositStatus> = {
  created: "awaiting",
  quoted: "awaiting",
  awaiting_zec: "awaiting",
  deposit_seen: "detected",
  confirming: "confirming",
  deposit_accepted: "accepted",
  expired_without_funds: "expired",
  cancelled: "expired",
  late_deposit: "late",
  underpaid: "underpaid",
  overpaid: "overpaid",
  refund_queued: "refund_pending",
  refunded: "refunded",
  chain_reorg_review: "under_review",
  manual_review: "under_review",
  rejected: "under_review",
};
export const mapDepositStatus = (s: string): DepositStatus => DEPOSIT[s] ?? "under_review";

const PAYOUT: Record<string, P2PStatus> = {
  not_started: "not_started",
  payout_queued: "placed",
  order_placing: "placed",
  placed: "placed",
  // transient: the worker retries with a new order
  cancelled: "placed",
  provider_timeout: "placed",
  not_liquid: "placed",
  provider_failed: "placed",
  merchant_accepted: "accepted",
  usdc_escrowed: "usdc_escrowed",
  inr_processing: "inr_processing",
  provider_completed: "inr_processing",
  payout_reconciled: "inr_processing",
  completed: "completed",
  disputed: "disputed",
  manual_review: "under_review",
  refund_queued: "failed",
};

const WITHDRAWAL: Record<string, WithdrawalStatus> = {
  requested: "requested",
  funds_reserved: "requested",
  awaiting_provider: "requested",
  order_placing: "matching",
  placed: "matching",
  merchant_accepted: "accepted",
  usdc_escrowed: "escrowed",
  inr_processing: "processing",
  provider_completed: "processing",
  reconciled: "processing",
  completed: "completed",
  failed_recoverable: "failed",
  cancel_requested: "cancelling",
  cancelled: "cancelled",
  disputed: "disputed",
  manual_review: "under_review",
};

const CREDIT: Record<string, CreditStatus> = {
  credit_prepared: "pending",
  credit_locked: "locked",
  credit_available: "available",
  withdrawal_reserved: "withdrawal_reserved",
  extinguished: "withdrawn",
  frozen: "pending",
};

const timeline = (t: CheckoutPublic["timeline"]): TimelineEvent[] => t.map((e) => ({ at: Date.parse(e.at), kind: e.type, label: e.label, ...(e.detail ? { detail: e.detail } : {}) }));

export interface CheckoutContext {
  merchantId: string | null;
  linkId: string | null;
  platformFeeBps: number;
}

export function mapCheckout(c: CheckoutPublic, cx: CheckoutContext): { intent: CheckoutIntent; order: P2POrder | null } {
  const quote = mapQuote(c.quote, cx.platformFeeBps);
  const d = c.deposits[0];
  const simulated = !c.zcash.payable;
  const orderId = c.payout ? `pay_${c.id}` : null;
  const intent: CheckoutIntent = {
    id: c.id,
    mode: c.mode,
    merchantId: cx.merchantId,
    linkId: cx.linkId,
    createdAt: Date.parse(c.createdAt),
    quote,
    privacy: c.zcash.poolPreference as PaymentPrivacy,
    receivingAddress: c.zcash.address,
    qrPayload: c.zcash.zip321Uri,
    depositStatus: mapDepositStatus(c.status),
    deposit: d
      ? {
          id: d.id,
          checkoutId: c.id,
          outputRef: d.id,
          zecZat: c.receivedZatoshis !== "0" ? c.receivedZatoshis : d.valueZatoshis,
          privacy: c.zcash.poolPreference as PaymentPrivacy,
          detectedAt: Date.parse(d.firstSeenAt),
          confirmations: d.confirmations,
          requiredConfirmations: d.requiredConfirmations,
          acceptedAt: ms(d.acceptedAt),
          simulated,
          publicTxid: d.publicTxid,
        }
      : null,
    recipient: c.recipient ? { vpa: c.recipient.vpaMasked, payeeName: c.recipient.payeeName ?? undefined, source: "manual" } : null,
    p2pOrderId: orderId,
    customerNote: c.customerNote,
    exceptionReason: c.exceptionReason,
    // payout.live_demo.* = TinyFish p2p.lol settlement progress (scripts/settle-p2plol.ts); shown on the status page.
    events: timeline(c.timeline.filter((e) => !e.type.startsWith("payout.") || e.type.startsWith("payout.live_demo."))),
    simulated,
    envLabel: c.label,
    payable: c.zcash.payable,
    canCancel: c.accessPolicy.canCancel,
    canRefresh: c.accessPolicy.canRefresh,
    refreshedTo: c.refreshedTo,
    receiptId: c.receiptId ?? null,
    memo: c.zcash.memo,
    network: c.zcash.network,
  };
  const order: P2POrder | null =
    c.payout && orderId
      ? {
          id: orderId,
          orderType: "PAY",
          orderTypeCode: 2,
          status: PAYOUT[c.payout.status] ?? "under_review",
          matching: c.payout.matching,
          checkoutId: c.id,
          withdrawalId: null,
          inrMinor: quote.inrMinor,
          usdcMicro: c.quote.requiredUsdcMicros,
          recipientVpa: c.recipient?.vpaMasked ?? "",
          createdAt: Date.parse(c.createdAt),
          events: timeline(c.timeline.filter((e) => e.type.startsWith("payout."))),
          simulated,
        }
      : null;
  return { intent, order };
}

export function mapMerchant(
  m: { id: string; handle: string; displayName: string; category: string; logoUrl: string | null; counterSlug: string; createdAt: string; preferences: Merchant["preferences"] },
  extra: { payoutUpi?: string; beneficiaryName?: string; retiredCounterSlugs?: string[] } = {},
): Merchant {
  return {
    id: m.id,
    businessName: m.displayName,
    handle: m.handle,
    category: m.category,
    logoDataUrl: m.logoUrl ?? undefined,
    payoutUpi: extra.payoutUpi ?? "",
    beneficiaryName: extra.beneficiaryName ?? "",
    counterSlug: m.counterSlug,
    retiredCounterSlugs: extra.retiredCounterSlugs ?? [],
    createdAt: Date.parse(m.createdAt),
    isSample: false,
    preferences: m.preferences,
  };
}

export function mapLink(l: {
  id: string;
  merchantId: string;
  slug: string;
  title: string;
  description: string;
  reference: string;
  amountMode: "fixed" | "variable";
  fixedInrPaise: string | null;
  minInrPaise: string | null;
  maxInrPaise: string | null;
  reusable: boolean;
  useLimit: number | null;
  successfulUses: number;
  expiresAt: string | null;
  allowNote: boolean;
  status: PaymentLink["liveStatus"];
  revokedAt: string | null;
  duplicatedFrom: string | null;
  views: number;
  createdAt: string;
}): PaymentLink {
  return {
    id: l.id,
    merchantId: l.merchantId,
    slug: l.slug,
    title: l.title,
    description: l.description,
    amountMode: l.amountMode,
    fixedInrMinor: num(l.fixedInrPaise),
    minInrMinor: num(l.minInrPaise),
    maxInrMinor: num(l.maxInrPaise),
    reusable: l.reusable,
    useLimit: l.useLimit,
    expiresAt: ms(l.expiresAt),
    allowNote: l.allowNote,
    reference: l.reference,
    revokedAt: ms(l.revokedAt),
    createdAt: Date.parse(l.createdAt),
    views: l.views,
    duplicatedFrom: l.duplicatedFrom ?? undefined,
    liveStatus: l.status,
    liveSuccessfulUses: l.successfulUses,
  };
}

export function mapCredit(s: { creditId: string; intentId: string | null; amountInrPaise: string; status: string; lockedAt: string | null; unlocksAt: string | null; availableAt: string | null; withdrawalId: string | null }, merchantId: string): MerchantCredit | null {
  const status = CREDIT[s.status];
  if (!status) return null;
  return {
    id: s.creditId,
    merchantId,
    checkoutId: s.intentId ?? "",
    depositId: "",
    inrMinor: Number(s.amountInrPaise),
    status,
    createdAt: ms(s.lockedAt) ?? ms(s.availableAt) ?? Date.now(),
    lockedAt: ms(s.lockedAt),
    unlockAt: ms(s.unlocksAt),
    availableAt: ms(s.availableAt),
    withdrawalId: s.withdrawalId,
    parentCreditId: null,
  };
}

const LEDGER_KIND: Record<string, LedgerKind> = {
  credit_locked: "credit_locked",
  credit_available: "credit_available",
  withdrawal_reserved: "withdrawal_reserved",
  withdrawal_completed: "withdrawal_completed",
  withdrawal_released: "withdrawal_released",
  reversal: "withdrawal_released",
};

/** Collapse a journal's merchant postings into one UI entry (the destination/credit side). */
export function mapLedger(entries: Array<{ id: string; journalId: string; at: string; kind: string; direction: "credit" | "debit"; amountInrPaise: string; memo: string; refId: string | null }>, merchantId: string): LedgerEntry[] {
  const byJournal = new Map<string, typeof entries>();
  for (const e of entries) byJournal.set(e.journalId, [...(byJournal.get(e.journalId) ?? []), e]);
  const out: LedgerEntry[] = [];
  for (const [journalId, rows] of byJournal) {
    const main = rows.find((r) => r.direction === "credit") ?? rows[0]!;
    const kind = LEDGER_KIND[main.kind] ?? "credit_pending";
    const direction: LedgerEntry["direction"] = kind === "credit_locked" ? "credit" : kind === "withdrawal_completed" ? "debit" : "memo";
    out.push({ id: journalId, merchantId, at: Date.parse(main.at), kind, direction, inrMinor: Number(main.amountInrPaise), refId: main.refId ?? journalId, description: main.memo });
  }
  return out;
}

export function mapWithdrawal(w: {
  id: string;
  merchantId: string;
  inrPaise: string;
  feeInrPaise: string;
  payoutInrPaise: string;
  requiredUsdcMicros: string;
  payoutVpaMasked: string;
  status: string;
  orderReference: string | null;
  recoveredAt: string | null;
  timeline: Array<{ at: string; type: string; label: string; detail?: string }>;
  createdAt: string;
  updatedAt: string;
  label: "DEMO" | "TEST" | null;
}): Withdrawal {
  return {
    id: w.id,
    merchantId: w.merchantId,
    inrMinor: Number(w.inrPaise),
    feeInrMinor: Number(w.feeInrPaise),
    payoutInrMinor: Number(w.payoutInrPaise),
    usdcMicro: w.requiredUsdcMicros,
    payoutUpi: w.payoutVpaMasked,
    beneficiaryName: "",
    status: WITHDRAWAL[w.status] ?? "under_review",
    createdAt: Date.parse(w.createdAt),
    updatedAt: Date.parse(w.updatedAt),
    p2pOrderId: w.orderReference ?? "",
    reservedCreditIds: [],
    recoveredAt: ms(w.recoveredAt),
    events: w.timeline.map((e) => ({ at: Date.parse(e.at), kind: e.type, label: e.label, ...(e.detail ? { detail: e.detail } : {}) })),
    simulated: w.label === "DEMO",
  };
}

export function mapReceipt(
  r: { id: string; issuedAt: string; inrPaise: string; totalInrPaise: string | null; zecZatoshis: string | null; privacyMode: "shielded" | "transparent" | null; merchantName: string | null; recipientVpaMasked: string | null; title: string; verification: "wallet_verified" | "simulated" },
  cx: { checkoutId: string; merchantId: string | null; mode: CheckoutIntent["mode"] },
): Receipt {
  return {
    id: r.id,
    checkoutId: cx.checkoutId,
    merchantId: cx.merchantId,
    mode: cx.mode,
    issuedAt: Date.parse(r.issuedAt),
    inrMinor: Number(r.inrPaise),
    totalInrMinor: Number(r.totalInrPaise ?? r.inrPaise),
    zecZat: r.zecZatoshis ?? "0",
    privacy: r.privacyMode ?? "shielded",
    merchantName: r.merchantName,
    recipientVpaMasked: r.recipientVpaMasked,
    title: r.title,
    verification: r.verification,
    simulated: r.verification === "simulated",
  };
}
