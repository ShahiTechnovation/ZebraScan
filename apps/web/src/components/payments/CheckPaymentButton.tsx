"use client";

import React, { useState } from "react";
import { Loader2, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useZeb } from "@/providers/ZebProvider";
import { API_BASE, checkoutTokens } from "@/services/live/api";
import type { CheckoutIntent } from "@/types/domain";

interface CheckResult {
  scanned: boolean;
  scanError: string | null;
  status: string;
  zecReceived: boolean;
  zecConfirmed: boolean;
  confirmations: number;
  confirmationsRequired: number;
}

/**
 * "Check payment now": asks the server to run one immediate watch-only scan of the receiving wallet
 * (mempool + latest blocks) instead of waiting for the next automatic poll, then shows the real
 * state. Live updates still arrive on their own; this never moves money.
 */
export function CheckPaymentButton({ checkout: c }: { checkout: CheckoutIntent }) {
  const { live } = useZeb();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!live || !API_BASE) return null; // connected mode only; demo payments are simulated
  if (!["awaiting", "detected", "confirming"].includes(c.depositStatus)) return null;

  const check = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const token = checkoutTokens.get(c.id);
      const r = await fetch(`${API_BASE}/api/v1/checkout/${encodeURIComponent(c.id)}/check-payment`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        setMsg(r.status === 429 ? "Checking too often — wait a few seconds." : "Couldn't check right now. Status still updates automatically.");
        return;
      }
      const j = (await r.json()) as CheckResult;
      if (j.scanError) setMsg(`Wallet watcher is catching up (${j.scanError}). Status still updates automatically.`);
      else if (j.zecConfirmed) setMsg("ZEC received and confirmed. The INR payout step starts next.");
      else if (j.zecReceived) setMsg(`ZEC detected on the network — ${j.confirmations}/${j.confirmationsRequired} confirmation${j.confirmationsRequired === 1 ? "" : "s"}. Usually 1–3 minutes.`);
      else setMsg("No ZEC seen yet for this address. Shielded sends can take a minute to reach the network.");
    } catch {
      setMsg("Couldn't reach the server. Status still updates automatically.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={check} disabled={busy}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <SearchCheck aria-hidden className="h-4 w-4" />}
        {busy ? "Checking the network…" : "I've paid — check now"}
      </Button>
      <p aria-live="polite" className="text-label text-foreground-secondary">
        {msg ?? "The page also checks automatically every few seconds."}
      </p>
    </div>
  );
}
