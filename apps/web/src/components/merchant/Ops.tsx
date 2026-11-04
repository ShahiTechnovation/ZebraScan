"use client";

import React, { useState } from "react";
import { AlertTriangle, Banknote, Lock, ShieldOff, Vault } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { treasurySnapshot } from "@/services/demo/engine";
import { formatInr, formatUsdc, formatZec } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { COPY } from "@/config/mode";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Callout, DataList, EmptyState, MetricStrip } from "@/components/ui/Blocks";
import { ConfirmDialog } from "@/components/ui/Modal";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { MetaBadge, P2P_META, StatusBadge } from "@/components/ui/StatusBadge";
import type { P2POrder } from "@/types/domain";

export function Ops() {
  const { state, demo, isDemo } = useZeb();
  const now = useNow(5_000) ?? state.seededAt;
  const [confirm, setConfirm] = useState(false);

  if (!isDemo || !demo)
    return (
      <EmptyState
        icon={ShieldOff}
        title="Ops view unavailable"
        description={`${COPY.notConnected} An admin treasury view requires a real, role-restricted backend.`}
      />
    );

  if (!state.session.opsUnlocked)
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <ShieldOff aria-hidden className="mx-auto h-8 w-8 text-foreground-secondary" />
        <h1 className="mt-3 font-display text-[22px] font-semibold">Admin-only area</h1>
        <p className="mt-2 text-[14px] text-foreground-secondary">
          This treasury view is for platform operators. In a live build it would require an admin role; merchants can&apos;t see it. In the demo you can open a simulated
          version.
        </p>
        <Button className="mt-6" onClick={() => setConfirm(true)}>
          Enter demo ops view
        </Button>
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          onConfirm={() => demo.unlockOps(true)}
          title="Open simulated ops view?"
          description="Shows simulated, aggregated treasury figures across all demo merchants on this device. No secrets, keys or transfer controls exist in the frontend."
          confirmLabel="Open demo ops view"
        />
      </div>
    );

  const t = treasurySnapshot(state, now);
  const low = BigInt(t.usdcAvailableMicro) < BigInt(t.refillThresholdMicro);
  const queue = state.orders.filter((o) => !["completed", "cancelled"].includes(o.status)).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <MerchantPageHeader
        title="Treasury health"
        badge={<StatusBadge tone="accent">Demo only · simulated</StatusBadge>}
        description="Aggregated two-pool view. Read-only: there are no transfer controls and no treasury secrets in the frontend."
        actions={
          <Button variant="ghost" onClick={() => demo.unlockOps(false)}>
            Leave ops view
          </Button>
        }
      />
      {low && (
        <Callout tone="warning" icon={AlertTriangle} className="mb-6" title="USDC treasury below refill threshold">
          Free USDC is under {formatUsdc(t.refillThresholdMicro)} USDC. A rebalance from the ZEC vault would be scheduled (simulated).
        </Callout>
      )}
      <MetricStrip
        items={[
          { label: "ZEC vault (verified)", value: `${formatZec(t.zecVaultZat)} ZEC`, icon: Vault, sub: `${formatZec(t.zecPendingZat)} ZEC held / confirming` },
          { label: "USDC available", value: formatUsdc(t.usdcAvailableMicro), icon: Banknote, sub: "Free liquidity on Base" },
          { label: "USDC reserved", value: formatUsdc(t.usdcReservedMicro), icon: Lock, sub: "Liabilities + queued payouts" },
          { label: "USDC in flight", value: formatUsdc(t.usdcInFlightMicro), sub: "Escrowed with providers" },
        ]}
      />
      <div className="mt-6 grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8">
          <PanelHeader title="Payout queue" description="PAY (Scan & Pay) and SELL (withdrawal) orders not yet final" />
          <DataTable<P2POrder>
            rows={queue}
            rowKey={(o) => o.id}
            caption="Payout queue"
            mobileTitle={(o) => <span className="font-mono text-label">{o.id}</span>}
            columns={[
              { key: "id", header: "Order", hideOnMobile: true, cell: (o) => <span className="font-mono text-label">{o.id}</span> },
              { key: "type", header: "Type", cell: (o) => <span>{o.orderType === "PAY" ? "PAY · type 2" : "SELL"}</span> },
              { key: "inr", header: "INR", align: "right", cell: (o) => <span className="num">{formatInr(o.inrMinor)}</span> },
              { key: "usdc", header: "USDC", align: "right", cell: (o) => <span className="num font-mono text-label">{formatUsdc(o.usdcMicro)}</span> },
              { key: "at", header: "Created", cell: (o) => <span className="num text-label text-foreground-secondary">{formatDateTime(o.createdAt)}</span> },
              { key: "st", header: "Status", cell: (o) => <MetaBadge meta={P2P_META[o.status]} /> },
            ]}
            empty={<EmptyState title="Queue empty" description="No payouts are waiting on providers." />}
          />
        </Panel>
        <div className="space-y-6 xl:col-span-4">
          <Panel>
            <PanelHeader title="Pools" />
            <PanelBody>
              <DataList
                items={[
                  { label: "USDC treasury total", value: `${formatUsdc(t.usdcTotalMicro)} USDC` },
                  { label: "Merchant liabilities (all demo shops)", value: formatInr(t.merchantLiabilityInrMinor) },
                  { label: "Rebalancing", value: t.rebalancing === "scheduled" ? "Scheduled (simulated)" : "Idle" },
                  { label: "Payout provider", value: "Simulated" },
                  { label: "Zcash wallet scanner", value: "Simulated" },
                  { label: "Snapshot", value: formatDateTime(t.at) },
                ]}
              />
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Transfers" />
            <PanelBody className="space-y-2">
              <Button variant="secondary" className="w-full" disabled>
                Rebalance ZEC → USDC · disabled in frontend
              </Button>
              <Button variant="secondary" className="w-full" disabled>
                Top up USDC treasury · disabled in frontend
              </Button>
              <p className="text-micro leading-relaxed text-foreground-muted">
                Treasury movements must run in a secured backend with proper key custody and approvals. The frontend never holds keys, seeds or viewing keys.
              </p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </>
  );
}
