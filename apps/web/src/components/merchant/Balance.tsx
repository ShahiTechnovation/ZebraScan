"use client";

import React, { useMemo, useState } from "react";
import { ArrowDownToLine, Hourglass, Landmark, Lock, LockOpen, ScrollText } from "lucide-react";
import { useMerchantData } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { COPY } from "@/config/mode";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { Callout, DataList, EmptyState, MetricStrip } from "@/components/ui/Blocks";
import { Segmented } from "@/components/ui/Field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import type { LedgerEntry } from "@/types/domain";
type F = "all" | "credit" | "debit" | "memo";

export function Balance() {
  const { ledger, balance, merchant } = useMerchantData();
  const [f, setF] = useState<F>("all");
  const rows = useMemo(() => ledger.filter((l) => f === "all" || l.direction === f), [ledger, f]);
  if (!merchant) return null;

  return (
    <>
      <MerchantPageHeader
        title="Balance"
        description={`${COPY.balanceDescriptor} · ${COPY.balanceSub}`}
        actions={
          <ButtonLink href="/app/withdrawals/new">
            <ArrowDownToLine aria-hidden className="h-4 w-4" /> Withdraw
          </ButtonLink>
        }
      />
      <Callout tone="info" icon={Landmark} className="mb-6" title="Merchant Platform Balance">
        Testnet payments are reference receipts only. They create no redeemable INR balance, and withdrawals remain disabled.
      </Callout>
      <MetricStrip
        items={[
          { label: "Pending verification", value: formatInr(balance.pending), sub: "ZEC detected, confirming", icon: Hourglass },
          { label: "Locked INR", value: formatInr(balance.locked), sub: "In cooldown", icon: Lock },
          { label: "Available INR", value: formatInr(balance.available), sub: "Eligible to withdraw", icon: LockOpen },
          { label: "Withdrawal processing", value: formatInr(balance.reserved), sub: "Reserved for payouts", icon: ArrowDownToLine },
        ]}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8">
          <PanelHeader title="Ledger" icon={<ScrollText />} description="Credits, reservations and releases — newest first" />
          <div className="border-b border-border p-4">
            <Segmented<F>
              label="Filter ledger"
              size="sm"
              value={f}
              onChange={setF}
              options={[
                { value: "all", label: "All" },
                { value: "credit", label: "Credits" },
                { value: "debit", label: "Debits" },
                { value: "memo", label: "Status changes" },
              ]}
            />
          </div>
          <DataTable<LedgerEntry>
            rows={rows}
            rowKey={(l) => l.id}
            caption="Balance ledger"
            mobileTitle={(l) => l.description}
            columns={[
              { key: "at", header: "Date", cell: (l) => <span className="num whitespace-nowrap text-label text-foreground-secondary">{formatDateTime(l.at)}</span> },
              { key: "desc", header: "Entry", hideOnMobile: true, cell: (l) => <span>{l.description}</span> },
              { key: "ref", header: "Reference", cell: (l) => <span className="font-mono text-micro text-foreground-secondary">{l.refId}</span> },
              {
                key: "amt",
                header: "Amount",
                align: "right",
                cell: (l) => (
                  <span className={l.direction === "credit" ? "num text-success" : l.direction === "debit" ? "num text-foreground" : "num text-foreground-secondary"}>
                    {l.direction === "credit" ? "+" : l.direction === "debit" ? "−" : ""}
                    {formatInr(l.inrMinor)}
                    {l.direction === "memo" && <span className="ml-1 text-micro">(status)</span>}
                  </span>
                ),
              },
            ]}
            empty={<EmptyState title="No ledger entries" description="Entries appear when a payment is detected or a withdrawal is requested." />}
          />
        </Panel>

        <div className="space-y-6 xl:col-span-4">
          <Panel>
            <PanelHeader title="Liability & backing" />
            <PanelBody>
              <DataList
                items={[
                  { label: "Outstanding liability", value: formatInr(balance.liability), hint: "Pending + locked + available + reserved" },
                  { label: "Already withdrawn", value: formatInr(balance.withdrawn) },
                  { label: "USDC equivalent reserved", value: `${"Unverified"} USDC`, hint: "Treasury reservation backed by USDC on Base" },
                ]}
              />
              <p className="mt-3 text-micro leading-relaxed text-foreground-muted">
                Every merchant credit is matched with reserved treasury liquidity on Base for settlement execution.
              </p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </>
  );
}
