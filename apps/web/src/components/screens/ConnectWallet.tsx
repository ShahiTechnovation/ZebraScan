"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, Wallet } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { api, errorMessage, setCsrf } from "@/services/live/api";
import { detectNoir, signInWithNoir } from "@/services/live/noir";

/**
 * "Connect to Zeb Scan" (delta spec §8.2). Honest options only:
 *  - Noir Wallet: signed challenge → session (connected mode).
 *  - Other Zcash wallet: no account needed to PAY; it cannot sign in.
 *  - Email code: first-party one-time code.
 *  - Passkey: not available in this build (shown, not faked).
 */
export function ConnectWalletButton({ className, label = "Connect wallet" }: { className?: string; label?: string }) {
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
  const network = live?.config?.wallet.noirNetwork ?? "zcash-testnet";

  useEffect(() => {
    if (!open) return;
    setView("choose");
    setError(null);
    void detectNoir().then((ok) => setNoir(ok ? "installed" : "not_installed"));
  }, [open]);

  const finish = async () => {
    await live?.refreshSession();
    onClose();
    router.push(live?.merchant ? next : "/onboarding");
  };

  const noirLogin = async () => {
    setBusy("noir");
    setError(null);
    try {
      await signInWithNoir("login");
      await finish();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect to Zeb Scan" description="Your ZEC stays in your wallet until you approve a payment.">
      {view === "choose" && (
        <div className="space-y-2">
          <button
            type="button"
            disabled={!live || noir !== "installed" || busy !== null}
            onClick={noirLogin}
            className="flex w-full items-center justify-between rounded-panel border border-border bg-surface-1 px-4 py-3 text-left hover:border-border-strong disabled:opacity-60"
          >
            <span>
              <span className="block text-[14px] font-medium">{busy === "noir" ? "Waiting for Noir…" : "Noir Wallet"}</span>
              <span className="block text-label text-foreground-secondary">
                {!live
                  ? "Sign-in needs the connected app (not the local demo)"
                  : noir === "checking"
                    ? "Checking for the extension…"
                    : noir === "not_installed"
                      ? `Not installed${network === "zcash-testnet" ? " — use the [Testnet] Noir Wallet build" : ""}`
                      : "Recommended for Zcash · signs a login message, never a payment"}
              </span>
            </span>
            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-micro font-medium text-accent">Recommended</span>
          </button>
          {noir === "not_installed" && (
            <a className="link block px-1 text-label" href="https://github.com/NoirWallet/noir-wallet/releases" target="_blank" rel="noreferrer">
              Get Noir Wallet{network === "zcash-testnet" ? " (testnet build: the release asset ending -testnet.zip)" : ""}
            </a>
          )}
          <button type="button" onClick={() => setView("other")} className="flex w-full items-center justify-between rounded-panel border border-border bg-surface-1 px-4 py-3 text-left hover:border-border-strong">
            <span>
              <span className="block text-[14px] font-medium">Other Zcash wallet</span>
              <span className="block text-label text-foreground-secondary">Pay without an account</span>
            </span>
          </button>
          <div className="flex items-center gap-3 py-1 text-micro text-foreground-muted">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setView("email")} disabled={!live}>
              <Mail aria-hidden className="h-4 w-4" /> Continue with email
            </Button>
            <Button variant="secondary" disabled aria-describedby="passkey-note">
              <KeyRound aria-hidden className="h-4 w-4" /> Passkey
            </Button>
          </div>
          <p id="passkey-note" className="text-micro text-foreground-muted">
            Passkeys are not available in this build yet.{!live ? " Sign-in is available in the connected app." : ""}
          </p>
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
          <p>Merchants who don&apos;t use Noir can sign in with an email code; that doesn&apos;t change how customers pay.</p>
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
                {live?.config?.auth.emailDelivery ? "If the address can receive mail, a code is on its way. It expires in 10 minutes." : "Email delivery is not configured on this server, so no code will arrive."}
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
