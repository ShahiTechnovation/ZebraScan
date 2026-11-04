/**
 * Exact non-negative rationals over bigint, used for market rates ("1301.62" USD/ZEC)
 * so that no rate ever touches a binary float.
 */
import { DomainError } from "./errors";

export interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rat(n: bigint, d: bigint = 1n): Rational {
  if (d <= 0n) throw new DomainError("MATH_DIVISOR", "rational denominator must be positive");
  if (n < 0n) throw new DomainError("MATH_NEGATIVE", "rational must be non-negative");
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

/** Parse a plain decimal string (no exponent). Max 18 fractional digits. */
export function parseRational(text: string, field = "rate"): Rational {
  const m = /^(0|[1-9]\d{0,24})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new DomainError("VALIDATION_RATE", `${field} is not a valid decimal`, { field, value: text.slice(0, 40) });
  const frac = m[2] ?? "";
  return rat(BigInt(m[1]! + frac), 10n ** BigInt(frac.length));
}

export function mul(a: Rational, b: Rational): Rational {
  return rat(a.n * b.n, a.d * b.d);
}
export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new DomainError("MATH_DIVISOR", "division by zero rate");
  return rat(a.n * b.d, a.d * b.n);
}
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export function ceilR(a: Rational): bigint {
  return (a.n + a.d - 1n) / a.d;
}
export function floorR(a: Rational): bigint {
  return a.n / a.d;
}

/** Exact decimal string with `places` digits, rounded half-up (display/audit only). */
export function toDecimalString(a: Rational, places = 8): string {
  const scale = 10n ** BigInt(places);
  const scaled = (a.n * scale * 2n + a.d) / (2n * a.d);
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Median of rationals (lower-middle for even counts, conservative for buyers of ZEC). */
export function median(values: Rational[]): Rational {
  if (values.length === 0) throw new DomainError("RATE_NO_SOURCES", "no rate sources");
  const sorted = [...values].sort(cmp);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** |a-b|/min(a,b) in basis points, ceil. */
export function deviationBps(a: Rational, b: Rational): bigint {
  const lo = cmp(a, b) <= 0 ? a : b;
  const hi = lo === a ? b : a;
  // (hi - lo)/lo = (hi.n*lo.d - lo.n*hi.d) / (lo.n*hi.d)
  const num = (hi.n * lo.d - lo.n * hi.d) * 10_000n;
  const den = lo.n * hi.d;
  if (den === 0n) return 10_000n;
  return (num + den - 1n) / den;
}
