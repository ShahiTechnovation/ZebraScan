"use client";

import React from "react";
import { Download, Printer } from "lucide-react";
import type { DemoState, Receipt } from "@/types/domain";
import { formatInr, formatZec } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { modeLabel } from "@/services/demo/engine";
import { ZebLogo } from "@/components/brand/ZebLogo";
import { Button } from "@/components/ui/Button";
import { CopyButton, ShareButton } from "@/components/ui/CopyShare";
import { DataList } from "@/components/ui/Blocks";
import { useToast } from "@/providers/ToastProvider";

export const RECEIPT_DISCLAIMER =
  "Simulated receipt — not proof of a bank transfer. Demo only. These are simulated transactions, not real payments or bank transfers.";

/** Redacted, export-safe receipt record. Shielded details are not exposed. */
export function receiptExport(r: Receipt, state: DemoState) {
  const c = state.checkouts.find((x) => x.id === r.checkoutId);
  const order = c?.p2pOrderId ? state.orders.find((o) => o.id === c.p2pOrderId) : undefined;
  return {
    receiptId: r.id,
    paymentReference: r.checkoutId,
    issuedAt: new Date(r.issuedAt).toISOString(),
    paymentMode: r.mode,
    title: r.title,
    merchant: r.merchantName,
    recipientUpiMasked: r.recipientVpaMasked,
    inrInvoiceAmount: formatInr(r.inrMinor, { symbol: false }),
    inrTotalInclFees: formatInr(r.totalInrMinor, { symbol: false }),
    zecPaid: formatZec(r.zecZat, { fixed: true }),
    privacy: r.privacy,
    walletVerification: r.verification,
    payoutStatus: order?.status ?? null,
    simulated: true,
    notice: "Demo record. Not evidence of live funds, a real ZEC payment, or a bank transfer.",
  };
}

export function ReceiptActions({ receipt, state, shareUrl }: { receipt: Receipt; state: DemoState; shareUrl: string }) {
  const toast = useToast();
  const download = () => {
    const blob = new Blob([JSON.stringify(receiptExport(receipt, state), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zeb-scan-receipt-${receipt.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Receipt JSON downloaded (simulated record)");
  };
  return (
    <div className="no-print flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => window.print()}>
        <Printer aria-hidden className="h-4 w-4" /> Print
      </Button>
      <Button variant="secondary" size="sm" onClick={download}>
        <Download aria-hidden className="h-4 w-4" /> Download JSON
      </Button>
      <CopyButton value={receipt.checkoutId} label="Copy reference" toastMessage="Payment reference copied" />
      <ShareButton url={shareUrl} title="Zeb Scan receipt" text={`Receipt ${receipt.id}`} />
    </div>
  );
}

export function ReceiptDocument({ receipt: r, state, showInternal }: { receipt: Receipt; state: DemoState; showInternal?: boolean }) {
  const c = state.checkouts.find((x) => x.id === r.checkoutId);
  const order = c?.p2pOrderId ? state.orders.find((o) => o.id === c.p2pOrderId) : undefined;
  const merchant = state.merchants.find((m) => m.id === r.merchantId);
  const showZec = merchant ? merchant.preferences.showZecOnReceipts : true;
  return (
    <article className="print-area theme-light rounded-panel border border-border bg-surface-1 text-foreground" aria-label="Receipt">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-7">
        <ZebLogo href={null} />
        <div className="text-right">
          <p className="eyebrow">Receipt</p>
          <p className="font-mono text-label">{r.id}</p>
        </div>
      </header>
      {r.simulated && (
        <div className="border-b border-gold/50 bg-gold/10 px-5 py-2.5 text-label font-medium text-accent sm:px-7" role="note">
          {RECEIPT_DISCLAIMER}
        </div>
      )}
      <div className="px-5 py-5 sm:px-7">
        <p className="text-label text-foreground-secondary">{r.mode === "scan_pay" ? "Paid to" : "Paid to merchant"}</p>
        <p className="text-[17px] font-semibold">{r.merchantName ?? r.recipientVpaMasked ?? "—"}</p>
        <p className="num mt-4 font-display text-[34px] font-semibold tracking-[-0.02em]">{formatInr(r.inrMinor)}</p>
        <p className="text-[13px] text-foreground-secondary">{r.title}</p>
        <DataList
          className="mt-5"
          items={[
            { label: "Payment reference", value: <span className="font-mono text-label">{r.checkoutId}</span> },
            { label: "Date", value: formatDateTime(r.issuedAt) },
            { label: "Payment mode", value: modeLabel(r.mode) },
            { label: "INR invoice amount", value: formatInr(r.inrMinor) },
            { label: "Total incl. fees", value: formatInr(r.totalInrMinor) },
            ...(showZec ? [{ label: "ZEC paid", value: <span className="font-mono">{formatZec(r.zecZat, { fixed: true })} ZEC</span> }] : []),
            { label: "Privacy", value: r.privacy === "shielded" ? "Shielded (on-chain details hidden)" : "Transparent (publicly visible on-chain)" },
            { label: "Wallet verification", value: r.verification === "simulated" ? "Simulated (demo)" : "Verified by receiving wallet" },
            ...(r.recipientVpaMasked ? [{ label: "Receiver UPI", value: <span className="font-mono">{r.recipientVpaMasked}</span> }] : []),
            ...(order ? [{ label: "INR payout", value: order.status === "completed" ? "Completed (provider confirmed · simulated)" : order.status }] : []),
            ...(showInternal && c?.deposit ? [{ label: "Deposit output (internal)", value: <span className="break-all font-mono text-micro">{c.deposit.outputRef}</span> }] : []),
          ]}
        />
      </div>
      <footer className="border-t border-border px-5 py-4 text-micro leading-relaxed text-foreground-muted sm:px-7">
        {r.mode === "scan_pay"
          ? "A verified ZEC payment funds the payout; the INR transfer is performed by a P2P liquidity provider."
          : "The merchant receives an INR-denominated platform credit, not a bank deposit."}{" "}
        Shielded transaction details are not shown on receipts. {r.simulated && "Not evidence of live funds."}
      </footer>
    </article>
  );
}
