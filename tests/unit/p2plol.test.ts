import { describe, expect, it } from "vitest";
import { buildP2PLolSellGoal, checkP2PLolResult, inrBand, validateP2PLolInput } from "../../packages/providers/src/p2plol";

const base = { offrampAmountUsdc: "0.534279", oneTimeUpiId: "8799792366.wallet@phonepe", reference: "pay_abc123", targetInrPaise: 5000n };

describe("P2P.lol TinyFish settlement goal (operator spec)", () => {
  it("injects only the amount, UPI ID and target INR; band is [95%, 115%]", () => {
    expect(inrBand(5000n)).toEqual({ target: "50.00", min: "47.50", max: "57.50" });
    expect(inrBand(1001n)).toEqual({ target: "10.01", min: "9.50", max: "11.52" });
    const g = buildP2PLolSellGoal({ ...base, authorized: true });
    expect(g).toContain('"offramp-amount":"0.534279"');
    expect(g).toContain('"one-time-upi-id":"8799792366.wallet@phonepe"');
    expect(g).toContain('"target-inr":"50.00"');
    expect(g).toContain("between INR 47.50 and INR 57.50");
    expect(g).toContain("https://app.p2p.lol/sell");
    expect(g).toContain("click \"Place Order\" exactly once");
    expect(g).toMatch(/never enter passwords, OTPs/i);
  });

  it("without authorization it must stop before Place Order", () => {
    const g = buildP2PLolSellGoal({ ...base, authorized: false });
    expect(g).toContain("stop immediately BEFORE clicking \"Place Order\"");
    expect(g).not.toContain("click \"Place Order\" exactly once");
  });

  it("rejects malformed inputs before anything reaches the agent", () => {
    expect(() => validateP2PLolInput({ ...base, authorized: true, offrampAmountUsdc: "0" })).toThrow();
    expect(() => validateP2PLolInput({ ...base, authorized: true, offrampAmountUsdc: "1e3" })).toThrow();
    expect(() => validateP2PLolInput({ ...base, authorized: true, offrampAmountUsdc: "0.1234567" })).toThrow();
    expect(() => validateP2PLolInput({ ...base, authorized: true, oneTimeUpiId: "not a vpa" })).toThrow();
    expect(() => validateP2PLolInput({ ...base, authorized: true, reference: "bad ref!" })).toThrow();
    expect(() => inrBand(0n)).toThrow();
  });

  it("only accepts SOLD with a matching order URL and positive amount; flags mismatches", () => {
    const sold = { success: true, code: 200, status: "SOLD", amount_paid: 50.1, currency: "INR", order_id: "83821", error: "", entered_usdc: "0.534279", entered_upi: "8799792366.wallet@phonepe", preview_inr: "50.10", order_url: "https://app.p2p.lol/order/83821", place_order_clicked: true };
    expect(checkP2PLolResult(sold, { ...base, authorized: true }).ok).toBe(true);
    expect(checkP2PLolResult({ ...sold, order_url: "https://evil.example/order/83821" }, { ...base, authorized: true }).ok).toBe(false);
    expect(checkP2PLolResult({ ...sold, amount_paid: null }, { ...base, authorized: true }).ok).toBe(false);
    expect(checkP2PLolResult({ ...sold, entered_upi: "someone.else@ybl" }, { ...base, authorized: true }).problems.join()).toMatch(/entered UPI/);
    expect(checkP2PLolResult({ ...sold, status: "AWAITING_AUTHORIZATION", success: false, place_order_clicked: true }, { ...base, authorized: false }).problems.join()).toMatch(/without authorization/);
    expect(checkP2PLolResult({ ...sold, status: "PAYMENT_IN_PROGRESS", success: true }, { ...base, authorized: true }).ok).toBe(false);
  });
});
