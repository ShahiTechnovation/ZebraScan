"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HelpCircle } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { modeLabel } from "@/services/demo/engine";
import { COPY } from "@/config/mode";
import { Container } from "@/components/layout/Container";
import { PageSkeleton } from "@/components/ui/Blocks";
import { ButtonLink } from "@/components/ui/Button";
import { CheckoutPanel } from "@/components/payments/CheckoutPanel";
import { MerchantIdentity } from "@/components/payments/MerchantIdentity";
import { NotFoundPanel } from "./NotFoundPanel";
import { useLiveResource } from "@/providers/ZebProvider";

export function HostedCheckout({ id }: { id: string }) {
  const router = useRouter();
  const { ready, state, isDemo } = useZeb();
  const res = useLiveResource("checkout", id);
  if (!ready || res.loading) return <Container className="py-10"><PageSkeleton /></Container>;
  const c = state.checkouts.find((x) => x.id === id);
  if (!c) return <NotFoundPanel title="Checkout not found" body="This checkout doesn't exist on this device, or the link is wrong. Ask the merchant for a new payment link or QR." href="/" cta="Go to Zeb Scan home" />;
  if (c.mode === "scan_pay")
    return <NotFoundPanel title="This is a Scan & Pay payment" body="Scan & Pay payments are tracked on their own status page." href={`/scan/${c.id}`} cta="Open payment status" />;

  const merchant = state.merchants.find((m) => m.id === c.merchantId);
  const link = c.linkId ? state.links.find((l) => l.id === c.linkId) : undefined;

  return (
    <Container className="max-w-3xl py-8 sm:py-12">
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          {merchant && <MerchantIdentity merchant={merchant} />}
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-micro text-foreground-secondary">{modeLabel(c.mode)}</span>
        </div>
        <div className="px-4 py-5 sm:px-6">
          <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em]">{link?.title ?? (c.mode === "counter_qr" ? "Counter payment" : "Payment")}</h1>
          {link?.description && <p className="mt-1 text-[14px] text-foreground-secondary">{link.description}</p>}
          {c.customerNote && <p className="mt-2 text-label text-foreground-secondary">Your note: “{c.customerNote}”</p>}
          <div className="mt-5">
            <CheckoutPanel checkout={c} onNewCheckout={(nid) => router.push(`/checkout/${nid}`)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-label text-foreground-secondary sm:px-6">
          <span>{isDemo ? COPY.simulation : "Payments are verified by the receiving wallet."}</span>
          <Link href="/faq" className="inline-flex min-h-[44px] items-center gap-1 text-accent hover:underline">
            <HelpCircle aria-hidden className="h-4 w-4" /> Need help?
          </Link>
        </div>
      </div>
      {link && (
        <div className="mt-4 text-center">
          <ButtonLink href={`/pay/${link.slug}`} variant="ghost" size="sm">
            Back to payment link
          </ButtonLink>
        </div>
      )}
    </Container>
  );
}
