/**
 * Quote formula — version QF-2026-11-01. Pure, exact, deterministic.
 *
 * Inputs are exact integers/rationals taken from verified sources and persisted with the quote:
 *   inrPaise                 what the UPI recipient / merchant invoice is for
 *   p2pSellPrice6            P2P Diamond PriceConfig.sellPrice: INR-per-USDC scaled 1e6
 *                            (consistent with the SDK README: sellPrice = fiat6 * 1e6 / usdc6)
 *   p2pFee                   FeeConfig.smallOrderThreshold + smallOrderFixedFee{Pay|Sell} (USDC micros)
 *   zecUsd                   ZEC/USD market rate (median of verified feeds) as a rational
 *   policy                   platform fee bps, P2P spread reserve bps, volatility premium bps
 *
 * Assumption (documented in docs/QUOTE_FORMULA.md): 1 USDC is valued at 1 USD for the ZEC leg;
 * the volatility premium + treasury FX policy absorb USDC/USD basis risk.
 *
 * Rounding: every amount the treasury must fund rounds UP; nothing rounds in the payer's favour
 * at the treasury's expense.
 */
import { DomainError } from "./errors";
import { bpsCeil, ceilDiv, MICROS_PER_USDC, PAISE_TO_P2P_FIAT, ZAT_PER_ZEC } from "./money";
import { ceilR, mul, rat, type Rational } from "./rational";

export const QUOTE_FORMULA_VERSION = "QF-2026-11-01";

export interface P2PFeeConfig {
  smallOrderThreshold: bigint;
  smallOrderFixedFee: bigint; // PAY or SELL fee, per order type
}

export interface QuotePolicy {
  platformFeeBps: number;
  /** Reserve for P2P spread/price movement between quote and order placement. */
  p2pSpreadReserveBps: number;
  /** Premium on the ZEC leg for ZEC/USD volatility during the funding window. */
  zecVolatilityPremiumBps: number;
}

export interface QuoteInputs {
  inrPaise: bigint;
  p2pSellPrice6: bigint;
  p2pFee: P2PFeeConfig;
  zecUsd: Rational;
  policy: QuotePolicy;
}

export interface QuoteBreakdown {
  formulaVersion: string;
  inrPaise: bigint;
  platformFeeInrPaise: bigint;
  /** USDC the P2P order needs for inrPaise (before fixed fee). */
  usdcForFiatMicros: bigint;
  estimatedP2PFeeUsdcMicros: bigint;
  spreadReserveUsdcMicros: bigint;
  /** USDC the treasury must hold for this payout: fiat + fixed fee + spread reserve. */
  requiredUsdcMicros: bigint;
  platformFeeUsdcMicros: bigint;
  /** USD value (micro) the payer must cover with ZEC, before volatility premium. */
  usdValueMicros: bigint;
  premiumUsdMicros: bigint;
  zecZatoshis: bigint;
  /** INR equivalent of the P2P fixed fee (display), ceil. */
  p2pFeeInrPaise: bigint;
}

/** usdc micros needed to deliver fiat: ceil(fiat6 * 1e6 / sellPrice6), as on-chain. */
export function usdcForInr(inrPaise: bigint, sellPrice6: bigint): bigint {
  if (sellPrice6 <= 0n) throw new DomainError("QUOTE_PRICE_INVALID", "P2P sell price must be positive");
  const fiat6 = inrPaise * PAISE_TO_P2P_FIAT;
  return ceilDiv(fiat6 * MICROS_PER_USDC, sellPrice6);
}

/** P2P small-order fixed fee as charged on-chain: applied when usdc <= threshold. */
export function p2pFixedFee(usdcMicros: bigint, fee: P2PFeeConfig): bigint {
  return usdcMicros <= fee.smallOrderThreshold ? fee.smallOrderFixedFee : 0n;
}

export function computeQuote(i: QuoteInputs): QuoteBreakdown {
  if (i.inrPaise <= 0n) throw new DomainError("QUOTE_AMOUNT_INVALID", "amount must be positive");
  if (i.zecUsd.n === 0n) throw new DomainError("QUOTE_PRICE_INVALID", "ZEC/USD rate must be positive");

  const platformFeeInrPaise = bpsCeil(i.inrPaise, i.policy.platformFeeBps);
  const usdcForFiatMicros = usdcForInr(i.inrPaise, i.p2pSellPrice6);
  const estimatedP2PFeeUsdcMicros = p2pFixedFee(usdcForFiatMicros, i.p2pFee);
  const spreadReserveUsdcMicros = bpsCeil(usdcForFiatMicros, i.policy.p2pSpreadReserveBps);
  const requiredUsdcMicros = usdcForFiatMicros + estimatedP2PFeeUsdcMicros + spreadReserveUsdcMicros;
  const platformFeeUsdcMicros = platformFeeInrPaise === 0n ? 0n : usdcForInr(platformFeeInrPaise, i.p2pSellPrice6);

  const usdValueMicros = requiredUsdcMicros + platformFeeUsdcMicros;
  const premiumUsdMicros = bpsCeil(usdValueMicros, i.policy.zecVolatilityPremiumBps);
  // zat = ceil((usdMicros / 1e6) * 1e8 / zecUsd) = ceil(usdMicros * 100 * zecUsd.d / zecUsd.n)
  const zecZatoshis = ceilR(mul(rat((usdValueMicros + premiumUsdMicros) * (ZAT_PER_ZEC / MICROS_PER_USDC)), rat(i.zecUsd.d, i.zecUsd.n)));

  const p2pFeeInrPaise =
    estimatedP2PFeeUsdcMicros === 0n ? 0n : ceilDiv(estimatedP2PFeeUsdcMicros * i.p2pSellPrice6, MICROS_PER_USDC * PAISE_TO_P2P_FIAT);

  return {
    formulaVersion: QUOTE_FORMULA_VERSION,
    inrPaise: i.inrPaise,
    platformFeeInrPaise,
    usdcForFiatMicros,
    estimatedP2PFeeUsdcMicros,
    spreadReserveUsdcMicros,
    requiredUsdcMicros,
    platformFeeUsdcMicros,
    usdValueMicros,
    premiumUsdMicros,
    zecZatoshis,
    p2pFeeInrPaise,
  };
}

/**
 * Re-derived pull when a PAY order's fiat is updated via setSellOrderUpiWithFiat (SDK README):
 *   sellPrice = floor(order.fiatAmount * 1e6 / order.usdcAmount)
 *   newUsdc   = ceil(updatedFiat * 1e6 / sellPrice)
 *   pull      = newUsdc + (newUsdc <= threshold ? smallOrderFixedFeePay(NOW) : 0)
 */
export function rederivedPayPull(order: { fiatAmount: bigint; usdcAmount: bigint }, updatedFiat6: bigint, feeNow: P2PFeeConfig): bigint {
  if (order.usdcAmount <= 0n) throw new DomainError("P2P_ORDER_MALFORMED", "order usdcAmount is zero");
  const sellPrice = (order.fiatAmount * MICROS_PER_USDC) / order.usdcAmount;
  if (sellPrice <= 0n) throw new DomainError("P2P_ORDER_MALFORMED", "order implied price is zero");
  const newUsdc = ceilDiv(updatedFiat6 * MICROS_PER_USDC, sellPrice);
  return newUsdc + p2pFixedFee(newUsdc, feeNow);
}

/** ZEC received vs. quoted, with a tolerance band in zatoshis (dust / wallet-fee rounding). */
export type PaymentClassification = "exact" | "underpaid" | "overpaid";
export function classifyPayment(receivedZat: bigint, quotedZat: bigint, toleranceZat: bigint): PaymentClassification {
  if (receivedZat + toleranceZat < quotedZat) return "underpaid";
  if (receivedZat > quotedZat + toleranceZat) return "overpaid";
  return "exact";
}
