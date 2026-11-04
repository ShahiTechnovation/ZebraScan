/** Demo implementations of the adapter contracts, backed by the local demo store. */
import { demoConfig } from "@/config/demo";
import { buildDemoQuote } from "@/lib/quote";
import type { DemoState } from "@/types/domain";
import type { ZebServices } from "../adapters";
import * as E from "./engine";
import { demoNow, demoStore } from "./store";

function run<T>(fn: (s: DemoState, now: number) => { state: DemoState; out: T }): T {
  let out!: T;
  demoStore.update((s, now) => {
    const r = fn(s, now);
    out = r.out;
    return r.state;
  });
  return out;
}

const snap = () => demoStore.getSnapshot()!;
const apply = (fn: (s: DemoState, now: number) => DemoState) => demoStore.update(fn);

export const demoServices: ZebServices = {
  kind: "demo",
  rates: {
    async getRates() {
      const now = demoNow(demoStore.getSnapshot());
      return {
        usdMicroPerZec: demoConfig.quote.usdMicroPerZec,
        inrPerUsdcMinor: demoConfig.quote.inrPerUsdcMinor,
        source: "demo",
        provider: demoConfig.quote.provider,
        fetchedAt: now,
        expiresAt: now + demoConfig.quote.lifetimeMs,
      };
    },
    async quote(inrMinor, privacy) {
      return buildDemoQuote({ id: "preview", inrMinor, privacy, now: demoNow(demoStore.getSnapshot()) });
    },
  },
  zcash: {
    async createPaymentIntent(input) {
      return run((s, now) => {
        const r = E.createCheckout(s, input, now);
        return { state: r.state, out: r.checkout };
      });
    },
    async getIntent(id) {
      return snap().checkouts.find((c) => c.id === id) ?? null;
    },
    subscribeDepositState(id, cb) {
      return demoStore.subscribe(() => {
        const c = snap().checkouts.find((x) => x.id === id);
        if (c) cb(c.depositStatus);
      });
    },
    async simulateDeposit(id, kind) {
      apply((s, now) => E.simulateDeposit(s, id, kind, now));
    },
    async advanceConfirmation(id) {
      apply((s, now) => E.advanceDeposit(s, id, now));
    },
    async startRefund(id) {
      apply((s, now) => E.startRefund(s, id, now));
    },
    async completeRefund(id) {
      apply((s, now) => E.completeRefund(s, id, now));
    },
  },
  p2p: {
    async getOrder(id) {
      return snap().orders.find((o) => o.id === id) ?? null;
    },
    async advanceOrder(id) {
      apply((s, now) => E.advanceOrder(s, id, now));
    },
    async failOrder(id, kind) {
      apply((s, now) => E.failOrder(s, id, kind, now));
    },
    async recoverOrder(id, how) {
      apply((s, now) => E.recoverOrder(s, id, how, now));
    },
  },
  merchant: {
    async onboard(input) {
      return run((s, now) => {
        const r = E.onboardMerchant(s, input, now);
        return { state: r.state, out: r.merchant };
      });
    },
    async updateMerchant(id, patch) {
      apply((s) => E.updateMerchant(s, id, patch));
    },
    async regenerateCounterSlug(id) {
      apply((s) => E.regenerateCounterSlug(s, id));
    },
    async createLink(merchantId, input) {
      return run((s, now) => {
        const r = E.createLink(s, merchantId, input, now);
        return { state: r.state, out: r.link };
      });
    },
    async updateLink(id, patch) {
      apply((s) => E.updateLinkMetadata(s, id, patch));
    },
    async revokeLink(id) {
      apply((s, now) => E.revokeLink(s, id, now));
    },
    async duplicateLink(id) {
      return run((s, now) => {
        const r = E.duplicateLink(s, id, now);
        return { state: r.state, out: r.link };
      });
    },
    async recordLinkView(id) {
      apply((s) => E.recordLinkView(s, id));
    },
    async requestWithdrawal(merchantId, inrMinor) {
      return run((s, now) => {
        const r = E.requestWithdrawal(s, merchantId, inrMinor, now);
        return { state: r.state, out: r.withdrawal };
      });
    },
    async cancelWithdrawal(id) {
      apply((s, now) => E.cancelWithdrawal(s, id, now));
    },
    async recoverWithdrawal(id) {
      apply((s, now) => E.recoverWithdrawal(s, id, now));
    },
    async advanceWithdrawal(id) {
      apply((s, now) => E.advanceWithdrawal(s, id, now));
    },
    async failWithdrawal(id, kind) {
      apply((s, now) => E.failWithdrawal(s, id, kind, now));
    },
    async resolveDispute(id, outcome) {
      apply((s, now) => E.resolveDispute(s, id, outcome, now));
    },
  },
  ledger: {
    async getCredits(merchantId) {
      return snap().credits.filter((c) => c.merchantId === merchantId);
    },
    async getLedger(merchantId) {
      return snap().ledger.filter((l) => l.merchantId === merchantId);
    },
    async getTreasury() {
      const s = snap();
      return E.treasurySnapshot(s, demoNow(s));
    },
  },
};

/** Demo-session-only controls that are not part of any live contract. */
export const demoSession = {
  signInSample() {
    apply((s, now) => {
      const sample = s.merchants.find((m) => m.isSample);
      if (!sample) return s;
      return { ...s, session: { merchantId: sample.id, startedAt: now, opsUnlocked: false } };
    });
  },
  switchMerchant(id: string) {
    apply((s, now) => (s.merchants.some((m) => m.id === id) ? { ...s, session: { ...s.session, merchantId: id, startedAt: now } } : s));
  },
  signOut() {
    apply((s) => ({ ...s, session: { merchantId: null, startedAt: null, opsUnlocked: false } }));
  },
  unlockOps(on: boolean) {
    apply((s) => ({ ...s, session: { ...s.session, opsUnlocked: on } }));
  },
  advanceClock(days: number) {
    apply((s) => {
      const next = { ...s, clockOffsetMs: s.clockOffsetMs + days * 86_400_000 };
      return E.reconcile(next, Date.now() + next.clockOffsetMs);
    });
  },
  resetClock() {
    apply((s) => ({ ...s, clockOffsetMs: 0 }));
  },
  reset() {
    demoStore.reset();
  },
};
