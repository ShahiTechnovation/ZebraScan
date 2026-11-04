/** Exact money helpers. INR paise as integer numbers; ZEC/USDC as bigint strings. */

export const ZAT_PER_ZEC = 100_000_000n;
export const MICRO_PER_USDC = 1_000_000n;

const groupFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatInr(minor: number, opts: { whole?: boolean; symbol?: boolean } = {}): string {
  const { whole = false, symbol = true } = opts;
  const sign = minor < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(minor));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const body =
    whole && paise === 0 ? groupFmt.format(rupees) : `${groupFmt.format(rupees)}.${paise.toString().padStart(2, "0")}`;
  return `${sign}${symbol ? "₹" : ""}${body}`;
}

/** Parse user INR text ("1,250.5") into paise. Returns null if invalid. */
export function parseInrToMinor(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, "");
  if (cleaned === "") return null;
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(cleaned)) return null;
  const [r, p = ""] = cleaned.split(".");
  return Number(r) * 100 + Number((p + "00").slice(0, 2));
}

export function minorToInputString(minor: number): string {
  const r = Math.floor(minor / 100);
  const p = minor % 100;
  return p === 0 ? String(r) : `${r}.${p.toString().padStart(2, "0")}`;
}

/** Exact decimal ZEC string, up to 8 places. `fixed` always prints 8 decimals. */
export function formatZec(zat: string | bigint, opts: { fixed?: boolean } = {}): string {
  const v = typeof zat === "bigint" ? zat : BigInt(zat);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ZAT_PER_ZEC;
  const frac = (abs % ZAT_PER_ZEC).toString().padStart(8, "0");
  const fracOut = opts.fixed ? frac : frac.replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracOut}`;
}

export function formatUsdc(micro: string | bigint): string {
  const v = typeof micro === "bigint" ? micro : BigInt(micro);
  const whole = v / MICRO_PER_USDC;
  const frac = (v % MICRO_PER_USDC).toString().padStart(6, "0").slice(0, 2);
  return `${new Intl.NumberFormat("en-US").format(Number(whole))}.${frac}`;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Fee in paise for a basis-point rate, rounded half-up. */
export function bpsOf(minor: number, bps: number): number {
  return Math.floor((minor * bps + 5_000) / 10_000);
}

export function sumBig(values: Array<string | bigint>): bigint {
  return values.reduce<bigint>((acc, v) => acc + (typeof v === "bigint" ? v : BigInt(v)), 0n);
}

/** INR paise → USDC micro at a paise-per-USDC rate (ceil, so treasury coverage is never short). */
export function inrToUsdcMicro(inrMinor: number, inrPerUsdcMinor: number): bigint {
  return ceilDiv(BigInt(inrMinor) * MICRO_PER_USDC, BigInt(inrPerUsdcMinor));
}

/** USDC micro → ZEC zatoshi at USD-micro-per-ZEC (assumes USDC≈USD, ceil). */
export function usdcMicroToZat(usdcMicro: bigint, usdMicroPerZec: number): bigint {
  return ceilDiv(usdcMicro * ZAT_PER_ZEC, BigInt(usdMicroPerZec));
}
