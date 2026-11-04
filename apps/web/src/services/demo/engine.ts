/**
 * Demo engine — pure, deterministic state transitions for the local demo.
 * Every function takes the current state + an explicit `now` and returns a NEW state.
 * Nothing here talks to a network, wallet, chain or bank.
 */
import { cooldownMs, demoConfig } from "@/config/demo";
import { formatInr, formatZec, inrToUsdcMicro, bpsOf } from "@/lib/money";
import { buildDemoQuote, isQuoteExpired } from "@/lib/quote";
import type {
  CheckoutIntent,
  DemoState,
  LedgerEntry,
  LedgerKind,
  Merchant,
  MerchantCredit,
  P2POrder,
  PaymentLink,
  PaymentLinkStatus,
  PaymentMode,
  PaymentPrivacy,
  Receipt,
  UpiRecipient,
  Withdrawal,
  WithdrawalStatus,
} from "@/types/domain";
import { maskVpa, validateVpa } from "@/lib/upi";

export class DemoError extends Error {
  constructor(message: string, public code: string = "invalid") {
    super(message);
    this.name = "DemoError";
  }
}

const ACTIVE_WITHDRAWAL: WithdrawalStatus[] = ["requested", "matching", "accepted", "escrowed", "processing", "disputed"];

export function emptyState(now: number): DemoState {
  return {
    version: demoConfig.seedVersion,
    seededAt: now,
    clockOffsetMs: 0,
    session: { merchantId: null, startedAt: null, opsUnlocked: false },
    merchants: [],
    links: [],
    checkouts: [],
    credits: [],
    ledger: [],
    orders: [],
    withdrawals: [],
    receipts: [],
    treasuryUsdcTotalMicro: demoConfig.treasury.usdcTotalMicro,
    counter: 0,
  };
}

/* ------------------------------------------------------------------ ids */

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** Deterministic id from the state counter (hashed so ids don't look sequential). */
export function nextId(s: DemoState, prefix: string): string {
  s.counter += 1;
  let h = (s.counter * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length) ^ ((s.counter * 40503 + i * 977) >>> 0);
    h >>>= 0;
  }
  return `${prefix}_${out}${s.counter.toString(36)}`;
}

/** Clearly non-payable placeholder. Never resembles a real Zcash address prefix. */
export function demoReceivingAddress(checkoutId: string): string {
  return `zebscan-demo-address-${checkoutId}-not-payable`;
}

export function demoQrPayload(checkoutId: string, zecZat: string): string {
  return `zebscan-demo://checkout/${checkoutId}?amount=${formatZec(zecZat, { fixed: true })}&payable=false`;
}

/* ------------------------------------------------------------- helpers */

function clone(s: DemoState): DemoState {
  return structuredClone(s);
}

function ledger(
  s: DemoState,
  merchantId: string,
  at: number,
  kind: LedgerKind,
  direction: LedgerEntry["direction"],
  inrMinor: number,
  refId: string,
  description: string,
) {
  s.ledger.push({ id: nextId(s, "led"), merchantId, at, kind, direction, inrMinor, refId, description });
}

export function getMerchant(s: DemoState, id: string | null | undefined): Merchant | undefined {
  return id ? s.merchants.find((m) => m.id === id) : undefined;
}

export function linkSuccessfulUses(s: DemoState, linkId: string): number {
  return s.checkouts.filter((c) => c.linkId === linkId && c.depositStatus === "accepted").length;
}

export function linkStatus(s: DemoState, link: PaymentLink, now: number): PaymentLinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && now >= link.expiresAt) return "expired";
  const limit = link.reusable ? link.useLimit : 1;
  if (limit !== null && linkSuccessfulUses(s, link.id) >= limit) return "exhausted";
  return "active";
}

/** Move time-based state forward: expire stale quotes, unlock matured credits. Idempotent. */
export function reconcile(input: DemoState, now: number): DemoState {
  let changed = false;
  const s = clone(input);
  for (const c of s.checkouts) {
    if (c.depositStatus === "awaiting" && isQuoteExpired(c.quote, now)) {
      c.depositStatus = "expired";
      c.events.push({ at: c.quote.expiresAt, kind: "expired", label: "Quote expired", detail: "No ZEC was detected before the quote expired." });
      changed = true;
    }
  }
  for (const cr of s.credits) {
    if (cr.status === "locked" && cr.unlockAt !== null && now >= cr.unlockAt) {
      cr.status = "available";
      cr.availableAt = cr.unlockAt;
      ledger(s, cr.merchantId, cr.unlockAt, "credit_available", "memo", cr.inrMinor, cr.id, "Cooldown ended · credit available to withdraw");
      changed = true;
    }
  }
  return changed ? s : input;
}

/* ----------------------------------------------------------- merchants */

export interface OnboardingInput {
  businessName: string;
  handle: string;
  category: string;
  logoDataUrl?: string;
  payoutUpi: string;
  beneficiaryName: string;
}

export function validateOnboarding(s: DemoState, input: OnboardingInput): Partial<Record<keyof OnboardingInput, string>> {
  const e: Partial<Record<keyof OnboardingInput, string>> = {};
  const name = input.businessName.trim();
  if (name.length < 2 || name.length > 60) e.businessName = "Business name must be 2–60 characters.";
  if (!/^[a-zA-Z0-9-]{3,24}$/.test(input.handle)) e.handle = "Handle must be 3–24 letters, numbers or hyphens.";
  else if (s.merchants.some((m) => m.handle.toLowerCase() === input.handle.toLowerCase() || m.counterSlug === input.handle.toLowerCase()))
    e.handle = "That handle is already used in this demo.";
  if (!input.category) e.category = "Choose a business category.";
  const vpaErr = validateVpa(input.payoutUpi);
  if (vpaErr) e.payoutUpi = vpaErr;
  const b = input.beneficiaryName.trim();
  if (b.length < 2 || b.length > 60) e.beneficiaryName = "Beneficiary display name must be 2–60 characters.";
  return e;
}

export function onboardMerchant(input: DemoState, data: OnboardingInput, now: number, isSample = false): { state: DemoState; merchant: Merchant } {
  const errors = validateOnboarding(input, data);
  if (Object.keys(errors).length) throw new DemoError(Object.values(errors)[0]!, "validation");
  const s = clone(input);
  const handle = data.handle.toLowerCase();
  const merchant: Merchant = {
    id: nextId(s, "mer"),
    businessName: data.businessName.trim(),
    handle,
    category: data.category,
    logoDataUrl: data.logoDataUrl,
    payoutUpi: data.payoutUpi.trim(),
    beneficiaryName: data.beneficiaryName.trim(),
    counterSlug: handle,
    retiredCounterSlugs: [],
    createdAt: now,
    isSample,
    preferences: {
      defaultPrivacy: "shielded",
      allowTransparent: true,
      notifyOnCredit: true,
      notifyOnWithdrawal: true,
      showZecOnReceipts: true,
    },
  };
  s.merchants.push(merchant);
  s.session = { merchantId: merchant.id, startedAt: now, opsUnlocked: false };
  return { state: s, merchant };
}

export function updateMerchant(input: DemoState, merchantId: string, patch: Partial<Omit<Merchant, "id" | "handle" | "counterSlug">>): DemoState {
  const s = clone(input);
  const m = getMerchant(s, merchantId);
  if (!m) throw new DemoError("Merchant not found.", "not_found");
  if (patch.businessName !== undefined) {
    const n = patch.businessName.trim();
    if (n.length < 2 || n.length > 60) throw new DemoError("Business name must be 2–60 characters.", "validation");
  }
  if (patch.payoutUpi !== undefined) {
    const err = validateVpa(patch.payoutUpi);
    if (err) throw new DemoError(err, "validation");
  }
  Object.assign(m, patch);
  return s;
}

export function regenerateCounterSlug(input: DemoState, merchantId: string): DemoState {
  const s = clone(input);
  const m = getMerchant(s, merchantId);
  if (!m) throw new DemoError("Merchant not found.", "not_found");
  m.retiredCounterSlugs.push(m.counterSlug);
  const suffix = nextId(s, "c").slice(2, 7);
  m.counterSlug = `${m.handle}-${suffix}`;
  return s;
}

/* --------------------------------------------------------------- links */

export interface LinkInput {
  title: string;
  description: string;
  amountMode: "fixed" | "variable";
  fixedInrMinor: number | null;
  minInrMinor: number | null;
  maxInrMinor: number | null;
  reusable: boolean;
  useLimit: number | null;
  expiresAt: number | null;
  allowNote: boolean;
  reference: string;
}

export type LinkErrors = Partial<Record<keyof LinkInput, string>>;

export function validateLink(l: LinkInput, now: number): LinkErrors {
  const e: LinkErrors = {};
  const t = l.title.trim();
  if (t.length < 3 || t.length > 80) e.title = "Title must be 3–80 characters.";
  if (l.description.length > 240) e.description = "Description can be at most 240 characters.";
  const { minInrMinor: min, maxInrMinor: max } = demoConfig.limits;
  const inRange = (v: number) => v >= min && v <= max;
  if (l.amountMode === "fixed") {
    if (l.fixedInrMinor === null) e.fixedInrMinor = "Enter the fixed INR amount.";
    else if (!inRange(l.fixedInrMinor)) e.fixedInrMinor = "Amount must be between ₹1 and ₹10,000 (demo policy).";
  } else {
    if (l.minInrMinor === null) e.minInrMinor = "Enter a minimum amount.";
    else if (!inRange(l.minInrMinor)) e.minInrMinor = "Minimum must be between ₹1 and ₹10,000.";
    if (l.maxInrMinor === null) e.maxInrMinor = "Enter a maximum amount.";
    else if (!inRange(l.maxInrMinor)) e.maxInrMinor = "Maximum must be between ₹1 and ₹10,000.";
    if (l.minInrMinor !== null && l.maxInrMinor !== null && l.minInrMinor > l.maxInrMinor)
      e.maxInrMinor = "Maximum must be greater than or equal to the minimum.";
  }
  if (l.reusable && l.useLimit !== null && (!Number.isInteger(l.useLimit) || l.useLimit < 1 || l.useLimit > 10_000))
    e.useLimit = "Use limit must be a whole number from 1 to 10,000, or unlimited.";
  if (l.expiresAt !== null && l.expiresAt <= now) e.expiresAt = "Expiry must be in the future.";
  if (l.reference.length > 40) e.reference = "Reference can be at most 40 characters.";
  return e;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "pay";
}

export function createLink(input: DemoState, merchantId: string, data: LinkInput, now: number, opts: { duplicatedFrom?: string } = {}): { state: DemoState; link: PaymentLink } {
  const errors = validateLink(data, now);
  if (Object.keys(errors).length) throw new DemoError(Object.values(errors)[0]!, "validation");
  const s = clone(input);
  if (!getMerchant(s, merchantId)) throw new DemoError("Merchant not found.", "not_found");
  const id = nextId(s, "lnk");
  const link: PaymentLink = {
    id,
    merchantId,
    slug: `${slugify(data.title)}-${id.slice(4, 9)}`,
    title: data.title.trim(),
    description: data.description.trim(),
    amountMode: data.amountMode,
    fixedInrMinor: data.amountMode === "fixed" ? data.fixedInrMinor : null,
    minInrMinor: data.amountMode === "variable" ? data.minInrMinor : null,
    maxInrMinor: data.amountMode === "variable" ? data.maxInrMinor : null,
    reusable: data.reusable,
    useLimit: data.reusable ? data.useLimit : 1,
    expiresAt: data.expiresAt,
    allowNote: data.allowNote,
    reference: data.reference.trim(),
    revokedAt: null,
    createdAt: now,
    views: 0,
    duplicatedFrom: opts.duplicatedFrom,
  };
  s.links.push(link);
  return { state: s, link };
}

export function updateLinkMetadata(
  input: DemoState,
  linkId: string,
  patch: Partial<Pick<PaymentLink, "title" | "description" | "reference" | "allowNote">>,
): DemoState {
  const s = clone(input);
  const link = s.links.find((l) => l.id === linkId);
  if (!link) throw new DemoError("Payment link not found.", "not_found");
  if (link.revokedAt) throw new DemoError("Revoked links cannot be edited.", "revoked");
  if (patch.title !== undefined && (patch.title.trim().length < 3 || patch.title.trim().length > 80))
    throw new DemoError("Title must be 3–80 characters.", "validation");
  if (patch.description !== undefined && patch.description.length > 240)
    throw new DemoError("Description can be at most 240 characters.", "validation");
  Object.assign(link, patch);
  return s;
}

export function revokeLink(input: DemoState, linkId: string, now: number): DemoState {
  const s = clone(input);
  const link = s.links.find((l) => l.id === linkId);
  if (!link) throw new DemoError("Payment link not found.", "not_found");
  if (link.revokedAt) return input;
  link.revokedAt = now;
  return s;
}

export function duplicateLink(input: DemoState, linkId: string, now: number) {
  const src = input.links.find((l) => l.id === linkId);
  if (!src) throw new DemoError("Payment link not found.", "not_found");
  return createLink(
    input,
    src.merchantId,
    {
      title: `${src.title} (copy)`.slice(0, 80),
      description: src.description,
      amountMode: src.amountMode,
      fixedInrMinor: src.fixedInrMinor,
      minInrMinor: src.minInrMinor,
      maxInrMinor: src.maxInrMinor,
      reusable: src.reusable,
      useLimit: src.reusable ? src.useLimit : 1,
      expiresAt: src.expiresAt && src.expiresAt > now ? src.expiresAt : null,
      allowNote: src.allowNote,
      reference: src.reference,
    },
    now,
    { duplicatedFrom: src.id },
  );
}

export function recordLinkView(input: DemoState, linkId: string): DemoState {
  const s = clone(input);
  const link = s.links.find((l) => l.id === linkId);
  if (link) link.views += 1;
  return s;
}

/* ------------------------------------------------------------ checkout */

export interface CheckoutInput {
  mode: PaymentMode;
  inrMinor: number;
  privacy: PaymentPrivacy;
  merchantId?: string | null;
  linkId?: string | null;
  recipient?: UpiRecipient | null;
  customerNote?: string;
}

export function createCheckout(input: DemoState, data: CheckoutInput, now: number): { state: DemoState; checkout: CheckoutIntent } {
  const { minInrMinor, maxInrMinor } = demoConfig.limits;
  if (!Number.isInteger(data.inrMinor) || data.inrMinor < minInrMinor || data.inrMinor > maxInrMinor)
    throw new DemoError("Amount must be between ₹1 and ₹10,000 (demo policy).", "validation");

  if (data.mode === "scan_pay") {
    if (!data.recipient || validateVpa(data.recipient.vpa)) throw new DemoError("A valid UPI receiver is required.", "validation");
  } else {
    const merchant = getMerchant(input, data.merchantId);
    if (!merchant) throw new DemoError("Merchant not found.", "not_found");
    if (data.privacy === "transparent" && !merchant.preferences.allowTransparent)
      throw new DemoError("This merchant only accepts shielded ZEC.", "privacy");
  }

  if (data.mode === "payment_link") {
    const link = input.links.find((l) => l.id === data.linkId);
    if (!link || link.merchantId !== data.merchantId) throw new DemoError("Payment link not found.", "not_found");
    const st = linkStatus(input, link, now);
    if (st !== "active") throw new DemoError(`This payment link is ${st}.`, st);
    if (link.amountMode === "fixed" && data.inrMinor !== link.fixedInrMinor)
      throw new DemoError("Amount does not match this link's fixed price.", "validation");
    if (link.amountMode === "variable" && (data.inrMinor < (link.minInrMinor ?? 0) || data.inrMinor > (link.maxInrMinor ?? 0)))
      throw new DemoError(`Enter an amount between ${formatInr(link.minInrMinor ?? 0)} and ${formatInr(link.maxInrMinor ?? 0)}.`, "validation");
  }

  const s = clone(input);
  const id = nextId(s, data.mode === "scan_pay" ? "scn" : "chk");
  const quote = buildDemoQuote({ id: nextId(s, "qt"), inrMinor: data.inrMinor, privacy: data.privacy, now });
  const checkout: CheckoutIntent = {
    id,
    mode: data.mode,
    merchantId: data.mode === "scan_pay" ? null : data.merchantId ?? null,
    linkId: data.linkId ?? null,
    createdAt: now,
    quote,
    privacy: data.privacy,
    receivingAddress: demoReceivingAddress(id),
    qrPayload: demoQrPayload(id, quote.zecZat),
    depositStatus: "awaiting",
    deposit: null,
    recipient: data.recipient ?? null,
    p2pOrderId: null,
    customerNote: (data.customerNote ?? "").slice(0, 140),
    exceptionReason: null,
    events: [
      { at: now, kind: "created", label: "Checkout created", detail: `Quote locked for ${demoConfig.quote.lifetimeMs / 1000}s · unique receiving address issued` },
    ],
    simulated: true,
  };
  if (s.checkouts.some((c) => c.receivingAddress === checkout.receivingAddress)) throw new DemoError("Address collision.", "internal");
  s.checkouts.push(checkout);
  return { state: s, checkout };
}

function findCheckout(s: DemoState, id: string): CheckoutIntent {
  const c = s.checkouts.find((x) => x.id === id);
  if (!c) throw new DemoError("Checkout not found.", "not_found");
  return c;
}

export type SimulatedDeposit = "exact" | "underpaid" | "overpaid";

/** Demo: a deposit to this checkout's unique address was seen by the (simulated) wallet scanner. */
export function simulateDeposit(input: DemoState, checkoutId: string, kind: SimulatedDeposit, now: number): DemoState {
  const s = clone(reconcile(input, now));
  const c = findCheckout(s, checkoutId);
  if (c.deposit) throw new DemoError("A deposit was already recorded for this checkout.", "duplicate");
  if (c.depositStatus !== "awaiting" && c.depositStatus !== "expired") throw new DemoError("This checkout is not awaiting payment.", "state");

  const due = BigInt(c.quote.zecZat);
  const zat = kind === "exact" ? due : kind === "underpaid" ? (due * 60n) / 100n : (due * 125n) / 100n;
  const outputRef = `demo-output:${c.id}:0`;
  if (s.checkouts.some((x) => x.deposit?.outputRef === outputRef)) throw new DemoError("Deposit output already used.", "duplicate");

  c.deposit = {
    id: nextId(s, "dep"),
    checkoutId: c.id,
    outputRef,
    zecZat: zat.toString(),
    privacy: c.privacy,
    detectedAt: now,
    confirmations: 0,
    requiredConfirmations: demoConfig.requiredConfirmations,
    acceptedAt: null,
    simulated: true,
    publicTxid: null,
  };

  const wasExpired = c.depositStatus === "expired";
  if (wasExpired) {
    c.depositStatus = "late";
    c.exceptionReason = "ZEC arrived after the quote expired. It will not be credited at the old rate and is held for recovery.";
    c.events.push({ at: now, kind: "late", label: "Late ZEC detected", detail: `${formatZec(zat)} ZEC arrived after quote expiry` });
    return s;
  }
  if (kind === "underpaid") {
    c.depositStatus = "underpaid";
    c.exceptionReason = `Received ${formatZec(zat)} ZEC, less than the ${formatZec(due)} ZEC due. No credit or payout is issued.`;
    c.events.push({ at: now, kind: "underpaid", label: "Underpayment detected", detail: c.exceptionReason });
    return s;
  }
  if (kind === "overpaid") {
    c.depositStatus = "overpaid";
    c.exceptionReason = `Received ${formatZec(zat)} ZEC, more than the ${formatZec(due)} ZEC due. Held for manual review and refund of the excess.`;
    c.events.push({ at: now, kind: "overpaid", label: "Overpayment detected", detail: c.exceptionReason });
    return s;
  }
  c.depositStatus = "detected";
  c.events.push({ at: now, kind: "detected", label: "ZEC detected", detail: "Wallet scanner saw an incoming payment (0 confirmations)" });

  if (c.merchantId) {
    if (!s.credits.some((cr) => cr.checkoutId === c.id)) {
      s.credits.push({
        id: nextId(s, "crd"),
        merchantId: c.merchantId,
        checkoutId: c.id,
        depositId: c.deposit.id,
        inrMinor: c.quote.inrMinor,
        status: "pending",
        createdAt: now,
        lockedAt: null,
        unlockAt: null,
        availableAt: null,
        withdrawalId: null,
        parentCreditId: null,
      });
      ledger(s, c.merchantId, now, "credit_pending", "memo", c.quote.inrMinor, c.id, "ZEC detected · credit pending verification");
    }
  }
  return s;
}

/** Demo: advance confirmations. detected → confirming → accepted (idempotent effects). */
export function advanceDeposit(input: DemoState, checkoutId: string, now: number): DemoState {
  const s = clone(input);
  const c = findCheckout(s, checkoutId);
  if (!c.deposit) throw new DemoError("No deposit to confirm.", "state");
  if (c.depositStatus === "detected") {
    c.depositStatus = "confirming";
    c.deposit.confirmations = 1;
    c.events.push({ at: now, kind: "confirming", label: "ZEC detected · confirming", detail: `1 of ${c.deposit.requiredConfirmations} confirmations` });
    return s;
  }
  if (c.depositStatus !== "confirming") throw new DemoError("Deposit is not confirming.", "state");
  c.deposit.confirmations = c.deposit.requiredConfirmations;
  c.deposit.acceptedAt = now;

  // Link concurrency: only the first confirmed payment may consume a one-use slot.
  if (c.linkId) {
    const link = s.links.find((l) => l.id === c.linkId)!;
    const st = linkStatus(s, link, now);
    if (st === "exhausted" || st === "revoked") {
      c.depositStatus = "refund_pending";
      c.exceptionReason = `The payment link was ${st} before this payment confirmed. The ZEC is held for refund; no credit is issued.`;
      c.events.push({ at: now, kind: "refund_pending", label: "Held for refund", detail: c.exceptionReason });
      s.credits = s.credits.filter((cr) => cr.checkoutId !== c.id);
      return s;
    }
  }

  c.depositStatus = "accepted";
  c.events.push({ at: now, kind: "accepted", label: "ZEC payment verified", detail: `${c.deposit.requiredConfirmations} confirmations · output accepted once` });

  if (c.merchantId) {
    const credit = s.credits.find((cr) => cr.checkoutId === c.id);
    if (credit && credit.status === "pending") {
      credit.status = "locked";
      credit.lockedAt = now;
      credit.unlockAt = now + cooldownMs();
      ledger(s, c.merchantId, now, "credit_locked", "credit", credit.inrMinor, c.id, `${modeLabel(c.mode)} payment credited · locked for cooldown`);
      c.events.push({ at: now, kind: "credited", label: "Merchant credit locked", detail: `INR credit locked until cooldown ends` });
    }
    issueReceipt(s, c, now);
  } else if (c.mode === "scan_pay" && !c.p2pOrderId) {
    const order: P2POrder = {
      id: nextId(s, "ord"),
      orderType: "PAY",
      orderTypeCode: 2,
      status: "placed",
      matching: false,
      checkoutId: c.id,
      withdrawalId: null,
      inrMinor: c.quote.inrMinor,
      usdcMicro: inrToUsdcMicro(c.quote.inrMinor, c.quote.inrPerUsdcMinor).toString(),
      recipientVpa: c.recipient!.vpa,
      createdAt: now,
      events: [{ at: now, kind: "placed", label: "Order queued", detail: "PAY order (type 2) funded from USDC treasury" }],
      simulated: true,
    };
    s.orders.push(order);
    c.p2pOrderId = order.id;
  }
  return s;
}

function issueReceipt(s: DemoState, c: CheckoutIntent, now: number) {
  if (s.receipts.some((r) => r.checkoutId === c.id)) return;
  const merchant = getMerchant(s, c.merchantId);
  const link = c.linkId ? s.links.find((l) => l.id === c.linkId) : undefined;
  const r: Receipt = {
    id: nextId(s, "rcp"),
    checkoutId: c.id,
    merchantId: c.merchantId,
    mode: c.mode,
    issuedAt: now,
    inrMinor: c.quote.inrMinor,
    totalInrMinor: c.quote.totalInrMinor,
    zecZat: c.deposit?.zecZat ?? c.quote.zecZat,
    privacy: c.privacy,
    merchantName: merchant?.businessName ?? null,
    recipientVpaMasked: c.recipient ? maskVpa(c.recipient.vpa) : null,
    title: link?.title ?? (c.mode === "scan_pay" ? "Scan & Pay" : c.mode === "counter_qr" ? "Counter payment" : "Terminal payment"),
    verification: "simulated",
    simulated: true,
  };
  s.receipts.push(r);
}

export function startRefund(input: DemoState, checkoutId: string, now: number): DemoState {
  const s = clone(input);
  const c = findCheckout(s, checkoutId);
  if (!["underpaid", "overpaid", "late"].includes(c.depositStatus)) throw new DemoError("This payment is not eligible for refund.", "state");
  c.depositStatus = "refund_pending";
  c.events.push({ at: now, kind: "refund_pending", label: "Refund requested", detail: "Refund to a payer-provided ZEC address (demo)" });
  return s;
}

export function completeRefund(input: DemoState, checkoutId: string, now: number): DemoState {
  const s = clone(input);
  const c = findCheckout(s, checkoutId);
  if (c.depositStatus !== "refund_pending") throw new DemoError("No refund is pending.", "state");
  c.depositStatus = "refunded";
  c.events.push({ at: now, kind: "refunded", label: "Refund sent (simulated)", detail: "Demo only — no ZEC moved" });
  return s;
}

/* ---------------------------------------------------------- P2P orders */

const PAY_STEPS = [
  { status: "placed", matching: true, label: "LP matching", detail: "Looking for a liquidity provider" },
  { status: "accepted", matching: false, label: "Accepted by provider", detail: "A liquidity provider accepted the order" },
  { status: "usdc_escrowed", matching: false, label: "USDC escrowed", detail: "Treasury USDC locked in P2P escrow on Base" },
  { status: "inr_processing", matching: false, label: "INR processing", detail: "Provider is sending INR to the UPI receiver" },
  { status: "completed", matching: false, label: "Payout completed", detail: "Provider confirmed the INR transfer (simulated)" },
] as const;

export function advanceOrder(input: DemoState, orderId: string, now: number): DemoState {
  const s = clone(input);
  const o = s.orders.find((x) => x.id === orderId);
  if (!o) throw new DemoError("Order not found.", "not_found");
  if (o.orderType !== "PAY") throw new DemoError("Use withdrawal controls for SELL orders.", "state");
  const idx = o.status === "placed" && !o.matching ? 0 : PAY_STEPS.findIndex((st) => st.status === o.status && st.matching === o.matching) + 1;
  const step = PAY_STEPS[idx];
  if (!step || ["completed", "failed", "cancelled", "disputed"].includes(o.status)) throw new DemoError("Order cannot advance.", "state");
  o.status = step.status;
  o.matching = step.matching;
  o.events.push({ at: now, kind: step.status, label: step.label, detail: step.detail });
  if (o.status === "completed" && o.checkoutId) {
    const c = findCheckout(s, o.checkoutId);
    issueReceipt(s, c, now);
  }
  return s;
}

export function failOrder(input: DemoState, orderId: string, kind: "failed" | "disputed", now: number): DemoState {
  const s = clone(input);
  const o = s.orders.find((x) => x.id === orderId);
  if (!o || o.orderType !== "PAY") throw new DemoError("Order not found.", "not_found");
  if (["completed", "failed", "cancelled"].includes(o.status)) throw new DemoError("Order is already final.", "state");
  o.status = kind;
  o.matching = false;
  o.events.push({
    at: now,
    kind,
    label: kind === "failed" ? "Payout failed" : "Payout disputed",
    detail: kind === "failed" ? "Provider could not complete the INR transfer" : "Provider and receiver disagree on payment status",
  });
  return s;
}

/** Recovery after a failed PAY order: retry with a new order, or route the ZEC to refund. */
export function recoverOrder(input: DemoState, orderId: string, how: "retry" | "refund", now: number): DemoState {
  const s = clone(input);
  const o = s.orders.find((x) => x.id === orderId);
  if (!o || !o.checkoutId) throw new DemoError("Order not found.", "not_found");
  if (o.status !== "failed" && o.status !== "disputed") throw new DemoError("Only failed or disputed payouts can be recovered.", "state");
  const c = findCheckout(s, o.checkoutId);
  o.status = "cancelled";
  o.events.push({ at: now, kind: "cancelled", label: "Order closed for recovery", detail: how === "retry" ? "Retrying with a new order" : "ZEC will be refunded" });
  if (how === "retry") {
    const retry: P2POrder = {
      ...structuredClone(o),
      id: nextId(s, "ord"),
      status: "placed",
      matching: false,
      createdAt: now,
      events: [{ at: now, kind: "placed", label: "Order queued", detail: `Retry of ${o.id}` }],
    };
    s.orders.push(retry);
    c.p2pOrderId = retry.id;
  } else {
    c.depositStatus = "refund_pending";
    c.exceptionReason = "INR payout could not be completed. The ZEC payment is being refunded.";
    c.events.push({ at: now, kind: "refund_pending", label: "Refund requested", detail: c.exceptionReason });
  }
  return s;
}

/* ---------------------------------------------------------- withdrawals */

export function withdrawalQuote(inrMinor: number) {
  const feeInrMinor = bpsOf(inrMinor, demoConfig.withdrawal.spreadBps);
  return {
    feeInrMinor,
    payoutInrMinor: inrMinor - feeInrMinor,
    usdcMicro: inrToUsdcMicro(inrMinor, demoConfig.quote.inrPerUsdcMinor).toString(),
  };
}

export function balances(s: DemoState, merchantId: string) {
  const mine = s.credits.filter((c) => c.merchantId === merchantId);
  const sum = (st: MerchantCredit["status"]) => mine.filter((c) => c.status === st).reduce((a, c) => a + c.inrMinor, 0);
  const pending = sum("pending");
  const locked = sum("locked");
  const available = sum("available");
  const reserved = sum("withdrawal_reserved");
  const withdrawn = sum("withdrawn");
  return {
    pending,
    locked,
    available,
    reserved,
    withdrawn,
    totalReceived: locked + available + reserved + withdrawn,
    liability: pending + locked + available + reserved,
  };
}

/**
 * `opts.payoutProblem` lets connected mode supply the server-side payout destination status (the
 * browser only ever sees a masked VPA, which is deliberately not a valid VPA).
 */
export function withdrawalBlockReason(s: DemoState, merchantId: string, inrMinor: number | null, opts?: { payoutProblem: string | null }): string | null {
  const m = getMerchant(s, merchantId);
  if (!m) return "Merchant not found.";
  const payoutProblem = opts ? opts.payoutProblem : validateVpa(m.payoutUpi) ? "Add a valid payout UPI ID in Settings first." : null;
  if (payoutProblem) return payoutProblem;
  if (s.withdrawals.some((w) => w.merchantId === merchantId && ACTIVE_WITHDRAWAL.includes(w.status)))
    return "You already have a withdrawal in progress. Wait for it to finish before requesting another.";
  if (s.withdrawals.some((w) => w.merchantId === merchantId && w.status === "failed" && !w.recoveredAt))
    return "A failed withdrawal still needs recovery. Restore its funds first.";
  const b = balances(s, merchantId);
  if (b.available <= 0) return b.locked > 0 ? "Your credits are still locked in cooldown. Nothing is available to withdraw yet." : "No available balance to withdraw.";
  if (inrMinor === null) return null;
  if (inrMinor < demoConfig.withdrawal.minInrMinor) return `Minimum withdrawal is ${formatInr(demoConfig.withdrawal.minInrMinor)} (demo policy).`;
  if (inrMinor > b.available) return `Amount exceeds your available balance of ${formatInr(b.available)}. Locked credits cannot be withdrawn.`;
  return null;
}

export function requestWithdrawal(input: DemoState, merchantId: string, inrMinor: number, now: number): { state: DemoState; withdrawal: Withdrawal } {
  const s0 = reconcile(input, now);
  const block = withdrawalBlockReason(s0, merchantId, inrMinor);
  if (block) throw new DemoError(block, "blocked");
  const s = clone(s0);
  const m = getMerchant(s, merchantId)!;
  const wid = nextId(s, "wdr");

  // FIFO reservation from available credits; split the last credit if partially used.
  let remaining = inrMinor;
  const reservedIds: string[] = [];
  const avail = s.credits
    .filter((c) => c.merchantId === merchantId && c.status === "available")
    .sort((a, b) => (a.availableAt ?? 0) - (b.availableAt ?? 0));
  for (const cr of avail) {
    if (remaining <= 0) break;
    if (cr.inrMinor <= remaining) {
      cr.status = "withdrawal_reserved";
      cr.withdrawalId = wid;
      remaining -= cr.inrMinor;
      reservedIds.push(cr.id);
    } else {
      const part: MerchantCredit = { ...cr, id: nextId(s, "crd"), inrMinor: remaining, status: "withdrawal_reserved", withdrawalId: wid, parentCreditId: cr.id };
      cr.inrMinor -= remaining;
      s.credits.push(part);
      reservedIds.push(part.id);
      remaining = 0;
    }
  }
  if (remaining !== 0) throw new DemoError("Could not reserve the requested amount.", "internal");

  const q = withdrawalQuote(inrMinor);
  const order: P2POrder = {
    id: nextId(s, "ord"),
    orderType: "SELL",
    orderTypeCode: 1,
    status: "not_started",
    matching: false,
    checkoutId: null,
    withdrawalId: wid,
    inrMinor: q.payoutInrMinor,
    usdcMicro: q.usdcMicro,
    recipientVpa: m.payoutUpi,
    createdAt: now,
    events: [],
    simulated: true,
  };
  s.orders.push(order);
  const w: Withdrawal = {
    id: wid,
    merchantId,
    inrMinor,
    feeInrMinor: q.feeInrMinor,
    payoutInrMinor: q.payoutInrMinor,
    usdcMicro: q.usdcMicro,
    payoutUpi: m.payoutUpi,
    beneficiaryName: m.beneficiaryName,
    status: "requested",
    createdAt: now,
    updatedAt: now,
    p2pOrderId: order.id,
    reservedCreditIds: reservedIds,
    recoveredAt: null,
    events: [{ at: now, kind: "requested", label: "Withdrawal requested", detail: `${formatInr(inrMinor)} reserved from available balance` }],
    simulated: true,
  };
  s.withdrawals.push(w);
  ledger(s, merchantId, now, "withdrawal_reserved", "debit", inrMinor, wid, "Withdrawal requested · available balance reserved");
  return { state: s, withdrawal: w };
}

const W_STEPS: Array<{ status: WithdrawalStatus; order: P2POrder["status"]; matching: boolean; label: string; detail: string }> = [
  { status: "matching", order: "placed", matching: true, label: "Finding a payout provider", detail: "P2P SELL order placed" },
  { status: "accepted", order: "accepted", matching: false, label: "Provider accepted", detail: "A liquidity provider accepted the SELL order" },
  { status: "escrowed", order: "usdc_escrowed", matching: false, label: "USDC escrowed", detail: "Treasury USDC (incl. fixed fees) approved and escrowed" },
  { status: "processing", order: "inr_processing", matching: false, label: "INR transfer in progress", detail: "Provider is sending INR to your UPI-linked account" },
  { status: "completed", order: "completed", matching: false, label: "Payout completed", detail: "Provider confirmed the INR transfer (simulated)" },
];

function findWithdrawal(s: DemoState, id: string) {
  const w = s.withdrawals.find((x) => x.id === id);
  if (!w) throw new DemoError("Withdrawal not found.", "not_found");
  const o = s.orders.find((x) => x.id === w.p2pOrderId)!;
  return { w, o };
}

export function advanceWithdrawal(input: DemoState, id: string, now: number): DemoState {
  const s = clone(input);
  const { w, o } = findWithdrawal(s, id);
  const idx = w.status === "requested" ? 0 : W_STEPS.findIndex((x) => x.status === w.status) + 1;
  const step = W_STEPS[idx];
  if (!step || idx === 0 && w.status !== "requested") throw new DemoError("Withdrawal cannot advance.", "state");
  if (["completed", "failed", "cancelled", "disputed"].includes(w.status)) throw new DemoError("Withdrawal cannot advance.", "state");
  w.status = step.status;
  w.updatedAt = now;
  w.events.push({ at: now, kind: step.status, label: step.label, detail: step.detail });
  o.status = step.order;
  o.matching = step.matching;
  o.events.push({ at: now, kind: step.order, label: step.label, detail: step.detail });
  if (w.status === "completed") settleWithdrawal(s, w, now);
  return s;
}

function settleWithdrawal(s: DemoState, w: Withdrawal, now: number) {
  for (const cr of s.credits) if (cr.withdrawalId === w.id && cr.status === "withdrawal_reserved") cr.status = "withdrawn";
  ledger(s, w.merchantId, now, "withdrawal_completed", "memo", w.inrMinor, w.id, `Payout completed · ${formatInr(w.payoutInrMinor)} sent by provider (simulated)`);
}

export function failWithdrawal(input: DemoState, id: string, kind: "failed" | "disputed", now: number): DemoState {
  const s = clone(input);
  const { w, o } = findWithdrawal(s, id);
  if (["completed", "failed", "cancelled"].includes(w.status)) throw new DemoError("Withdrawal is already final.", "state");
  w.status = kind;
  w.updatedAt = now;
  o.status = kind;
  o.matching = false;
  const label = kind === "failed" ? "Payout failed" : "Payout disputed";
  const detail = kind === "failed" ? "Provider could not complete the INR transfer. Funds stay reserved until recovery." : "Under review with the provider.";
  w.events.push({ at: now, kind, label, detail });
  o.events.push({ at: now, kind, label, detail });
  return s;
}

export function resolveDispute(input: DemoState, id: string, outcome: "completed" | "failed", now: number): DemoState {
  const s = clone(input);
  const { w, o } = findWithdrawal(s, id);
  if (w.status !== "disputed") throw new DemoError("Withdrawal is not disputed.", "state");
  w.status = outcome;
  o.status = outcome;
  w.updatedAt = now;
  const label = outcome === "completed" ? "Dispute resolved · payout confirmed" : "Dispute resolved · payout failed";
  w.events.push({ at: now, kind: outcome, label });
  o.events.push({ at: now, kind: outcome, label });
  if (outcome === "completed") settleWithdrawal(s, w, now);
  return s;
}

export function cancelWithdrawal(input: DemoState, id: string, now: number): DemoState {
  const s = clone(input);
  const { w, o } = findWithdrawal(s, id);
  if (w.status !== "requested" && w.status !== "matching") throw new DemoError("Only withdrawals that haven't been accepted by a provider can be cancelled.", "state");
  w.status = "cancelled";
  o.status = "cancelled";
  w.updatedAt = now;
  w.events.push({ at: now, kind: "cancelled", label: "Withdrawal cancelled", detail: "Reserved funds returned to available balance" });
  releaseCredits(s, w, now);
  return s;
}

/** Explicit recovery for a failed withdrawal. Restores reserved credits exactly once. */
export function recoverWithdrawal(input: DemoState, id: string, now: number): DemoState {
  const s = clone(input);
  const { w } = findWithdrawal(s, id);
  if (w.status !== "failed") throw new DemoError("Only failed withdrawals can be recovered.", "state");
  if (w.recoveredAt) throw new DemoError("Funds for this withdrawal were already restored.", "duplicate");
  w.events.push({ at: now, kind: "recovered", label: "Funds restored", detail: "Reserved credit returned to available balance" });
  releaseCredits(s, w, now);
  return s;
}

function releaseCredits(s: DemoState, w: Withdrawal, now: number) {
  let released = 0;
  for (const cr of s.credits) {
    if (cr.withdrawalId === w.id && cr.status === "withdrawal_reserved") {
      cr.status = "available";
      cr.withdrawalId = null;
      released += cr.inrMinor;
    }
  }
  w.recoveredAt = now;
  if (released > 0) ledger(s, w.merchantId, now, "withdrawal_released", "credit", released, w.id, "Withdrawal funds restored to available balance");
}

/* ----------------------------------------------------------- treasury */

export function treasurySnapshot(s: DemoState, now: number) {
  const accepted = s.checkouts.filter((c) => c.deposit && (c.depositStatus === "accepted"));
  const held = s.checkouts.filter((c) => c.deposit && ["detected", "confirming", "underpaid", "overpaid", "late", "refund_pending"].includes(c.depositStatus));
  const zecVault = accepted.reduce((a, c) => a + BigInt(c.deposit!.zecZat), 0n);
  const zecPending = held.reduce((a, c) => a + BigInt(c.deposit!.zecZat), 0n);

  const liability = s.credits.filter((c) => c.status !== "withdrawn").reduce((a, c) => a + c.inrMinor, 0);
  const inFlightOrders = s.orders.filter((o) => o.status === "usdc_escrowed" || o.status === "inr_processing" || o.status === "disputed");
  const queuedOrders = s.orders.filter((o) => o.status === "placed" || o.status === "accepted" || o.status === "not_started");
  const spent = s.orders.filter((o) => o.status === "completed").reduce((a, o) => a + BigInt(o.usdcMicro), 0n);
  const inFlight = inFlightOrders.reduce((a, o) => a + BigInt(o.usdcMicro), 0n);
  // Scan & Pay intents awaiting deposit reserve USDC at quote time.
  const scanReserve = s.checkouts
    .filter((c) => c.mode === "scan_pay" && ["awaiting", "detected", "confirming"].includes(c.depositStatus))
    .reduce((a, c) => a + inrToUsdcMicro(c.quote.inrMinor, c.quote.inrPerUsdcMinor), 0n);
  const payQueued = queuedOrders.filter((o) => o.orderType === "PAY").reduce((a, o) => a + BigInt(o.usdcMicro), 0n);
  // Merchant liabilities not already in flight (SELL orders in flight are counted under inFlight).
  const sellInFlightInr = s.withdrawals
    .filter((w) => ["escrowed", "processing", "disputed"].includes(w.status))
    .reduce((a, w) => a + w.inrMinor, 0);
  const liabilityReserve = inrToUsdcMicro(Math.max(0, liability - sellInFlightInr), demoConfig.quote.inrPerUsdcMinor);
  const reserved = liabilityReserve + scanReserve + payQueued;
  const total = BigInt(s.treasuryUsdcTotalMicro) - spent;
  const available = total - reserved - inFlight;
  return {
    at: now,
    source: "demo" as const,
    zecVaultZat: zecVault.toString(),
    zecPendingZat: zecPending.toString(),
    usdcTotalMicro: total.toString(),
    usdcReservedMicro: reserved.toString(),
    usdcInFlightMicro: inFlight.toString(),
    usdcAvailableMicro: available.toString(),
    refillThresholdMicro: demoConfig.treasury.refillThresholdMicro,
    merchantLiabilityInrMinor: liability,
    payoutQueue: queuedOrders.length + inFlightOrders.length,
    rebalancing: available < BigInt(demoConfig.treasury.refillThresholdMicro) ? ("scheduled" as const) : ("idle" as const),
    providerStatus: "simulated" as const,
  };
}

export function modeLabel(mode: PaymentMode): string {
  return mode === "scan_pay" ? "Scan & Pay" : mode === "terminal" ? "Terminal" : mode === "counter_qr" ? "Counter QR" : "Payment link";
}
