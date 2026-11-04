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
 * "I've paid — check now": asks the server to run one immediate watch-only scan of the receiving
 * wallet (mempool + latest blocks) instead of waiting for the next automatic poll, then shows the
 * real state. Always visible; in the public demo build it explains that it is not connected to the
 * live watcher. It never moves money (the INR payout runs in the separate, gated settlement step).
 */
export function CheckPaymentButton({ checkout: c }: { checkout: CheckoutIntent }) {
  const { live, isDemo } = useZeb();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const connected = !!live && !!API_BASE;
  const settled = ["accepted", "underpaid", "overpaid", "late", "refund_pending", "refunded", "under_review", "expired"].includes(c.depositStatus);

  const check = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!connected) {
        if (!isDemo) {
          setMsg("Not connected to the Zeb Scan service right now. Status still updates automatically once it reconnects.");
          return;
        }
        // Public demo: real check against the operator's watch-only MAINNET wallet, matched by this checkout's memo.
        const r = await fetch(`/api/mainnet-check?memo=${encodeURIComponent(`ZEB ${c.id}`)}&zat=${encodeURIComponent(c.quote.zecZat)}`, { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; zecReceived?: boolean; zecConfirmed?: boolean; underpaid?: boolean; confirmations?: number; receivedZatoshis?: string; txid?: string };
        if (!r.ok || !j.ok) setMsg(`Couldn't reach the mainnet wallet watcher (${j.error ?? `HTTP ${r.status}`}). Try again in a few seconds.`);
        else if (!j.zecReceived) setMsg("No ZEC with this checkout's memo has reached the wallet yet. Shielded sends take about a minute to appear; include the memo.");
        else if (j.underpaid) setMsg(`ZEC received (${Number(j.receivedZatoshis) / 1e8} ZEC) but less than the amount due. Tx ${j.txid?.slice(0, 12)}…`);
        else if (j.zecConfirmed) setMsg(`ZEC received and confirmed on Zcash mainnet (${j.confirmations} confirmation${j.confirmations === 1 ? "" : "s"}). Tx ${j.txid?.slice(0, 12)}…`);
        else setMsg(`ZEC detected in the mempool — waiting for the first block (about 75 s). Tx ${j.txid?.slice(0, 12)}…`);
        return;
      }
      const token = checkoutTokens.get(c.id);
      const r = await fetch(`${API_BASE}/api/v1/checkout/${encodeURIComponent(c.id)}/check-payment`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        setMsg(r.status === 429 ? "Checking too often — wait a few seconds." : r.status === 404 ? "This browser doesn't hold this checkout's access link." : "Couldn't check right now. Status still updates automatically.");
        return;
      }
      const j = (await r.json()) as CheckResult;
      if (j.scanError) setMsg(`Wallet watcher is catching up (${j.scanError}). Status still updates automatically.`);
      else if (j.zecConfirmed) setMsg(`ZEC received and confirmed (${j.confirmations} confirmation${j.confirmations === 1 ? "" : "s"}). The INR payout step starts next.`);
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
      <Button variant={settled ? "ghost" : "secondary"} onClick={check} disabled={busy}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <SearchCheck aria-hidden className="h-4 w-4" />}
        {busy ? "Checking the network…" : settled ? "Re-check payment status" : "I've paid — check if ZEC is received"}
      </Button>
      <p aria-live="polite" className="text-label text-foreground-secondary">
        {msg ?? (connected ? "The page also checks automatically every few seconds." : "Checks whether this checkout's ZEC has been received.")}
      </p>
    </div>
  );
}
