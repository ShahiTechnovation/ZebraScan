import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  Envelope,
  hashPassword,
  LocalKeyProvider,
  merchantCan,
  needsRehash,
  operatorCan,
  passwordProblem,
  redact,
  requestHash,
  ScopedTokenSigner,
  totpAt,
  verifyPassword,
  verifyTotp,
  base32Encode,
} from "@zeb/security";
import { validateLines } from "@zeb/ledger";
import { DomainError, parseRational } from "@zeb/domain";
import { resetBreakers, validateP2PConfig, ZecUsdOracle, CIRCLE_USDC, type PriceSource } from "@zeb/providers";
import { loadConfig } from "@zeb/core";

const kek = () => randomBytes(32).toString("base64");

describe("envelope encryption", () => {
  it("round-trips, binds AAD, and rotates KEKs", async () => {
    const k1 = kek();
    const env1 = new Envelope(new LocalKeyProvider({ a: k1 }, "a"));
    const ct = await env1.seal("monsoon.chai@okhdfcbank", "payout_destinations:pd_1:vpa");
    expect(ct).not.toContain("monsoon");
    expect(await env1.open(ct, "payout_destinations:pd_1:vpa")).toBe("monsoon.chai@okhdfcbank");
    await expect(env1.open(ct, "payout_destinations:pd_2:vpa")).rejects.toThrow();
    const env2 = new Envelope(new LocalKeyProvider({ a: k1, b: kek() }, "b"));
    const rotated = await env2.rotate(ct, "payout_destinations:pd_1:vpa");
    expect(env2.keyIdOf(rotated)).toBe("b");
    expect(await env2.open(rotated, "payout_destinations:pd_1:vpa")).toBe("monsoon.chai@okhdfcbank");
  });
});

describe("tokens", () => {
  it("signs scoped tokens and rejects tampering/expiry", () => {
    const s = new ScopedTokenSigner("s".repeat(40));
    const t = s.sign({ scope: "checkout:pi_x", sub: "anon:1", exp: Math.floor(Date.now() / 1000) + 60 });
    expect(s.verify(t)?.scope).toBe("checkout:pi_x");
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ scope: "checkout:pi_other", sub: "anon:1", exp: 9e9 })).toString("base64url");
    expect(s.verify(`${forged}.${sig}`)).toBeNull();
    expect(s.verify(`${body}.x${sig!.slice(1)}`)).toBeNull();
    expect(s.verify(s.sign({ scope: "a", sub: "b", exp: 1 }))).toBeNull();
    expect(() => new ScopedTokenSigner("short")).toThrow();
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(requestHash("post", "/x", { a: 1 })).toBe(requestHash("POST", "/x", { a: 1 }));
  });
});

describe("TOTP (RFC 6238 SHA-1 test vectors)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the RFC appendix B values (6-digit truncation)", () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(verifyTotp(secret, "005924", 1234567890 * 1000)).toBe(true);
    expect(verifyTotp(secret, "005925", 1234567890 * 1000)).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes with argon2id and enforces policy", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("password1")).not.toBeNull();
    expect(passwordProblem("alice-very-long-pass", "alice@example.com")).toMatch(/email/);
  });
});

describe("redaction", () => {
  it("removes VPAs, Zcash addresses, keys and secrets", () => {
    const out = JSON.stringify(redact({ msg: `pay chai@okaxis to utest1${"q".repeat(60)} key 0x${"a".repeat(64)}`, password: "x", nested: { vpa: "a@b" } }));
    expect(out).not.toContain("chai@okaxis");
    expect(out).not.toContain("utest1qq");
    expect(out).not.toContain("aaaaaaaa");
    expect(out).not.toContain('"x"');
  });
  it("removes one-character-name VPAs the UPI parsers accept (x@ybl)", () => {
    expect(JSON.stringify(redact({ msg: "send INR 10 to x@ybl now" }))).not.toContain("x@ybl");
  });
});

describe("rbac", () => {
  it("separates merchant and operator permissions", () => {
    expect(merchantCan("viewer", "withdrawal.request")).toBe(false);
    expect(merchantCan("finance", "withdrawal.request")).toBe(true);
    expect(merchantCan("finance", "payout_destination.manage")).toBe(false);
    expect(operatorCan("auditor", "ops.decide")).toBe(false);
    expect(operatorCan("treasury_approver", "ops.approve_treasury")).toBe(true);
  });
});

describe("ledger line validation", () => {
  it("requires per-currency balance and correct merchant scoping", () => {
    expect(() => validateLines([{ account: "zcash_asset", debit: 5n }, { account: "zec_inventory_clearing", credit: 5n }])).not.toThrow();
    expect(() => validateLines([{ account: "zcash_asset", debit: 5n }, { account: "fee_revenue", credit: 5n }])).toThrow(/unbalanced/); // ZEC vs INR never net
    expect(() => validateLines([{ account: "merchant_credits_locked", credit: 5n }, { account: "crypto_inventory_valuation", debit: 5n }])).toThrow(/merchantId/);
    expect(() => validateLines([{ account: "zcash_asset", debit: 5n, credit: 5n }, { account: "zec_inventory_clearing", credit: 0n }])).toThrow();
  });
});

describe("price oracle policy", () => {
  const src = (name: string, rate: string, ageMs = 0, fail = false): PriceSource => ({
    name,
    async fetch() {
      if (fail) throw new Error("down");
      return { source: name, rate: parseRational(rate), rateText: rate, observedAt: new Date(Date.now() - ageMs), fetchedAt: new Date(), raw: {} };
    },
  });
  const policy = { minSources: 2, maxAgeMs: 60_000, maxDeviationBps: 150, maxBidAskSpreadBps: 200 };
  it("takes the median of fresh agreeing sources", async () => {
    resetBreakers();
    const r = await new ZecUsdOracle([src("a", "45.10"), src("b", "45.00"), src("c", "45.20")], { ...policy, minSources: 3 }).read();
    expect(r.rateText).toBe("45.1");
  });
  it("refuses stale, missing or divergent sources — no fallback number", async () => {
    await expect(new ZecUsdOracle([src("a", "45"), src("b", "45", 120_000)], policy).read()).rejects.toThrow(/unavailable/);
    await expect(new ZecUsdOracle([src("a", "45"), src("b", "0", 0, true)], policy).read()).rejects.toThrow(DomainError);
    await expect(new ZecUsdOracle([src("a", "45"), src("b", "50")], policy).read()).rejects.toThrow(/disagree/);
  });
});

describe("P2P config validation", () => {
  it("refuses zero/placeholder addresses, example subgraphs and non-Circle USDC", () => {
    const good = { chainId: 84532, rpcUrl: "https://sepolia.base.org", diamondAddress: "0x1111111111111111111111111111111111111111", subgraphUrl: "https://subgraph.provider.test/p2p", usdcAddress: CIRCLE_USDC[84532] };
    expect(validateP2PConfig(good).chainId).toBe(84532);
    expect(() => validateP2PConfig({ ...good, diamondAddress: "0x0000000000000000000000000000000000000000" })).toThrow();
    expect(() => validateP2PConfig({ ...good, subgraphUrl: "https://example.com/subgraph" })).toThrow();
    expect(() => validateP2PConfig({ ...good, usdcAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" })).toThrow(); // USDbC is not USDC
    expect(() => validateP2PConfig({ ...good, chainId: 1 })).toThrow();
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x", ZEB_TOKEN_SECRET: "t".repeat(40), ZEB_LOCAL_KEKS: `k:${kek()}`, ZEB_ACTIVE_KEK: "k" };
  it("fails closed on typos and unsafe combinations", () => {
    expect(() => loadConfig({ ...base, ZEB_ENVIRONMENT: "mainnet" })).toThrow();
    expect(() => loadConfig({ ...base, ZEB_ENVIRONMENT: "testnet", ZCASH_NETWORK: "mainnet" })).toThrow(/conflicts/);
    expect(() => loadConfig({ ...base, ZEB_ENVIRONMENT: "mainnet-enabled", BASE_SIGNER_MODE: "testnet-file", BASE_SIGNER_KEY_FILE: "/x" })).toThrow(/testnet/);
    expect(() => loadConfig({ ...base, ZEB_ENVIRONMENT: "mainnet-readonly", EMAIL_MODE: "dev-file" })).toThrow(/mainnet/);
    expect(() => loadConfig({ ...base, ZEB_ENVIRONMENT: "testnet", P2P_DIAMOND_ADDRESS: "0x1", P2P_CHAIN_ID: "8453", BASE_RPC_URL: "x", P2P_SUBGRAPH_URL: "x", P2P_USDC_ADDRESS: "x" })).toThrow(/Sepolia/);
    expect(loadConfig({ ...base, ZEB_ENVIRONMENT: "demo" }).policy.quoteLifetimeSec).toBe(90);
  });
});
