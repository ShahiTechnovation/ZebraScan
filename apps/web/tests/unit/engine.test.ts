import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS, demoConfig } from "@/config/demo";
import * as E from "@/services/demo/engine";
import { buildSeed } from "@/services/demo/seed";
import type { DemoState } from "@/types/domain";

const T0 = Date.UTC(2026, 10, 1, 6, 0, 0);

function freshMerchant(): { s: DemoState; mid: string } {
  const { state, merchant } = E.onboardMerchant(
    E.emptyState(T0),
    { businessName: "Test Tiffin House", handle: "test-tiffin", category: "Food & beverage", payoutUpi: "tiffin.test@zebdemo", beneficiaryName: "Test Tiffin" },
    T0,
  );
  return { s: state, mid: merchant.id };
}

function payAndAccept(s: DemoState, checkoutId: string, t: number): DemoState {
  s = E.simulateDeposit(s, checkoutId, "exact", t);
  s = E.advanceDeposit(s, checkoutId, t + 1000);
  return E.advanceDeposit(s, checkoutId, t + 2000);
}

const linkInput = (over: Partial<E.LinkInput> = {}): E.LinkInput => ({
  title: "Test link",
  description: "",
  amountMode: "fixed",
  fixedInrMinor: 50_000,
  minInrMinor: null,
  maxInrMinor: null,
  reusable: false,
  useLimit: 1,
  expiresAt: null,
  allowNote: false,
  reference: "",
  ...over,
});

describe("seed", () => {
  it("is deterministic and internally consistent", () => {
    const a = buildSeed(T0);
    const b = buildSeed(T0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const mid = a.merchants[0]!.id;
    const bal = E.balances(a, mid);
    expect(bal.withdrawn).toBe(100_000);
    // every credit references an accepted checkout
    for (const c of a.credits) {
      const ck = a.checkouts.find((x) => x.id === c.checkoutId)!;
      expect(ck.depositStatus).toBe("accepted");
    }
    const addrs = new Set(a.checkouts.map((c) => c.receivingAddress));
    expect(addrs.size).toBe(a.checkouts.length);
    expect(a.session.merchantId).toBeNull();
  });
});

describe("terminal checkout (acceptance 2)", () => {
  it("transitions waiting → detected → confirming → accepted and credits exactly once", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const r = E.createCheckout(s, { mode: "terminal", inrMinor: 50_000, privacy: "shielded", merchantId: mid }, T0);
    s = r.state;
    const id = r.checkout.id;
    expect(r.checkout.qrPayload.startsWith("zebscan-demo://checkout/")).toBe(true);
    expect(r.checkout.receivingAddress).toMatch(/not-payable$/);
    expect(s.checkouts[0]!.depositStatus).toBe("awaiting");
    s = E.simulateDeposit(s, id, "exact", T0 + 1000);
    expect(s.checkouts[0]!.depositStatus).toBe("detected");
    expect(E.balances(s, mid).pending).toBe(50_000);
    s = E.advanceDeposit(s, id, T0 + 2000);
    expect(s.checkouts[0]!.depositStatus).toBe("confirming");
    s = E.advanceDeposit(s, id, T0 + 3000);
    expect(s.checkouts[0]!.depositStatus).toBe("accepted");
    expect(s.credits).toHaveLength(1);
    expect(s.credits[0]!.status).toBe("locked");
    expect(s.receipts).toHaveLength(1);
    // idempotency: replays are rejected and never double credit
    expect(() => E.simulateDeposit(s, id, "exact", T0 + 4000)).toThrow(/already/);
    expect(() => E.advanceDeposit(s, id, T0 + 5000)).toThrow();
    expect(s.credits).toHaveLength(1);
  });

  it("never reuses a receiving address", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = E.createCheckout(s, { mode: "terminal", inrMinor: 10_000, privacy: "shielded", merchantId: mid }, T0 + i);
      s = r.state;
      ids.push(r.checkout.receivingAddress);
    }
    expect(new Set(ids).size).toBe(5);
  });
});

describe("payment links (acceptance 3, 4)", () => {
  it("single-use link exhausts after one confirmed payment; opening does not consume", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const l = E.createLink(s, mid, linkInput(), T0);
    s = l.state;
    // two visitors open checkouts concurrently
    const a = E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 50_000, privacy: "shielded" }, T0);
    s = a.state;
    const b = E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 50_000, privacy: "shielded" }, T0 + 10);
    s = b.state;
    expect(E.linkSuccessfulUses(s, l.link.id)).toBe(0);
    expect(E.linkStatus(s, s.links[0]!, T0)).toBe("active");
    s = E.simulateDeposit(s, b.checkout.id, "exact", T0 + 100);
    s = payAndAccept(s, a.checkout.id, T0 + 200);
    expect(E.linkSuccessfulUses(s, l.link.id)).toBe(1);
    expect(E.linkStatus(s, s.links[0]!, T0 + 300)).toBe("exhausted");
    // concurrent second payment confirms later → held for refund, no credit
    s = E.advanceDeposit(s, b.checkout.id, T0 + 400);
    s = E.advanceDeposit(s, b.checkout.id, T0 + 500);
    expect(s.checkouts.find((c) => c.id === b.checkout.id)!.depositStatus).toBe("refund_pending");
    expect(s.credits.filter((c) => c.checkoutId === b.checkout.id)).toHaveLength(0);
    expect(E.balances(s, mid).locked).toBe(50_000);
    // a new visitor cannot start a checkout
    expect(() => E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 50_000, privacy: "shielded" }, T0 + 600)).toThrow(/exhausted/);
  });

  it("variable reusable link creates distinct checkouts and enforces bounds", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const l = E.createLink(s, mid, linkInput({ amountMode: "variable", fixedInrMinor: null, minInrMinor: 10_000, maxInrMinor: 100_000, reusable: true, useLimit: null }), T0);
    s = l.state;
    expect(() => E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 5_000, privacy: "shielded" }, T0)).toThrow(/between/);
    const a = E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 20_000, privacy: "shielded" }, T0);
    s = a.state;
    const b = E.createCheckout(s, { mode: "payment_link", linkId: l.link.id, merchantId: mid, inrMinor: 75_000, privacy: "shielded" }, T0);
    s = b.state;
    expect(a.checkout.id).not.toBe(b.checkout.id);
    expect(a.checkout.qrPayload).not.toBe(b.checkout.qrPayload);
    s = payAndAccept(s, a.checkout.id, T0 + 10);
    s = payAndAccept(s, b.checkout.id, T0 + 20);
    expect(s.credits).toHaveLength(2);
    expect(E.balances(s, mid).locked).toBe(95_000);
    expect(E.linkStatus(s, s.links[0]!, T0 + 30)).toBe("active");
  });

  it("validates link input", () => {
    const e = E.validateLink(linkInput({ title: "x", amountMode: "variable", minInrMinor: 5000, maxInrMinor: 1000 }), T0);
    expect(e.title).toBeTruthy();
    expect(e.maxInrMinor).toMatch(/greater than or equal/);
  });

  it("revoke blocks new checkouts and duplicate creates a new active link", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const l = E.createLink(s, mid, linkInput(), T0);
    s = E.revokeLink(l.state, l.link.id, T0 + 1);
    expect(E.linkStatus(s, s.links[0]!, T0 + 2)).toBe("revoked");
    const d = E.duplicateLink(s, l.link.id, T0 + 3);
    expect(d.link.id).not.toBe(l.link.id);
    expect(E.linkStatus(d.state, d.link, T0 + 4)).toBe("active");
  });
});

describe("counter QR (acceptance 5)", () => {
  it("each counter checkout gets an independent address", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const a = E.createCheckout(s, { mode: "counter_qr", merchantId: mid, inrMinor: 10_000, privacy: "shielded" }, T0);
    const b = E.createCheckout(a.state, { mode: "counter_qr", merchantId: mid, inrMinor: 10_000, privacy: "shielded" }, T0);
    expect(a.checkout.receivingAddress).not.toBe(b.checkout.receivingAddress);
    s = E.regenerateCounterSlug(b.state, mid);
    expect(s.merchants[0]!.counterSlug).not.toBe("test-tiffin");
    expect(s.merchants[0]!.retiredCounterSlugs).toContain("test-tiffin");
  });
});

describe("scan & pay (acceptance 6)", () => {
  it("requires a valid receiver and progresses the PAY order through real states", () => {
    let s = E.emptyState(T0);
    expect(() => E.createCheckout(s, { mode: "scan_pay", inrMinor: 25_000, privacy: "shielded", recipient: { vpa: "bad", source: "manual" } }, T0)).toThrow();
    const r = E.createCheckout(s, { mode: "scan_pay", inrMinor: 25_000, privacy: "shielded", recipient: { vpa: "sample.store@zebdemo", source: "qr_paste" } }, T0);
    s = payAndAccept(r.state, r.checkout.id, T0 + 10);
    const c = s.checkouts[0]!;
    expect(c.merchantId).toBeNull();
    expect(s.credits).toHaveLength(0);
    const order = s.orders.find((o) => o.id === c.p2pOrderId)!;
    expect(order.orderTypeCode).toBe(2);
    expect(order.status).toBe("placed");
    expect(s.receipts).toHaveLength(0); // no receipt before payout completes
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      s = E.advanceOrder(s, order.id, T0 + 100 + i);
      const o = s.orders.find((x) => x.id === order.id)!;
      seen.push(o.status + (o.matching ? ":matching" : ""));
    }
    expect(seen).toEqual(["placed:matching", "accepted", "usdc_escrowed", "inr_processing", "completed"]);
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0]!.simulated).toBe(true);
  });

  it("failed payout recovers via retry or refund", () => {
    const r = E.createCheckout(E.emptyState(T0), { mode: "scan_pay", inrMinor: 25_000, privacy: "shielded", recipient: { vpa: "sample.store@zebdemo", source: "manual" } }, T0);
    let s = payAndAccept(r.state, r.checkout.id, T0 + 10);
    const oid = s.checkouts[0]!.p2pOrderId!;
    s = E.failOrder(s, oid, "failed", T0 + 20);
    const retried = E.recoverOrder(s, oid, "retry", T0 + 30);
    expect(retried.checkouts[0]!.p2pOrderId).not.toBe(oid);
    const refunded = E.recoverOrder(s, oid, "refund", T0 + 30);
    expect(refunded.checkouts[0]!.depositStatus).toBe("refund_pending");
  });
});

describe("cooldown and withdrawals (acceptance 7)", () => {
  let s: DemoState;
  let mid: string;
  beforeEach(() => {
    const f = freshMerchant();
    s = f.s;
    mid = f.mid;
    const r = E.createCheckout(s, { mode: "terminal", inrMinor: 200_000, privacy: "shielded", merchantId: mid }, T0);
    s = payAndAccept(r.state, r.checkout.id, T0 + 10);
  });

  it("locked credit cannot be withdrawn", () => {
    expect(E.withdrawalBlockReason(s, mid, 50_000)).toMatch(/locked/);
    expect(() => E.requestWithdrawal(s, mid, 50_000, T0 + 100)).toThrow(/locked/);
  });

  it("cooldown unlock, reserve, complete", () => {
    const later = T0 + demoConfig.cooldownDays * DAY_MS + 60_000;
    s = E.reconcile(s, later);
    let b = E.balances(s, mid);
    expect(b.locked).toBe(0);
    expect(b.available).toBe(200_000);
    expect(() => E.requestWithdrawal(s, mid, 300_000, later)).toThrow(/exceeds/);
    const w = E.requestWithdrawal(s, mid, 50_000, later);
    s = w.state;
    b = E.balances(s, mid);
    expect(b.available).toBe(150_000);
    expect(b.reserved).toBe(50_000);
    expect(b.liability).toBe(200_000);
    expect(E.withdrawalBlockReason(s, mid, 10_000)).toMatch(/in progress/);
    for (let i = 0; i < 5; i++) s = E.advanceWithdrawal(s, w.withdrawal.id, later + i);
    expect(s.withdrawals[0]!.status).toBe("completed");
    b = E.balances(s, mid);
    expect(b.reserved).toBe(0);
    expect(b.withdrawn).toBe(50_000);
    expect(b.liability).toBe(150_000);
  });

  it("failure restores funds only through explicit recovery, once", () => {
    const later = T0 + demoConfig.cooldownDays * DAY_MS + 60_000;
    s = E.reconcile(s, later);
    const w = E.requestWithdrawal(s, mid, 50_000, later);
    s = E.advanceWithdrawal(w.state, w.withdrawal.id, later + 1);
    s = E.failWithdrawal(s, w.withdrawal.id, "failed", later + 2);
    expect(E.balances(s, mid).available).toBe(150_000);
    expect(E.balances(s, mid).reserved).toBe(50_000);
    expect(E.withdrawalBlockReason(s, mid, 10_000)).toMatch(/recovery/);
    s = E.recoverWithdrawal(s, w.withdrawal.id, later + 3);
    expect(E.balances(s, mid).available).toBe(200_000);
    expect(() => E.recoverWithdrawal(s, w.withdrawal.id, later + 4)).toThrow(/already/);
    expect(E.balances(s, mid).available).toBe(200_000);
  });
});

describe("quote expiry and exceptions (acceptance 8)", () => {
  it("expires awaiting quotes and routes late/underpaid funds to exceptions without credit", () => {
    const f = freshMerchant();
    let s = f.s;
    const mid = f.mid;
    const a = E.createCheckout(s, { mode: "terminal", inrMinor: 10_000, privacy: "shielded", merchantId: mid }, T0);
    s = E.reconcile(a.state, T0 + demoConfig.quote.lifetimeMs + 1);
    expect(s.checkouts[0]!.depositStatus).toBe("expired");
    s = E.simulateDeposit(s, a.checkout.id, "exact", T0 + 200_000);
    expect(s.checkouts[0]!.depositStatus).toBe("late");
    const b = E.createCheckout(s, { mode: "terminal", inrMinor: 10_000, privacy: "shielded", merchantId: mid }, T0 + 300_000);
    s = E.simulateDeposit(b.state, b.checkout.id, "underpaid", T0 + 300_010);
    expect(s.checkouts[1]!.depositStatus).toBe("underpaid");
    expect(s.credits).toHaveLength(0);
    s = E.startRefund(s, b.checkout.id, T0 + 300_020);
    s = E.completeRefund(s, b.checkout.id, T0 + 300_030);
    expect(s.checkouts[1]!.depositStatus).toBe("refunded");
    expect(s.credits).toHaveLength(0);
  });
});

describe("treasury", () => {
  it("reports reserves that never double-count liabilities", () => {
    const s = buildSeed(T0);
    const t = E.treasurySnapshot(s, T0);
    const total = BigInt(t.usdcTotalMicro);
    expect(BigInt(t.usdcReservedMicro) + BigInt(t.usdcInFlightMicro) + BigInt(t.usdcAvailableMicro)).toBe(total);
    expect(t.merchantLiabilityInrMinor).toBe(E.balances(s, s.merchants[0]!.id).liability);
  });
});
