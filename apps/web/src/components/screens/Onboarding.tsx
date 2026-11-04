"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Download, ExternalLink, KeyRound, Pencil, ShieldCheck, Sparkles, Upload, Wallet } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { validateOnboarding, type OnboardingInput } from "@/services/model";
import { Container } from "@/components/layout/Container";
import { Button } from "@/components/ui/Button";
import { Callout, DataList, PageSkeleton } from "@/components/ui/Blocks";
import { FormField, Input, InlineError, Select } from "@/components/ui/Field";
import { Stepper } from "@/components/ui/Timeline";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { detectNoir, connectNoir, signInWithNoir } from "@/services/live/noir";
import { errorMessage } from "@/services/live/api";

const CATEGORIES = ["Food & beverage", "Retail", "Groceries", "Services", "Education", "Health & wellness", "Travel & transport", "Events", "Other"];
const DRAFT_KEY = "zebscan.onboarding.draft";
const EMPTY: OnboardingInput = { businessName: "", handle: "", category: "", payoutUpi: "", beneficiaryName: "" };

export function Onboarding() {
  const router = useRouter();
  const { ready, state, services, live } = useZeb();
  const { run, busy } = useAction();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [data, setData] = useState<OnboardingInput>(EMPTY);
  const [ack, setAck] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Noir wallet state
  const [noirStatus, setNoirStatus] = useState<"checking" | "installed" | "not_installed">("checking");
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setData({ ...EMPTY, ...(parsed as Partial<OnboardingInput>) });
        if (parsed.connectedAddress) setConnectedAddress(parsed.connectedAddress);
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
    void detectNoir().then((ok) => setNoirStatus(ok ? "installed" : "not_installed"));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...data, connectedAddress }));
    } catch {
      /* logo may exceed quota; keep in memory */
    }
  }, [data, connectedAddress, loaded]);

  const handleConnectNoir = async () => {
    setWalletBusy(true);
    setWalletError(null);
    try {
      if (live) {
        try {
          await signInWithNoir("login");
          await live.refreshSession();
        } catch {
          // If login fails (new account), connect direct to get address
        }
      }
      const res = await connectNoir();
      const addr = res.shielded;
      if (!addr) throw new Error("No shielded address was shared by the wallet.");
      setConnectedAddress(addr);
    } catch (e) {
      setWalletError(errorMessage(e));
    } finally {
      setWalletBusy(false);
    }
  };

  const errors = validateOnboarding(state, data);
  const step2Fields: Array<keyof OnboardingInput> = ["businessName", "handle", "category"];
  const step3Fields: Array<keyof OnboardingInput> = ["payoutUpi", "beneficiaryName"];
  const stepValid = (fields: Array<keyof OnboardingInput>) => fields.every((f) => !errors[f]);
  const err = (f: keyof OnboardingInput) => (showErrors ? errors[f] : undefined);
  const set = (patch: Partial<OnboardingInput>) => setData((d) => ({ ...d, ...patch }));

  const nextFromStep2 = () => {
    setShowErrors(true);
    if (!stepValid(step2Fields)) return;
    setShowErrors(false);
    setStep(3);
  };

  const nextFromStep3 = () => {
    setShowErrors(true);
    if (!stepValid(step3Fields) || !ack) return;
    setShowErrors(false);
    setStep(4);
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
    const r = await run(() => services.merchant.onboard(data), "Business profile created");
    if (r.ok) {
      localStorage.removeItem(DRAFT_KEY);
      router.push("/app");
    }
  };

  if (!ready) return <Container className="py-10"><PageSkeleton /></Container>;

  return (
    <Container className="max-w-4xl py-8 sm:py-12">
      <div className="flex items-center gap-2">
        <p className="eyebrow text-accent">Merchant Onboarding</p>
        <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-micro font-medium text-accent">
          Shielded Settlement
        </span>
      </div>
      <h1 className="mt-2 font-display text-[28px] font-semibold tracking-[-0.03em] sm:text-[32px]">
        Set up your merchant checkout
      </h1>
      <p className="mt-1.5 text-[15px] text-foreground-secondary">
        Connect your Noir Wallet, configure your store profile, and set your settlement preferences.
      </p>
      {!services && <NotConnectedNotice className="mt-5" />}

      <div className="mt-8 grid gap-6 md:grid-cols-[230px_minmax(0,1fr)]">
        <aside aria-label="Setup progress">
          <Stepper
            label="Setup steps"
            steps={[
              { key: "w", label: "Noir Wallet", state: step > 1 ? "done" : "current" },
              { key: "b", label: "Business Details", state: step > 2 ? "done" : step === 2 ? "current" : "upcoming" },
              { key: "p", label: "Settlement (UPI)", state: step > 3 ? "done" : step === 3 ? "current" : "upcoming" },
              { key: "r", label: "Review & Launch", state: step === 4 ? "current" : "upcoming" },
            ]}
          />
        </aside>

        <div className="panel p-5 sm:p-6">
          {/* STEP 1: NOIR WALLET ONBOARDING */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-[18px] font-semibold flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-accent" /> 1. Connect Noir Wallet
                </h2>
                <p className="mt-1 text-[14px] text-foreground-secondary">
                  Noir Wallet is the non-custodial browser extension for Zcash shielded assets. Link your wallet to verify your merchant identity.
                </p>
              </div>

              {connectedAddress ? (
                <div className="rounded-panel border border-success/40 bg-success/[0.06] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-success">
                      <CheckCircle2 className="h-4 w-4" /> Noir Wallet Connected
                    </span>
                    <span className="rounded-full bg-success/20 px-2.5 py-0.5 text-micro font-medium text-success">
                      Shielded Identity Active
                    </span>
                  </div>
                  <div>
                    <p className="text-micro text-foreground-muted">Connected Shielded Address</p>
                    <p className="mt-0.5 font-mono text-[13px] break-all text-foreground font-medium">
                      {connectedAddress}
                    </p>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConnectedAddress(null)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-panel border border-border bg-surface-1 p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gold/15 text-accent">
                          <Wallet className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-[16px] font-semibold">Noir Extension</p>
                          <p className="text-micro text-foreground-muted">
                            {noirStatus === "checking"
                              ? "Detecting extension..."
                              : noirStatus === "installed"
                                ? "Extension ready to connect"
                                : "Extension not detected in browser"}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-micro font-medium text-accent">
                        Official Zcash
                      </span>
                    </div>

                    <div className="mt-4">
                      {noirStatus === "installed" ? (
                        <Button
                          className="w-full"
                          isLoading={walletBusy}
                          onClick={handleConnectNoir}
                        >
                          <Wallet className="h-4 w-4" /> Connect Noir Wallet
                        </Button>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-[13px] text-foreground-secondary leading-relaxed">
                            To use Shielded Point-of-Sale with automated signature verification, install the Noir Wallet extension for Chromium browsers.
                          </p>
                          <a
                            className="button-primary inline-flex h-10 w-full items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium"
                            href="https://github.com/NoirWallet/noir-wallet/releases"
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Download className="h-4 w-4" /> Download Noir Wallet Release <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                          <div className="rounded-input border border-border bg-surface-2 p-3 text-micro text-foreground-muted">
                            <strong>Setup Guide:</strong> Install the extension &rarr; Create or restore your Shielded Zcash account &rarr; Click &quot;Check Again&quot; below.
                          </div>
                          <Button
                            variant="secondary"
                            className="w-full"
                            onClick={() => {
                              setNoirStatus("checking");
                              void detectNoir().then((ok) => setNoirStatus(ok ? "installed" : "not_installed"));
                            }}
                          >
                            Check Extension Again
                          </Button>
                        </div>
                      )}
                    </div>

                    {walletError && (
                      <p role="alert" className="mt-3 rounded-input border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[13px] text-danger">
                        {walletError}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3 py-1 text-micro text-foreground-muted">
                    <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setConnectedAddress("Account setup with email authentication");
                      setStep(2);
                    }}
                    className="w-full rounded-panel border border-border bg-surface-1 px-4 py-3 text-left hover:border-border-strong text-[13px] text-foreground-secondary flex items-center justify-between"
                  >
                    <span>
                      <strong className="text-foreground block">Continue without wallet extension</strong>
                      Set up store profile with email authentication; connect your wallet later in Settings.
                    </span>
                    <ArrowRight className="h-4 w-4 text-foreground-muted shrink-0 ml-2" />
                  </button>
                </div>
              )}

              <div className="flex justify-end pt-3">
                <Button
                  onClick={() => setStep(2)}
                  disabled={!connectedAddress}
                >
                  Continue to Business Details <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 2: BUSINESS DETAILS */}
          {step === 2 && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                nextFromStep2();
              }}
            >
              <h2 className="text-[17px] font-semibold">2. Business Profile</h2>
              <FormField label="Business name" error={err("businessName")} hint="2–60 characters. Displayed on payment QR terminals and links.">
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
                  Store Logo <span className="font-normal text-foreground-muted">· optional</span>
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
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                </Button>
                <Button type="submit">
                  Continue <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </form>
          )}

          {/* STEP 3: SETTLEMENT DESTINATION */}
          {step === 3 && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                nextFromStep3();
              }}
            >
              <h2 className="text-[17px] font-semibold">3. Settlement Account (Payout UPI)</h2>
              <FormField label="Payout UPI ID" error={err("payoutUpi")} hint="The UPI VPA linked to your bank account for INR settlements.">
                {(p) => (
                  <Input {...p} value={data.payoutUpi} onChange={(e) => set({ payoutUpi: e.target.value.trim() })} placeholder="yourshop@upi" autoCapitalize="none" spellCheck={false} className="font-mono" />
                )}
              </FormField>
              <FormField label="Beneficiary display name" error={err("beneficiaryName")} hint="Account holder name for settlement verification.">
                {(p) => <Input {...p} value={data.beneficiaryName} maxLength={60} onChange={(e) => set({ beneficiaryName: e.target.value })} />}
              </FormField>
              <Callout tone="info" title="How Settlement Works">
                Customers pay in shielded ZEC. Payout settlements are routed over the P2P settlement rail directly into your designated UPI bank account.
              </Callout>
              <label className="flex min-h-[44px] items-start gap-2.5 text-[13px] text-foreground-secondary">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#E6B84B]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand that payouts are executed via P2P liquidity providers to my designated UPI account.</span>
              </label>
              {showErrors && !ack && <InlineError>Please confirm your understanding of the payout rail.</InlineError>}
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                </Button>
                <Button type="submit">
                  Review &amp; Launch <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </form>
          )}

          {/* STEP 4: REVIEW */}
          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-[17px] font-semibold">4. Review &amp; Launch</h2>
              <div className="rounded-panel border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <p className="text-[13px] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-accent" /> Wallet Identity
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                    <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
                <DataList
                  className="px-4"
                  items={[
                    { label: "Shielded Wallet", value: <span className="font-mono text-micro break-all">{connectedAddress ?? "Configured"}</span> },
                    { label: "Network", value: "Zcash Shielded Pool" },
                  ]}
                />
              </div>

              <div className="rounded-panel border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <p className="text-[13px] font-medium">Business</p>
                  <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                    <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
                <DataList
                  className="px-4"
                  items={[
                    { label: "Business name", value: data.businessName },
                    { label: "Handle", value: <span className="font-mono">{data.handle.toLowerCase()}</span> },
                    { label: "Category", value: data.category },
                    { label: "Logo", value: data.logoDataUrl ? "Uploaded" : "Default" },
                  ]}
                />
              </div>

              <div className="rounded-panel border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <p className="text-[13px] font-medium">Settlement</p>
                  <Button variant="ghost" size="sm" onClick={() => setStep(3)}>
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
                <Button variant="ghost" onClick={() => setStep(3)}>
                  <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                </Button>
                <Button onClick={create} isLoading={busy} disabled={!services || Object.keys(errors).length > 0}>
                  Launch Merchant Console
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Container>
  );
}
