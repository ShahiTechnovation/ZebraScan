"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, Link2, Lock, QrCode } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useMerchantData, checkoutTitle } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDate, formatRelativeDays } from "@/lib/format";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Blocks";
import { CheckoutStatus } from "./shared";

/**
 * Merchant home (delta spec §9.3): one balance row, two primary actions, the last few payments.
 * No KPI wall, no charts, no fabricated activity.
 */
export function Overview() {
  const { state, isDemo, canTransact } = useZeb();
  const now = useNow(30_000);
  const { merchant, checkouts, credits, balance } = useMerchantData();
  if (!merchant) return null;

  const locked = credits.filter((c) => c.status === "locked" && c.unlockAt);
  const nextUnlock = locked.length ? Math.min(...locked.map((c) => c.unlockAt!)) : null;
  const recent = checkouts.slice(0, 5);
  const creditOf = (id: string) => state.credits.find((cr) => cr.checkoutId === id && !cr.parentCreditId);

  return (
    <div className="mx-auto max-w-[640px]">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{merchant.businessName}</h1>
      <p className="mt-1 text-[14px] text-foreground-secondary">
        INR equivalent balance (held by Zeb Scan){isDemo ? " · demo, simulated" : ""}. Not yet in your bank account.
      </p>

      <section aria-label="Balance" className="mt-6 grid grid-cols-2 overflow-hidden rounded-panel border border-border bg-surface-1">
        <div className="p-5">
          <p className="text-label text-foreground-secondary">Available for withdrawal</p>
          <p className="num mt-1 text-[30px] font-semibold tracking-[-0.02em]">{formatInr(balance.available)}</p>
          <Link href="/app/balance" className="mt-2 inline-flex items-center gap-1 text-label font-medium text-accent hover:underline">
            Balance &amp; withdraw <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="border-l border-border p-5">
          <p className="flex items-center gap-1 text-label text-foreground-secondary">
            <Lock aria-hidden className="h-3.5 w-3.5" /> Locked INR credit
          </p>
          <p className="num mt-1 text-[30px] font-semibold tracking-[-0.02em] text-foreground-secondary">{formatInr(balance.locked)}</p>
          <p className="mt-2 text-label text-foreground-secondary">
            {nextUnlock ? `Next unlock ${formatDate(nextUnlock)}${now ? ` (${formatRelativeDays(nextUnlock, now)})` : ""}` : "Nothing locked"}
          </p>
        </div>
      </section>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <ButtonLink href="/app/terminal" size="lg" className="w-full" aria-disabled={!canTransact}>
          <QrCode aria-hidden className="h-4 w-4" /> Receive payment
        </ButtonLink>
        <ButtonLink href="/app/links/new" size="lg" variant="secondary" className="w-full">
          <Link2 aria-hidden className="h-4 w-4" /> Create payment link
        </ButtonLink>
      </div>

      <section aria-label="Recent payments" className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[16px] font-semibold">Recent payments</h2>
          {checkouts.length > 0 && (
            <Link href="/app/transactions" className="text-label font-medium text-accent hover:underline">
              All activity
            </Link>
          )}
        </div>
        {recent.length === 0 ? (
          <EmptyState className="mt-3" title="No payments yet" description="Create a QR on Receive or share a payment link. Payments appear here once ZEC is detected." />
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-panel border border-border bg-surface-1">
            {recent.map((c) => (
              <li key={c.id}>
                <Link href={`/app/transactions/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-surface-hover">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">{checkoutTitle(state, c)}</span>
                    <span className="block text-label text-foreground-secondary">{formatDate(c.createdAt)}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="num text-[14px] font-medium">{formatInr(c.quote.inrMinor)}</span>
                    <CheckoutStatus c={c} credit={creditOf(c.id)} short />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
