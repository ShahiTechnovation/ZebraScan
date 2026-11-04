/**
 * Server-side UPI payload validation (authoritative; the browser parser is UX only).
 * It never follows, fetches or executes anything in the payload.
 *
 * Real-world QRs (GPay, PhonePe, Paytm, BHIM, BharatPe, bank merchant QRs) vary: scheme and keys
 * in any case (UPI://PAY?PA=…), percent-encoding with "+" for spaces, empty or unknown params
 * (aid, ver, mam, qrMedium, gstIn, …), base64 `sign` values, and amounts like "10", "10.0",
 * "10.00" or "100.000". Keep this in step with apps/web/src/lib/upi.ts (the browser copy).
 */
import { DomainError } from "./errors";

/** Signed UPI 2.0 / GST invoice QRs (RSA `sign`, invoice fields) run past 512 characters. */
export const MAX_UPI_PAYLOAD = 1024;
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;
/** Params we read: repeating one with a different value makes the QR ambiguous, so it is rejected. */
const USED_PARAMS = new Set(["pa", "pn", "am", "cu", "tn"]);
/** Present on merchant / dynamic QRs. `mc=0000` (no merchant category) is a person's QR. */
const MERCHANT_PARAMS = ["mc", "tr", "tid", "sign", "orgid", "mid", "msid", "mtid"];

export type QrSupport = "supported" | "supported_with_notice" | "unsupported";

export interface ParsedUpi {
  vpa: string;
  payeeName: string | null;
  amountInrPaise: bigint | null;
  note: string | null;
  merchantParams: string[];
  support: QrSupport;
  notices: string[];
}

export function validateVpa(input: string): string {
  const v = input.trim();
  if (!v || v.length > 120 || !VPA_RE.test(v)) throw new DomainError("QR_VPA_INVALID", "UPI ID must look like name@handle");
  return v;
}

/** Control, markup-significant and bidi-override characters (payee names are shown to the payer). */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>"'`‎‏‪-‮⁦-⁩]/g;

function sanitizeText(v: string | null | undefined, max: number): string | null {
  if (!v) return null;
  const clean = v.replace(UNSAFE_CHARS, "").trim().slice(0, max);
  return clean || null;
}

/**
 * Query params with lower-cased keys and trimmed, percent-decoded values ("+" is a space).
 * Empty values count as absent. A param we use that repeats with another value is rejected.
 */
function readParams(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, raw] of new URLSearchParams(query)) {
    const key = k.trim().toLowerCase();
    const v = raw.trim();
    if (!key) continue;
    const prev = out.get(key);
    if (!prev) out.set(key, v);
    else if (v && v !== prev && USED_PARAMS.has(key)) throw new DomainError("QR_DUPLICATE_PARAM", `QR repeats parameter "${key.slice(0, 8)}" with different values`);
  }
  return out;
}

/** Paise from "10", "10.5", "10.00", "10.", ".5" or "100.000"; signs, exponents and sub-paise are invalid. */
function parseQrAmount(am: string | undefined): bigint | null {
  if (!am) return null;
  const m = /^(\d{0,7})(?:\.(\d{0,6}))?$/.exec(am);
  const frac = m?.[2] ?? "";
  if (!m || (!m[1] && !m[2]) || /[1-9]/.test(frac.slice(2))) throw new DomainError("QR_AMOUNT_INVALID", "Amount encoded in this QR is invalid");
  const paise = BigInt(m[1] || "0") * 100n + BigInt((frac + "00").slice(0, 2));
  if (paise <= 0n) throw new DomainError("QR_AMOUNT_INVALID", "QR amount must be greater than zero");
  return paise;
}

export function parseUpiPayload(raw: string): ParsedUpi {
  const input = raw.trim();
  if (!input) throw new DomainError("QR_EMPTY", "No QR data found");
  if (input.length > MAX_UPI_PAYLOAD) throw new DomainError("QR_TOO_LONG", "QR payload is unusually long and was rejected");
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new DomainError("QR_CONTROL_CHARS", "QR data contains control characters");
  const lower = input.toLowerCase();
  if (!lower.startsWith("upi://pay?")) {
    if (lower.startsWith("upi://")) throw new DomainError("QR_UNSUPPORTED_ACTION", "Only upi://pay codes are supported (not mandates or other UPI actions)");
    if (/^000201/.test(input)) throw new DomainError("QR_NOT_UPI", "This is a BharatQR / card-network code, not a UPI payment QR");
    throw new DomainError("QR_NOT_UPI", "This is not a UPI payment QR");
  }
  const params = readParams(input.slice(input.indexOf("?") + 1));
  const pa = params.get("pa");
  if (!pa) throw new DomainError("QR_MISSING_VPA", "QR is missing the receiver UPI ID (pa)");
  const vpa = validateVpa(pa);
  const cu = params.get("cu");
  if (cu && cu.toUpperCase() !== "INR") throw new DomainError("QR_CURRENCY", "Only INR UPI QR codes are supported");

  const amountInrPaise = parseQrAmount(params.get("am"));
  const mc = params.get("mc");
  const merchantParams = MERCHANT_PARAMS.filter((k) => (k === "mc" ? !!mc && !/^0+$/.test(mc) : !!params.get(k)));
  const notices: string[] = [];
  let support: QrSupport = "supported";
  if (merchantParams.length) {
    support = "supported_with_notice";
    notices.push("This is a merchant/dynamic UPI QR. The payout provider pays the UPI ID shown; merchant reference fields may not be carried through.");
  }
  if (params.get("sign")) notices.push("Signed QR parameters are not verified by Zeb Scan.");
  const payeeName = sanitizeText(params.get("pn"), 80);
  if (payeeName) notices.push("Payee name comes from the QR and is not independently verified.");
  return { vpa, payeeName, amountInrPaise, note: sanitizeText(params.get("tn"), 80), merchantParams, support, notices };
}

/** "monsoon.chai@okaxis" -> "mo•••••i@okaxis". Never log a full VPA. */
export function maskVpa(vpa: string): string {
  const [user, host] = vpa.split("@");
  if (!host || !user) return "•••";
  if (user.length <= 3) return `${user[0]}••@${host}`;
  return `${user.slice(0, 2)}${"•".repeat(Math.min(5, user.length - 3))}${user.slice(-1)}@${host}`;
}
