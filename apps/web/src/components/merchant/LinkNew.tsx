"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { formatInr, parseInrToMinor } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { validateLink, type LinkErrors, type LinkInput } from "@/services/demo/engine";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { FormField, Input, Segmented, Switch, Textarea } from "@/components/ui/Field";
import { Panel, PanelBody } from "@/components/ui/Panel";
import { CurrencyInput } from "@/components/payments/CurrencyInput";
import { MerchantIdentity } from "@/components/payments/MerchantIdentity";

export function LinkNew() {
  const router = useRouter();
  const { merchant, services, canTransact } = useZeb();
  const now = useNow(60_000);
  const { run, busy } = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"fixed" | "variable">("fixed");
  const [fixed, setFixed] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [reusable, setReusable] = useState(false);
  const [limitText, setLimitText] = useState("");
  const [expiry, setExpiry] = useState("");
  const [allowNote, setAllowNote] = useState(false);
  const [reference, setReference] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!merchant) return null;

  const input: LinkInput = {
    title,
    description,
    amountMode: mode,
    fixedInrMinor: mode === "fixed" ? parseInrToMinor(fixed) : null,
    minInrMinor: mode === "variable" ? parseInrToMinor(min) : null,
    maxInrMinor: mode === "variable" ? parseInrToMinor(max) : null,
    reusable,
    useLimit: reusable ? (limitText.trim() === "" || limitText.trim() === "0" ? null : Number(limitText)) : 1,
    expiresAt: expiry ? new Date(`${expiry}T23:59:59`).getTime() : null,
    allowNote,
    reference,
  };
  const errors: LinkErrors = submitted ? validateLink(input, now ?? Date.now()) : {};

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setSubmitError(null);
    if (!services) return;
    if (Object.keys(validateLink(input, now ?? Date.now())).length) return;
    const r = await run(() => services.merchant.createLink(merchant.id, input), "Payment link created");
    if (r.ok) router.push(`/app/links/${r.value.id}`);
    else setSubmitError(r.error);
  };

  const previewAmount =
    mode === "fixed"
      ? input.fixedInrMinor
        ? formatInr(input.fixedInrMinor)
        : "₹—"
      : input.minInrMinor && input.maxInrMinor
        ? `${formatInr(input.minInrMinor, { whole: true })} – ${formatInr(input.maxInrMinor, { whole: true })}`
        : "Customer enters amount";

  return (
    <>
      <MerchantPageHeader title="Create payment link" back={{ href: "/app/links", label: "Payment links" }} description="Customers open the link without signing in and pay a fresh ZEC quote." />
      {!canTransact && <NotConnectedNotice className="mb-6" />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <form onSubmit={submit} noValidate>
            <PanelBody className="space-y-5">
              <FormField label="Title" error={errors.title} hint="3–80 characters">
                {(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Masala chai tasting box" />}
              </FormField>
              <FormField label="Description" optional error={errors.description} hint={`${description.length}/240`}>
                {(p) => <Textarea {...p} value={description} maxLength={240} onChange={(e) => setDescription(e.target.value)} />}
              </FormField>
              <div className="space-y-2">
                <p className="text-label font-medium text-foreground-secondary">Amount</p>
                <Segmented
                  label="Amount mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "fixed", label: "Fixed INR" },
                    { value: "variable", label: "Variable INR" },
                  ]}
                />
              </div>
              {mode === "fixed" ? (
                <FormField label="Fixed amount" error={errors.fixedInrMinor}>
                  {(p) => <CurrencyInput {...p} size="md" value={fixed} onChange={setFixed} />}
                </FormField>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Minimum" error={errors.minInrMinor}>
                    {(p) => <CurrencyInput {...p} size="md" value={min} onChange={setMin} />}
                  </FormField>
                  <FormField label="Maximum" error={errors.maxInrMinor}>
                    {(p) => <CurrencyInput {...p} size="md" value={max} onChange={setMax} />}
                  </FormField>
                </div>
              )}
              <div className="rounded-panel border border-border p-4">
                <Switch
                  checked={reusable}
                  onChange={setReusable}
                  label="Reusable link"
                  description="Off = one-time: the first confirmed payment uses it up. Opening the link or abandoning a checkout never counts."
                />
                {reusable && (
                  <FormField className="mt-3" label="Use limit" optional error={errors.useLimit} hint="Leave empty or 0 for unlimited confirmed payments.">
                    {(p) => <Input {...p} inputMode="numeric" value={limitText} onChange={(e) => setLimitText(e.target.value.replace(/\D/g, "").slice(0, 5))} className="sm:w-40" />}
                  </FormField>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Expiry date" optional error={errors.expiresAt} hint="Link stops accepting new checkouts after this day.">
                  {(p) => <Input {...p} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />}
                </FormField>
                <FormField label="Invoice / reference" optional error={errors.reference}>
                  {(p) => <Input {...p} value={reference} maxLength={40} onChange={(e) => setReference(e.target.value)} className="font-mono" />}
                </FormField>
              </div>
              <Switch checked={allowNote} onChange={setAllowNote} label="Let customers add a note" description="For an order number or name." />
              {submitError && <p role="alert" className="text-label text-danger">{submitError}</p>}
            </PanelBody>
            <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
              <ButtonLink href="/app/links" variant="ghost">
                Cancel
              </ButtonLink>
              <Button type="submit" isLoading={busy} disabled={!canTransact}>
                Create link
              </Button>
            </div>
          </form>
        </Panel>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Live preview">
          <p className="eyebrow mb-2">Live preview · customer view</p>
          <div className="theme-light mx-auto max-w-[360px] rounded-[20px] border border-border bg-background p-3 text-foreground shadow-overlay">
            <div className="rounded-overlay border border-border bg-surface-1">
              <div className="border-b border-border p-4">
                <MerchantIdentity merchant={merchant} />
              </div>
              <div className="space-y-3 p-4">
                <p className="font-display text-[18px] font-semibold">{title || "Your link title"}</p>
                {description && <p className="text-[13px] text-foreground-secondary">{description}</p>}
                <div className="flex items-baseline justify-between rounded-input bg-surface-2 px-3 py-2.5">
                  <span className="text-label text-foreground-secondary">{mode === "fixed" ? "Amount" : "Enter amount"}</span>
                  <span className="num font-semibold">{previewAmount}</span>
                </div>
                {allowNote && <div className="h-10 rounded-input border border-border bg-surface-2 px-3 py-2.5 text-label text-foreground-muted">Note for the merchant</div>}
                <div className="flex h-11 items-center justify-center rounded-full bg-gold text-[14px] font-medium text-ink">Generate checkout</div>
                <p className="text-micro text-foreground-muted">
                  {reusable ? (input.useLimit ? `Up to ${input.useLimit} confirmed payments` : "Unlimited confirmed payments") : "One-time link"}
                  {input.expiresAt ? ` · expires ${formatDate(input.expiresAt)}` : ""}
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
