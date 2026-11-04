/**
 * Server-side UPI payload validation (authoritative; the browser parser is UX only).
 * It never follows, fetches or executes anything in the payload.
 */
import { DomainError } from "./errors";

export const MAX_UPI_PAYLOAD = 512;
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;

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

const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>"'`]/g;

function sanitizeText(v: string | null, max: number): string | null {
  if (!v) return null;
  const clean = v.replace(UNSAFE_CHARS, "").trim().slice(0, max);
  return clean || null;
}

export function parseUpiPayload(raw: string): ParsedUpi {
  const input = raw.trim();
  if (!input) throw new DomainError("QR_EMPTY", "No QR data found");
  if (input.length > MAX_UPI_PAYLOAD) throw new DomainError("QR_TOO_LONG", "QR payload is unusually long and was rejected");
  if (/[\u0000-\u001f]/.test(input)) throw new DomainError("QR_CONTROL_CHARS", "QR data contains control characters");
  const lower = input.toLowerCase();
  if (!lower.startsWith("upi://pay?")) {
    if (lower.startsWith("upi://")) throw new DomainError("QR_UNSUPPORTED_ACTION", "Only upi://pay codes are supported (not mandates or other UPI actions)");
    throw new DomainError("QR_NOT_UPI", "This is not a UPI payment QR");
  }
  const params = new URLSearchParams(input.slice(input.indexOf("?") + 1));
  for (const k of new Set(params.keys())) {
    if (params.getAll(k).length > 1) throw new DomainError("QR_DUPLICATE_PARAM", `QR repeats parameter "${k.slice(0, 8)}"`);
  }
  const pa = params.get("pa");
  if (!pa) throw new DomainError("QR_MISSING_VPA", "QR is missing the receiver UPI ID (pa)");
  const vpa = validateVpa(pa);
  const cu = params.get("cu");
  if (cu && cu.toUpperCase() !== "INR") throw new DomainError("QR_CURRENCY", "Only INR UPI QR codes are supported");

  let amountInrPaise: bigint | null = null;
  const am = params.get("am")?.trim();
  if (am) {
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(am)) throw new DomainError("QR_AMOUNT_INVALID", "Amount encoded in this QR is invalid");
    const [r, p = ""] = am.split(".");
    amountInrPaise = BigInt(r!) * 100n + BigInt((p + "00").slice(0, 2));
    if (amountInrPaise <= 0n) throw new DomainError("QR_AMOUNT_INVALID", "QR amount must be greater than zero");
  }
  const merchantParams = ["mc", "tr", "tid", "sign", "mode", "orgid", "mid", "msid", "mtid"].filter((k) => params.has(k));
  const notices: string[] = [];
  let support: QrSupport = "supported";
  if (merchantParams.length) {
    support = "supported_with_notice";
    notices.push("This is a merchant/dynamic UPI QR. The payout provider pays the UPI ID shown; merchant reference fields may not be carried through.");
  }
  if (params.has("sign")) notices.push("Signed QR parameters are not verified by Zeb Scan.");
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
