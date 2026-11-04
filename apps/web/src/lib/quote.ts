import { demoConfig } from "@/config/demo";
import type { PaymentPrivacy, PaymentQuote } from "@/types/domain";
import { bpsOf, inrToUsdcMicro, usdcMicroToZat } from "./money";

export interface QuoteInput {
  id: string;
  inrMinor: number;
  privacy: PaymentPrivacy;
  now: number;
}

/** Deterministic demo quote. Fees reconcile exactly: total = inr + protocol + platform. */
export function buildDemoQuote({ id, inrMinor, privacy, now }: QuoteInput): PaymentQuote {
  const q = demoConfig.quote;
  const protocolFeeInrMinor = bpsOf(inrMinor, q.protocolFeeBps);
  const platformFeeInrMinor = bpsOf(inrMinor, q.platformFeeBps);
  const totalInrMinor = inrMinor + protocolFeeInrMinor + platformFeeInrMinor;
  const usdc = inrToUsdcMicro(totalInrMinor, q.inrPerUsdcMinor);
  const zat = usdcMicroToZat(usdc, q.usdMicroPerZec);
  return {
    id,
    createdAt: now,
    expiresAt: now + q.lifetimeMs,
    source: "demo",
    provider: q.provider,
    privacy,
    inrMinor,
    protocolFeeBps: q.protocolFeeBps,
    platformFeeBps: q.platformFeeBps,
    protocolFeeInrMinor,
    platformFeeInrMinor,
    totalInrMinor,
    inrPerUsdcMinor: q.inrPerUsdcMinor,
    usdMicroPerZec: q.usdMicroPerZec,
    usdcMicro: usdc.toString(),
    zecZat: zat.toString(),
  };
}

export function isQuoteExpired(quote: PaymentQuote, now: number): boolean {
  return now >= quote.expiresAt;
}

export function validateInrAmount(minor: number | null): string | null {
  if (minor === null) return "Enter an INR amount.";
  if (minor <= 0) return "Amount must be greater than zero.";
  if (minor < demoConfig.limits.minInrMinor) return "Minimum is ₹1 (demo policy).";
  if (minor > demoConfig.limits.maxInrMinor) return "Maximum is ₹10,000 per payment (demo policy).";
  return null;
}
