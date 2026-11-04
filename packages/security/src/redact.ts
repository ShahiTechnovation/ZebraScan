/**
 * Log/telemetry redaction. Applied by the API logger serializers and every outbound alert.
 * Never let a VPA, viewing key, seed, private key, Zcash address, memo, password, token or
 * cookie reach logs or third-party telemetry.
 */
const SENSITIVE_KEYS = /(password|secret|token|cookie|authorization|private|seed|mnemonic|viewing|ufvk|uivk|spend|vpa|upi|payee|memo|address|email|phone|kek|dek|relay)/i;

const PATTERNS: Array<[RegExp, string]> = [
  // Same shape as the VPA validators in packages/domain/src/upi.ts and apps/web/src/lib/upi.ts (1-char names allowed).
  [/\b[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}@[a-zA-Z][a-zA-Z0-9.-]{1,48}\b/g, "[vpa-or-email]"],
  [/\b(u|utest|uregtest|zs|ztestsapling|uview|uivk|zxview)1[02-9ac-hj-np-z]{20,}\b/g, "[zcash-redacted]"],
  [/\bt[123m][1-9A-HJ-NP-Za-km-z]{33}\b/g, "[t-addr]"],
  [/\b0x[0-9a-fA-F]{64}\b/g, "[hex32]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
