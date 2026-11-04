"use client";

import React, { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, Camera, ClipboardPaste, ImageUp, Keyboard, Loader2, RefreshCcw, UserRound } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { parseUpiPayload, validateVpa } from "@/lib/upi";
import { formatInr, minorToInputString, parseInrToMinor } from "@/lib/money";
import { validateInrAmount, isQuoteExpired } from "@/lib/payment-validation";
import { COPY } from "@/config/mode";
import type { PaymentPrivacy, UpiRecipient } from "@/types/domain";
import { Container } from "@/components/layout/Container";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { FormField, InlineError, Input, Segmented, Textarea } from "@/components/ui/Field";
import { Stepper } from "@/components/ui/Timeline";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { CameraScanner, decodeQrFromFile } from "@/components/payments/QRScanner";
import { CurrencyInput } from "@/components/payments/CurrencyInput";
import { PrivacyChoice, QuoteCard } from "@/components/payments/Quote";
import { useQuotePreview } from "@/components/payments/useQuotePreview";

type Tab = "camera" | "upload" | "paste" | "manual";
const SAMPLE_PAYLOAD = "upi://pay?pa=urbanroast@upi&pn=Urban%20Roast&am=250.00&cu=INR";

export function ScanSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const labels = ["Recipient", "Amount & quote", "Pay ZEC", "Track payout"];
  return (
    <Stepper
      label="Scan & Pay steps"
      steps={labels.map((l, i) => ({
        key: l,
        label: `${i + 1}. ${l}`,
        state: i + 1 < current ? "done" : i + 1 === current ? "current" : "upcoming",
      }))}
    />
  );
}

export function ScanPayWizard() {
  const router = useRouter();
  const { services, canTransact, isDemo } = useZeb();
  const now = useNow(1000);
  const { run, busy } = useAction();

  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<Tab>("camera");
  const [paste, setPaste] = useState("");
  const [manualVpa, setManualVpa] = useState("");
  const [manualName, setManualName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recipient, setRecipient] = useState<(UpiRecipient & { hasMerchantParams?: boolean }) | null>(null);

  const [amountText, setAmountText] = useState("");
  const [privacy, setPrivacy] = useState<PaymentPrivacy>("shielded");
  const [amountTouched, setAmountTouched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const amountMinor = parseInrToMinor(amountText);
  const amountError = amountText === "" && !amountTouched ? null : amountMinor === null && amountText !== "" ? "Enter a valid amount (up to 2 decimals)." : validateInrAmount(amountMinor);
  const validAmount = amountMinor !== null && validateInrAmount(amountMinor) === null ? amountMinor : null;
  const { quote, error: quoteError, refresh, unavailable } = useQuotePreview(step === 2 ? validAmount : null, privacy);
  const quoteExpired = quote && now !== null ? isQuoteExpired(quote, now) : false;

  const accept = (text: string, source: UpiRecipient["source"]) => {
    const r = parseUpiPayload(text);
    if (!r.ok) {
      setParseError(r.error);
      setRecipient(null);
      return;
    }
    setParseError(null);
    setRecipient({ vpa: r.value.vpa, payeeName: r.value.payeeName, requestedInrMinor: r.value.amountMinor, note: r.value.note, source, hasMerchantParams: r.value.hasMerchantParams });
    if (r.value.amountMinor) setAmountText(minorToInputString(r.value.amountMinor));
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setParseError(null);
    try {
      const text = await decodeQrFromFile(file);
      accept(text, "qr_upload");
    } catch (e) {
      setParseError((e as Error).message);
      setRecipient(null);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const manualError = manualVpa ? validateVpa(manualVpa) : null;

  const submit = async () => {
    if (!services || !recipient || !validAmount) return;
    const r = await run(() =>
      services.zcash.createPaymentIntent({
        mode: "scan_pay",
        inrMinor: validAmount,
        privacy,
        recipient: { vpa: recipient.vpa, payeeName: recipient.payeeName, source: recipient.source, requestedInrMinor: recipient.requestedInrMinor, note: recipient.note },
      }),
    );
    if (r.ok) router.push(`/scan/${r.value.id}`);
  };

  const summary = useMemo(
    () => (
      <div className="space-y-4">
        <ScanSteps current={step} />
        {recipient && (
          <div className="border-t border-border pt-4 text-[13px]">
            <p className="text-label text-foreground-secondary">Paying</p>
            <p className="mt-0.5 break-all font-mono text-foreground">{recipient.vpa}</p>
            {recipient.payeeName && <p className="text-foreground-secondary">{recipient.payeeName} · From QR</p>}
            {validAmount && <p className="num mt-2 font-display text-[20px] font-semibold">{formatInr(validAmount)}</p>}
          </div>
        )}
        <p className="border-t border-border pt-4 text-micro leading-relaxed text-foreground-muted">
          The receiver doesn&apos;t need a Zeb Scan account. Scanning a QR does not move any money by itself.
        </p>
      </div>
    ),
    [step, recipient, validAmount],
  );

  return (
    <Container className="py-8 sm:py-12">
      <div className="mb-6">
        <p className="eyebrow text-accent">Scan &amp; Pay</p>
        <h1 className="mt-2 font-display text-[28px] font-semibold tracking-[-0.03em] sm:text-[34px]">Pay a UPI QR with ZEC</h1>
        <p className="mt-1.5 max-w-xl text-[15px] text-foreground-secondary">No sign-in needed. Confirm who you&apos;re paying, lock a quote, then send ZEC.</p>
      </div>

      {!canTransact && <NotConnectedNotice className="mb-6" />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="panel min-w-0 p-4 sm:p-6">
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-[17px] font-semibold">1. Who are you paying?</h2>
                <p className="mt-0.5 text-[13px] text-foreground-secondary">Scan, upload or paste a UPI QR — or type a UPI ID.</p>
              </div>
              <Segmented<Tab>
                label="Recipient input method"
                role="tabs"
                fullWidth
                value={tab}
                onChange={(t) => {
                  setTab(t);
                  setParseError(null);
                }}
                options={[
                  { value: "camera", label: <><Camera aria-hidden className="h-4 w-4" /> Scan</> },
                  { value: "upload", label: <><ImageUp aria-hidden className="h-4 w-4" /> Upload</> },
                  { value: "paste", label: <><ClipboardPaste aria-hidden className="h-4 w-4" /> Paste</> },
                  { value: "manual", label: <><Keyboard aria-hidden className="h-4 w-4" /> UPI ID</> },
                ]}
              />

              <div role="tabpanel" aria-label={tab}>
                {tab === "camera" && <CameraScanner onResult={(t) => accept(t, "qr_camera")} onUseFallback={() => setTab("upload")} />}
                {tab === "upload" && (
                  <div className="space-y-3">
                    <label className="flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-border-strong bg-surface-2 p-6 text-center hover:border-accent">
                      {uploading ? <Loader2 aria-hidden className="h-6 w-6 animate-spin text-foreground-secondary" /> : <ImageUp aria-hidden className="h-6 w-6 text-foreground-secondary" />}
                      <span className="text-[14px] font-medium">{uploading ? "Reading QR…" : "Choose a QR image"}</span>
                      <span className="text-label text-foreground-secondary">PNG, JPG or WebP · processed locally in your browser</span>
                      <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={(e) => onUpload(e.target.files?.[0])} />
                    </label>
                  </div>
                )}
                {tab === "paste" && (
                  <div className="space-y-3">
                    <FormField label="QR data" hint="Paste the text inside a UPI QR. It starts with upi://pay?">
                      {(p) => <Textarea {...p} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="upi://pay?pa=…&pn=…&am=…&cu=INR" className="font-mono text-[13px]" maxLength={2000} />}
                    </FormField>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => accept(paste, "qr_paste")} disabled={!paste.trim()}>
                        Read QR data
                      </Button>
                      {isDemo && (
                        <Button variant="ghost" onClick={() => setPaste(SAMPLE_PAYLOAD)}>
                          Load test UPI QR
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {tab === "manual" && (
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (validateVpa(manualVpa)) return;
                      setRecipient({ vpa: manualVpa.trim(), payeeName: manualName.trim() || undefined, source: "manual" });
                      setParseError(null);
                    }}
                  >
                    <FormField label="Receiver UPI ID" error={manualError}>
                      {(p) => <Input {...p} value={manualVpa} onChange={(e) => setManualVpa(e.target.value)} placeholder="name@handle" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono" />}
                    </FormField>
                    <FormField label="Receiver name (for your reference)" optional hint="Shown only to you. Not verified with the bank.">
                      {(p) => <Input {...p} value={manualName} onChange={(e) => setManualName(e.target.value)} maxLength={60} />}
                    </FormField>
                    <Button type="submit" disabled={!manualVpa || Boolean(manualError)}>
                      Use this UPI ID
                    </Button>
                  </form>
                )}
              </div>

              {parseError && (
                <Callout tone="danger" title="Can't use this QR">
                  {parseError} Nothing has been filled in. Try another QR, or enter the UPI ID manually.
                </Callout>
              )}

              {recipient && (
                <div className="rounded-panel border border-gold/50 bg-gold/[0.06] p-4">
                  <p className="eyebrow">Check the receiver</p>
                  <div className="mt-2 flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3">
                      <UserRound aria-hidden className="h-5 w-5 text-foreground-secondary" />
                    </span>
                    <div className="min-w-0">
                      <p className="break-all font-mono text-[15px] font-medium text-foreground">{recipient.vpa}</p>
                      {recipient.payeeName && (
                        <p className="text-[13px] text-foreground-secondary">
                          {recipient.payeeName} <span className="text-micro text-foreground-muted">· {recipient.source === "manual" ? "entered by you" : "From QR — not independently verified"}</span>
                        </p>
                      )}
                      {recipient.requestedInrMinor && <p className="text-[13px] text-foreground-secondary">QR requests {formatInr(recipient.requestedInrMinor)}</p>}
                    </div>
                  </div>
                  {recipient.hasMerchantParams && (
                    <p className="mt-3 flex items-start gap-1.5 text-label text-warning">
                      <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
                      This looks like a merchant dynamic QR. Some of these aren&apos;t supported — the payout provider may be unable to complete it.
                    </p>
                  )}
                  <p className="mt-3 text-micro text-foreground-muted">INR will be sent to this UPI ID by a payout provider. Make sure it&apos;s right — payouts can&apos;t be redirected.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button onClick={() => setStep(2)}>
                      Continue <ArrowRight aria-hidden className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" onClick={() => setRecipient(null)}>
                      Choose a different receiver
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && recipient && (
            <div className="space-y-5">
              <div>
                <button type="button" onClick={() => setStep(1)} className="mb-2 inline-flex min-h-[44px] items-center gap-1 text-label text-foreground-secondary hover:text-foreground">
                  <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> Back to recipient
                </button>
                <h2 className="text-[17px] font-semibold">2. How much INR should they receive?</h2>
              </div>
              <FormField
                label="Amount the receiver gets"
                error={amountError}
                hint={`Allowed range: ${formatInr(100, { whole: true })} – ₹10,000 per payment.`}
              >
                {(p) => <CurrencyInput {...p} value={amountText} onChange={setAmountText} onBlur={() => setAmountTouched(true)} />}
              </FormField>
              {recipient.requestedInrMinor && validAmount !== null && validAmount !== recipient.requestedInrMinor && (
                <Callout tone="warning">
                  The QR asked for {formatInr(recipient.requestedInrMinor)}. You changed it to {formatInr(validAmount)} — the receiver may expect the original amount.
                </Callout>
              )}
              <PrivacyChoice value={privacy} onChange={setPrivacy} />

              {unavailable ? (
                <div className="rounded-panel border border-border p-4 text-[13px]">
                  <p className="font-medium">Live quote unavailable</p>
                  <p className="mt-0.5 text-foreground-secondary">{COPY.notConnected} No rate adapter is configured, so no quote can be shown.</p>
                </div>
              ) : quoteError && !quote ? (
                <div role="alert" className="rounded-panel border border-warning/40 bg-warning/[0.07] p-4 text-[13px]">
                  <p className="font-medium">Live quote unavailable</p>
                  <p className="mt-0.5 text-foreground-secondary">{quoteError}</p>
                  <Button size="sm" variant="secondary" className="mt-2" onClick={refresh}>
                    <RefreshCcw aria-hidden className="h-4 w-4" /> Retry
                  </Button>
                </div>
              ) : quote ? (
                <QuoteCard quote={quote} now={now} />
              ) : (
                validAmount && <div className="h-40 animate-pulse rounded-panel bg-surface-2" aria-label="Loading quote" />
              )}

              {quoteExpired && (
                <InlineError>This preview quote expired. Refresh it to continue.</InlineError>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                {quoteExpired ? (
                  <Button onClick={refresh}>
                    <RefreshCcw aria-hidden className="h-4 w-4" /> Refresh quote
                  </Button>
                ) : (
                  <Button onClick={submit} isLoading={busy} disabled={!canTransact || !validAmount || !quote}>
                    Lock quote &amp; continue <ArrowRight aria-hidden className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {isDemo && <p className="text-micro text-foreground-muted">{COPY.simulation}</p>}
            </div>
          )}
        </div>

        <aside className="panel h-fit p-5 lg:sticky lg:top-24" aria-label="Progress summary">
          {summary}
        </aside>
      </div>
    </Container>
  );
}
