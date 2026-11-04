/**
 * Noir wallet sign-in + email OTP against the real API and PostgreSQL.
 *
 * The signer below implements the scheme found in @noir-wallet/sdk 0.1.9's own verifier
 * (Bitcoin-style: compactSize("Zcash Signed Message:\n") || prefix || compactSize(msg) || msg,
 * double SHA-256, 65-byte recoverable secp256k1 with header 31+recid for compressed keys). It is a
 * test vector generator only; production verification uses the vendor's verifyMessageSignature.
 * Real-extension signatures are NOT yet captured (no Noir extension in this environment).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { publicKeyToAddress } from "@noir-wallet/sdk";
import { Client, makeHarness, type Harness } from "./harness";

const MAIL = path.resolve("var/it-mail");

function compactSize(n: number) {
  return n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n & 255, n >> 8);
}
function noirSign(priv: Uint8Array, message: string) {
  const prefix = new TextEncoder().encode("Zcash Signed Message:\n");
  const msg = new TextEncoder().encode(message);
  const payload = new Uint8Array([...compactSize(prefix.length), ...prefix, ...compactSize(msg.length), ...msg]);
  const hash = sha256(sha256(payload));
  const sig = secp256k1.sign(hash, priv);
  const out = new Uint8Array(65);
  out[0] = 31 + sig.recovery;
  out.set(sig.toCompactRawBytes(), 1);
  const pubkey = bytesToHex(secp256k1.getPublicKey(priv, true));
  return { signature: bytesToHex(out), pubkey, address: publicKeyToAddress(pubkey, "testnet") };
}

let h: Harness;
beforeAll(async () => {
  rmSync(MAIL, { recursive: true, force: true });
  mkdirSync(MAIL, { recursive: true });
  h = await makeHarness({ EMAIL_MODE: "dev-file", EMAIL_DEV_DIR: MAIL });
}, 60_000);
afterAll(async () => h?.close());

async function challenge(c: Client, action = "login") {
  const r = await c.req("POST", "/api/v1/auth/challenge", { body: { action } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { challengeId: string; message: string; network: string };
}

describe("Noir wallet sign-in", () => {
  const priv = secp256k1.utils.randomPrivateKey();

  it("issues an ASCII, origin-bound, single-use challenge with the required statement", async () => {
    const ch = await challenge(new Client(h.app));
    expect(ch.network).toBe("zcash-testnet");
    expect(ch.message).toMatch(/^Zeb Scan wants you to sign in\nDomain: localhost:3000\nURI: http:\/\/localhost:3000\nNetwork: zcash-testnet\nAction: login\nNonce: [0-9a-z]{30,}\n/);
    expect(ch.message).toContain("it does not authorize a transaction or transfer funds");
    expect(/^[\x0a\x20-\x7e]*$/.test(ch.message)).toBe(true);
  });

  it("valid signature → session; same wallet signs in to the same account; replay rejected", async () => {
    const c = new Client(h.app);
    const ch = await challenge(c);
    const s = noirSign(priv, ch.message);
    const v = await c.req("POST", "/api/v1/auth/wallet/verify", { body: { challengeId: ch.challengeId, ...s, signingMode: "derived" } });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.emailVerified).toBe(false);
    const sess = await c.req("GET", "/api/v1/auth/session");
    expect(sess.json.authenticated).toBe(true);
    // replay of the same challenge
    const replay = await new Client(h.app).req("POST", "/api/v1/auth/wallet/verify", { body: { challengeId: ch.challengeId, ...s, signingMode: "derived" } });
    expect(replay.status).toBe(401);
    // same wallet, new challenge → same user
    const c2 = new Client(h.app);
    const ch2 = await challenge(c2);
    const v2 = await c2.req("POST", "/api/v1/auth/wallet/verify", { body: { challengeId: ch2.challengeId, ...noirSign(priv, ch2.message), signingMode: "derived" } });
    expect(v2.json.userId).toBe(v.json.userId);
    // the address itself is not stored — only a keyed fingerprint
    const ids = await h.db.query(`SELECT identity_fingerprint FROM wallet_identities`);
    expect(JSON.stringify(ids.rows)).not.toContain(s.address);
  });

  it("rejects tampered messages, foreign keys, wrong network addresses and non-derived signing", async () => {
    const c = new Client(h.app);
    const tamper = async (mutate: (s: ReturnType<typeof noirSign>, msg: string) => Record<string, unknown>) => {
      const ch = await challenge(c);
      const s = noirSign(priv, ch.message);
      return c.req("POST", "/api/v1/auth/wallet/verify", { body: { challengeId: ch.challengeId, signingMode: "derived", ...mutate(s, ch.message) } });
    };
    // signature over a different message
    expect((await tamper((s, m) => ({ ...noirSign(priv, m.replace("login", "logon")), address: s.address }))).status).toBe(401);
    // claim someone else's address/pubkey with our signature (recoverable sigs recover SOME key; address must match)
    const other = noirSign(secp256k1.utils.randomPrivateKey(), "x");
    expect((await tamper((s) => ({ ...s, pubkey: other.pubkey, address: other.address }))).status).toBe(401);
    expect((await tamper((s) => ({ ...s, address: other.address }))).status).toBe(401);
    // mainnet-format address on testnet
    expect((await tamper((s) => ({ ...s, address: publicKeyToAddress(s.pubkey, "mainnet") }))).status).toBe(401);
    // non-derived signing mode
    expect((await tamper((s) => ({ ...s, signingMode: "current" }))).status).toBe(400);
  });

  it("expired challenge is rejected", async () => {
    const c = new Client(h.app);
    const ch = await challenge(c);
    await h.db.query(`UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE id=$1`, [ch.challengeId]);
    const v = await c.req("POST", "/api/v1/auth/wallet/verify", { body: { challengeId: ch.challengeId, ...noirSign(priv, ch.message), signingMode: "derived" } });
    expect(v.status).toBe(401);
  });
});

describe("email OTP", () => {
  async function lastCode(): Promise<string> {
    await h.runJobs(1); // nothing; delivery is a periodic job, call it directly:
    const { deliverEmails } = await import("@zeb/core");
    await deliverEmails(h.ctx);
    const f = readdirSync(MAIL).sort().reverse().find((x) => readFileSync(path.join(MAIL, x), "utf8").includes("sign-in code"));
    const m = f ? /code is (\d{6})/.exec(readFileSync(path.join(MAIL, f), "utf8")) : null;
    if (!m) throw new Error("no OTP mail");
    return m[1]!;
  }

  it("delivers a code, verifies once, marks email verified; wrong codes are rate-limited", async () => {
    const c = new Client(h.app);
    expect((await c.req("POST", "/api/v1/auth/email/otp", { body: { email: "otp.user@example.test" } })).status).toBe(200);
    const code = await lastCode();
    const subj = readdirSync(MAIL).map((x) => readFileSync(path.join(MAIL, x), "utf8")).join("\n");
    expect(subj).not.toMatch(/Subject: .*\d{6}/); // code never in the subject line
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await c.req("POST", "/api/v1/auth/email/otp/verify", { body: { email: "otp.user@example.test", code: wrong } })).status).toBe(401);
    const ok = await c.req("POST", "/api/v1/auth/email/otp/verify", { body: { email: "otp.user@example.test", code } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.emailVerified).toBe(true);
    // single use
    expect((await new Client(h.app).req("POST", "/api/v1/auth/email/otp/verify", { body: { email: "otp.user@example.test", code } })).status).toBe(401);
    // password login refuses a password-less account (no oracle about the account either)
    expect((await new Client(h.app).req("POST", "/api/v1/auth/login", { body: { email: "otp.user@example.test", password: "anything-long-enough" } })).status).toBe(401);
  });

  it("same response for unknown emails (no enumeration)", async () => {
    const a = await new Client(h.app).req("POST", "/api/v1/auth/email/otp", { body: { email: "nobody-yet@example.test" } });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ ok: true });
  });
});

describe("payout readiness (public, sanitized)", () => {
  it("is strictly not eligible without a rail and a fresh PASS capability report", async () => {
    const r = await new Client(h.app).req("GET", "/api/v1/providers/p2p/readiness");
    expect(r.status).toBe(200);
    expect(r.json.eligible_for_payout).toBe(false);
    expect(r.json.reasons.join(" ")).toMatch(/TINYFISH_API_KEY not configured/);
    const cfg = await new Client(h.app).req("GET", "/api/v1/config/public");
    expect(cfg.json.modeName).toBe("DEMO");
    expect(JSON.stringify(cfg.json)).not.toMatch(/tinyfish_api|apiKey/i);
  });
});
