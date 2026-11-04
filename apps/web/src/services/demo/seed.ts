/**
 * Deterministic demo seed. Built by replaying engine actions at fixed offsets
 * relative to the seed time, so every seeded record is internally consistent.
 * These are sample records for the demo — not historical Zeb Scan activity.
 */
import { DAY_MS } from "@/config/demo";
import type { DemoState } from "@/types/domain";
import * as E from "./engine";

export const SAMPLE_MERCHANT = {
  businessName: "Monsoon Chai Co.",
  handle: "monsoon-chai",
  category: "Food & beverage",
  payoutUpi: "monsoon.chai@zebdemo",
  beneficiaryName: "Monsoon Chai Co. (sample)",
};

const H = 3_600_000;

export function buildSeed(now: number): DemoState {
  let s = E.emptyState(now);
  const at = (daysAgo: number, hours = 0) => now - daysAgo * DAY_MS + hours * H;

  const { state: s1, merchant } = E.onboardMerchant(s, SAMPLE_MERCHANT, at(40), true);
  s = s1;
  const mid = merchant.id;

  // Payment links
  const tasting = E.createLink(
    s,
    mid,
    {
      title: "Masala chai tasting box",
      description: "Six single-estate chai blends with tasting notes. Ships within 3 days.",
      amountMode: "fixed",
      fixedInrMinor: 120_000,
      minInrMinor: null,
      maxInrMinor: null,
      reusable: true,
      useLimit: null,
      expiresAt: null,
      allowNote: true,
      reference: "TASTE-BOX",
    },
    at(30),
  );
  s = tasting.state;
  const catering = E.createLink(
    s,
    mid,
    {
      title: "Catering advance",
      description: "Advance for event catering. Enter the amount agreed with us.",
      amountMode: "variable",
      fixedInrMinor: null,
      minInrMinor: 50_000,
      maxInrMinor: 500_000,
      reusable: true,
      useLimit: 20,
      expiresAt: null,
      allowNote: true,
      reference: "",
    },
    at(25),
  );
  s = catering.state;
  const workshop = E.createLink(
    s,
    mid,
    {
      title: "Chai workshop seat — single use",
      description: "One seat at the Saturday brewing workshop.",
      amountMode: "fixed",
      fixedInrMinor: 80_000,
      minInrMinor: null,
      maxInrMinor: null,
      reusable: false,
      useLimit: 1,
      expiresAt: null,
      allowNote: false,
      reference: "WS-SAT",
    },
    at(12),
  );
  s = workshop.state;
  s = E.revokeLink(s, workshop.link.id, at(10));

  const pay = (mode: "terminal" | "counter_qr" | "payment_link", inr: number, daysAgo: number, linkId: string | null = null) => {
    const t = at(daysAgo);
    const r = E.createCheckout(s, { mode, inrMinor: inr, privacy: "shielded", merchantId: mid, linkId }, t);
    s = r.state;
    s = E.simulateDeposit(s, r.checkout.id, "exact", t + 40_000);
    s = E.advanceDeposit(s, r.checkout.id, t + 120_000);
    s = E.advanceDeposit(s, r.checkout.id, t + 420_000);
    return r.checkout.id;
  };

  pay("terminal", 50_000, 21);
  pay("payment_link", 120_000, 19, tasting.link.id);
  pay("counter_qr", 24_000, 6);
  pay("terminal", 85_000, 2);
  pay("payment_link", 300_000, 1, catering.link.id);

  // Exception: an underpaid terminal checkout held for refund.
  {
    const t = at(3, 2);
    const r = E.createCheckout(s, { mode: "terminal", inrMinor: 35_000, privacy: "shielded", merchantId: mid }, t);
    s = r.state;
    s = E.simulateDeposit(s, r.checkout.id, "underpaid", t + 50_000);
    s = E.startRefund(s, r.checkout.id, t + 3 * H);
  }
  // An abandoned counter checkout whose quote expired.
  {
    const t = at(0, -5);
    const r = E.createCheckout(s, { mode: "counter_qr", inrMinor: 18_000, privacy: "shielded", merchantId: mid }, t);
    s = r.state;
  }

  // Credits from 21 and 19 days ago have passed the 15-day cooldown.
  s = E.reconcile(s, at(3));
  // A completed withdrawal of ₹1,000.
  {
    const r = E.requestWithdrawal(s, mid, 100_000, at(3));
    s = r.state;
    let t = at(3) + H;
    for (let i = 0; i < 5; i++) {
      s = E.advanceWithdrawal(s, r.withdrawal.id, t);
      t += 2 * H;
    }
  }

  s = E.reconcile(s, now);
  // Seed leaves no one signed in; /login picks the sample merchant or onboarding.
  s.session = { merchantId: null, startedAt: null, opsUnlocked: false };
  s.seededAt = now;
  return s;
}
