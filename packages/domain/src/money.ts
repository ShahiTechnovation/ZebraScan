/**
 * Exact money primitives. NO JavaScript floating point is used for any amount.
 *  - INR:       integer paise          (decimals 2)
 *  - ZEC:       integer zatoshis       (decimals 8)
 *  - USDC_BASE: integer micro-units    (decimals 6)  — Base native USDC, internal only
 * On the wire every amount is a base-10 integer STRING.
 */
import { DomainError } from "./errors";

export type AssetCode = "INR" | "ZEC" | "USDC_BASE";
export const ASSET_DECIMALS: Record<AssetCode, number> = { INR: 2, ZEC: 8, USDC_BASE: 6 };

export interface Money {
  asset: AssetCode;
  minor: string;
  decimals: number;
}

export const ZAT_PER_ZEC = 100_000_000n;
export const MICROS_PER_USDC = 1_000_000n;
export const PAISE_PER_INR = 100n;
/** P2P.me fiat amounts are 6-decimal scaled (see official example: parseUnits("85", 6)). */
export const P2P_FIAT_SCALE = 1_000_000n;
export const PAISE_TO_P2P_FIAT = P2P_FIAT_SCALE / PAISE_PER_INR; // 10_000n

const INT_RE = /^-?(0|[1-9]\d*)$/;
const UINT_RE = /^(0|[1-9]\d*)$/;

/** Parse a wire integer string. Rejects floats, exponents, whitespace, leading zeros. */
export function parseMinor(value: string, field = "amount", opts: { allowNegative?: boolean } = {}): bigint {
  if (typeof value !== "string" || !(opts.allowNegative ? INT_RE : UINT_RE).test(value)) {
    throw new DomainError("VALIDATION_AMOUNT", `${field} must be a base-10 integer string`, { field });
  }
  if (value.length > 30) throw new DomainError("VALIDATION_AMOUNT", `${field} is out of range`, { field });
  return BigInt(value);
}

export function money(asset: AssetCode, minor: bigint): Money {
  return { asset, minor: minor.toString(), decimals: ASSET_DECIMALS[asset] };
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new DomainError("MATH_DIVISOR", "divisor must be positive");
  if (a < 0n) throw new DomainError("MATH_NEGATIVE", "ceilDiv expects a non-negative dividend");
  return (a + b - 1n) / b;
}

export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new DomainError("MATH_DIVISOR", "divisor must be positive");
  if (a < 0n) throw new DomainError("MATH_NEGATIVE", "floorDiv expects a non-negative dividend");
  return a / b;
}

/** Basis-point fee, rounded UP (never undercharge a fee that funds a payout). */
export function bpsCeil(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new DomainError("VALIDATION_BPS", "bps must be an integer 0..10000");
  return ceilDiv(amount * BigInt(bps), 10_000n);
}

/** Exact decimal string for a minor amount: formatMinor(123456789n, 8) -> "1.23456789". */
export function formatMinor(minor: bigint, decimals: number, opts: { trim?: boolean } = {}): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, "0");
  if (opts.trim) frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Parse a decimal string ("1301.62") into minor units at `decimals`, rejecting extra precision. */
export function parseDecimalToMinor(text: string, decimals: number, field = "amount"): bigint {
  const t = text.trim();
  const re = new RegExp(`^(0|[1-9]\\d{0,20})(?:\\.(\\d{1,${decimals}}))?$`);
  const m = re.exec(t);
  if (!m) throw new DomainError("VALIDATION_AMOUNT", `${field} must be a decimal with at most ${decimals} places`, { field });
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function sum(values: Iterable<bigint>): bigint {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
