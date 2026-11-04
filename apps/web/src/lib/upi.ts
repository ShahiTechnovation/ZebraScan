/**
 * Conservative UPI QR / VPA parser. It never navigates to or executes the payload;
 * it only extracts fields we can display for the payer to verify.
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

export const MAX_UPI_PAYLOAD = 512;
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;

export function validateVpa(input: string): string | null {
  const v = input.trim();
  if (!v) return "Enter a UPI ID.";
  if (v.length > 120) return "That UPI ID is too long.";
  if (!VPA_RE.test(v)) return "Use the format name@handle — letters, numbers, dot, dash or underscore.";
  return null;
}

export function parseUpiPayload(raw: string): UpiParseResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: "No QR data found." };
  if (input.length > MAX_UPI_PAYLOAD) return { ok: false, error: "This QR payload is unusually long and was rejected." };
  if (/[\u0000-\u001f]/.test(input)) return { ok: false, error: "The QR data contains unsupported control characters." };

  const lower = input.toLowerCase();
  if (!lower.startsWith("upi://pay?")) {
    if (lower.startsWith("upi://")) {
      return { ok: false, error: "Only upi://pay QR codes are supported (not mandates or other UPI actions)." };
    }
    if (/^[a-z][a-z0-9+.-]*:/.test(lower)) {
      return { ok: false, error: "This is not a UPI payment QR. Zeb Scan only reads upi://pay codes." };
    }
    return { ok: false, error: "This doesn't look like a UPI payment QR." };
  }

  const params = new URLSearchParams(input.slice(input.indexOf("?") + 1));

  const pa = params.get("pa")?.trim();
  if (!pa) return { ok: false, error: "The QR is missing the receiver UPI ID (pa)." };
  if (validateVpa(pa)) return { ok: false, error: "The receiver UPI ID in this QR is malformed." };

  const cu = params.get("cu");
  if (cu && cu.toUpperCase() !== "INR") {
    return { ok: false, error: `Unsupported currency "${cu.slice(0, 8)}". Only INR is supported.` };
  }

  let amountMinor: number | undefined;
  const am = params.get("am");
  if (am !== null && am.trim() !== "") {
    const a = am.trim();
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(a)) return { ok: false, error: "The amount encoded in this QR is invalid." };
    const [r, p = ""] = a.split(".");
    amountMinor = Number(r) * 100 + Number((p + "00").slice(0, 2));
    if (amountMinor <= 0) return { ok: false, error: "The QR amount must be greater than zero." };
  }

  const pnRaw = params.get("pn")?.trim();
  const payeeName = pnRaw ? pnRaw.replace(/[<>]/g, "").slice(0, 80) : undefined;
  const tn = params.get("tn")?.trim();
  const hasMerchantParams = ["mc", "tr", "tid", "sign", "mode", "orgid"].some((k) => params.has(k));

  return {
    ok: true,
    value: {
      vpa: pa,
      payeeName: payeeName || undefined,
      amountMinor,
      note: tn ? tn.slice(0, 80) : undefined,
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
