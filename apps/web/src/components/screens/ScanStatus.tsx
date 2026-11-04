"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ReceiptText, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr } from "@/lib/money";
import { COPY } from "@/config/mode";
import { Container } from "@/components/layout/Container";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout, PageSkeleton } from "@/components/ui/Blocks";
import { MetaBadge, P2P_META } from "@/components/ui/StatusBadge";
import { CheckoutPanel } from "@/components/payments/CheckoutPanel";
import { PayoutProgress } from "@/components/payments/Progress";
import { DemoControls } from "@/components/payments/DemoControls";
import { ScanSteps } from "./ScanPayWizard";
import { NotFoundPanel } from "./NotFoundPanel";
import { useLiveResource } from "@/providers/ZebProvider";

export function ScanStatus({ id }: { id: string }) {
  const router = useRouter();
  const { ready, state, services, isDemo, live } = useZeb();
  const { run, busy } = useAction();
  const res = useLiveResource("checkout", id);

  if (!ready || res.loading) return <Container className="py-10"><PageSkeleton /></Container>;
  const c = state.checkouts.find((x) => x.id === id && x.mode === "scan_pay");
  if (!c) return <NotFoundPanel title="Payment not found" body={live ? "This payment wasn't found, or this browser doesn't hold its access link. Open the status link on the device that created it." : "This Scan & Pay payment doesn't exist on this device. Demo data lives only in the browser that created it."} href="/scan" cta="Start a new Scan & Pay" />;

  const order = c.p2pOrderId ? state.orders.find((o) => o.id === c.p2pOrderId) ?? null : null;
  const receipt = state.receipts.find((r) => r.checkoutId === c.id);
  const stepNo = c.depositStatus === "accepted" ? 4 : 3;
  // HACKATHON_TESTNET: TAZ is worthless; no P2P order is ever created, so never draw an order tracker.
  const testnet = !isDemo && live?.config?.label === "TEST";

  return (
    <Container className="py-8 sm:py-12">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-accent">Scan &amp; Pay · {stepNo === 3 ? "Step 3 — Pay ZEC" : "Step 4 — Track payout"}</p>
          <h1 className="mt-2 font-display text-[26px] font-semibold tracking-[-0.03em] sm:text-[32px]">
            {formatInr(c.quote.inrMinor)} to <span className="break-all font-mono text-[0.75em]">{c.recipient?.vpa}</span>
          </h1>
          {c.recipient?.payeeName && <p className="mt-1 text-[14px] text-foreground-secondary">{c.recipient.payeeName} · From QR — not independently verified</p>}
        </div>
        {order && <MetaBadge meta={P2P_META[order.status]} label={order.status === "placed" && order.matching ? "LP matching" : undefined} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section className="panel p-4 sm:p-6" aria-labelledby="pay-zec">
            <h2 id="pay-zec" className="mb-4 text-[17px] font-semibold">
              Pay ZEC
            </h2>
            <CheckoutPanel checkout={c} onNewCheckout={(nid) => router.push(`/scan/${nid}`)} />
          </section>

          <section className="panel p-4 sm:p-6" aria-labelledby="payout">
            <h2 id="payout" className="text-[17px] font-semibold">
              INR payout
            </h2>
            {!testnet && (
              <p className="mb-4 mt-0.5 text-[13px] text-foreground-secondary">
                After your ZEC is verified, a P2P PAY order (type 2) is funded from the USDC treasury. A liquidity provider sends INR to the receiver. The payout is complete
                only when the provider confirms it.
              </p>
            )}
            {testnet ? (
              <p className="rounded-panel border border-border bg-surface-2 px-4 py-3 text-[13px] text-foreground-secondary">
                <strong>INR payout disabled on testnet.</strong> TESTNET TAZ — NO REAL INR. {c.depositStatus === "accepted" ? "Your shielded ZEC payment is real and verified on Zcash testnet; no P2P order was created and nothing was sent to the UPI ID." : "No INR is ever paid on testnet, even after the ZEC payment is verified."}
              </p>
            ) : c.depositStatus !== "accepted" && !order ? (
              <p className="rounded-panel border border-border bg-surface-2 px-4 py-3 text-[13px] text-foreground-secondary">The payout starts once your ZEC payment is verified.</p>
            ) : (
              <PayoutProgress order={order} />
            )}

            {order?.status === "completed" && (
              <Callout
                tone="success"
                className="mt-4"
                title="Payout completed"
                action={
                  receipt && (
                    <ButtonLink href={`/receipt/${receipt.id}`} variant="secondary" size="sm">
                      <ReceiptText aria-hidden className="h-4 w-4" /> View receipt
                    </ButtonLink>
                  )
                }
              >
                {isDemo ? "Simulated receipt — not proof of a bank transfer. No real INR moved." : "The payout provider reported the INR transfer as complete. This is not a bank statement."}
              </Callout>
            )}
            {order?.status === "failed" && (
              <Callout tone="danger" className="mt-4" title="Payout failed">
                The provider couldn&apos;t complete the INR transfer. Your ZEC is safe in recovery: the payout can be retried with another provider, or the ZEC refunded.
              </Callout>
            )}
            {order?.status === "disputed" && (
              <Callout tone="warning" className="mt-4" title="Payout disputed">
                The provider and receiver disagree about the transfer. It&apos;s held for review; it can be retried or refunded once resolved.
              </Callout>
            )}

            {services && order && services.p2p.advanceOrder && (
              <DemoControls title="Payout simulator" className="mt-4">
                {["placed", "accepted", "usdc_escrowed", "inr_processing"].includes(order.status) && (
                  <>
                    <Button size="sm" isLoading={busy} onClick={() => run(() => services.p2p.advanceOrder!(order.id))}>
                      Advance payout stage <ArrowRight aria-hidden className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => run(() => services.p2p.failOrder!(order.id, "failed"), "Simulated payout failure")}>
                      <XCircle aria-hidden className="h-4 w-4" /> Simulate failure
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => run(() => services.p2p.failOrder!(order.id, "disputed"), "Simulated dispute")}>
                      <ShieldAlert aria-hidden className="h-4 w-4" /> Simulate dispute
                    </Button>
                  </>
                )}
                {(order.status === "failed" || order.status === "disputed") && (
                  <>
                    <Button size="sm" onClick={() => run(() => services.p2p.recoverOrder!(order.id, "retry"), "Retrying with a new order")}>
                      <RotateCcw aria-hidden className="h-4 w-4" /> Retry payout
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => run(() => services.p2p.recoverOrder!(order.id, "refund"), "ZEC refund requested")}>
                      Refund ZEC instead
                    </Button>
                  </>
                )}
                {order.status === "completed" && <p className="text-label text-foreground-secondary">Payout finished.</p>}
                {order.status === "cancelled" && <p className="text-label text-foreground-secondary">This order was closed for recovery.</p>}
              </DemoControls>
            )}
          </section>
        </div>

        <aside className="panel h-fit space-y-4 p-5 lg:sticky lg:top-24" aria-label="Progress summary">
          <ScanSteps current={stepNo as 3 | 4} />
          <div className="border-t border-border pt-4 text-[13px] text-foreground-secondary">
            <p>Receiver gets</p>
            <p className="num font-display text-[20px] font-semibold text-foreground">{formatInr(c.quote.inrMinor)}</p>
            <p className="mt-2 text-micro">Payment reference</p>
            <p className="break-all font-mono text-label text-foreground">{c.id}</p>
          </div>
          {isDemo && <p className="border-t border-border pt-4 text-micro leading-relaxed text-foreground-muted">{COPY.simulation}</p>}
        </aside>
      </div>
    </Container>
  );
}
