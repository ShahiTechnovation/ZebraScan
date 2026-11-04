"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Printer, QrCode } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { useMerchantData } from "@/lib/selectors";
import { formatInr, parseInrToMinor } from "@/lib/money";
import { validateInrAmount } from "@/lib/payment-validation";
import { formatDateTime } from "@/lib/format";
import type { PaymentPrivacy } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { Button } from "@/components/ui/Button";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { FormField, Segmented } from "@/components/ui/Field";
import { ShareButton } from "@/components/ui/CopyShare";
import { DEPOSIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import { AmountChips, CurrencyInput } from "@/components/payments/CurrencyInput";
import { CheckoutPanel } from "@/components/payments/CheckoutPanel";

export function Terminal() {
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get("c");
  const { state, services, canTransact } = useZeb();
  const { merchant, checkouts } = useMerchantData();
  const { run, busy } = useAction();
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [privacy, setPrivacy] = useState<PaymentPrivacy>("shielded");
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (merchant) setPrivacy(merchant.preferences.defaultPrivacy);
  }, [merchant?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!merchant) return null;
  const active = activeId ? state.checkouts.find((c) => c.id === activeId && c.merchantId === merchant.id && c.mode === "terminal") : undefined;
  const minor = parseInrToMinor(amountText);
  const error = touched || amountText ? (minor === null && amountText ? "Enter a valid amount (up to 2 decimals)." : validateInrAmount(minor)) : null;
  const recent = checkouts.filter((c) => c.mode === "terminal").slice(0, 5);

  const create = async () => {
    setTouched(true);
    if (!services || minor === null || validateInrAmount(minor)) return;
    const r = await run(() => services.zcash.createPaymentIntent({ mode: "terminal", inrMinor: minor, privacy, merchantId: merchant.id }), "Checkout created with a unique address");
    if (r.ok) {
      setAmountText("");
      setTouched(false);
      router.replace(`/app/terminal?c=${r.value.id}`);
    }
  };

  return (
    <>
      <MerchantPageHeader
        title="Accept a ZEC payment"
        description="Enter a fixed INR amount, lock a quote and show the customer a one-time ZEC QR. Every payment gets a new receiving address."
        actions={
          active && (
            <Button variant="secondary" onClick={() => router.replace("/app/terminal")}>
              <Plus aria-hidden className="h-4 w-4" /> New payment
            </Button>
          )
        }
      />
      {!canTransact && <NotConnectedNotice className="mb-6" />}

      {activeId && !active && (
        <p className="mb-4 text-[13px] text-warning" role="alert">
          That checkout wasn&apos;t found for this shop. Start a new payment below.
        </p>
      )}

      {active ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel className="print-area">
            <PanelHeader
              title={`${formatInr(active.quote.inrMinor)} · ${merchant.businessName}`}
              description="Show this screen to the customer"
              actions={
                <>
                  <Button variant="ghost" size="sm" onClick={() => window.print()}>
                    <Printer aria-hidden className="h-4 w-4" /> Print
                  </Button>
                  {origin && <ShareButton url={`${origin}/checkout/${active.id}`} title={`Pay ${merchant.businessName}`} label="Share checkout" />}
                </>
              }
            />
            <PanelBody>
              <CheckoutPanel checkout={active} onNewCheckout={(id) => router.replace(`/app/terminal?c=${id}`)} receiptHref={undefined} />
            </PanelBody>
          </Panel>
          <Panel className="h-fit">
            <PanelHeader title="Incoming payment" />
            <PanelBody className="space-y-3 text-[13px]">
              <MetaBadge meta={DEPOSIT_META[active.depositStatus]} />
              <p className="text-foreground-secondary">
                {active.depositStatus === "accepted"
                  ? "ZEC verified. On testnet this is a nonredeemable reference receipt; no INR credit or bank transfer is created."
                  : active.depositStatus === "expired"
                    ? "The quote expired without a payment. Refresh to create a new checkout. Any late ZEC is held for recovery."
                    : "The customer's payment shows up here once the wallet scanner sees it. Don't hand over goods until it says “ZEC payment verified”."}
              </p>
              <Link href={`/app/transactions/${active.id}`} className="link inline-flex min-h-[44px] items-center">
                Open transaction details
              </Link>
            </PanelBody>
          </Panel>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
          <Panel>
            <PanelHeader title="Charge" icon={<QrCode />} />
            <PanelBody>
              <form
                className="space-y-4"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <FormField label="Amount (INR)" error={error} hint="Allowed range: ₹1 – ₹10,000">
                  {(p) => <CurrencyInput {...p} value={amountText} onChange={setAmountText} onBlur={() => setTouched(true)} autoFocus />}
                </FormField>
                <AmountChips values={[10_000, 50_000, 100_000]} onPick={(v) => setAmountText(String(v / 100))} />
                <div className="space-y-1.5">
                  <p className="text-label font-medium text-foreground-secondary">Requested privacy</p>
                  <Segmented<PaymentPrivacy>
                    label="Requested privacy"
                    value={privacy}
                    onChange={setPrivacy}
                    options={[
                      { value: "shielded", label: "Shielded" },
                      { value: "transparent", label: "Transparent", disabled: !merchant.preferences.allowTransparent },
                    ]}
                  />
                  {privacy === "transparent" && <p className="text-label text-warning">Transparent payments are publicly visible on-chain.</p>}
                </div>
                <Button type="submit" size="lg" className="w-full" isLoading={busy} disabled={!canTransact}>
                  Create checkout
                </Button>
              </form>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Recent terminal checkouts" />
            {recent.length ? (
              <ul className="divide-y divide-border">
                {recent.map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/terminal?c=${c.id}`} className="flex min-h-[52px] items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2/60">
                      <span>
                        <span className="num block text-[14px] font-medium">{formatInr(c.quote.inrMinor)}</span>
                        <span className="num block text-micro text-foreground-muted">{formatDateTime(c.createdAt)}</span>
                      </span>
                      <MetaBadge meta={DEPOSIT_META[c.depositStatus]} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-[13px] text-foreground-secondary">No terminal checkouts yet.</p>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
