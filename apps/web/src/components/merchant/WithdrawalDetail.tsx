"use client";

import React, { useState } from "react";
import { Printer, RotateCcw } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr, formatUsdc } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { COPY } from "@/config/mode";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Callout, DataList } from "@/components/ui/Blocks";
import { CopyableValue } from "@/components/ui/CopyShare";
import { ConfirmDialog } from "@/components/ui/Modal";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { MetaBadge, P2P_META, WITHDRAWAL_META } from "@/components/ui/StatusBadge";
import { EventLog, Stepper } from "@/components/ui/Timeline";
import { withdrawalSteps } from "@/components/payments/Progress";
import { NotFoundPanel } from "@/components/screens/NotFoundPanel";

export function WithdrawalDetail({ id }: { id: string }) {
  const { state, merchant, services, isDemo } = useZeb();
  const { run, busy } = useAction();
  const [cancelOpen, setCancelOpen] = useState(false);
  if (!merchant) return null;
  const w = state.withdrawals.find((x) => x.id === id && x.merchantId === merchant.id);
  if (!w) return <NotFoundPanel title="Withdrawal not found" body="No withdrawal with this id exists for the current shop." href="/app/withdrawals" cta="Back to withdrawals" />;
  const order = state.orders.find((o) => o.id === w.p2pOrderId);
  const m = services?.merchant;
  const active = ["requested", "matching", "accepted", "escrowed", "processing"].includes(w.status);

  return (
    <>
      <MerchantPageHeader
        back={{ href: "/app/withdrawals", label: "Withdrawals" }}
        title={`Withdrawal ${formatInr(w.inrMinor)}`}
        badge={<MetaBadge meta={WITHDRAWAL_META[w.status]} />}
        actions={
          <>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer aria-hidden className="h-4 w-4" /> Print
            </Button>
            {(w.status === "requested" || w.status === "matching") && m && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                Cancel withdrawal
              </Button>
            )}
          </>
        }
      />

      {w.status === "completed" && (
        <Callout tone="success" className="mb-6" title="Payout completed">
          Payout completed and confirmed by settlement provider.
        </Callout>
      )}
      {w.status === "failed" && (
        <Callout
          tone="danger"
          className="mb-6"
          title={w.recoveredAt ? "Payout failed · funds restored" : "Payout failed · recovery needed"}
          action={
            !w.recoveredAt &&
            m &&
            isDemo && (
              <Button size="sm" isLoading={busy} onClick={() => run(() => m.recoverWithdrawal(w.id), "Funds restored to available balance")}>
                <RotateCcw aria-hidden className="h-4 w-4" /> Restore funds to available balance
              </Button>
            )
          }
        >
          {w.recoveredAt
            ? `The reserved ${formatInr(w.inrMinor)} was returned to your available balance on ${formatDateTime(w.recoveredAt)}. It was never double-debited.`
            : isDemo
              ? `The provider couldn't complete the transfer. ${formatInr(w.inrMinor)} stays reserved until you restore it — this is an explicit step so funds are never counted twice.`
              : `The provider couldn't complete the transfer. ${formatInr(w.inrMinor)} stays reserved while Zeb Scan confirms on-chain that no USDC is in flight; an operator then retries or restores it. Open a support case if you need help.`}
        </Callout>
      )}
      {w.status === "disputed" && (
        <Callout tone="warning" className="mb-6" title="Payout disputed">
          The provider and the bank-side status disagree. The amount stays reserved while it&apos;s reviewed.
        </Callout>
      )}

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-8">
          <Panel>
            <PanelHeader title="SELL payout path" description="Separate from how your credits were issued — this is the cash-out." />
            <PanelBody>
              <Stepper label="Withdrawal progress" steps={withdrawalSteps(w)} />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Event log" />
            <PanelBody>
              <EventLog events={w.events} />
            </PanelBody>
          </Panel>
        </div>
        <Panel className="h-fit xl:col-span-4">
          <PanelHeader title="Payout summary" />
          <PanelBody className="space-y-3">
            <DataList
              items={[
                { label: "Requested", value: formatInr(w.inrMinor) },
                { label: "Fee & spread", value: `−${formatInr(w.feeInrMinor)}` },
                { label: "Estimated payout", value: formatInr(w.payoutInrMinor) },
                { label: "USDC sold (Base)", value: `${formatUsdc(w.usdcMicro)} USDC` },
                { label: "To UPI", value: <span className="font-mono">{w.payoutUpi}</span> },
                { label: "Beneficiary", value: w.beneficiaryName },
                { label: "P2P order", value: order ? <MetaBadge meta={P2P_META[order.status]} label={`SELL · ${P2P_META[order.status].label}`} /> : "—" },
                { label: "Requested on", value: formatDateTime(w.createdAt) },
                { label: "Last update", value: formatDateTime(w.updatedAt) },
              ]}
            />
            <CopyableValue value={w.id} label="Withdrawal id" />
          </PanelBody>
        </Panel>
      </div>
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => m && run(() => m.cancelWithdrawal(w.id), "Withdrawal cancelled · funds returned to available")}
        title="Cancel this withdrawal?"
        description="It hasn't been accepted by a payout provider yet. The reserved amount returns to your available balance."
        confirmLabel="Cancel withdrawal"
        confirmVariant="danger"
      />
    </>
  );
}
