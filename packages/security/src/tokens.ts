/**
 * HMAC-SHA256 signed, scoped, expiring tokens (checkout access tokens, CSRF, SSE grants,
 * receipt validation hashes), plus random secret tokens stored only as SHA-256 hashes
 * (session ids, email verification, password reset).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Opaque random secret (base64url). Store sha256Hex(secret) server-side, never the secret. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface ScopedClaims {
  /** e.g. "checkout:pi_xxx" or "withdrawal:wd_xxx" */
  scope: string;
  /** subject: anonymous session id or user id */
  sub: string;
  /** unix seconds */
  exp: number;
  /** token generation, bumped to revoke all tokens for a resource */
  gen?: number;
}

export class ScopedTokenSigner {
  constructor(private secret: string) {
    if (!secret || secret.length < 32) throw new Error("token signing secret must be >= 32 chars");
  }
  sign(claims: ScopedClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  verify(token: string, nowSec = Math.floor(Date.now() / 1000)): ScopedClaims | null {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (!safeEqual(sig, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ScopedClaims;
      if (typeof claims.exp !== "number" || claims.exp < nowSec) return null;
      if (typeof claims.scope !== "string" || typeof claims.sub !== "string") return null;
      return claims;
    } catch {
      return null;
    }
  }
}

/** Deterministic JSON (sorted keys) for idempotency hashing and receipt validation hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(method: string, route: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()} ${route}\n${canonicalJson(body ?? null)}`);
}
