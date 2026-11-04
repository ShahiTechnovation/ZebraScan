"use client";

import React, { useEffect, useState } from "react";
import { PlugZap, WifiOff } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { COPY } from "@/config/mode";
import { DemoBadge } from "@/components/ui/StatusBadge";

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** Offline notice everywhere; "not connected" notice in connected mode without adapters. */
export function ModeBanner() {
  const { mode, canTransact, isDemo, live } = useZeb();
  const online = useOnline();
  if (!online)
    return (
      <div role="status" className="no-print theme-dark border-b border-warning/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
        <WifiOff aria-hidden className="mr-1.5 inline h-4 w-4 text-warning" />
        You&apos;re offline. {isDemo ? "The demo keeps working locally; nothing is sent anywhere." : "Payment status can't update until you reconnect."}
      </div>
    );
  if (live?.error)
    return (
      <div role="status" className="no-print theme-dark border-b border-warning/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
        <PlugZap aria-hidden className="mr-1.5 inline h-4 w-4 text-warning" />
        The Zeb Scan service is unreachable right now. Money actions are disabled until it responds.
      </div>
    );
  const label = live?.config?.label;
  if (live && label)
    return (
      <div role="status" className="no-print theme-dark border-b border-gold/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
        <DemoBadge label={label} className="mr-2" />
        {label === "TEST" ? "Testnet environment — test funds only. Balances are not redeemable." : "Demo backend — simulated payments only. Nothing here moves real money."}
      </div>
    );
  if (mode !== "connected" || canTransact) return null;
  return (
    <div role="status" className="no-print theme-dark border-b border-warning/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
      <PlugZap aria-hidden className="mr-1.5 inline h-4 w-4 text-warning" />
      {COPY.notConnected} Money actions are disabled.
    </div>
  );
}

export function NotConnectedNotice({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="rounded-panel border border-warning/40 bg-warning/[0.07] px-4 py-3 text-[13px] text-foreground-secondary" role="status">
        <p className="font-medium text-foreground">{COPY.notConnected}</p>
        <p className="mt-0.5">No quote, receiving address, deposit, USDC order or UPI transfer can be created until real adapters are configured.</p>
      </div>
    </div>
  );
}

/** DEMO badge in demo mode; "Not connected" in connected mode without adapters. */
export function ModeBadge({ className }: { className?: string }) {
  const { isDemo, canTransact, live } = useZeb();
  if (isDemo) return <DemoBadge className={className} />;
  const envLabel = live?.config?.label;
  return <DemoBadge className={className} label={envLabel ?? (canTransact ? "Live" : "Not connected")} />;
}
