/**
 * Connected-mode store. Exposes the same subscribe/getSnapshot contract as the demo store, but the
 * snapshot is ONLY ever filled from backend responses — nothing is simulated or seeded here.
 * Freshness: SSE per open checkout / merchant stream, with bounded polling as a fallback.
 */
"use client";

import type { PublicConfigZ } from "@zeb/contracts";
import type { z } from "zod";
import { emptyState } from "@/services/model";
import type { CheckoutIntent, DemoState, Merchant, P2POrder, PaymentLink, Receipt } from "@/types/domain";
import { API_BASE, api, checkoutTokens, setCsrf } from "./api";
import { mapCheckout, mapCredit, mapLedger, mapLink, mapMerchant, mapReceipt, mapWithdrawal } from "./map";

type Listener = () => void;
export type PublicConfig = z.infer<typeof PublicConfigZ>;

export interface LiveSession {
  authenticated: boolean;
  emailVerified: boolean;
  role: string | null;
  gates: { canReceive: boolean; canWithdraw: boolean; reasons: string[] };
  merchantStatus: string | null;
  merchantVersion: number | null;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

class LiveStore {
  private state: DemoState = emptyState(0);
  private listeners = new Set<Listener>();
  ready = false;
  error: string | null = null;
  config: PublicConfig | null = null;
  session: LiveSession = { authenticated: false, emailVerified: false, role: null, gates: { canReceive: false, canWithdraw: false, reasons: [] }, merchantStatus: null, merchantVersion: null };
  private started = false;
  private merchantStream: EventSource | null = null;
  private pollTimer: number | null = null;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    if (!this.started && typeof window !== "undefined") {
      this.started = true;
      void this.init();
    }
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): DemoState | null => (this.ready ? this.state : null);
  getServerSnapshot = (): DemoState | null => null;

  private emit() {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }
  private set(fn: (s: DemoState) => DemoState) {
    this.state = fn(this.state);
    this.emit();
  }

  get platformFeeBps() {
    return this.config?.fees.platformFeeBps ?? 0;
  }
  get merchant(): Merchant | null {
    return this.state.merchants.find((m) => m.id === this.state.session.merchantId) ?? null;
  }

  async init() {
    try {
      this.config = await api.call("getPublicConfig");
      await this.refreshSession();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Backend unreachable";
    }
    this.ready = true;
    this.emit();
    this.pollTimer = window.setInterval(() => void this.reconnect(), 30_000);
    window.addEventListener("online", () => void this.reconnect());
  }

  private async reconnect() {
    try {
      if (this.error || !this.config) { this.config = await api.call("getPublicConfig");
      if (this.config.environment === "demo" && process.env.NEXT_PUBLIC_ISOLATED_TEST_API !== "true") throw new Error("Payments temporarily unavailable: a test fixture API cannot serve this build"); await this.refreshSession(); }
      else await this.refreshMerchantData();
      this.error = null;
    } catch { this.error = "Payments temporarily unavailable"; }
    this.emit();
  }

  async refreshSession() {
    const s = await api.call("getMerchantSession");
    setCsrf(s.csrfToken);
    this.session = {
      authenticated: s.authenticated,
      emailVerified: s.emailVerified,
      role: s.role,
      gates: s.gates,
      merchantStatus: s.merchant?.status ?? null,
      merchantVersion: s.merchant?.version ?? null,
    };
    if (s.merchant) {
      const merchant = s.merchant;
      this.set((st) => ({
        ...st,
        session: { merchantId: merchant.id, startedAt: Date.now(), opsUnlocked: false },
        merchants: upsert(st.merchants, mapMerchant(merchant, { payoutUpi: this.merchant?.payoutUpi, retiredCounterSlugs: this.merchant?.retiredCounterSlugs })),
      }));
      await this.refreshMerchantData();
      this.openMerchantStream();
    } else {
      this.set((st) => ({ ...st, session: { merchantId: null, startedAt: null, opsUnlocked: false } }));
      this.merchantStream?.close();
      this.merchantStream = null;
    }
  }

  private openMerchantStream() {
    if (this.merchantStream || typeof EventSource === "undefined") return;
    const es = new EventSource(`${API_BASE}/api/v1/events?resource=merchant:me`, { withCredentials: true });
    let t: number | null = null;
    es.onmessage = es.onerror = null;
    const kick = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => void this.refreshMerchantData().catch(() => undefined), 400);
    };
    for (const type of ["checkout.created", "checkout.updated", "credit.locked", "credit.available", "payment.testnet_received", "withdrawal.updated"]) es.addEventListener(type, kick);
    this.merchantStream = es;
  }

  /** Merchant-scoped data, all ledger-backed on the server. */
  async refreshMerchantData() {
    const mid = this.state.session.merchantId;
    if (!mid) return;
    const [links, txs, settlements, entries, withdrawals, dests, counter] = await Promise.all([
      api.call("listLinks", { query: { limit: 100 } }),
      api.call("listTransactions", { query: { limit: 50 } }),
      api.call("listSettlements", { query: { limit: 100 } }),
      api.call("listBalanceEntries", { query: { limit: 100 } }),
      api.call("listWithdrawals", { query: { limit: 50 } }),
      api.call("listPayoutDestinations").catch(() => ({ items: [] })),
      api.call("getCounterQr").catch(() => null),
    ]);
    const mappedLinks = links.items.map(mapLink);
    const checkouts = await Promise.all(txs.items.map((t) => api.call("getCheckout", { params: { id: t.id } }).catch(() => null)));
    const intents: CheckoutIntent[] = [];
    const orders: P2POrder[] = [];
    for (const c of checkouts) {
      if (!c) continue;
      const linkId = c.link ? (mappedLinks.find((l) => l.slug === c.link!.slug)?.id ?? null) : null;
      const { intent, order } = mapCheckout(c, { merchantId: mid, linkId, platformFeeBps: this.platformFeeBps });
      intents.push(intent);
      if (order) orders.push(order);
    }
    const receipts = (
      await Promise.all(
        intents
          .filter((i) => i.receiptId)
          .map((i) =>
            api
              .call("getReceipt", { params: { id: i.receiptId! } })
              .then((r) => mapReceipt(r, { checkoutId: i.id, merchantId: mid, mode: i.mode }))
              .catch(() => null),
          ),
      )
    ).filter((r): r is Receipt => r !== null);
    const dest = dests.items.find((d) => d.status !== "removed") ?? null;
    this.set((st) => {
      const others = (arr: { merchantId: string | null }[]) => arr.filter((x) => x.merchantId !== mid);
      const me = st.merchants.find((m) => m.id === mid);
      return {
        ...st,
        merchants: me ? upsert(st.merchants, { ...me, payoutUpi: dest ? `${dest.vpaMasked}${dest.status === "verified" ? "" : ` (${dest.status.replace(/_/g, " ")})`}` : "", beneficiaryName: dest?.beneficiaryName ?? "", retiredCounterSlugs: counter?.retiredSlugs ?? me.retiredCounterSlugs }) : st.merchants,
        links: [...(others(st.links) as PaymentLink[]), ...mappedLinks],
        checkouts: [...(others(st.checkouts) as CheckoutIntent[]), ...intents],
        orders: [...st.orders.filter((o) => !intents.some((i) => `pay_${i.id}` === o.id)), ...orders],
        credits: [...st.credits.filter((c) => c.merchantId !== mid), ...settlements.items.map((s) => mapCredit(s, mid)).filter((c): c is NonNullable<typeof c> => c !== null)],
        ledger: [...st.ledger.filter((l) => l.merchantId !== mid), ...mapLedger(entries.items, mid)],
        withdrawals: [...st.withdrawals.filter((w) => w.merchantId !== mid), ...withdrawals.items.map(mapWithdrawal)],
        receipts: [...st.receipts.filter((r) => r.merchantId !== mid), ...receipts],
      };
    });
  }

  /* ---------------------------------------------------------------- payer-side resources */

  /** Fetch one checkout (scoped token or merchant session) and merge it into the snapshot. */
  async loadCheckout(id: string, cx?: { merchantId?: string | null; linkId?: string | null }): Promise<CheckoutIntent | null> {
    const c = await api.call("getCheckout", { params: { id } }).catch(() => null);
    if (!c) return null;
    const existing = this.state.checkouts.find((x) => x.id === id);
    const merchantId = cx?.merchantId ?? existing?.merchantId ?? (c.merchant ? `handle:${c.merchant.handle}` : null);
    const linkId = cx?.linkId ?? existing?.linkId ?? (c.link ? `slug:${c.link.slug}` : null);
    const { intent, order } = mapCheckout(c, { merchantId, linkId, platformFeeBps: this.platformFeeBps });
    let receipt: Receipt | null = null;
    if (intent.receiptId) {
      checkoutTokens.linkReceipt(id, intent.receiptId);
      receipt = await api
        .call("getReceipt", { params: { id: intent.receiptId }, accessToken: checkoutTokens.get(id) ?? undefined })
        .then((r) => mapReceipt(r, { checkoutId: id, merchantId, mode: intent.mode }))
        .catch(() => null);
    }
    this.set((st) => ({
      ...st,
      checkouts: upsert(st.checkouts, intent),
      orders: order ? upsert(st.orders, order) : st.orders,
      receipts: receipt ? upsert(st.receipts, receipt) : st.receipts,
      merchants:
        c.merchant && merchantId?.startsWith("handle:") && !st.merchants.some((m) => m.id === merchantId)
          ? [...st.merchants, publicMerchant(merchantId, c.merchant.displayName, c.merchant.handle, "")]
          : st.merchants,
    }));
    return intent;
  }

  /** Live updates for one checkout: SSE, with bounded polling when SSE is unavailable. */
  watchCheckout(id: string, onChange: (c: CheckoutIntent) => void): () => void {
    let closed = false;
    let es: EventSource | null = null;
    let poll: number | null = null;
    const refresh = async () => {
      const c = await this.loadCheckout(id);
      if (c && !closed) onChange(c);
    };
    const startPolling = (every = 5_000) => {
      if (poll) return;
      poll = window.setInterval(() => void refresh(), every);
    };
    const token = checkoutTokens.get(id);
    if (typeof EventSource !== "undefined") {
      const qs = new URLSearchParams({ resource: `checkout:${id}`, ...(token ? { access_token: token } : {}) });
      es = new EventSource(`${API_BASE}/api/v1/events?${qs}`, { withCredentials: true });
      let t: number | null = null;
      const kick = () => {
        if (t) window.clearTimeout(t);
        t = window.setTimeout(() => void refresh(), 250);
      };
      es.onmessage = kick;
      for (const type of ["checkout.awaiting_zec", "checkout.deposit_seen", "checkout.confirming", "checkout.deposit_accepted", "checkout.expired_without_funds", "checkout.late_deposit", "checkout.underpaid", "checkout.overpaid", "checkout.refund_queued", "checkout.chain_reorg_review", "checkout.manual_review", "checkout.cancelled", "deposit.confirming", "deposit.reorged", "deposit.extra", "credit.locked", "receipt.issued", "refund.details_received"]) es.addEventListener(type, kick);
      for (const p of ["payout_queued", "order_placing", "placed", "merchant_accepted", "usdc_escrowed", "inr_processing", "provider_completed", "payout_reconciled", "completed", "cancelled", "provider_timeout", "not_liquid", "provider_failed", "disputed", "manual_review", "refund_queued"]) es.addEventListener(`payout.${p}`, kick);
      es.addEventListener("access_revoked", () => es?.close());
      es.onerror = () => startPolling(10_000); // keep SSE retrying; poll as a fallback meanwhile
    } else startPolling();
    void refresh();
    return () => {
      closed = true;
      es?.close();
      if (poll) window.clearInterval(poll);
    };
  }

  async ensurePublicLink(slug: string) {
    if (this.state.links.some((l) => l.slug === slug && l.id.startsWith("slug:"))) return;
    const l = await api.call("getPublicLink", { params: { slug } });
    const merchantId = `handle:${l.merchant.handle}`;
    const link: PaymentLink = {
      id: `slug:${l.slug}`,
      merchantId,
      slug: l.slug,
      title: l.title,
      description: l.description,
      amountMode: l.amountMode,
      fixedInrMinor: l.fixedInrPaise ? Number(l.fixedInrPaise) : null,
      minInrMinor: Number(l.minInrPaise),
      maxInrMinor: Number(l.maxInrPaise),
      reusable: true,
      useLimit: null,
      expiresAt: l.expiresAt ? Date.parse(l.expiresAt) : null,
      allowNote: l.allowNote,
      reference: "",
      revokedAt: l.status === "revoked" ? Date.now() : null,
      createdAt: 0,
      views: 0,
      liveStatus: l.status,
    };
    this.set((st) => ({ ...st, links: upsert(st.links, link), merchants: upsert(st.merchants, publicMerchant(merchantId, l.merchant.displayName, l.merchant.handle, "", l.merchant.logoUrl)) }));
  }

  async ensurePublicMerchant(counterSlug: string) {
    const id = `counter:${counterSlug}`;
    if (this.state.merchants.some((m) => m.id === id)) return;
    const m = await api.call("getPublicMerchant", { params: { handle: counterSlug } });
    this.set((st) => ({ ...st, merchants: upsert(st.merchants, publicMerchant(id, m.displayName, m.handle, counterSlug, m.logoUrl)) }));
  }

  async ensureReceipt(receiptId: string) {
    if (this.state.receipts.some((r) => r.id === receiptId)) return;
    const checkoutId = checkoutTokens.checkoutForReceipt(receiptId);
    if (checkoutId) await this.loadCheckout(checkoutId);
  }

  async signOut() {
    await api.call("logout").catch(() => undefined);
    setCsrf(null);
    this.merchantStream?.close();
    this.merchantStream = null;
    this.state = { ...emptyState(0), merchants: [], session: { merchantId: null, startedAt: null, opsUnlocked: false } };
    this.session = { ...this.session, authenticated: false, role: null, merchantStatus: null, merchantVersion: null };
    this.emit();
  }

  notify() {
    this.emit();
  }

  dispose() {
    this.merchantStream?.close();
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }
}

function publicMerchant(id: string, name: string, handle: string, counterSlug: string, logo?: string | null): Merchant {
  return {
    id,
    businessName: name,
    handle,
    category: "",
    logoDataUrl: logo ?? undefined,
    payoutUpi: "",
    beneficiaryName: "",
    counterSlug,
    retiredCounterSlugs: [],
    createdAt: 0,
    isSample: false,
    preferences: { defaultPrivacy: "shielded", allowTransparent: false, notifyOnCredit: false, notifyOnWithdrawal: false, showZecOnReceipts: true },
  };
}

export const liveStore = new LiveStore();
export type { LiveStore };
