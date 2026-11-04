"use client";

import React, { useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useMerchantData, checkoutTitle } from "@/lib/selectors";
import type { PaymentMode } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Blocks";
import { Input, SearchInput, Segmented, Select } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { txColumns } from "./shared";

type TypeFilter = "all" | Exclude<PaymentMode, "scan_pay">;
type StatusFilter = "all" | "verified" | "in_progress" | "exceptions" | "expired";

export function Transactions() {
  const { state } = useZeb();
  const { checkouts } = useMerchantData();
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    return checkouts.filter((c) => {
      if (type !== "all" && c.mode !== type) return false;
      if (status === "verified" && c.depositStatus !== "accepted") return false;
      if (status === "in_progress" && !["awaiting", "detected", "confirming"].includes(c.depositStatus)) return false;
      if (status === "exceptions" && !["underpaid", "overpaid", "late", "refund_pending", "refunded"].includes(c.depositStatus)) return false;
      if (status === "expired" && c.depositStatus !== "expired") return false;
      if (fromMs && c.createdAt < fromMs) return false;
      if (toMs && c.createdAt > toMs) return false;
      if (needle) {
        const hay = [c.id, checkoutTitle(state, c), (c.quote.inrMinor / 100).toFixed(2)].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [checkouts, state, q, type, status, from, to]);

  return (
    <>
      <MerchantPageHeader title="Transactions" description="Every checkout across your terminal, counter QR and payment links — including expired and exception cases." />
      <Panel>
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Segmented<TypeFilter>
              label="Filter by source"
              size="sm"
              value={type}
              onChange={setType}
              options={[
                { value: "all", label: "All", count: checkouts.length },
                { value: "terminal", label: "Terminal", count: checkouts.filter((c) => c.mode === "terminal").length },
                { value: "counter_qr", label: "Counter QR", count: checkouts.filter((c) => c.mode === "counter_qr").length },
                { value: "payment_link", label: "Payment Link", count: checkouts.filter((c) => c.mode === "payment_link").length },
              ]}
            />
            <SearchInput label="Search transactions" placeholder="Search id, title or amount" value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="lg:w-72" />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All statuses</option>
              <option value="verified">ZEC verified</option>
              <option value="in_progress">Waiting / confirming</option>
              <option value="exceptions">Exceptions & refunds</option>
              <option value="expired">Expired quotes</option>
            </Select>
            <Input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <DataTable
          rows={rows}
          columns={txColumns(state)}
          rowKey={(c) => c.id}
          onRowHref={(c) => `/app/transactions/${c.id}`}
          caption="Transactions"
          mobileTitle={(c) => (
            <span className="flex flex-col">
              <span>{checkoutTitle(state, c)}</span>
              <span className="font-mono text-micro text-foreground-muted">{c.id}</span>
            </span>
          )}
          empty={
            <EmptyState
              icon={Inbox}
              title={checkouts.length ? "No transactions match" : "No transactions yet"}
              description={checkouts.length ? "Adjust the filters or search." : "Create a checkout at the terminal to see it here."}
              action={
                !checkouts.length && (
                  <ButtonLink href="/app/terminal" size="sm">
                    Open QR Terminal
                  </ButtonLink>
                )
              }
            />
          }
        />
      </Panel>
    </>
  );
}
