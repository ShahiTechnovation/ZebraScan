"use client";

import React, { useMemo, useState } from "react";
import { ArrowDownToLine, Plus } from "lucide-react";
import { useMerchantData } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import type { Withdrawal, WithdrawalStatus } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Blocks";
import { Select } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { MetaBadge, WITHDRAWAL_META } from "@/components/ui/StatusBadge";

const GROUPS: Record<string, WithdrawalStatus[]> = {
  active: ["requested", "matching", "accepted", "escrowed", "processing"],
  completed: ["completed"],
  attention: ["failed", "disputed"],
  cancelled: ["cancelled"],
};

export function Withdrawals() {
  const { withdrawals } = useMerchantData();
  const [filter, setFilter] = useState<string>("all");
  const rows = useMemo(() => (filter === "all" ? withdrawals : withdrawals.filter((w) => (GROUPS[filter] ?? [filter]).includes(w.status))), [withdrawals, filter]);
  return (
    <>
      <MerchantPageHeader
        title="Withdrawals"
        description="Cash out available INR credit to your UPI-linked account through a P2P payout provider. Not guaranteed instant."
        actions={
          <ButtonLink href="/app/withdrawals/new">
            <Plus aria-hidden className="h-4 w-4" /> New withdrawal
          </ButtonLink>
        }
      />
      <Panel>
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <Select aria-label="Filter withdrawals by status" value={filter} onChange={(e) => setFilter(e.target.value)} className="sm:w-64">
            <option value="all">All withdrawals</option>
            <option value="active">In progress</option>
            <option value="completed">Completed</option>
            <option value="attention">Failed or disputed</option>
            <option value="cancelled">Cancelled</option>
            <optgroup label="Exact status">
              {(Object.keys(WITHDRAWAL_META) as WithdrawalStatus[]).map((s) => (
                <option key={s} value={s}>
                  {WITHDRAWAL_META[s].label}
                </option>
              ))}
            </optgroup>
          </Select>
          <span className="text-label text-foreground-secondary">{rows.length} shown</span>
        </div>
        <DataTable<Withdrawal>
          rows={rows}
          rowKey={(w) => w.id}
          onRowHref={(w) => `/app/withdrawals/${w.id}`}
          caption="Withdrawals"
          mobileTitle={(w) => <span className="font-mono text-label">{w.id}</span>}
          columns={[
            { key: "id", header: "Withdrawal", hideOnMobile: true, cell: (w) => <span className="font-mono text-label">{w.id}</span> },
            { key: "amt", header: "Requested", align: "right", cell: (w) => <span className="num font-medium">{formatInr(w.inrMinor)}</span> },
            { key: "payout", header: "Est. payout", align: "right", cell: (w) => <span className="num text-foreground-secondary">{formatInr(w.payoutInrMinor)}</span> },
            { key: "upi", header: "To UPI", cell: (w) => <span className="font-mono text-label text-foreground-secondary">{w.payoutUpi}</span> },
            { key: "date", header: "Requested on", cell: (w) => <span className="num text-label text-foreground-secondary">{formatDateTime(w.createdAt)}</span> },
            { key: "status", header: "Status", cell: (w) => <MetaBadge meta={WITHDRAWAL_META[w.status]} label={w.status === "failed" && w.recoveredAt ? "Failed · funds restored" : undefined} /> },
          ]}
          empty={
            <EmptyState
              icon={ArrowDownToLine}
              title={withdrawals.length ? "No withdrawals match" : "No withdrawals yet"}
              description={withdrawals.length ? "Try another filter." : "Once credits finish their cooldown, you can withdraw them to your UPI-linked account."}
            />
          }
        />
      </Panel>
    </>
  );
}
