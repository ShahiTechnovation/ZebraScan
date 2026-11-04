"use client";

import React, { useState } from "react";
import { RefreshCcw, Wallet, ReceiptText, Printer, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr, formatZec } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { isQuoteExpired } from "@/lib/payment-validation";
import type { CheckoutIntent } from "@/types/domain";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { CopyableValue, CopyButton } from "@/components/ui/CopyShare";
import { DEPOSIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import { payWithNoir } from "@/services/live/noir";
import { QRRenderer } from "./QR";
import { PrivacyBadge, RateExpiry } from "./Quote";
import { DepositProgress } from "./Progress";
import { demoConfig } from "@/config/demo";
import { CheckPaymentButton } from "./CheckPaymentButton";

export const WALLET_SHIELDED_ADDRESS =
  "u1uvjhhx67pmgcqth9xzgzw2x0vhn8ktvpsh6l6cuyezq5emrqyz48u5fl4du3rlazs9gg4262pr8xjxnwav3vz8z8tj8vyye0h4anyua70uf48wcy6dysqpx22duw32jkr3cntqahjn09p3cm23c50hd3egnxhwmpgyze6q277qhppdk5";
export const WALLET_TRANSPARENT_ADDRESS =
  "t1cst5qjbk1U9RNYsBmrkXyZTGGKKSDrVtc";

/**
 * Connected app: always THIS checkout's own issued, watched receiving address (never substituted).
 * Public demo build: its checkouts only have a non-payable placeholder, so show the operator's real
 * mainnet SHIELDED address instead (demoConfig.receiveAddress), with a memo code for matching.
 */
function isDemoPlaceholder(addr: string): boolean {
  return !addr || addr.startsWith("zebscan-demo-address-");
}
function getEffectiveAddress(addr: string): string {
  return isDemoPlaceholder(addr) ? demoConfig.receiveAddress : addr;
}
function b64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function CheckoutPanel({
  checkout: c,
  onNewCheckout,
  receiptHref,
  compactHeader,
}: {
  checkout: CheckoutIntent;
  /** Called with the new checkout id after "Refresh quote" creates a fresh intent. */
  onNewCheckout?: (id: string) => void;
  receiptHref?: string;
  compactHeader?: boolean;
}) {
  const { services, state } = useZeb();
  const now = useNow(1000);
  const { run, busy } = useAction();


  const credit = state.credits.find((cr) => cr.checkoutId === c.id && !cr.parentCreditId) ?? null;
  const receipt = state.receipts.find((r) => r.checkoutId === c.id);
  const expired = c.depositStatus === "expired" || (c.depositStatus === "awaiting" && now !== null && isQuoteExpired(c.quote, now));
  const awaiting = c.depositStatus === "awaiting" && !expired;
  const exactZec = formatZec(c.quote.zecZat, { fixed: true });
  const [refundAddr, setRefundAddr] = useState("");
  const [noirError, setNoirError] = useState<string | null>(null);

  const demoReal = isDemoPlaceholder(c.receivingAddress);
  const activeAddress = getEffectiveAddress(c.receivingAddress);
  // Demo → operator's mainnet shielded wallet: memo "ZEB <checkout id>" lets the operator match the payment.
  const demoMemo = demoReal ? `ZEB ${c.id}` : null;
  const activeQrPayload = demoReal
    ? `zcash:${activeAddress}?amount=${exactZec}&memo=${b64url(demoMemo!)}`
    : c.qrPayload?.startsWith("zcash:")
      ? c.qrPayload
      : `zcash:${activeAddress}?amount=${exactZec}`;
  const shownMemo = c.memo ?? demoMemo;

  const refresh = async () => {
    if (!services) return;
    const r = await run(
      () =>
        services.zcash.refreshIntent ? services.zcash.refreshIntent(c.id) : services.zcash.createPaymentIntent({
          mode: c.mode,
          inrMinor: c.quote.inrMinor,
          privacy: c.privacy,
          merchantId: c.merchantId,
          linkId: c.linkId,
          recipient: c.recipient,
          customerNote: c.customerNote,
        }),
      "New quote and receiving address created",
    );
    if (r.ok) onNewCheckout?.(r.value.id);
  };

  // No dynamic import or await before the wallet: payWithNoir posts zcash_requestAccounts inside this click.
  // The wallet network comes from the checkout, never from the displayed address, so payWithNoir refuses an
  // address on another network (e.g. a mainnet address shown on a testnet or demo checkout) instead of paying it.
  const handlePayNoir = () => {
    const net = c.network === "mainnet" ? "mainnet" : "testnet";
    setNoirError(null);
    void run(
      () => payWithNoir({ to: activeAddress, zat: c.quote.zecZat, memo: shownMemo, network: net }),
      "Payment initiated in Noir Wallet — waiting for network confirmation"
    ).then((r) => {
      if (!r.ok) setNoirError(r.error); // toasts vanish after ~3 s; wallet errors carry multi-step fixes
    });
  };

  return (
    <div className="space-y-5">
      {!compactHeader && (
        <div className="flex flex-wrap items-center gap-2">
          <MetaBadge meta={expired && c.depositStatus === "awaiting" ? DEPOSIT_META.expired : DEPOSIT_META[c.depositStatus]} />
          <PrivacyBadge privacy={c.privacy} />
          <span className="font-mono text-micro text-foreground-muted">Checkout {c.id}</span>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        {/* QR column */}
        <div className="flex flex-col items-center">
          <QRRenderer
            value={activeQrPayload}
            label={`Zcash payment request for ${exactZec} ZEC`}
            dimmed={!awaiting}
            size={240}
          />
          <div className="mt-3 w-full text-center">
            {awaiting ? <RateExpiry expiresAt={c.quote.expiresAt} now={now} /> : <span className="text-label text-foreground-secondary">{expired ? "This QR is no longer valid." : c.depositStatus === "accepted" ? "ZEC received and verified." : "Payment is being checked. Do not send again."}</span>}
          </div>
        </div>

        {/* Details column */}
        <div className="min-w-0 space-y-4">
          <div>
            <p className="eyebrow">Amount due</p>
            <p className="num mt-1 font-mono text-[26px] font-semibold leading-tight text-foreground sm:text-[30px]">
              {exactZec} <span className="font-sans text-[15px] font-medium text-foreground-secondary">ZEC</span>
            </p>
            <p className="num text-[14px] text-foreground-secondary">
              for {formatInr(c.quote.inrMinor)}
              {c.quote.totalInrMinor !== c.quote.inrMinor && <> · {formatInr(c.quote.totalInrMinor)} incl. fees</>}
            </p>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-label font-medium text-foreground-secondary">{demoReal ? "Shielded receiving address" : "Unique receiving address"}</p>
              <span className={clsx("inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-[12px] font-semibold text-accent")} title="Shielded pool receiving">
                <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
                Shielded
              </span>
            </div>

            <CopyableValue value={activeAddress} label="Address" />

            <div className="flex flex-wrap gap-2">
              <CopyButton value={exactZec} label="Copy exact amount" toastMessage="Exact ZEC amount copied" />
              <CopyButton value={activeQrPayload} label="Copy payment URI" toastMessage="Payment URI copied" />
              {shownMemo && <CopyButton value={shownMemo} label="Copy memo" toastMessage="Memo copied" />}
            </div>

            {shownMemo && (
              <p className="rounded-input border border-gold/40 bg-gold/[0.06] px-3 py-2 text-label text-foreground">
                Memo (required): <span className="font-mono font-semibold">{shownMemo}</span> — it identifies this invoice.
              </p>
            )}
            {demoReal && (
              <p className="rounded-input border border-warning/40 bg-warning/[0.06] px-3 py-2 text-label text-foreground">
                <strong>Real ZEC — Zcash mainnet.</strong> This is Zeb Scan&apos;s shielded wallet. This public demo does not confirm payments or send INR automatically;
                include the memo so the operator can match your payment.
              </p>
            )}

            {/* No one-click real payment from the public demo (it cannot confirm or pay INR): scan the QR deliberately instead. */}
            {awaiting && !demoReal && (
              <Button
                className="w-full"
                isLoading={busy}
                onClick={handlePayNoir}
              >
                <Wallet aria-hidden className="h-4 w-4" /> Pay with Noir Wallet
              </Button>
            )}
            {awaiting && noirError && (
              <p role="alert" className="rounded-input border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[13px] text-danger">
                {noirError}
              </p>
            )}
            <p className="text-micro text-foreground-muted">
              Network: {demoReal ? "Zcash mainnet" : c.envLabel === "TEST" ? "Zcash testnet" : "Zcash"} · Protected by Shielded Pool
            </p>
          </div>

          {awaiting && (
            <div className="rounded-panel border border-border bg-surface-2 px-3.5 py-3 text-[13px] text-foreground-secondary">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <Wallet aria-hidden className="h-4 w-4" /> How to pay
              </p>
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
                {demoReal ? (
                  <li>Scan the QR with a shielded Zcash <strong>mainnet</strong> wallet (it fills in the exact amount and memo).</li>
                ) : (
                  <>
                    <li>Click <strong>Pay with Noir Wallet</strong> to review the exact transfer.</li>
                    <li>Or scan the QR with a compatible shielded wallet.</li>
                  </>
                )}
                <li>Verify exact amount and memo. Keep this page open until confirmed.</li>
              </ol>
            </div>
          )}
        </div>
      </div>

      {/* Status-specific next actions */}
      {expired && !c.deposit && (
        <Callout
          tone="warning"
          title="Quote expired"
          action={
            onNewCheckout && services ? (
              <Button onClick={refresh} isLoading={busy}>
                <RefreshCcw aria-hidden className="h-4 w-4" />
                Refresh quote
              </Button>
            ) : undefined
          }
        >
          Exchange rate quotes are refreshed regularly. To ensure accurate settlement, refreshing generates a new quote and receiving address.
        </Callout>
      )}
      {["underpaid", "overpaid", "late"].includes(c.depositStatus) && (
        <Callout tone="warning" title={DEPOSIT_META[c.depositStatus].label}>
          {c.exceptionReason} Contact the {c.merchantId ? "merchant" : "Zeb Scan support team"} to arrange a refund.
        </Callout>
      )}
      {c.depositStatus === "refund_pending" && (
        <Callout tone="warning" title="Refund pending">
          {c.exceptionReason ?? "A refund has been requested for this payment."} No refund has been sent. A refund needs separate operator review and authorization.
        </Callout>
      )}
      {c.depositStatus === "refunded" && <Callout tone="info" title="Refunded">This payment was refunded. No credit was issued.</Callout>}
      {c.depositStatus === "under_review" && (
        <Callout tone="warning" title="Under review">
          {c.exceptionReason ? `Held for review (${c.exceptionReason.replace(/_/g, " ")}).` : "This payment is held for operator review."}
        </Callout>
      )}
      {services?.zcash.submitRefundAddress && ["underpaid", "overpaid", "late", "refund_pending", "under_review"].includes(c.depositStatus) && (
        <form
          className="rounded-panel border border-border p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => services.zcash.submitRefundAddress!(c.id, refundAddr.trim()), "Refund address submitted for review");
            if (r.ok) setRefundAddr("");
          }}
        >
          <label htmlFor={`refund-${c.id}`} className="text-[13px] font-semibold text-foreground">Refund address (optional)</label>
          <p className="mt-0.5 text-micro text-foreground-muted">Provide a Zcash address you control for refund verification.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input id={`refund-${c.id}`} value={refundAddr} onChange={(e) => setRefundAddr(e.target.value)} className="input flex-1 font-mono text-label" placeholder="u1… / zs1… / t1…" autoComplete="off" spellCheck={false} />
            <Button type="submit" size="sm" isLoading={busy} disabled={refundAddr.trim().length < 20}>Submit</Button>
          </div>
        </form>
      )}
      {c.depositStatus === "accepted" && c.merchantId && (
        <Callout
          tone="success"
          title="ZEC payment verified"
          action={
            (receiptHref || receipt) && (
              <>
                {receipt && (
                  <ButtonLink href={receiptHref ?? `/receipt/${receipt.id}`} variant="secondary" size="sm">
                    <ReceiptText aria-hidden className="h-4 w-4" />
                    View receipt
                  </ButtonLink>
                )}
                <Button variant="ghost" size="sm" onClick={() => window.print()}>
                  <Printer aria-hidden className="h-4 w-4" />
                  Print
                </Button>
              </>
            )
          }
        >
          {credit?.unlockAt ? `The merchant received an INR-denominated credit. Credit locked until ${formatDate(credit.unlockAt)}.` : "The merchant received an INR-denominated credit."}
        </Callout>
      )}

      <div className="rounded-panel border border-border p-4">
        <p className="mb-3 text-[13px] font-semibold text-foreground">Payment progress</p>
        <DepositProgress checkout={c} credit={credit} />
        <div className="mt-4">
          <CheckPaymentButton checkout={c} />
        </div>
      </div>
    </div>
  );
}
