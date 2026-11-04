"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Ban, Clock, HelpCircle, Lock, RefreshCcw } from "lucide-react";
import { useLiveResource, useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr, parseInrToMinor } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { isQuoteExpired, validateInrAmount } from "@/lib/payment-validation";
import { linkStatus } from "@/services/model";
import { COPY } from "@/config/mode";
import type { PaymentPrivacy } from "@/types/domain";
import { Container } from "@/components/layout/Container";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { Button } from "@/components/ui/Button";
import { Callout, PageSkeleton } from "@/components/ui/Blocks";
import { FormField, Input } from "@/components/ui/Field";
import { CurrencyInput } from "@/components/payments/CurrencyInput";
import { PrivacyChoice, QuoteCard } from "@/components/payments/Quote";
import { useQuotePreview } from "@/components/payments/useQuotePreview";
import { MerchantIdentity } from "@/components/payments/MerchantIdentity";
import { NotFoundPanel } from "./NotFoundPanel";

/** Public /pay/[slug] and /m/[handle] — fresh checkout per visit, no sign-in. */
export function StartCheckout({ kind, slug }: { kind: "link" | "counter"; slug: string }) {
  const router = useRouter();
  const { ready, state, services, canTransact, isDemo } = useZeb();
  const res = useLiveResource(kind === "link" ? "link" : "counter", slug);
  const now = useNow(1000);
  const { run, busy } = useAction();

  const link = kind === "link" ? state.links.find((l) => l.slug === slug) : undefined;
  const merchant =
    kind === "link" ? state.merchants.find((m) => m.id === link?.merchantId) : state.merchants.find((m) => m.counterSlug === slug.toLowerCase());
  const retiredOwner = kind === "counter" && !merchant ? state.merchants.find((m) => m.retiredCounterSlugs.includes(slug.toLowerCase())) : undefined;

  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState("");
  const [privacy, setPrivacy] = useState<PaymentPrivacy>("shielded");

  useEffect(() => {
    if (merchant) setPrivacy(merchant.preferences.defaultPrivacy);
  }, [merchant?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Demo-only view counter: counted once per browser session per link. Never consumes a use.
  const counted = useRef(false);
  useEffect(() => {
    if (!ready || !link || !services || counted.current) return;
    counted.current = true;
    const key = `zebscan.viewed.${link.id}`;
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      void services.merchant.recordLinkView(link.id);
    }
  }, [ready, link, services]);

  const fixed = link?.amountMode === "fixed" ? link.fixedInrMinor : null;
  const typed = parseInrToMinor(amountText);
  const amount = fixed ?? typed;
  let amountError: string | null = null;
  if (!fixed && (touched || amountText)) {
    amountError = typed === null && amountText ? "Enter a valid amount (up to 2 decimals)." : validateInrAmount(typed);
    if (!amountError && link && typed !== null && (typed < (link.minInrMinor ?? 0) || typed > (link.maxInrMinor ?? Infinity)))
      amountError = `Enter between ${formatInr(link.minInrMinor ?? 0)} and ${formatInr(link.maxInrMinor ?? 0)}.`;
  }
  const valid = amount !== null && !amountError && validateInrAmount(amount) === null ? amount : null;
  const { quote, error: quoteError, refresh, unavailable } = useQuotePreview(valid, privacy);
  const expired = quote && now !== null ? isQuoteExpired(quote, now) : false;

  if (!ready || res.loading) return <Container className="py-10"><PageSkeleton /></Container>;
  if (retiredOwner)
    return (
      <NotFoundPanel
        title="This counter QR was replaced"
        body={`${retiredOwner.businessName} regenerated their counter QR, so this old code no longer opens a checkout. Ask the merchant for their current QR.`}
        href="/"
        cta="Go to Zeb Scan home"
      />
    );
  if (!merchant || (kind === "link" && !link))
    return (
      <NotFoundPanel
        title={kind === "link" ? "Payment link not found" : "Merchant not found"}
        body="This link doesn't exist on this device. Demo links only work in the browser where they were created."
        href="/"
        cta="Go to Zeb Scan home"
      />
    );

  const status = link && now !== null ? linkStatus(state, link, now) : "active";
  const blocked = status !== "active";

  const start = async () => {
    if (!services || valid === null) return;
    const r = await run(() =>
      services.zcash.createPaymentIntent({
        mode: kind === "link" ? "payment_link" : "counter_qr",
        inrMinor: valid,
        privacy,
        merchantId: merchant.id,
        linkId: link?.id ?? null,
        customerNote: link?.allowNote ? note.trim() : "",
      }),
    );
    if (r.ok) router.push(`/checkout/${r.value.id}`);
  };

  return (
    <Container className="max-w-2xl py-8 sm:py-12">
      {!canTransact && <NotConnectedNotice className="mb-5" />}
      <div className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-4 sm:px-6">
          <MerchantIdentity merchant={merchant} />
        </div>
        <div className="space-y-5 px-4 py-5 sm:px-6">
          <div>
            <h1 className="font-display text-[24px] font-semibold tracking-[-0.02em]">{link ? link.title : `Pay ${merchant.businessName}`}</h1>
            {link?.description && <p className="mt-1 text-[14px] leading-relaxed text-foreground-secondary">{link.description}</p>}
            {!link && <p className="mt-1 text-[14px] text-foreground-secondary">Enter the amount shown at the counter. You&apos;ll get a fresh ZEC quote and a unique address.</p>}
            {link?.reference && <p className="mt-2 font-mono text-micro text-foreground-muted">Ref: {link.reference}</p>}
          </div>

          {blocked ? (
            <Callout
              tone={status === "revoked" ? "danger" : "warning"}
              icon={status === "expired" ? Clock : status === "revoked" ? Ban : Lock}
              title={status === "expired" ? "This payment link has expired" : status === "revoked" ? "This payment link was revoked" : "This payment link has been used"}
            >
              {status === "expired" && link?.expiresAt ? `It expired on ${formatDate(link.expiresAt)}. ` : ""}
              {status === "exhausted" ? "It has reached its limit of confirmed payments. " : ""}
              No new payments can be made. Contact {merchant.businessName} for a new link.
            </Callout>
          ) : (
            <>
              {fixed !== null ? (
                <div className="flex items-baseline justify-between rounded-panel border border-border bg-surface-2 px-4 py-3">
                  <span className="text-[13px] text-foreground-secondary">Amount</span>
                  <span className="num font-display text-[24px] font-semibold">{formatInr(fixed)}</span>
                </div>
              ) : (
                <FormField
                  label="Amount in INR"
                  error={amountError}
                  hint={link ? `Between ${formatInr(link.minInrMinor ?? 0)} and ${formatInr(link.maxInrMinor ?? 0)}.` : "Demo policy: ₹1 – ₹10,000."}
                >
                  {(p) => <CurrencyInput {...p} value={amountText} onChange={setAmountText} onBlur={() => setTouched(true)} />}
                </FormField>
              )}

              {link?.allowNote && (
                <FormField label="Note for the merchant" optional>
                  {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder="e.g. order number or name" />}
                </FormField>
              )}

              <PrivacyChoice value={privacy} onChange={setPrivacy} allowTransparent={merchant.preferences.allowTransparent} />

              {unavailable ? (
                <p className="rounded-panel border border-border px-4 py-3 text-[13px] text-foreground-secondary">Live quote unavailable. {COPY.notConnected}</p>
              ) : quoteError && !quote ? (
                <p role="alert" className="rounded-panel border border-warning/40 bg-warning/[0.07] px-4 py-3 text-[13px] text-foreground-secondary">
                  Live quote unavailable: {quoteError}{" "}
                  <button type="button" className="link" onClick={refresh}>
                    Retry
                  </button>
                </p>
              ) : (
                quote && <QuoteCard quote={quote} now={now} recipientLabel="Merchant receives" />
              )}
              <p className="text-micro text-foreground-muted">
                Fees are added to the INR amount and included in the ZEC you pay. Generating a checkout doesn&apos;t use up the link — only a confirmed payment does.
              </p>

              {expired ? (
                <Button onClick={refresh} className="w-full sm:w-auto">
                  <RefreshCcw aria-hidden className="h-4 w-4" /> Refresh quote
                </Button>
              ) : (
                <Button onClick={start} isLoading={busy} disabled={!canTransact || valid === null || !quote} className="w-full sm:w-auto">
                  Generate checkout <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-label text-foreground-secondary sm:px-6">
          <span>{isDemo ? COPY.simulation : "No sign-in required."}</span>
          <Link href="/faq" className="inline-flex min-h-[44px] items-center gap-1 text-accent hover:underline">
            <HelpCircle aria-hidden className="h-4 w-4" /> Need help?
          </Link>
        </div>
      </div>
    </Container>
  );
}
