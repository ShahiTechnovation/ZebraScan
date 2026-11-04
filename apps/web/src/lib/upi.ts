/**
 * Conservative UPI QR / VPA parser. It never navigates to or executes the payload;
 * it only extracts fields we can display for the payer to verify.
 *
 * Real-world QRs (GPay, PhonePe, Paytm, BHIM, BharatPe, bank merchant QRs) vary: scheme and keys
 * in any case (UPI://PAY?PA=…), percent-encoding with "+" for spaces, empty or unknown params
 * (aid, ver, mam, qrMedium, gstIn, …), base64 `sign` values, and amounts like "10", "10.0",
 * "10.00" or "100.000". Keep this in step with packages/domain/src/upi.ts (the server copy).
 */

export interface ParsedUpi {
  vpa: string;
  payeeName?: string;
  amountMinor?: number;
  note?: string;
  /** Signed / merchant dynamic QR parameters present — may not be supported. */
  hasMerchantParams: boolean;
}

export type UpiParseResult = { ok: true; value: ParsedUpi } | { ok: false; error: string };

/** Signed UPI 2.0 / GST invoice QRs (RSA `sign`, invoice fields) run past 512 characters. */
export const MAX_UPI_PAYLOAD = 1024;
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;
/** Params we read: repeating one with a different value makes the QR ambiguous, so it is rejected. */
const USED_PARAMS = new Set(["pa", "pn", "am", "cu", "tn"]);
/** Present on merchant / dynamic QRs. `mc=0000` (no merchant category) is a person's QR. */
const MERCHANT_PARAMS = ["mc", "tr", "tid", "sign", "orgid", "mid", "msid", "mtid"];
/** Control, markup-significant and bidi-override characters (payee names are shown to the payer). */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f<>"'`‎‏‪-‮⁦-⁩]/g;

export function validateVpa(input: string): string | null {
  const v = input.trim();
  if (!v) return "Enter a UPI ID.";
  if (v.length > 120) return "That UPI ID is too long.";
  if (!VPA_RE.test(v)) return "Use the format name@handle — letters, numbers, dot, dash or underscore.";
  return null;
}

/**
 * Query params with lower-cased keys and trimmed, percent-decoded values ("+" is a space).
 * Empty values count as absent. Returns the key when a param we use repeats with another value.
 */
function readParams(query: string): Map<string, string> | { duplicate: string } {
  const out = new Map<string, string>();
  for (const [k, raw] of new URLSearchParams(query)) {
    const key = k.trim().toLowerCase();
    const v = raw.trim();
    if (!key) continue;
    const prev = out.get(key);
    if (!prev) out.set(key, v);
    else if (v && v !== prev && USED_PARAMS.has(key)) return { duplicate: key.slice(0, 8) };
  }
  return out;
}

/** Paise from "10", "10.5", "10.00", "10.", ".5" or "100.000"; "invalid" for signs, exponents or sub-paise. */
function parseQrAmount(am: string | undefined): number | null | "invalid" {
  if (!am) return null;
  const m = /^(\d{0,7})(?:\.(\d{0,6}))?$/.exec(am);
  if (!m || (!m[1] && !m[2])) return "invalid";
  const frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(2))) return "invalid";
  return Number(m[1] || "0") * 100 + Number((frac + "00").slice(0, 2));
}

function cleanText(v: string | undefined): string | undefined {
  const clean = v?.replace(UNSAFE_TEXT, "").trim().slice(0, 80);
  return clean || undefined;
}

export function parseUpiPayload(raw: string): UpiParseResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: "No QR data found." };
  if (input.length > MAX_UPI_PAYLOAD) return { ok: false, error: "This QR payload is unusually long and was rejected." };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, error: "The QR data contains unsupported control characters." };

  const lower = input.toLowerCase();
  if (!lower.startsWith("upi://pay?")) {
    if (lower.startsWith("upi://")) {
      return { ok: false, error: "Only upi://pay QR codes are supported (not mandates or other UPI actions)." };
    }
    if (/^000201/.test(input)) {
      return { ok: false, error: "This is a BharatQR / card-network code, not a UPI payment QR. Ask for the merchant's UPI QR, or enter their UPI ID." };
    }
    if (/^[a-z][a-z0-9+.-]*:/.test(lower)) {
      return { ok: false, error: "This is not a UPI payment QR. Zeb Scan only reads upi://pay codes." };
    }
    return { ok: false, error: "This doesn't look like a UPI payment QR." };
  }

  const params = readParams(input.slice(input.indexOf("?") + 1));
  if (!(params instanceof Map)) return { ok: false, error: `The QR repeats "${params.duplicate}" with different values, so it was rejected.` };

  const pa = params.get("pa");
  if (!pa) return { ok: false, error: "The QR is missing the receiver UPI ID (pa)." };
  if (validateVpa(pa)) return { ok: false, error: "The receiver UPI ID in this QR is malformed." };

  const cu = params.get("cu");
  if (cu && cu.toUpperCase() !== "INR") {
    return { ok: false, error: `Unsupported currency "${cu.slice(0, 8)}". Only INR is supported.` };
  }

  const amount = parseQrAmount(params.get("am"));
  if (amount === "invalid") return { ok: false, error: "The amount encoded in this QR is invalid." };
  if (amount === 0) return { ok: false, error: "The QR amount must be greater than zero." };

  const mc = params.get("mc");
  const hasMerchantParams = MERCHANT_PARAMS.some((k) => (k === "mc" ? !!mc && !/^0+$/.test(mc) : !!params.get(k)));

  return {
    ok: true,
    value: {
      vpa: pa,
      payeeName: cleanText(params.get("pn")),
      amountMinor: amount ?? undefined,
      note: cleanText(params.get("tn")),
      hasMerchantParams,
    },
  };
}

/** Mask a VPA for public receipts: "monsoon.chai@zebdemo" → "mo•••••i@zebdemo". */
export function maskVpa(vpa: string): string {
  const [user, host] = vpa.split("@");
  if (!host || !user) return "•••";
  if (user.length <= 3) return `${user[0]}••@${host}`;
  return `${user.slice(0, 2)}${"•".repeat(Math.min(5, user.length - 3))}${user.slice(-1)}@${host}`;
}
