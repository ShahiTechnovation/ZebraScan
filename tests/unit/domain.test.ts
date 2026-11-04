import { describe, expect, it } from "vitest";
import {
  assertZip321Matches,
  bpsCeil,
  buildZip321,
  ceilDiv,
  classifyPayment,
  computeQuote,
  creditMachine,
  deriveLinkStatus,
  deviationBps,
  DomainError,
  environmentCapabilities,
  formatMinor,
  intentMachine,
  isId,
  maskVpa,
  median,
  newId,
  p2pFixedFee,
  parseDecimalToMinor,
  parseEnvironment,
  parseMinor,
  parseRational,
  parseUpiPayload,
  payoutMachine,
  payoutStatusFromOnchain,
  rederivedPayPull,
  toDecimalString,
  usdcForInr,
  withdrawalMachine,
  zatToZip321Amount,
} from "@zeb/domain";

describe("money", () => {
  it("parses only canonical integer strings", () => {
    expect(parseMinor("0")).toBe(0n);
    expect(parseMinor("12345678901234567890")).toBe(12345678901234567890n);
    for (const bad of ["01", "1.5", "1e3", " 1", "-1", "", "0x10"]) expect(() => parseMinor(bad)).toThrow(DomainError);
    expect(parseMinor("-5", "x", { allowNegative: true })).toBe(-5n);
  });
  it("formats and parses decimals exactly", () => {
    expect(formatMinor(123456789n, 8)).toBe("1.23456789");
    expect(formatMinor(100000000n, 8, { trim: true })).toBe("1");
    expect(parseDecimalToMinor("1301.62", 2)).toBe(130162n);
    expect(() => parseDecimalToMinor("1.234", 2)).toThrow();
  });
  it("rounds fees and divisions up", () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(bpsCeil(10001n, 50)).toBe(51n);
    expect(bpsCeil(0n, 50)).toBe(0n);
  });
});

describe("rationals", () => {
  it("are exact and support median / deviation", () => {
    const a = parseRational("1301.62");
    expect(toDecimalString(a, 2)).toBe("1301.62");
    expect(median([parseRational("10"), parseRational("12"), parseRational("11")])).toEqual(parseRational("11"));
    expect(deviationBps(parseRational("100"), parseRational("101"))).toBe(100n);
    expect(() => parseRational("1e5")).toThrow();
  });
});

describe("quote formula QF-2026-11-01", () => {
  const fee = { smallOrderThreshold: 10_000_000n, smallOrderFixedFee: 50_000n };
  const policy = { platformFeeBps: 50, p2pSpreadReserveBps: 100, zecVolatilityPremiumBps: 150 };

  it("matches a hand-computed example (₹500 at ₹90/USDC, $45/ZEC)", () => {
    const q = computeQuote({ inrPaise: 50_000n, p2pSellPrice6: 90_000_000n, p2pFee: fee, zecUsd: parseRational("45"), policy });
    // usdc = ceil(500e6 * 1e6 / 90e6) = 5_555_556
    expect(q.usdcForFiatMicros).toBe(5_555_556n);
    expect(q.estimatedP2PFeeUsdcMicros).toBe(50_000n); // under 10 USDC threshold
    expect(q.spreadReserveUsdcMicros).toBe(55_556n);
    expect(q.requiredUsdcMicros).toBe(5_661_112n);
    expect(q.platformFeeInrPaise).toBe(250n);
    expect(q.platformFeeUsdcMicros).toBe(27_778n);
    expect(q.usdValueMicros).toBe(5_688_890n);
    expect(q.premiumUsdMicros).toBe(85_334n);
    // zat = ceil((5_688_890 + 85_334) * 100 / 45)
    expect(q.zecZatoshis).toBe(ceilDiv((5_688_890n + 85_334n) * 100n, 45n));
  });
  it("never under-funds: USDC covers fiat at the protocol price, rounding up", () => {
    for (const inr of [1n, 99n, 12_345n, 1_000_000n, 999_999_999n]) {
      for (const price of [83_123_456n, 90_000_000n, 91_999_999n]) {
        const usdc = usdcForInr(inr, price);
        expect(usdc * price).toBeGreaterThanOrEqual(inr * 10_000n * 1_000_000n);
        expect((usdc - 1n) * price).toBeLessThan(inr * 10_000n * 1_000_000n);
      }
    }
  });
  it("applies the small-order fee only at or below the threshold", () => {
    expect(p2pFixedFee(10_000_000n, fee)).toBe(50_000n);
    expect(p2pFixedFee(10_000_001n, fee)).toBe(0n);
  });
  it("re-derives a PAY pull like the SDK README", () => {
    const pull = rederivedPayPull({ fiatAmount: 85_000_000n, usdcAmount: 1_000_000n }, 85_000_000n, fee);
    expect(pull).toBe(1_000_000n + 50_000n);
  });
  it("classifies payments with tolerance", () => {
    expect(classifyPayment(100n, 100n, 0n)).toBe("exact");
    expect(classifyPayment(99n, 100n, 0n)).toBe("underpaid");
    expect(classifyPayment(99n, 100n, 1n)).toBe("exact");
    expect(classifyPayment(102n, 100n, 1n)).toBe("overpaid");
  });
});

describe("environment", () => {
  it("is strict and never falls back", () => {
    expect(parseEnvironment("testnet")).toBe("testnet");
    for (const bad of [undefined, "", "Testnet", "mainnet", "prod"]) expect(() => parseEnvironment(bad)).toThrow(DomainError);
    expect(environmentCapabilities("mainnet-readonly").canIssueReceivingAddress).toBe(false);
    expect(environmentCapabilities("testnet").creditsRedeemable).toBe(false);
    expect(environmentCapabilities("demo").realChainAddresses).toBe(false);
  });
});

describe("state machines", () => {
  it("reject invented transitions with 409 + currentStatus", () => {
    try {
      intentMachine.assert("awaiting_zec", "deposit_accepted");
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).status).toBe(409);
      expect((e as DomainError).opts.currentStatus).toBe("awaiting_zec");
    }
    expect(intentMachine.can("expired_without_funds", "late_deposit")).toBe(true);
    expect(intentMachine.can("refunded", "deposit_accepted")).toBe(false);
  });
  it("payout completion requires provider completion then reconciliation", () => {
    expect(payoutMachine.can("usdc_escrowed", "completed")).toBe(false);
    expect(payoutMachine.can("provider_completed", "completed")).toBe(false);
    expect(payoutMachine.can("payout_reconciled", "completed")).toBe(true);
    expect(payoutStatusFromOnchain("paid", "none")).toBe("usdc_escrowed");
    expect(payoutStatusFromOnchain("paid", "open")).toBe("disputed");
  });
  it("withdrawals cannot restore credits from committed states", () => {
    expect(withdrawalMachine.can("usdc_escrowed", "cancelled")).toBe(false);
    expect(withdrawalMachine.can("inr_processing", "cancelled")).toBe(false);
    expect(withdrawalMachine.can("failed_recoverable", "cancelled")).toBe(true);
  });
  it("credits only move forward or freeze", () => {
    expect(creditMachine.can("credit_locked", "credit_available")).toBe(true);
    expect(creditMachine.can("credit_available", "credit_locked")).toBe(false);
    expect(creditMachine.can("extinguished", "credit_available")).toBe(false);
  });
  it("derives link status independently of checkouts", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    expect(deriveLinkStatus({ revokedAt: null, expiresAt: null, useLimit: 1, successfulUses: 0 }, now)).toBe("active");
    expect(deriveLinkStatus({ revokedAt: null, expiresAt: null, useLimit: 1, successfulUses: 1 }, now)).toBe("exhausted");
    expect(deriveLinkStatus({ revokedAt: now, expiresAt: null, useLimit: null, successfulUses: 0 }, now)).toBe("revoked");
    expect(deriveLinkStatus({ revokedAt: null, expiresAt: new Date("2026-11-03T00:00:00Z"), useLimit: null, successfulUses: 0 }, now)).toBe("expired");
  });
});

describe("UPI", () => {
  it("parses upi://pay and flags merchant QR params", () => {
    const p = parseUpiPayload("upi://pay?pa=shop@okaxis&pn=My%20Shop&am=10.5&cu=INR&tr=123");
    expect(p.vpa).toBe("shop@okaxis");
    expect(p.amountInrPaise).toBe(1050n);
    expect(p.support).toBe("supported_with_notice");
  });
  it("rejects unsafe or unsupported payloads", () => {
    for (const bad of ["upi://mandate?pa=a@b", "https://x.y", "upi://pay?pa=a@b&pa=c@d", "upi://pay?pa=ab@cd&cu=USD", "upi://pay?pa=ab@cd&am=-1", `upi://pay?pa=${"a".repeat(600)}@x`]) {
      expect(() => parseUpiPayload(bad)).toThrow(DomainError);
    }
  });
  it("masks VPAs", () => {
    expect(maskVpa("monsoon.chai@zebdemo")).toBe("mo•••••i@zebdemo");
    expect(maskVpa("abc@x")).toBe("a••@x");
  });
});

describe("ZIP-321", () => {
  const addr = `utest1${"q".repeat(100)}`;
  it("formats exact zatoshi amounts without floats", () => {
    expect(zatToZip321Amount(1n)).toBe("0.00000001");
    expect(zatToZip321Amount(123_456_789n)).toBe("1.23456789");
    expect(zatToZip321Amount(100_000_000n)).toBe("1");
    expect(() => zatToZip321Amount(0n)).toThrow();
  });
  it("validates gateway URIs exactly", () => {
    const uri = buildZip321(addr, 12_345n);
    expect(() => assertZip321Matches(uri, { address: addr, zat: 12_345n, network: "testnet" })).not.toThrow();
    expect(() => assertZip321Matches(uri, { address: addr, zat: 12_346n, network: "testnet" })).toThrow(/amount/);
    expect(() => assertZip321Matches(`${uri}&message=hello`, { address: addr, zat: 12_345n, network: "testnet" })).toThrow(/disallowed/);
    expect(() => assertZip321Matches(uri, { address: addr, zat: 12_345n, network: "mainnet" })).toThrow(/network/);
  });
});

describe("ids", () => {
  it("are prefixed and unguessable", () => {
    const a = newId("intent");
    expect(isId(a, "intent")).toBe(true);
    expect(a).toMatch(/^pi_[0-9a-z]{26}$/);
    expect(new Set(Array.from({ length: 1000 }, () => newId("quote"))).size).toBe(1000);
  });
});
