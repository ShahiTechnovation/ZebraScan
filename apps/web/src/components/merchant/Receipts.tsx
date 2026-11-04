"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ReceiptText } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useMerchantData } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { modeLabel } from "@/services/model";
import type { Receipt } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { EmptyState } from "@/components/ui/Blocks";
import { SearchInput } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ReceiptActions, ReceiptDocument } from "@/components/payments/ReceiptDocument";
import { NotFoundPanel } from "@/components/screens/NotFoundPanel";

export function Receipts() {
  const { receipts } = useMerchantData();
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? receipts.filter((r) => [r.id, r.checkoutId, r.title, (r.inrMinor / 100).toFixed(2)].join(" ").toLowerCase().includes(n)) : receipts;
  }, [receipts, q]);
  return (
    <>
      <MerchantPageHeader title="Receipts" description="Cryptographically verifiable payment receipts issued for verified ZEC deposits." />
      <Panel>
        <div className="border-b border-border p-4">
          <SearchInput label="Search receipts" placeholder="Search receipt id, payment reference, title or amount" value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="sm:max-w-md" />
        </div>
        <DataTable<Receipt>
          rows={rows}
          rowKey={(r) => r.id}
          onRowHref={(r) => `/app/receipts/${r.id}`}
          caption="Receipts"
          mobileTitle={(r) => r.title}
          columns={[
            { key: "id", header: "Receipt", hideOnMobile: true, cell: (r) => <span className="font-mono text-label">{r.id}</span> },
            { key: "title", header: "For", cell: (r) => <span>{r.title}</span> },
            { key: "mode", header: "Source", cell: (r) => <span className="text-foreground-secondary">{modeLabel(r.mode)}</span> },
            { key: "amt", header: "Amount", align: "right", cell: (r) => <span className="num font-medium">{formatInr(r.inrMinor)}</span> },
            { key: "date", header: "Issued", cell: (r) => <span className="num text-label text-foreground-secondary">{formatDateTime(r.issuedAt)}</span> },
            { key: "ver", header: "Verification", cell: (r) => <StatusBadge tone={r.simulated ? "accent" : "success"}>{r.simulated ? "Simulated" : "Wallet verified"}</StatusBadge> },
          ]}
          empty={<EmptyState icon={ReceiptText} title={receipts.length ? "No receipts match" : "No receipts yet"} description="Receipts are issued when a ZEC payment is verified." />}
        />
      </Panel>
    </>
  );
}

export function ReceiptDetail({ id }: { id: string }) {
  const { state, merchant } = useZeb();
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  if (!merchant) return null;
  const r = state.receipts.find((x) => x.id === id && x.merchantId === merchant.id);
  if (!r) return <NotFoundPanel title="Receipt not found" body="No receipt with this id exists for the current shop." href="/app/receipts" cta="Back to receipts" />;
  return (
    <>
      <MerchantPageHeader back={{ href: "/app/receipts", label: "Receipts" }} title={`Receipt ${r.id}`} description="The public version hides internal references." />
      <div className="mx-auto max-w-2xl space-y-4">
        <ReceiptActions receipt={r} state={state} shareUrl={`${origin}/receipt/${r.id}`} />
        <ReceiptDocument receipt={r} state={state} showInternal />
      </div>
    </>
  );
}
