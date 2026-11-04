"use client";

import React, { useState } from "react";
import { ArrowRight, RefreshCcw, Wallet, ReceiptText, Printer } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr, formatZec } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { isQuoteExpired } from "@/lib/quote";
import { COPY } from "@/config/mode";
import type { CheckoutIntent } from "@/types/domain";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { CopyableValue, CopyButton } from "@/components/ui/CopyShare";
import { DEPOSIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import { Modal } from "@/components/ui/Modal";
import { QRRenderer } from "./QR";
import { PrivacyBadge, RateExpiry } from "./Quote";
import { DepositProgress } from "./Progress";
import { DemoControls } from "./DemoControls";

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
  const { services, state, isDemo } = useZeb();
  const now = useNow(1000);
  const { run, busy } = useAction();
  const [simOpen, setSimOpen] = useState(false);

  const credit = state.credits.find((cr) => cr.checkoutId === c.id && !cr.parentCreditId) ?? null;
  const receipt = state.receipts.find((r) => r.checkoutId === c.id);
  const expired = c.depositStatus === "expired" || (c.depositStatus === "awaiting" && now !== null && isQuoteExpired(c.quote, now));
  const awaiting = c.depositStatus === "awaiting" && !expired;
  const exactZec = formatZec(c.quote.zecZat, { fixed: true });
  /** Non-payable preview: local demo, or a DEMO-environment backend address. */
  const nonPayable = isDemo || c.payable === false;
  const canSimulate = !!services?.zcash.simulateDeposit && (isDemo || c.envLabel === "DEMO");
  const [refundAddr, setRefundAddr] = useState("");

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
            value={c.qrPayload}
            label={nonPayable ? "Demo preview QR. Encodes a non-payable placeholder; it cannot receive ZEC." : `Zcash payment request for ${exactZec} ZEC`}
            caption={nonPayable ? COPY.previewQr : undefined}
            dimmed={!awaiting}
            size={240}
          />
          <div className="mt-3 w-full text-center">
            {awaiting ? <RateExpiry expiresAt={c.quote.expiresAt} now={now} /> : <span className="text-label text-foreground-secondary">{expired ? "This QR is no longer valid." : "Payment received — QR closed."}</span>}
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
            {c.quote.source === "demo" && <p className="mt-1 text-micro font-medium text-accent">{COPY.illustrative}</p>}
          </div>

          <div className="space-y-2">
            <p className="text-label font-medium text-foreground-secondary">Unique receiving address</p>
            <CopyableValue value={c.receivingAddress} label="Address" />
            <div className="flex flex-wrap gap-2">
              <CopyButton value={exactZec} label="Copy exact amount" toastMessage="Exact ZEC amount copied" />
              <CopyButton value={c.qrPayload} label="Copy payment URI" toastMessage="Payment URI copied" />
              {c.memo && <CopyButton value={c.memo} label="Copy memo" toastMessage="Memo copied" />}
            </div>
            {c.memo && (
              <p className="rounded-input border border-gold/40 bg-gold/[0.06] px-3 py-2 text-label text-foreground">
                Memo (required): <span className="font-mono font-semibold">{c.memo}</span> — it identifies this invoice. If your wallet does not fill it in from the QR, add it manually.
              </p>
            )}
            {awaiting && !nonPayable && (c.network === "testnet" || c.network === "mainnet") && c.privacy === "shielded" && (
              <Button
                className="w-full"
                isLoading={busy}
                onClick={() =>
                  run(async () => {
                    const { payWithNoir } = await import("@/services/live/noir");
                    await payWithNoir({ to: c.receivingAddress, zat: c.quote.zecZat, memo: c.memo ?? null, network: c.network as "testnet" });
                  }, "Wallet sent ZEC — waiting for Zeb Scan to detect and confirm it")
                }
              >
                <Wallet aria-hidden className="h-4 w-4" /> Pay with Noir Wallet
              </Button>
            )}
            <p className="text-micro text-foreground-muted">
              Network: {nonPayable ? "Demo simulation — not a Zcash network" : c.envLabel === "TEST" ? "Zcash testnet (TEST — not redeemable)" : "Zcash"} · This address is used for this checkout only.
            </p>
          </div>

          {awaiting && (
            <div className="rounded-panel border border-border bg-surface-2 px-3.5 py-3 text-[13px] text-foreground-secondary">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <Wallet aria-hidden className="h-4 w-4" /> How to pay
              </p>
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
                <li>Open your Zcash wallet and choose Send.</li>
                <li>Scan the QR or paste the address and the exact amount.</li>
                <li>Prefer a shielded send. Keep this page open until the payment is verified.</li>
              </ol>
              <p className="mt-2 text-micro text-foreground-muted">
                {nonPayable
                  ? "No wallet deep link in demo — this preview cannot receive real ZEC. Do not send funds."
                  : "Open with your wallet if it supports Zcash payment URIs; otherwise copy the details manually."}
              </p>
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
          Prices move, so quotes are short-lived. Don&apos;t send ZEC to this address — refreshing creates a new quote and a new unique address. If you already sent
          ZEC, it is tracked separately and routed to recovery, never silently discarded.
        </Callout>
      )}
      {["underpaid", "overpaid", "late"].includes(c.depositStatus) && (
        <Callout tone="warning" title={DEPOSIT_META[c.depositStatus].label}>
          {c.exceptionReason} Contact the {c.merchantId ? "merchant" : "Zeb Scan support team"} to arrange a refund. No merchant credit or payout was issued.
        </Callout>
      )}
      {c.depositStatus === "refund_pending" && (
        <Callout tone="warning" title="Refund pending">
          {c.exceptionReason ?? "A refund has been requested for this payment."} Refunds return ZEC to a payer-provided address.
        </Callout>
      )}
      {c.depositStatus === "refunded" && <Callout tone="info" title="Refunded">This payment was refunded. No credit was issued.</Callout>}
      {c.depositStatus === "under_review" && (
        <Callout tone="warning" title="Under review">
          {c.exceptionReason ? `Held for review (${c.exceptionReason.replace(/_/g, " ")}).` : "This payment is held for operator review."} No credit or payout is released until the review completes.
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
          <p className="mt-0.5 text-micro text-foreground-muted">Provide a Zcash address you control. A reviewer verifies it before any refund is sent; refunds are never automatic.</p>
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
          {credit?.unlockAt ? `The merchant received an INR-denominated credit. Credit locked until ${formatDate(credit.unlockAt)}.` : "The merchant received an INR-denominated credit."}{" "}
          {isDemo && "Simulated — no real ZEC moved."}
        </Callout>
      )}

      <div className="rounded-panel border border-border p-4">
        <p className="mb-3 text-[13px] font-semibold text-foreground">Payment progress</p>
        <DepositProgress checkout={c} credit={credit} />
      </div>

      {services && canSimulate && (
        <DemoControls title="Wallet simulator">
          {(c.depositStatus === "awaiting" || c.depositStatus === "expired") && !c.deposit && (
            <Button size="sm" onClick={() => setSimOpen(true)}>
              {expired ? "Simulate late deposit…" : "Simulate deposit detected…"}
            </Button>
          )}
          {(c.depositStatus === "detected" || c.depositStatus === "confirming") && services.zcash.advanceConfirmation && (
            <Button size="sm" isLoading={busy} onClick={() => run(() => services.zcash.advanceConfirmation!(c.id))}>
              {c.depositStatus === "detected" ? "Add confirmation" : "Reach required confirmations"}
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Button>
          )}
          {["underpaid", "overpaid", "late"].includes(c.depositStatus) && services.zcash.startRefund && (
            <Button size="sm" isLoading={busy} onClick={() => run(() => services.zcash.startRefund!(c.id), "Refund requested (simulated)")}>
              Start refund
            </Button>
          )}
          {c.depositStatus === "refund_pending" && services.zcash.completeRefund && (
            <Button size="sm" isLoading={busy} onClick={() => run(() => services.zcash.completeRefund!(c.id), "Refund marked sent (simulated)")}>
              Mark refund sent
            </Button>
          )}
          {["accepted", "refunded"].includes(c.depositStatus) && <p className="text-label text-foreground-secondary">No further wallet events for this checkout.</p>}
        </DemoControls>
      )}

      <Modal
        open={simOpen}
        onClose={() => setSimOpen(false)}
        title="Simulate a ZEC deposit"
        description="This pretends the wallet scanner saw a payment to this checkout's unique address. No ZEC moves and nothing is sent to any network."
      >
        <div className="space-y-2">
          {expired ? (
            <Button
              className="w-full"
              onClick={async () => {
                setSimOpen(false);
                await run(() => services!.zcash.simulateDeposit!(c.id, "exact"), "Simulated late deposit recorded");
              }}
            >
              Simulate ZEC arriving after expiry
            </Button>
          ) : (
            <>
              <Button
                className="w-full"
                data-autofocus
                onClick={async () => {
                  setSimOpen(false);
                  await run(() => services!.zcash.simulateDeposit!(c.id, "exact"), "Simulated deposit detected");
                }}
              >
                Exact amount ({exactZec} ZEC)
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  setSimOpen(false);
                  await run(() => services!.zcash.simulateDeposit!(c.id, "underpaid"), "Simulated underpayment");
                }}
              >
                Underpay (60%)
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  setSimOpen(false);
                  await run(() => services!.zcash.simulateDeposit!(c.id, "overpaid"), "Simulated overpayment");
                }}
              >
                Overpay (125%)
              </Button>
            </>
          )}
          <p className="pt-1 text-micro text-foreground-muted">{COPY.simulation}</p>
        </div>
      </Modal>
    </div>
  );
}
