"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, ExternalLink, Mail, ShieldCheck, Wallet } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { api, errorMessage, setCsrf } from "@/services/live/api";
import {
  connectNoir,
  detectNoir,
  getNoirProvider,
  noirErrorMessage,
  noirOriginProblem,
  onNoirInitialized,
  signInWithNoir,
  type NoirConnection,
  type NoirNetwork,
} from "@/services/live/noir";

function shortAddress(a: string): string {
  return a.length > 26 ? `${a.slice(0, 14)}…${a.slice(-8)}` : a;
}

export function ConnectWalletButton({ className, label = "Connect Noir Wallet" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "inline-flex h-10 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-3.5 text-[13px] font-medium hover:border-border-strong"}>
        <Wallet aria-hidden className="h-4 w-4" /> {label}
      </button>
      <ConnectWalletModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ConnectWalletModal({ open, onClose, next = "/app" }: { open: boolean; onClose: () => void; next?: string }) {
  const router = useRouter();
  const { live } = useZeb();
  const [noir, setNoir] = useState<"checking" | "installed" | "not_installed">("checking");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"choose" | "email" | "other">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [connected, setConnected] = useState<NoirConnection | null>(null);
  const [originProblem, setOriginProblem] = useState<string | null>(null);
  const network = live?.config?.wallet.noirNetwork ?? "zcash-testnet";
  const expected: NoirNetwork | null = live && !live.config ? null : network === "zcash-mainnet" ? "mainnet" : "testnet"; // no guess before the API config loads; sign-in then checks the challenge's network
  // Sign-in needs the Zeb Scan API. Without it (public demo build) the wallet can still connect.
  const canSignIn = !!live && !live.error;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setView("choose");
    setError(null);
    setConnected(null);
    setOriginProblem(noirOriginProblem());
    // The extension defines window.noirwallet at document_start, so this is normally immediate.
    setNoir(getNoirProvider() ? "installed" : "checking");
    void detectNoir().then((ok) => {
      if (active) setNoir(ok ? "installed" : "not_installed");
    });
    const stop = onNoirInitialized(() => {
      if (active) setNoir("installed");
    });
    return () => {
      active = false;
      stop();
    };
  }, [open]);

  const finish = async () => {
    await live?.refreshSession();
    onClose();
    router.push(live?.merchant ? next : "/onboarding");
  };

  // Not async on purpose: the wallet request must be posted inside this click, with nothing awaited first.
  const noirConnect = () => {
    setBusy("noir");
    setError(null);
    const flow = canSignIn ? signInWithNoir("login", expected).then(finish) : connectNoir(expected).then(setConnected);
    flow.catch((e: unknown) => setError(noirErrorMessage(e))).finally(() => setBusy(null));
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect to Zeb Scan" description="Your ZEC stays securely in your wallet until you approve transactions.">
      {view === "choose" && (
        <div className="space-y-3">
          <div className="rounded-panel border border-border bg-surface-1 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gold/15 text-accent">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[15px] font-semibold">Noir Wallet</p>
                  <p className="text-micro text-foreground-muted">Zcash Shielded Identity</p>
                </div>
              </div>
              <span className="rounded-full bg-gold/15 px-2 py-0.5 text-micro font-medium text-accent">Recommended</span>
            </div>

            <p className="mt-3 text-[13px] leading-relaxed text-foreground-secondary">
              {noir === "checking"
                ? "Detecting browser extension..."
                : noir === "installed"
                  ? canSignIn
                    ? "Extension detected. Approve the connection, then sign a server challenge to authenticate. Hardware accounts may not support message signing."
                    : `Extension detected. Approve the connection in Noir Wallet to see your account. Merchant sign-in needs the Zeb Scan API, which ${live ? "is not reachable right now" : "this build does not include"}.`
                  : originProblem ?? "Noir Wallet is the premier shielded Zcash browser extension. Install it to authenticate."}
            </p>

            <div className="mt-4">
              {connected ? (
                <div role="status" className="rounded-input border border-success/40 bg-success/[0.06] px-3 py-2 text-[13px]">
                  <p className="font-medium text-foreground">Noir Wallet connected{connected.network ? ` · Zcash ${connected.network}` : ""}</p>
                  <p className="mt-0.5 font-mono text-micro text-foreground-secondary">{shortAddress(connected.shielded ?? connected.transparent ?? "")}</p>
                </div>
              ) : noir === "installed" ? (
                <Button className="w-full" isLoading={busy === "noir"} onClick={noirConnect}>
                  <Wallet className="h-4 w-4" /> {canSignIn ? "Connect & Sign In" : "Connect Noir Wallet"}
                </Button>
              ) : (
                <div className="space-y-2">
                  <a
                    className="button-primary inline-flex h-10 w-full items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium"
                    href="https://github.com/NoirWallet/noir-wallet/releases"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download className="h-4 w-4" /> Install Noir Wallet <ExternalLink className="h-3 w-3" />
                  </a>
                  <p className="text-center text-micro text-foreground-muted">
                    {network === "zcash-testnet"
                      ? 'For testnet: load the release asset ending in -testnet.zip ("[Testnet] Noir Wallet"). The standard "Noir Wallet" build is mainnet.'
                      : "Available for Chrome, Brave, and Chromium browsers"}
                  </p>
                  {noir === "not_installed" && (
                    <Button variant="ghost" size="sm" className="w-full" onClick={() => window.location.reload()}>
                      Installed or enabled it just now? Reload this page
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 py-1 text-micro text-foreground-muted">
            <span className="h-px flex-1 bg-border" /> or continue with <span className="h-px flex-1 bg-border" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={!live?.config?.auth.emailDelivery} onClick={() => setView("email")}>
              <Mail aria-hidden className="h-4 w-4" /> Email code
            </Button>
            <Button variant="secondary" onClick={() => setView("other")}>
              Other wallets
            </Button>
          </div>

          {error && (
            <p role="alert" className="rounded-input border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {view === "other" && (
        <div className="space-y-3 text-[14px] text-foreground-secondary">
          <p>
            Any Zcash wallet that can send to a payment request can pay a Zeb Scan checkout: scan the QR, or copy the address, exact amount and memo. No account or
            connection is needed, and Zeb Scan never asks for your seed phrase or keys.
          </p>
          <p>Email code sign-in is available only when delivery is configured. Customers can pay without an account from a compatible testnet wallet.</p>
          <Button variant="secondary" onClick={() => setView("choose")}>
            Back
          </Button>
        </div>
      )}
      {view === "email" && (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy("email");
            setError(null);
            try {
              if (!sent) {
                await api.call("emailOtpRequest", { body: { email } });
                setSent(true);
              } else {
                const r = await api.call("emailOtpVerify", { body: { email, code } });
                setCsrf(r.csrfToken);
                await finish();
              }
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <label htmlFor="otp-email" className="text-label font-medium text-foreground-secondary">
            Email
          </label>
          <input id="otp-email" type="email" autoComplete="email" className="input w-full" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} />
          {sent && (
            <>
              <label htmlFor="otp-code" className="text-label font-medium text-foreground-secondary">
                6-digit code
              </label>
              <input id="otp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="input w-full font-mono tracking-[0.3em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <p className="text-micro text-foreground-muted">
                {live?.config?.auth.emailDelivery ? "If the address can receive mail, a code is on its way. It expires in 10 minutes." : "Enter your verification code to complete sign-in."}
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => setView("choose")}>
              Back
            </Button>
            <Button type="submit" isLoading={busy === "email"} disabled={!email || (sent && code.length !== 6)}>
              {sent ? "Sign in" : "Send code"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
