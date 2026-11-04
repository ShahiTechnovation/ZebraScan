"use client";

import React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { CREDIT_META, DEPOSIT_META, MetaBadge, P2P_META, WITHDRAWAL_META } from "@/components/ui/StatusBadge";

const TROUBLE = [
  {
    q: "A customer says they paid, but it still shows “Waiting for ZEC”",
    a: "Deposits are detected by the receiving wallet scanning the chain, which can take a short while after the customer sends. Don't accept a screenshot or a transaction id as proof — wait until the status reads “ZEC payment verified”. If the quote expired first, the payment is tracked as late and routed to recovery.",
  },
  {
    q: "The UPI QR won't scan or is rejected",
    a: "Zeb Scan only reads standard upi://pay QR codes with a receiver UPI ID and INR currency. Mandate, collect and some signed merchant dynamic QRs aren't supported. Try uploading a clearer image, pasting the QR text, or entering the UPI ID manually.",
  },
  {
    q: "The quote expired",
    a: `Quotes last until the server expiry shown on the checkout. Use “Refresh quote” — it creates a new checkout with a new quote and a new unique address. Never send ZEC to an expired checkout.`,
  },
  {
    q: "The amount received doesn't match",
    a: "Underpaid and overpaid deposits are held as exceptions and never create a normal credit. Start a refund from the transaction page, then create a new checkout for the correct amount.",
  },
  {
    q: "Why can't I withdraw my balance yet?",
    a: `New credits are locked during the settlement cooldown shown by the server. Check the unlock dates on the Settlements page. Only one withdrawal can be in progress at a time.`,
  },
  {
    q: "A withdrawal failed or is disputed",
    a: "The amount stays reserved — it's never lost or double-debited. For a failed payout, use “Restore funds to available balance” on the withdrawal page, then request again. Disputes are resolved with the payout provider.",
  },
  {
    q: "How do refunds work?",
    a: "Exceptions (underpaid, overpaid, late, or a payment to an exhausted link) move to “Refund pending” and are returned to a payer-provided ZEC address. Refunds for completed sales are arranged between you and your customer.",
  },
];

function Glossary<T extends string>({ title, meta, notes }: { title: string; meta: Record<T, { label: string; tone: never | string; icon: never | unknown }>; notes: Partial<Record<T, string>> }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <ul className="divide-y divide-border">
        {(Object.keys(meta) as T[]).map((k) => (
          <li key={k} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
            <span className="shrink-0 sm:w-56">
              <MetaBadge meta={meta[k] as never} />
            </span>
            <span className="text-[13px] text-foreground-secondary">{notes[k]}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function Help() {
  const { merchant } = useZeb();
  return (
    <>
      <MerchantPageHeader
        title="Help center"
        description="Troubleshooting and what every payment and withdrawal state means."
        actions={!merchant && <ButtonLink href="/login">Merchant sign in</ButtonLink>}
      />
      <div className="grid gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-7">
          <Panel>
            <PanelHeader title="Troubleshooting" />
            <div className="divide-y divide-border">
              {TROUBLE.map((t) => (
                <details key={t.q} className="group">
                  <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 px-5 py-3.5 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
                    {t.q}
                    <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-foreground-secondary transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="px-5 pb-4 text-[13px] leading-relaxed text-foreground-secondary">{t.a}</p>
                </details>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Contact" />
            <PanelBody className="text-[13px] leading-relaxed text-foreground-secondary">
              For support inquiries or network status questions, refer to the <Link href="/faq" className="link">FAQ</Link> and{" "}
              <Link href="/how-it-works" className="link">How it works</Link> or reach out to your account representative.
            </PanelBody>
          </Panel>
        </div>
        <div className="space-y-6 xl:col-span-5">
          <Glossary
            title="Payment (ZEC deposit) states"
            meta={DEPOSIT_META}
            notes={{
              awaiting: "Checkout created; waiting for the customer's ZEC.",
              detected: "Wallet saw the payment; no confirmations yet.",
              confirming: "Gaining confirmations under the confirmation policy.",
              accepted: "Verified once. Creates exactly one credit or one payout.",
              expired: "Quote ran out before any payment.",
              underpaid: "Less than due. No credit.",
              overpaid: "More than due. Held for review/refund of excess.",
              late: "Arrived after expiry. Held for recovery.",
              refund_pending: "Refund in progress.",
              refunded: "Returned to the payer.",
            }}
          />
          <Glossary
            title="Merchant credit states"
            meta={CREDIT_META}
            notes={{
              pending: "Deposit detected, not yet verified.",
              locked: "Verified; waiting for cooldown.",
              available: "Eligible to withdraw. Still not in your bank.",
              withdrawal_reserved: "Held for a withdrawal in progress.",
              withdrawn: "Paid out by a provider.",
            }}
          />
          <Glossary
            title="Withdrawal states"
            meta={WITHDRAWAL_META}
            notes={{
              requested: "Available credit reserved.",
              matching: "SELL order placed; finding a provider.",
              accepted: "Provider accepted the order.",
              escrowed: "Treasury USDC escrowed for the provider.",
              processing: "Provider is sending INR.",
              completed: "Only after the provider confirms.",
              failed: "Restore funds explicitly, then retry.",
              disputed: "Under review.",
              cancelled: "Cancelled before acceptance; funds returned.",
            }}
          />
          <Glossary
            title="Scan & Pay payout states"
            meta={P2P_META}
            notes={{
              not_started: "Waiting for ZEC verification.",
              placed: "PAY order queued / matching a provider.",
              accepted: "Provider accepted.",
              usdc_escrowed: "USDC locked in escrow on Base.",
              inr_processing: "INR being sent to the UPI receiver.",
              completed: "Provider confirmed the transfer.",
              cancelled: "Closed (e.g. replaced by a retry).",
              failed: "Retry or refund ZEC.",
              disputed: "Under review.",
            }}
          />
        </div>
      </div>
    </>
  );
}
