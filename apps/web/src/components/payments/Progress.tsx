"use client";

import React from "react";
import { Stepper, type StepItem, type StepState } from "@/components/ui/Timeline";
import { formatDate } from "@/lib/format";
import type { CheckoutIntent, MerchantCredit, P2POrder, Withdrawal } from "@/types/domain";


/** Wallet verification + (for merchant modes) credit status steps. */
export function depositSteps(c: CheckoutIntent, credit?: MerchantCredit | null): StepItem[] {
  const st = c.depositStatus;
  const exception = ["underpaid", "overpaid", "late", "refund_pending", "refunded"].includes(st);
  const order = ["awaiting", "detected", "confirming", "accepted"];
  const idx = order.indexOf(st);
  const state = (i: number): StepState => {
    if (st === "expired") return i === 0 ? "failed" : "skipped";
    if (exception) return i === 0 ? "done" : i === 1 ? "failed" : "skipped";
    if (idx > i) return "done";
    if (idx === i) return st === "accepted" ? "done" : "current";
    return "upcoming";
  };
  const steps: StepItem[] = [
    {
      key: "awaiting",
      label: st === "expired" ? "Quote expired before payment" : "Waiting for ZEC",
      detail: st === "awaiting" ? "Send the exact amount to the unique address above." : undefined,
      state: state(0),
      at: c.createdAt,
    },
    {
      key: "detected",
      label: exception ? "Payment needs attention" : "ZEC detected · confirming",
      detail: c.deposit
        ? exception
          ? c.exceptionReason ?? undefined
          : c.deposit.confirmations >= c.deposit.requiredConfirmations ? `${c.deposit.confirmations} confirmations (${c.deposit.requiredConfirmations} required)` : `Confirming (${c.deposit.confirmations}/${c.deposit.requiredConfirmations})`
        : "Detected by wallet scanning, not by a screenshot or a reported transaction id.",
      state: state(1),
      at: c.deposit?.detectedAt,
    },
    {
      key: "accepted",
      label: "ZEC payment verified",
      state: idx >= 3 ? "done" : state(2),
      at: c.deposit?.acceptedAt ?? undefined,
    },
  ];
  if (c.merchantId) {
    const locked = credit && credit.status !== "pending";
    const available = credit && ["available", "withdrawal_reserved", "withdrawn"].includes(credit.status);
    steps.push({
      key: "locked",
      label: credit?.unlockAt ? `Credit locked until ${formatDate(credit.unlockAt)}` : "Merchant credit locked",
      detail: "INR-denominated platform credit — not a bank deposit.",
      state: exception || st === "expired" ? "skipped" : available ? "done" : locked ? "current" : "upcoming",
      at: credit?.lockedAt ?? undefined,
    });
    steps.push({
      key: "available",
      label: "Available to withdraw",
      detail: "After the cooldown the merchant can request a withdrawal.",
      state: exception || st === "expired" ? "skipped" : available ? "done" : "upcoming",
      at: credit?.availableAt ?? undefined,
    });
  }
  return steps;
}

export function DepositProgress({ checkout, credit }: { checkout: CheckoutIntent; credit?: MerchantCredit | null }) {
  return <Stepper label="Payment progress" steps={depositSteps(checkout, credit)} />;
}

const PAY_ORDER = ["queued", "matching", "accepted", "usdc_escrowed", "inr_processing", "completed"] as const;
const PAY_LABEL: Record<(typeof PAY_ORDER)[number], { label: string; detail: string }> = {
  queued: { label: "Order queued", detail: "PAY order (type 2) created, funded by the USDC treasury" },
  matching: { label: "LP matching", detail: "Waiting for a P2P liquidity provider" },
  accepted: { label: "Accepted", detail: "A liquidity provider accepted the order" },
  usdc_escrowed: { label: "USDC escrow", detail: "Treasury USDC locked in escrow on Base" },
  inr_processing: { label: "INR processing", detail: "Provider is sending INR to the UPI receiver" },
  completed: { label: "Completed", detail: "Provider confirmed the INR transfer" },
};

export function payoutSteps(o: P2POrder | null): StepItem[] {
  const cur = !o
    ? -1
    : o.status === "placed"
      ? o.matching
        ? 1
        : 0
      : o.status === "accepted"
        ? 2
        : o.status === "usdc_escrowed"
          ? 3
          : o.status === "inr_processing"
            ? 4
            : o.status === "completed"
              ? 5
              : -2;
  // Map each order event to its step index ("placed" appears twice: queued, then matching).
  const eventAt = new Map<number, number>();
  let placedSeen = 0;
  for (const e of o?.events ?? []) {
    const i = e.kind === "placed" ? (placedSeen++ === 0 ? 0 : 1) : PAY_ORDER.indexOf(e.kind as never);
    if (i >= 0 && !eventAt.has(i)) eventAt.set(i, e.at);
  }
  const reached = eventAt.size ? Math.max(...eventAt.keys()) : -1;
  return PAY_ORDER.map((k, i) => {
    let state: StepState = "upcoming";
    if (cur === -2) state = i <= reached ? "done" : i === reached + 1 ? "failed" : "skipped";
    else if (cur > i || (cur === 5 && i === 5)) state = "done";
    else if (cur === i) state = "current";
    return { key: k, label: PAY_LABEL[k].label, detail: PAY_LABEL[k].detail, state, at: eventAt.get(i) };
  });
}

export function PayoutProgress({ order }: { order: P2POrder | null }) {
  return <Stepper label="INR payout progress" steps={payoutSteps(order)} />;
}

const W_ORDER = ["requested", "matching", "accepted", "escrowed", "processing", "completed"] as const;
const W_LABEL: Record<(typeof W_ORDER)[number], { label: string; detail: string }> = {
  requested: { label: "Withdrawal requested", detail: "Available credit reserved" },
  matching: { label: "P2P SELL order · finding a payout provider", detail: "SELL order placed with P2P liquidity providers" },
  accepted: { label: "Provider accepted", detail: "A liquidity provider accepted the order" },
  escrowed: { label: "USDC escrowed", detail: "Treasury USDC (incl. fixed fees) approved and escrowed on Base" },
  processing: { label: "INR transfer in progress", detail: "Provider is sending INR to your UPI-linked account" },
  completed: { label: "Payout completed", detail: "Only marked complete once the provider confirms" },
};

export function withdrawalSteps(w: Withdrawal): StepItem[] {
  const idx = W_ORDER.indexOf(w.status as never);
  const reached = Math.max(0, ...w.events.map((e) => W_ORDER.indexOf(e.kind as never)));
  return W_ORDER.map((k, i) => {
    let state: StepState = "upcoming";
    if (idx === -1) state = i <= reached ? "done" : i === reached + 1 ? (w.status === "cancelled" ? "skipped" : w.status === "disputed" ? "current" : "failed") : "skipped";
    else if (idx > i || (k === "completed" && idx === i)) state = "done";
    else if (idx === i) state = "current";
    const ev = w.events.find((e) => e.kind === k);
    return { key: k, label: W_LABEL[k].label, detail: W_LABEL[k].detail, state, at: ev?.at };
  });
}
