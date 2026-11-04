"use client";

import React from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useMerchantData, checkoutTitle } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDate, formatRelativeDays } from "@/lib/format";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { Callout, EmptyState, MetricStrip } from "@/components/ui/Blocks";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { CREDIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import type { MerchantCredit } from "@/types/domain";


export function Settlements() {
  const { state } = useZeb();
  const now = useNow(10_000) ?? state.seededAt;
  const { credits, balance } = useMerchantData();
  const rows = [...credits].sort((a, b) => (a.unlockAt ?? Infinity) - (b.unlockAt ?? Infinity));
  const upcoming = credits.filter((c) => c.status === "locked" && c.unlockAt);
  const next7 = upcoming.filter((c) => c.unlockAt! - now <= 7 * 86_400_000).reduce((a, c) => a + c.inrMinor, 0);

  return (
    <>
      <MerchantPageHeader
        title="Settlements"
        description="When each credit unlocks. Unlocking makes a credit eligible to withdraw; it doesn't send INR anywhere."
        actions={
          <ButtonLink href="/app/withdrawals/new" variant="secondary">
            Request withdrawal
          </ButtonLink>
        }
      />
      <Callout tone="info" icon={CalendarClock} className="mb-6" title="Settlement availability">
        Testnet payments create reference receipts only. No INR credits or withdrawals are available. Any future live credit must show its server-approved lock period and verified backing.
      </Callout>
      <MetricStrip
        items={[
          { label: "Pending verification", value: formatInr(balance.pending) },
          { label: "Locked", value: formatInr(balance.locked), sub: `${upcoming.length} credits` },
          { label: "Unlocking in 7 days", value: formatInr(next7) },
          { label: "Available", value: formatInr(balance.available) },
        ]}
      />
      <div className="mt-6 grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8">
          <PanelHeader title="Cooldown schedule" />
          <DataTable<MerchantCredit>
            rows={rows}
            rowKey={(c) => c.id}
            caption="Cooldown schedule"
            mobileTitle={(c) => {
              const ck = state.checkouts.find((x) => x.id === c.checkoutId);
              return ck ? checkoutTitle(state, ck) : c.checkoutId;
            }}
            columns={[
              {
                key: "pay",
                header: "Payment",
                hideOnMobile: true,
                cell: (c) => {
                  const ck = state.checkouts.find((x) => x.id === c.checkoutId);
                  return (
                    <Link href={`/app/transactions/${c.checkoutId}`} className="link">
                      {ck ? checkoutTitle(state, ck) : c.checkoutId}
                      {c.parentCreditId && <span className="ml-1 text-micro text-foreground-muted">(split)</span>}
                    </Link>
                  );
                },
              },
              { key: "amt", header: "Amount", align: "right", cell: (c) => <span className="num">{formatInr(c.inrMinor)}</span> },
              { key: "locked", header: "Locked", cell: (c) => <span className="num text-label text-foreground-secondary">{c.lockedAt ? formatDate(c.lockedAt) : "—"}</span> },
              {
                key: "unlock",
                header: "Unlocks",
                cell: (c) => (
                  <span className="num text-label">
                    {c.unlockAt ? formatDate(c.unlockAt) : "After verification"}
                    {c.status === "locked" && c.unlockAt && <span className="block text-micro text-foreground-muted">{formatRelativeDays(c.unlockAt, now)}</span>}
                  </span>
                ),
              },
              { key: "status", header: "Status", cell: (c) => <MetaBadge meta={CREDIT_META[c.status]} /> },
            ]}
            empty={<EmptyState icon={CalendarClock} title="No credits yet" description="Verified payments create credits that appear here with their unlock date." />}
          />
        </Panel>
        <div className="space-y-6 xl:col-span-4">
          <Panel className="p-5 text-[13px] leading-relaxed text-foreground-secondary">
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">Rules</h2>
            <ul className="space-y-2">
              <li>• Only verified ZEC deposits create credits — one credit per deposit.</li>
              <li>• Underpaid, overpaid and late payments never create normal credits.</li>
              <li>• Credits unlock automatically at the date shown. Withdrawals are always a separate request.</li>
              <li>• Partial withdrawals split a credit; the rest stays available.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
