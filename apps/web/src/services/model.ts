/** Presentation and validation only. Payment facts come from the server. */
import type { DemoState, MerchantCredit, PaymentMode, PaymentLink, PaymentLinkStatus } from '@/types/domain';
import { validateVpa } from '@/lib/upi';
export function emptyState(now: number): DemoState {
  return { version: 1, seededAt: now, clockOffsetMs: 0,
    session: {merchantId:null, startedAt:null, opsUnlocked:false},
    merchants:[], links:[], checkouts:[], credits:[], ledger:[], orders:[], withdrawals:[], receipts:[], treasuryUsdcTotalMicro:'0', counter:0 };
}
export function linkSuccessfulUses(s: DemoState, id: string): number { return s.links.find(l=>l.id===id)?.liveSuccessfulUses ?? 0; }
export function linkStatus(_s: DemoState, link: PaymentLink, _now: number): PaymentLinkStatus { return link.liveStatus ?? 'expired'; }
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
    e.handle = "That handle is already used.";
  if (!input.category) e.category = "Choose a business category.";
  const vpaErr = validateVpa(input.payoutUpi);
  if (input.payoutUpi && vpaErr) e.payoutUpi = vpaErr;
  const b = input.beneficiaryName.trim();
  if (b && (b.length < 2 || b.length > 60)) e.beneficiaryName = "Beneficiary display name must be 2–60 characters.";
  return e;
}

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
  const min = 1; const max = Number.MAX_SAFE_INTEGER;
  const inRange = (v: number) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (l.amountMode === "fixed") {
    if (l.fixedInrMinor === null) e.fixedInrMinor = "Enter the fixed INR amount.";
    else if (!inRange(l.fixedInrMinor)) e.fixedInrMinor = "Enter a positive amount within the server limits.";
  } else {
    if (l.minInrMinor === null) e.minInrMinor = "Enter a minimum amount.";
    else if (!inRange(l.minInrMinor)) e.minInrMinor = "Enter a positive minimum.";
    if (l.maxInrMinor === null) e.maxInrMinor = "Enter a maximum amount.";
    else if (!inRange(l.maxInrMinor)) e.maxInrMinor = "Enter a positive maximum.";
    if (l.minInrMinor !== null && l.maxInrMinor !== null && l.minInrMinor > l.maxInrMinor)
      e.maxInrMinor = "Maximum must be greater than or equal to the minimum.";
  }
  if (l.reusable && l.useLimit !== null && (!Number.isInteger(l.useLimit) || l.useLimit < 1 || l.useLimit > 10_000))
    e.useLimit = "Use limit must be a whole number from 1 to 10,000, or unlimited.";
  if (l.expiresAt !== null && l.expiresAt <= now) e.expiresAt = "Expiry must be in the future.";
  if (l.reference.length > 40) e.reference = "Reference can be at most 40 characters.";
  return e;
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

export function modeLabel(mode: PaymentMode): string {
  return mode === "scan_pay" ? "Scan & Pay" : mode === "terminal" ? "Terminal" : mode === "counter_qr" ? "Counter QR" : "Payment link";
}
