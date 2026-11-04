"use client";

import { useMemo } from "react";
import { useZeb } from "@/providers/ZebProvider";
import { balances, linkStatus, linkSuccessfulUses } from "@/services/model";
import type { CheckoutIntent, DemoState, PaymentLink } from "@/types/domain";

/** Only data owned by the signed-in merchant — never other merchants' balances. */
export function useMerchantData() {
  const { state, merchant } = useZeb();
  return useMemo(() => {
    const mid = merchant?.id ?? "__none__";
    const checkouts = state.checkouts.filter((c) => c.merchantId === mid).sort((a, b) => b.createdAt - a.createdAt);
    const links = state.links.filter((l) => l.merchantId === mid).sort((a, b) => b.createdAt - a.createdAt);
    const credits = state.credits.filter((c) => c.merchantId === mid);
    const ledger = state.ledger.filter((l) => l.merchantId === mid).sort((a, b) => b.at - a.at);
    const withdrawals = state.withdrawals.filter((w) => w.merchantId === mid).sort((a, b) => b.createdAt - a.createdAt);
    const receipts = state.receipts.filter((r) => r.merchantId === mid).sort((a, b) => b.issuedAt - a.issuedAt);
    return { merchant, checkouts, links, credits, ledger, withdrawals, receipts, balance: balances(state, mid) };
  }, [state, merchant]);
}

export function effectiveLinkStatus(state: DemoState, link: PaymentLink, now: number) {
  if (link.liveStatus) return link.revokedAt ? "revoked" : link.liveStatus;
  return linkStatus(state, link, now);
}

export function linkUses(state: DemoState, link: PaymentLink) {
  if (link.liveSuccessfulUses !== undefined) return link.liveSuccessfulUses;
  return linkSuccessfulUses(state, link.id);
}

/** Transactions table only shows checkouts that reached a deposit or are still live/expired. */
export function checkoutTitle(state: DemoState, c: CheckoutIntent): string {
  if (c.linkId) return state.links.find((l) => l.id === c.linkId)?.title ?? "Payment link";
  if (c.mode === "terminal") return "Terminal payment";
  if (c.mode === "counter_qr") return "Counter QR payment";
  return "Scan & Pay";
}
