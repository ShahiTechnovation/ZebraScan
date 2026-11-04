"use client";

import React, { useEffect, useState } from "react";
import { PlugZap, WifiOff } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
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

/** Offline notice and service connectivity alerts. */
export function ModeBanner() {
  const { canTransact, live } = useZeb();
  const online = useOnline();
  if (!online)
    return (
      <div role="status" className="no-print theme-dark border-b border-warning/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
        <WifiOff aria-hidden className="mr-1.5 inline h-4 w-4 text-warning" />
        You&apos;re currently offline. Reconnecting to update real-time payment status...
      </div>
    );
  if (live?.error || !canTransact)
    return (
      <div role="status" className="no-print theme-dark border-b border-warning/40 bg-surface-nav px-4 py-2 text-center text-[13px] text-foreground">
        <PlugZap aria-hidden className="mr-1.5 inline h-4 w-4 text-warning" />
        Payments temporarily unavailable. Keep your checkout reference and try again.
      </div>
    );
  return <div role="status" className="border-b border-border px-4 py-2 text-center text-[13px]">Zcash testnet · TAZ only · INR payouts disabled</div>;
}

export function NotConnectedNotice({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="rounded-panel border border-warning/40 bg-warning/[0.07] px-4 py-3 text-[13px] text-foreground-secondary" role="status">
        <p className="font-medium text-foreground">Payments temporarily unavailable</p>
        <p className="mt-0.5">A verified backend connection is required. Existing checkout references are preserved.</p>
      </div>
    </div>
  );
}

/** Network indicator badge. */
export function ModeBadge({ className }: { className?: string }) {
  const { canTransact, live } = useZeb();
  const envLabel = live?.config?.label;
  const label = envLabel === "TEST" ? "Testnet" : envLabel === "DEMO" ? "Isolated test API" : canTransact ? envLabel ?? "Connected" : "Unavailable";
  return <DemoBadge className={className} label={label} />;
}
