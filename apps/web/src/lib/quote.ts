import { demoConfig } from "@/config/demo";
import type { PaymentPrivacy, PaymentQuote } from "@/types/domain";
import { bpsOf, inrToUsdcMicro, usdcMicroToZat } from "./money";
import { latestLiveRates, type LiveRates } from "./liveRates";

export interface QuoteInput {
  id: string;
  inrMinor: number;
  privacy: PaymentPrivacy;
  now: number;
}

/**
 * Demo quote. Fees reconcile exactly: total = inr + protocol + platform.
 * Uses LIVE market reference rates (CoinGecko + Kraken median via /api/rates) whenever they were
 * fetched in the last 2 minutes; only falls back to the labelled demo constants when no live rate is
 * available (e.g. offline or in unit tests).
 */
export function buildDemoQuote({ id, inrMinor, privacy, now, rates }: QuoteInput & { rates?: LiveRates | null }): PaymentQuote {
  const q = demoConfig.quote;
  const live = rates === undefined ? latestLiveRates() : rates;
  const usdMicroPerZec = live?.usdMicroPerZec ?? q.usdMicroPerZec;
  const inrPerUsdcMinor = live?.inrPerUsdcMinor ?? q.inrPerUsdcMinor;
  const protocolFeeInrMinor = bpsOf(inrMinor, q.protocolFeeBps);
  const platformFeeInrMinor = bpsOf(inrMinor, q.platformFeeBps);
  const totalInrMinor = inrMinor + protocolFeeInrMinor + platformFeeInrMinor;
  const usdc = inrToUsdcMicro(totalInrMinor, inrPerUsdcMinor);
  const zat = usdcMicroToZat(usdc, usdMicroPerZec);
  return {
    id,
    createdAt: now,
    expiresAt: now + q.lifetimeMs,
    source: live ? "live" : "demo",
    provider: live ? live.provider : `${q.provider} (live rate unavailable)`,
    privacy,
    inrMinor,
    protocolFeeBps: q.protocolFeeBps,
    platformFeeBps: q.platformFeeBps,
    protocolFeeInrMinor,
    platformFeeInrMinor,
    totalInrMinor,
    inrPerUsdcMinor,
    usdMicroPerZec,
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
