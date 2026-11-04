/**
 * Live implementations of the adapter contracts, talking ONLY to the Zeb Scan API (/api/v1).
 * Demo-only progression controls are undefined here, except deposit simulation which is exposed
 * when (and only when) the backend itself runs in the `demo` environment.
 */
import type { ZebServices } from "../adapters";
import { mapQuote, mapWithdrawal } from "./map";
import { api, checkoutTokens, newKey, withStepUp } from "./api";
import { liveStore } from "./store";
import type { CheckoutIntent, Merchant, PaymentLink, Withdrawal } from "@/types/domain";

const str = (n: number | null | undefined) => (n === null || n === undefined ? undefined : String(Math.round(n)));

function requireMerchantId(): string {
  const id = liveStore.merchant?.id;
  if (!id) throw new Error("Sign in to your business account first.");
  return id;
}

async function afterCreate(r: { checkout: { id: string }; accessToken: string; accessExpiresAt: string }, cx: { merchantId?: string | null; linkId?: string | null }): Promise<CheckoutIntent> {
  checkoutTokens.set(r.checkout.id, r.accessToken, r.accessExpiresAt);
  const c = await liveStore.loadCheckout(r.checkout.id, cx);
  if (!c) throw new Error("Checkout was created but could not be loaded. Reload the page.");
  return c;
}

const backendIsDemo = () => liveStore.config?.environment === "demo";

export const liveServices: ZebServices = {
  kind: "live",
  rates: {
    async getRates() {
      const [z, p] = await Promise.all([api.call("getZecUsdRate"), api.call("getInrUsdcRate")]);
      if (!p.available || !p.sellPrice) throw new Error(p.reason ?? "Live INR/USDC price unavailable");
      const [zw = "0", zf = ""] = z.rate.split(".");
      const [pw = "0", pf = ""] = p.sellPrice.split(".");
      const observed = Date.parse(z.observedAt);
      return {
        usdMicroPerZec: Number(zw) * 1e6 + Number((zf + "000000").slice(0, 6)),
        inrPerUsdcMinor: Number(pw) * 100 + Number((pf + "00").slice(0, 2)),
        source: liveStore.config?.environment === "demo" ? "demo" : "live",
        provider: z.sources.map((s) => s.source).join(", "),
        fetchedAt: observed,
        expiresAt: observed + 60_000,
      };
    },
    async quote(inrMinor, privacy) {
      // Preview quote: a real, immutable server quote (it simply goes unused if the payer stops).
      const q = await api.call("createQuote", { body: { mode: "scan_pay", inrPaise: String(inrMinor), privacyPreference: privacy }, idempotencyKey: newKey() });
      if (!q.paymentEligible) throw new Error(q.disabledReason ?? "Payments are not available right now");
      return mapQuote(q, liveStore.platformFeeBps);
    },
  },
  zcash: {
    async createPaymentIntent(input) {
      const inrPaise = str(input.inrMinor)!;
      const privacyPreference = input.privacy;
      if (input.mode === "scan_pay") {
        if (!input.recipient) throw new Error("A UPI receiver is required.");
        const q = await api.call("createQuote", { body: { mode: "scan_pay", inrPaise, privacyPreference }, idempotencyKey: newKey() });
        const r = await api.call("createScanPayIntent", {
          body: { quoteId: q.id, payee: { vpa: input.recipient.vpa, payeeName: input.recipient.payeeName, source: input.recipient.source }, payeeConfirmed: true, refundPreference: "manual_review", customerNote: input.customerNote || undefined },
          idempotencyKey: newKey(),
        });
        return afterCreate(r, { merchantId: null, linkId: null });
      }
      if (input.mode === "terminal") {
        const q = await api.call("createQuote", { body: { mode: "terminal", inrPaise, privacyPreference, merchantHandle: liveStore.merchant?.counterSlug }, idempotencyKey: newKey() });
        const r = await api.call("createTerminalIntent", { body: { quoteId: q.id, customerNote: input.customerNote || undefined }, idempotencyKey: newKey() });
        return afterCreate(r, { merchantId: requireMerchantId(), linkId: null });
      }
      if (input.mode === "payment_link") {
        const link = liveStore.getSnapshot()?.links.find((l) => l.id === input.linkId);
        const slug = link?.slug ?? input.linkId?.replace(/^slug:/, "");
        if (!slug) throw new Error("Payment link not found.");
        const q = await api.call("createQuote", { body: { mode: "payment_link", inrPaise, privacyPreference, linkSlug: slug }, idempotencyKey: newKey() });
        const r = await api.call("createLinkCheckout", { params: { slug }, body: { quoteId: q.id, customerNote: input.customerNote || undefined }, idempotencyKey: newKey() });
        return afterCreate(r, { merchantId: input.merchantId ?? null, linkId: input.linkId ?? null });
      }
      // counter_qr
      const m = liveStore.getSnapshot()?.merchants.find((x) => x.id === input.merchantId);
      const slug = m?.counterSlug || input.merchantId?.replace(/^counter:/, "");
      if (!slug) throw new Error("Merchant not found.");
      const q = await api.call("createQuote", { body: { mode: "counter_qr", inrPaise, privacyPreference, merchantHandle: slug }, idempotencyKey: newKey() });
      const r = await api.call("createCounterCheckout", { params: { handle: slug }, body: { quoteId: q.id, customerNote: input.customerNote || undefined }, idempotencyKey: newKey() });
      return afterCreate(r, { merchantId: input.merchantId ?? null, linkId: null });
    },
    async getIntent(id) {
      return liveStore.loadCheckout(id);
    },
    subscribeDepositState(id, cb) {
      return liveStore.watchCheckout(id, (c) => cb(c.depositStatus));
    },
    async refreshIntent(id) {
      const old = liveStore.getSnapshot()?.checkouts.find((c) => c.id === id);
      const r = await api.call("refreshCheckout", { params: { id }, idempotencyKey: newKey() });
      return afterCreate(r, { merchantId: old?.merchantId ?? null, linkId: old?.linkId ?? null });
    },
    async submitRefundAddress(id, zcashAddress) {
      await api.call("submitRefundDetails", { params: { id }, body: { zcashAddress }, idempotencyKey: newKey() });
      await liveStore.loadCheckout(id);
    },
    // Present only so DEMO-environment backends can be exercised end to end; the API rejects these elsewhere.
    async simulateDeposit(id, kind) {
      if (!backendIsDemo()) throw new Error("Simulation is only available against a DEMO backend.");
      await api.call("demoSimulateDeposit", { params: { id }, body: { kind, confirmations: 0 }, idempotencyKey: newKey() });
      await liveStore.loadCheckout(id);
    },
    async advanceConfirmation(id) {
      if (!backendIsDemo()) throw new Error("Simulation is only available against a DEMO backend.");
      await api.call("demoAdvanceConfirmations", { params: { id }, idempotencyKey: newKey() });
      await liveStore.loadCheckout(id);
    },
  },
  p2p: {
    async getOrder(id) {
      return liveStore.getSnapshot()?.orders.find((o) => o.id === id) ?? null;
    },
  },
  merchant: {
    async onboard(input) {
      const m = await api.call("createMerchant", { body: { displayName: input.businessName.trim(), handle: input.handle.toLowerCase(), category: input.category }, idempotencyKey: newKey() });
      await liveStore.refreshSession();
      // Payout destination needs a verified email + step-up. If the email is not verified yet the
      // console lists that gate; the destination is added later from Settings.
      if (input.payoutUpi && liveStore.session.emailVerified) {
        try {
          await withStepUp(() => api.call("createPayoutDestination", { body: { vpa: input.payoutUpi, beneficiaryName: input.beneficiaryName || undefined }, idempotencyKey: newKey() }));
          await liveStore.refreshMerchantData();
        } catch (e) {
          throw new Error(`Business created. Payout UPI not saved yet: ${e instanceof Error ? e.message : "error"}. Add it later in Settings.`);
        }
      }
      return liveStore.merchant ?? ({ id: m.id } as Merchant);
    },
    async updateMerchant(_id, patch) {
      if (patch.preferences) await api.call("updatePreferences", { body: patch.preferences, idempotencyKey: newKey() });
      if (patch.businessName !== undefined || patch.category !== undefined) {
        await api.call("updateMyMerchant", { body: { expectedVersion: liveStore.session.merchantVersion ?? 0, displayName: patch.businessName, category: patch.category }, idempotencyKey: newKey() });
      }
      if (patch.payoutUpi !== undefined) {
        const key = newKey();
        await withStepUp(() => api.call("createPayoutDestination", { body: { vpa: patch.payoutUpi!, beneficiaryName: patch.beneficiaryName || undefined }, idempotencyKey: key }));
      }
      await liveStore.refreshSession();
    },
    async regenerateCounterSlug() {
      await api.call("regenerateCounterQr", { idempotencyKey: newKey() });
      await liveStore.refreshSession();
    },
    async createLink(_merchantId, input) {
      const l = await api.call("createLink", {
        body: {
          title: input.title,
          description: input.description,
          reference: input.reference,
          amountMode: input.amountMode,
          fixedInrPaise: input.amountMode === "fixed" ? str(input.fixedInrMinor) : undefined,
          minInrPaise: input.amountMode === "variable" ? str(input.minInrMinor) : undefined,
          maxInrPaise: input.amountMode === "variable" ? str(input.maxInrMinor) : undefined,
          reusable: input.reusable,
          useLimit: input.reusable ? input.useLimit : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
          allowNote: input.allowNote,
        },
        idempotencyKey: newKey(),
      });
      await liveStore.refreshMerchantData();
      return liveStore.getSnapshot()!.links.find((x) => x.id === l.id) as PaymentLink;
    },
    async updateLink(id, patch) {
      const cur = await api.call("getLink", { params: { id } });
      await api.call("updateLink", { params: { id }, body: { expectedVersion: cur.version, ...patch }, idempotencyKey: newKey() });
      await liveStore.refreshMerchantData();
    },
    async revokeLink(id) {
      await api.call("revokeLink", { params: { id }, idempotencyKey: newKey() });
      await liveStore.refreshMerchantData();
    },
    async duplicateLink(id) {
      const l = await api.call("duplicateLink", { params: { id }, idempotencyKey: newKey() });
      await liveStore.refreshMerchantData();
      return liveStore.getSnapshot()!.links.find((x) => x.id === l.id) as PaymentLink;
    },
    async recordLinkView() {
      // The server counts views when the public link is fetched; opening never consumes quota.
    },
    async requestWithdrawal(_merchantId, inrMinor) {
      const dests = await api.call("listPayoutDestinations");
      const dest = dests.items.find((d) => d.status === "verified");
      if (!dest) throw new Error("Add and verify a payout UPI ID before withdrawing.");
      const key = newKey();
      const w = await withStepUp(() => api.call("createWithdrawal", { body: { inrPaise: String(inrMinor), payoutDestinationId: dest.id }, idempotencyKey: key }));
      await liveStore.refreshMerchantData();
      return mapWithdrawal(w) as Withdrawal;
    },
    async cancelWithdrawal(id) {
      await api.call("cancelWithdrawal", { params: { id }, idempotencyKey: newKey() });
      await liveStore.refreshMerchantData();
    },
    async recoverWithdrawal() {
      throw new Error("Failed withdrawals are recovered by Zeb Scan operators after the chain confirms no funds are in flight. Open a support case from Help.");
    },
  },
  ledger: {
    async getCredits(merchantId) {
      return liveStore.getSnapshot()?.credits.filter((c) => c.merchantId === merchantId) ?? [];
    },
    async getLedger(merchantId) {
      return liveStore.getSnapshot()?.ledger.filter((l) => l.merchantId === merchantId) ?? [];
    },
    async getTreasury() {
      throw new Error("Treasury data is restricted to the operator console.");
    },
  },
};
