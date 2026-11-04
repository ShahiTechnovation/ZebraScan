import { describe, expect, it } from "vitest";
import { formatInr, formatZec, parseInrToMinor, bpsOf, formatUsdc } from "@/lib/money";
import { buildDemoQuote, validateInrAmount } from "@/lib/quote";
import { maskVpa, parseUpiPayload, validateVpa } from "@/lib/upi";

describe("money", () => {
  it("formats INR with Indian grouping", () => {
    expect(formatInr(12_345_678_90)).toBe("₹1,23,45,678.90");
    expect(formatInr(50_000, { whole: true })).toBe("₹500");
    expect(formatInr(5)).toBe("₹0.05");
  });
  it("parses INR text into paise exactly", () => {
    expect(parseInrToMinor("1,250.5")).toBe(125_050);
    expect(parseInrToMinor("0.1")).toBe(10);
    expect(parseInrToMinor("12.345")).toBeNull();
    expect(parseInrToMinor("abc")).toBeNull();
    expect(parseInrToMinor("")).toBeNull();
  });
  it("formats ZEC to at most 8 decimals without floats", () => {
    expect(formatZec("123456789")).toBe("1.23456789");
    expect(formatZec("100000000")).toBe("1.00");
    expect(formatZec("1", { fixed: true })).toBe("0.00000001");
  });
  it("formats USDC", () => {
    expect(formatUsdc("5555555")).toBe("5.55");
  });
  it("rounds basis points half-up", () => {
    expect(bpsOf(50_000, 100)).toBe(500);
    expect(bpsOf(150, 50)).toBe(1); // 0.75 paise → 1
  });
});

describe("demo quote", () => {
  it("reconciles fees and converts at illustrative constants", () => {
    const q = buildDemoQuote({ id: "q", inrMinor: 50_000, privacy: "shielded", now: 0 });
    expect(q.protocolFeeInrMinor).toBe(500);
    expect(q.platformFeeInrMinor).toBe(250);
    expect(q.totalInrMinor).toBe(q.inrMinor + q.protocolFeeInrMinor + q.platformFeeInrMinor);
    expect(q.totalInrMinor).toBe(50_750);
    // ₹507.50 / 90 = 5.638889 USDC (ceil micro)
    expect(q.usdcMicro).toBe("5638889");
    // 5.638889 / 45 = 0.12530865 ZEC (ceil zat)
    expect(q.zecZat).toBe("12530865");
    expect(q.expiresAt - q.createdAt).toBe(90_000);
    expect(q.source).toBe("demo");
  });
  it("validates demo amount policy", () => {
    expect(validateInrAmount(null)).toMatch(/Enter/);
    expect(validateInrAmount(0)).toMatch(/greater than zero/);
    expect(validateInrAmount(99)).toMatch(/Minimum/);
    expect(validateInrAmount(1_000_001)).toMatch(/Maximum/);
    expect(validateInrAmount(100)).toBeNull();
  });
});

describe("UPI parser", () => {
  it("parses a canonical upi://pay payload", () => {
    const r = parseUpiPayload("upi://pay?pa=sample.store@zebdemo&pn=Sample%20Store&am=250.00&cu=INR");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vpa).toBe("sample.store@zebdemo");
      expect(r.value.payeeName).toBe("Sample Store");
      expect(r.value.amountMinor).toBe(25_000);
    }
  });
  it.each([
    ["", /No QR data/],
    ["https://example.com/pay", /not a UPI payment QR/],
    ["upi://mandate?pa=a@b", /Only upi:\/\/pay/],
    ["upi://pay?pn=NoAddress", /missing the receiver/],
    ["upi://pay?pa=bad", /malformed/],
    ["upi://pay?pa=ok.user@bank&cu=USD", /Unsupported currency/],
    ["upi://pay?pa=ok.user@bank&am=0", /greater than zero/],
    ["upi://pay?pa=ok.user@bank&am=-5", /invalid/],
    ["upi://pay?pa=ok.user@bank&am=1e5", /invalid/],
    ["upi://pay?pa=ok.user@bank&pn=" + "x".repeat(600), /unusually long/],
    ["hello world", /doesn't look like/],
  ])("rejects %s", (input, err) => {
    const r = parseUpiPayload(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(err);
  });
  it("flags merchant dynamic QR params", () => {
    const r = parseUpiPayload("upi://pay?pa=shop.x@bank&mc=5411&tr=ABC123");
    expect(r.ok && r.value.hasMerchantParams).toBe(true);
  });
  it("validates manual VPAs and masks them", () => {
    expect(validateVpa("monsoon.chai@zebdemo")).toBeNull();
    expect(validateVpa("no-at-sign")).not.toBeNull();
    expect(maskVpa("monsoon.chai@zebdemo")).toBe("mo•••••i@zebdemo");
  });
});
