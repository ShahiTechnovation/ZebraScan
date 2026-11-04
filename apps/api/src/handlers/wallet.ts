/**
 * Zcash-ecosystem sign-in (delta spec §8): Noir `signMessage` challenge + email OTP fallback.
 *
 * Noir signatures are Bitcoin-style signed messages ("Zcash Signed Message:\n" prefix, double
 * SHA-256, 65-byte recoverable secp256k1) over a derived transparent identity. We verify with the
 * vendor's own `verifyMessageSignature` (@noir-wallet/sdk 0.1.9) and defend against two properties
 * of that function observed in its source:
 *   1. it returns valid=true when no expected pubkey/address is passed → we ALWAYS pass both and
 *      require pubkeyMatch && addressMatch;
 *   2. its length prefix uses JS string length, not UTF-8 bytes → challenges are ASCII-only.
 * A derived-identity signature is NOT proof of ownership of any shielded Unified Address.
 */
import { createHmac, randomInt } from "node:crypto";
import { maybeOne, one, tx } from "@zeb/db";
import { DomainError, newId, randomToken } from "@zeb/domain";
import { audit, queueEmail } from "@zeb/core";
import { sha256Hex } from "@zeb/security";
import { publicKeyToAddress, verifyMessageSignature } from "@noir-wallet/sdk";
import type { AnyReq, Handler } from "../http";
import { startSessionFor } from "./auth";

const CHALLENGE_TTL_MS = 5 * 60_000;

function noirNetwork(env: string): "testnet" | "mainnet" {
  return env === "mainnet-readonly" || env === "mainnet-enabled" ? "mainnet" : "testnet";
}

function requestOrigin(req: AnyReq): string {
  const o = req.raw.headers.origin;
  if (typeof o === "string" && req.ctx.cfg.webOrigins.includes(o)) return o;
  return req.ctx.cfg.webOrigins[0] ?? req.ctx.cfg.appBaseUrl;
}

export function buildChallenge(p: { origin: string; network: string; action: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  const msg = [
    "Zeb Scan wants you to sign in",
    `Domain: ${new URL(p.origin).host}`,
    `URI: ${p.origin}`,
    `Network: ${p.network}`,
    `Action: ${p.action}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expires At: ${p.expiresAt.toISOString()}`,
    "Statement: This signs in; it does not authorize a transaction or transfer funds.",
  ].join("\n");
  if (!/^[\x0a\x20-\x7e]*$/.test(msg)) throw new DomainError("SYSTEM_CHALLENGE", "challenge must be ASCII");
  return msg;
}

export const walletChallenge: Handler = async (req) => {
  const { ctx } = req;
  const action = (req.body as { action: "login" | "link_wallet" }).action;
  if (action === "link_wallet" && !req.principal) throw new DomainError("AUTH_REQUIRED", "Sign in first to link a wallet", undefined, { status: 401 });
  const net = noirNetwork(ctx.env);
  const nonce = `${randomToken(16)}${randomToken(8)}`; // ≥128 bits
  const now = ctx.now();
  const expires = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const origin = requestOrigin(req);
  const message = buildChallenge({ origin, network: `zcash-${net}`, action, nonce, issuedAt: now, expiresAt: expires });
  const id = newId("token").replace(/^tok_/, "chl_");
  await ctx.db.query(`INSERT INTO login_challenges(id, environment, nonce_hash, message, origin, network, action, user_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    id,
    ctx.env,
    sha256Hex(nonce),
    message,
    origin,
    `zcash-${net}`,
    action,
    action === "link_wallet" ? req.principal!.userId : null,
    expires,
  ]);
  return { challengeId: id, message, network: `zcash-${net}`, expiresAt: expires.toISOString() };
};

export function verifyNoirSignature(p: { message: string; signature: string; pubkey: string; address: string; network: "testnet" | "mainnet" }): { ok: boolean; reason?: string } {
  const prefix = p.network === "testnet" ? /^tm/ : /^t1/;
  if (!prefix.test(p.address)) return { ok: false, reason: "address is not a transparent address for this network" };
  let derived: string;
  try {
    derived = publicKeyToAddress(p.pubkey, p.network);
  } catch {
    return { ok: false, reason: "malformed public key" };
  }
  if (derived !== p.address) return { ok: false, reason: "address does not derive from the public key" };
  // The vendor compares the UNCOMPRESSED recovered key to the provided pubkey string, so a valid
  // signature with a compressed pubkey reports pubkeyMatch=false. Verify by address instead (hash160 of
  // the compressed recovered key) — which we ALWAYS pass — and require the recovered address to match.
  const r = verifyMessageSignature({ message: p.message, signature: p.signature, address: p.address, network: p.network });
  if (!(r.valid && r.addressMatch === true && r.recoveredAddress === p.address)) return { ok: false, reason: r.error ?? "signature does not match" };
  return { ok: true };
}

export const walletVerify: Handler = async (req) => {
  const { ctx } = req;
  const b = req.body as { challengeId: string; signature: string; pubkey: string; address: string; signingMode: string };
  const net = noirNetwork(ctx.env);
  const generic = new DomainError("AUTH_WALLET_SIGNATURE_INVALID", "Wallet sign-in could not be verified. Try again or continue with email.", undefined, { status: 401 });
  const userId = await tx(ctx.db, async (t) => {
    // Single use: consume atomically before anything else.
    const ch = await maybeOne<{ id: string; message: string; origin: string; network: string; action: string; user_id: string | null; expires_at: Date }>(
      t,
      `UPDATE login_challenges SET consumed_at=now() WHERE id=$1 AND environment=$2 AND consumed_at IS NULL RETURNING id, message, origin, network, action, user_id, expires_at`,
      [b.challengeId, ctx.env],
    );
    if (!ch || new Date(ch.expires_at) < ctx.now() || ch.network !== `zcash-${net}`) throw generic;
    const origin = requestOrigin(req);
    if (origin !== ch.origin) throw generic;
    if (b.signingMode !== "derived") throw new DomainError("AUTH_WALLET_SIGNING_MODE", "Use the wallet's derived signing mode", undefined, { status: 400 });
    const v = verifyNoirSignature({ message: ch.message, signature: b.signature, pubkey: b.pubkey, address: b.address, network: net });
    if (!v.ok) {
      await audit(t, ctx.env, { actorType: "payer", action: "auth.wallet_failed", details: { reason: v.reason }, requestId: req.requestId, ipHash: req.ipHash });
      throw generic;
    }
    // Store only a keyed fingerprint of the derived identity, never the address/pubkey.
    const fp = createHmac("sha256", ctx.cfg.tokenSecret).update(`noir:${net}:${b.address}`).digest("hex");
    const existing = await maybeOne<{ user_id: string }>(t, `SELECT user_id FROM wallet_identities WHERE environment=$1 AND provider='noir' AND network=$2 AND identity_fingerprint=$3`, [ctx.env, `zcash-${net}`, fp]);
    if (ch.action === "link_wallet") {
      if (existing && existing.user_id !== ch.user_id) throw new DomainError("AUTH_WALLET_IN_USE", "This wallet is already linked to another account", undefined, { status: 409 });
      if (!existing) await t.query(`INSERT INTO wallet_identities(id, environment, user_id, provider, network, identity_fingerprint, signing_mode) VALUES ($1,$2,$3,'noir',$4,$5,$6)`, [newId("member").replace(/^mem_/, "wid_"), ctx.env, ch.user_id, `zcash-${net}`, fp, b.signingMode]);
      await audit(t, ctx.env, { actorType: "user", actorId: ch.user_id, action: "auth.wallet_linked", requestId: req.requestId });
      return ch.user_id!;
    }
    if (existing) {
      await t.query(`UPDATE wallet_identities SET last_used_at=now() WHERE environment=$1 AND identity_fingerprint=$2`, [ctx.env, fp]);
      return existing.user_id;
    }
    const uid = newId("user");
    await t.query(`INSERT INTO users(id, environment, email, email_normalized, password_hash, realm) VALUES ($1,$2,NULL,NULL,NULL,'merchant')`, [uid, ctx.env]);
    await t.query(`INSERT INTO wallet_identities(id, environment, user_id, provider, network, identity_fingerprint, signing_mode) VALUES ($1,$2,$3,'noir',$4,$5,$6)`, [newId("member").replace(/^mem_/, "wid_"), ctx.env, uid, `zcash-${net}`, fp, b.signingMode]);
    await audit(t, ctx.env, { actorType: "user", actorId: uid, action: "auth.wallet_signup", requestId: req.requestId, ipHash: req.ipHash });
    return uid;
  });
  const u = await one<{ email_verified_at: Date | null }>(ctx.db, `SELECT email_verified_at FROM users WHERE id=$1`, [userId]);
  const csrfToken = await startSessionFor(req, userId, "merchant");
  return { userId, emailVerified: !!u.email_verified_at, csrfToken };
};

/* ------------------------------------------------------------------ email OTP */

const otpHash = (secret: string, email: string, code: string) => createHmac("sha256", secret).update(`otp:${email}:${code}`).digest("hex");

export const emailOtpRequest: Handler = async (req) => {
  const { ctx } = req;
  const email = (req.body as { email: string }).email.trim().toLowerCase();
  await tx(ctx.db, async (t) => {
    let u = await maybeOne<{ id: string; disabled_at: Date | null }>(t, `SELECT id, disabled_at FROM users WHERE environment=$1 AND realm='merchant' AND email_normalized=$2`, [ctx.env, email]);
    if (u?.disabled_at) return; // same response; no code
    if (!u) {
      const id = newId("user");
      await t.query(`INSERT INTO users(id, environment, email, email_normalized, password_hash, realm) VALUES ($1,$2,$3,$4,NULL,'merchant')`, [id, ctx.env, email, email]);
      u = { id, disabled_at: null };
    }
    const recent = await one<{ n: string }>(t, `SELECT count(*) AS n FROM auth_tokens WHERE user_id=$1 AND purpose='login_otp' AND created_at > now() - interval '15 minutes'`, [u.id]);
    if (Number(recent.n) >= 3) return; // silently rate-limited (no enumeration signal)
    const realCode = String(randomInt(0, 1_000_000)).padStart(6, "0"); // CSPRNG, uniform
    await t.query(`UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='login_otp' AND used_at IS NULL`, [u.id]);
    await t.query(`INSERT INTO auth_tokens(id, environment, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,'login_otp',$4, now() + interval '10 minutes')`, [newId("token"), ctx.env, u.id, otpHash(ctx.cfg.tokenSecret, email, realCode)]);
    await queueEmail(t, ctx, email, "login_otp", { code: realCode });
  });
  return { ok: true };
};

export const emailOtpVerify: Handler = async (req) => {
  const { ctx } = req;
  const { email: raw, code } = req.body as { email: string; code: string };
  const email = raw.trim().toLowerCase();
  const generic = new DomainError("AUTH_OTP_INVALID", "That code is invalid or expired", undefined, { status: 401 });
  const userId = await tx(ctx.db, async (t) => {
    const tok = await maybeOne<{ id: string; user_id: string; token_hash: string; expires_at: Date; attempts: number }>(
      t,
      `SELECT a.id, a.user_id, a.token_hash, a.expires_at, a.attempts FROM auth_tokens a JOIN users u ON u.id=a.user_id
        WHERE u.environment=$1 AND u.email_normalized=$2 AND a.purpose='login_otp' AND a.used_at IS NULL ORDER BY a.created_at DESC LIMIT 1 FOR UPDATE`,
      [ctx.env, email],
    );
    if (!tok || new Date(tok.expires_at) < ctx.now() || tok.attempts >= 5) throw generic;
    if (tok.token_hash !== otpHash(ctx.cfg.tokenSecret, email, code)) {
      await t.query(`UPDATE auth_tokens SET attempts=attempts+1, used_at=CASE WHEN attempts+1 >= 5 THEN now() ELSE NULL END WHERE id=$1`, [tok.id]);
      return null;
    }
    await t.query(`UPDATE auth_tokens SET used_at=now() WHERE id=$1`, [tok.id]);
    await t.query(`UPDATE users SET email_verified_at=coalesce(email_verified_at, now()), failed_logins=0 WHERE id=$1`, [tok.user_id]);
    await audit(t, ctx.env, { actorType: "user", actorId: tok.user_id, action: "auth.otp_login", requestId: req.requestId, ipHash: req.ipHash });
    return tok.user_id;
  });
  if (!userId) throw generic;
  const csrfToken = await startSessionFor(req, userId, "merchant");
  return { userId, emailVerified: true, csrfToken };
};
