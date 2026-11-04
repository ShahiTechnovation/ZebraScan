"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Pencil, Upload } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { validateOnboarding, type OnboardingInput } from "@/services/demo/engine";
import { COPY } from "@/config/mode";
import { Container } from "@/components/layout/Container";
import { Button } from "@/components/ui/Button";
import { Callout, DataList, PageSkeleton } from "@/components/ui/Blocks";
import { FormField, Input, InlineError, Select } from "@/components/ui/Field";
import { Stepper } from "@/components/ui/Timeline";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";

const CATEGORIES = ["Food & beverage", "Retail", "Groceries", "Services", "Education", "Health & wellness", "Travel & transport", "Events", "Other"];
const DRAFT_KEY = "zebscan.onboarding.draft";
const EMPTY: OnboardingInput = { businessName: "", handle: "", category: "", payoutUpi: "", beneficiaryName: "" };

export function Onboarding() {
  const router = useRouter();
  const { ready, state, services, isDemo, live } = useZeb();
  const { run, busy } = useAction();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [data, setData] = useState<OnboardingInput>(EMPTY);
  const [ack, setAck] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) setData({ ...EMPTY, ...(JSON.parse(raw) as Partial<OnboardingInput>) });
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch {
      /* logo may exceed quota; keep in memory */
    }
  }, [data, loaded]);

  const errors = validateOnboarding(state, data);
  const step1Fields: Array<keyof OnboardingInput> = ["businessName", "handle", "category"];
  const step2Fields: Array<keyof OnboardingInput> = ["payoutUpi", "beneficiaryName"];
  const stepValid = (fields: Array<keyof OnboardingInput>) => fields.every((f) => !errors[f]);
  const err = (f: keyof OnboardingInput) => (showErrors ? errors[f] : undefined);
  const set = (patch: Partial<OnboardingInput>) => setData((d) => ({ ...d, ...patch }));

  const next = (fields: Array<keyof OnboardingInput>, to: 2 | 3) => {
    setShowErrors(true);
    if (!stepValid(fields) || (to === 3 && !ack)) return;
    setShowErrors(false);
    setStep(to);
  };

  const onLogo = (file?: File) => {
    setLogoError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) return setLogoError("Choose an image file.");
    if (file.size > 300 * 1024) return setLogoError("Logo must be under 300 KB.");
    const reader = new FileReader();
    reader.onload = () => set({ logoDataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const create = async () => {
    if (!services) return;
    const r = await run(() => services.merchant.onboard(data), live ? "Business profile created" : "Demo merchant created");
    if (r.ok) {
      localStorage.removeItem(DRAFT_KEY);
      router.push("/app");
    }
  };

  if (!ready) return <Container className="py-10"><PageSkeleton /></Container>;

  return (
    <Container className="max-w-4xl py-8 sm:py-12">
      <p className="eyebrow text-accent">Merchant setup</p>
      <h1 className="mt-2 font-display text-[28px] font-semibold tracking-[-0.03em] sm:text-[32px]">{live ? "Set up your business" : "Set up your demo shop"}</h1>
      <p className="mt-1.5 text-[15px] text-foreground-secondary">{live ? "Three short steps. Business verification (KYB) may be required before you can accept live payments." : "Three short steps. Your demo merchant is saved in this browser only."}</p>
      {!services && <NotConnectedNotice className="mt-5" />}

      <div className="mt-8 grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Setup progress">
          <Stepper
            label="Setup steps"
            steps={[
              { key: "b", label: "Business", state: step > 1 ? "done" : "current" },
              { key: "p", label: "Payout UPI", state: step > 2 ? "done" : step === 2 ? "current" : "upcoming" },
              { key: "r", label: "Review", state: step === 3 ? "current" : "upcoming" },
            ]}
          />
        </aside>

        <div className="panel p-5 sm:p-6">
          {step === 1 && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                next(step1Fields, 2);
              }}
            >
              <h2 className="text-[17px] font-semibold">1. Your business</h2>
              <FormField label="Business name" error={err("businessName")} hint="2–60 characters. Shown to customers at checkout.">
                {(p) => <Input {...p} value={data.businessName} maxLength={60} onChange={(e) => set({ businessName: e.target.value })} autoComplete="organization" />}
              </FormField>
              <FormField label="Merchant handle" error={err("handle")} hint="3–24 letters, numbers or hyphens. Used in your counter link: /m/your-handle">
                {(p) => (
                  <Input
                    {...p}
                    value={data.handle}
                    maxLength={24}
                    onChange={(e) => set({ handle: e.target.value.replace(/\s+/g, "-") })}
                    autoCapitalize="none"
                    spellCheck={false}
                    className="font-mono"
                  />
                )}
              </FormField>
              <FormField label="Business category" error={err("category")}>
                {(p) => (
                  <Select {...p} value={data.category} onChange={(e) => set({ category: e.target.value })}>
                    <option value="">Choose a category</option>
                    {CATEGORIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                )}
              </FormField>
              <div className="space-y-1.5">
                <p className="text-label font-medium text-foreground-secondary">
                  Logo <span className="font-normal text-foreground-muted">· optional, local preview only</span>
                </p>
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 font-display text-[18px] font-semibold">
                    {data.logoDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={data.logoDataUrl} alt="Logo preview" className="h-full w-full object-cover" />
                    ) : (
                      (data.businessName[0] ?? "?").toUpperCase()
                    )}
                  </span>
                  <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-[13px] hover:border-border-strong">
                    <Upload aria-hidden className="h-4 w-4" /> Choose image
                    <input type="file" accept="image/*" className="sr-only" onChange={(e) => onLogo(e.target.files?.[0])} />
                  </label>
                  {data.logoDataUrl && (
                    <Button variant="ghost" size="sm" onClick={() => set({ logoDataUrl: undefined })}>
                      Remove
                    </Button>
                  )}
                </div>
                <InlineError>{logoError}</InlineError>
              </div>
              <div className="flex justify-end pt-2">
                <Button type="submit">
                  Continue <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </form>
          )}

          {step === 2 && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                next(step2Fields, 3);
              }}
            >
              <h2 className="text-[17px] font-semibold">2. Where should withdrawals go?</h2>
              <FormField label="Payout UPI ID" error={err("payoutUpi")} hint="The UPI ID linked to the bank account you withdraw to. Use a demo value — no bank validation happens here.">
                {(p) => (
                  <Input {...p} value={data.payoutUpi} onChange={(e) => set({ payoutUpi: e.target.value.trim() })} placeholder="yourshop@handle" autoCapitalize="none" spellCheck={false} className="font-mono" />
                )}
              </FormField>
              <FormField label="Beneficiary display name" error={err("beneficiaryName")} hint="How you'd like the payout recipient to appear in your records.">
                {(p) => <Input {...p} value={data.beneficiaryName} maxLength={60} onChange={(e) => set({ beneficiaryName: e.target.value })} />}
              </FormField>
              <Callout tone="info" title="How payouts work">
                Withdrawals are sent by a P2P payout provider to this UPI ID. Completion depends on the provider and the bank, and isn&apos;t guaranteed instant.
              </Callout>
              <label className="flex min-h-[44px] items-start gap-2.5 text-[13px] text-foreground-secondary">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#E6B84B]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand that UPI payouts depend on a payout provider and my bank, and that my balance is an INR-denominated platform credit, not a bank deposit.</span>
              </label>
              {showErrors && !ack && <InlineError>Please confirm you understand how payouts work.</InlineError>}
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                </Button>
                <Button type="submit">
                  Review <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </form>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-[17px] font-semibold">3. Review</h2>
              <div className="rounded-panel border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <p className="text-[13px] font-medium">Business</p>
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                    <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
                <DataList
                  className="px-4"
                  items={[
                    { label: "Business name", value: data.businessName },
                    { label: "Handle", value: <span className="font-mono">{data.handle.toLowerCase()}</span> },
                    { label: "Category", value: data.category },
                    { label: "Logo", value: data.logoDataUrl ? "Added (stored locally)" : "None" },
                  ]}
                />
              </div>
              <div className="rounded-panel border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <p className="text-[13px] font-medium">Payout</p>
                  <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                    <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
                <DataList
                  className="px-4"
                  items={[
                    { label: "Payout UPI ID", value: <span className="font-mono">{data.payoutUpi}</span> },
                    { label: "Beneficiary display name", value: data.beneficiaryName },
                  ]}
                />
              </div>
              {Object.keys(errors).length > 0 && <InlineError>{Object.values(errors)[0]}</InlineError>}
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                </Button>
                <Button onClick={create} isLoading={busy} disabled={!services || Object.keys(errors).length > 0}>
                  {isDemo ? "Create demo merchant" : "Create merchant"}
                </Button>
              </div>
              {isDemo && <p className="text-micro text-foreground-muted">{COPY.simulation}</p>}
            </div>
          )}
        </div>
      </div>
    </Container>
  );
}
