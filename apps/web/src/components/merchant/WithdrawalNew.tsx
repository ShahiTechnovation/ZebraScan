"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Ban } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { useMerchantData } from "@/lib/selectors";
import { formatInr, formatUsdc, minorToInputString, parseInrToMinor } from "@/lib/money";
import { withdrawalBlockReason, withdrawalQuote } from "@/services/demo/engine";
import { demoConfig } from "@/config/demo";
import { COPY } from "@/config/mode";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { NotConnectedNotice } from "@/components/layout/ModeBanner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout, DataList } from "@/components/ui/Blocks";
import { FormField, InlineError } from "@/components/ui/Field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { CurrencyInput } from "@/components/payments/CurrencyInput";

export function WithdrawalNew() {
  const router = useRouter();
  const { state, services, canTransact, isDemo, live } = useZeb();
  const { merchant, balance } = useMerchantData();
  const { run, busy } = useAction();
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState("");
  const [ack, setAck] = useState(false);
  const [showAck, setShowAck] = useState(false);
  if (!merchant) return null;

  // Connected mode: payout destination status comes from the server (masked VPA, review state).
  const liveOpts = live
    ? { payoutProblem: !merchant.payoutUpi ? "Add a payout UPI ID in Settings first." : merchant.payoutUpi.includes("(") ? "Your payout UPI ID is still under review or cooling off." : null }
    : undefined;
  const general = withdrawalBlockReason(state, merchant.id, null, liveOpts);
  const minor = parseInrToMinor(text);
  const amountError = text ? (minor === null ? "Enter a valid amount." : withdrawalBlockReason(state, merchant.id, minor, liveOpts)) : null;
  const q = minor && !amountError ? withdrawalQuote(minor) : null;
  const blocked = !canTransact || Boolean(general);

  const submit = async () => {
    if (!ack) return setShowAck(true);
    if (!services || !minor) return;
    const r = await run(() => services.merchant.requestWithdrawal(merchant.id, minor), "Withdrawal requested — finding a payout provider");
    if (r.ok) router.push(`/app/withdrawals/${r.value.id}`);
  };

  return (
    <>
      <MerchantPageHeader back={{ href: "/app/withdrawals", label: "Withdrawals" }} title="New withdrawal" description="Withdraw available INR credit to your registered UPI-linked account." />
      {!canTransact && <NotConnectedNotice className="mb-6" />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel>
          {general ? (
            <PanelBody>
              <Callout tone="warning" icon={Ban} title="Withdrawal unavailable" action={
                <>
                  <ButtonLink href="/app/settlements" variant="secondary" size="sm">View cooldown schedule</ButtonLink>
                  <ButtonLink href="/app/withdrawals" variant="ghost" size="sm">See withdrawals</ButtonLink>
                </>
              }>
                {general}
              </Callout>
            </PanelBody>
          ) : step === 1 ? (
            <>
              <PanelHeader title="1. Amount" description={`Available to withdraw: ${formatInr(balance.available)}`} />
              <PanelBody className="space-y-4">
                <FormField label="Withdrawal amount (INR)" error={amountError} hint={`Minimum ${formatInr(demoConfig.withdrawal.minInrMinor, { whole: true })} (demo policy). Locked credits can't be withdrawn.`}>
                  {(p) => <CurrencyInput {...p} value={text} onChange={setText} />}
                </FormField>
                <Button variant="secondary" size="sm" onClick={() => setText(minorToInputString(balance.available))}>
                  Withdraw all available ({formatInr(balance.available)})
                </Button>
                {q && (
                  <div className="rounded-panel border border-border">
                    <DataList
                      className="px-4"
                      items={[
                        { label: "Debited from available balance", value: formatInr(minor!) },
                        { label: `Payout fee & spread (${demoConfig.withdrawal.spreadBps / 100}%)`, value: `−${formatInr(q.feeInrMinor)}` },
                        { label: "Estimated INR to your account", value: <strong>{formatInr(q.payoutInrMinor)}</strong> },
                        { label: "Treasury USDC sold (Base)", value: `${formatUsdc(q.usdcMicro)} USDC`, hint: isDemo ? COPY.illustrative : undefined },
                      ]}
                    />
                  </div>
                )}
                <div className="flex justify-end">
                  <Button onClick={() => setStep(2)} disabled={!q}>
                    Review <ArrowRight aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
              </PanelBody>
            </>
          ) : (
            <>
              <PanelHeader title="2. Review & confirm" />
              <PanelBody className="space-y-4">
                <DataList
                  items={[
                    { label: "Amount", value: formatInr(minor!) },
                    { label: "Estimated payout", value: formatInr(q!.payoutInrMinor) },
                    { label: "Payout UPI ID", value: <span className="font-mono">{merchant.payoutUpi}</span> },
                    { label: "Beneficiary", value: merchant.beneficiaryName },
                    { label: "Route", value: "P2P SELL order · USDC on Base → INR via UPI" },
                  ]}
                />
                <p className="text-label text-foreground-secondary">
                  Wrong UPI ID? <Link href="/app/settings?tab=payout" className="link">Update it in Settings</Link> first — payouts can&apos;t be redirected once sent.
                </p>
                <Callout tone="warning" title="Before you confirm">
                  A payout provider must accept and complete this order. It isn&apos;t guaranteed instant, the final INR can differ slightly from the estimate, and the
                  amount stays reserved until the payout completes or is recovered. No bank validation of the UPI ID happens in this build.
                </Callout>
                <label className="flex min-h-[44px] items-start gap-2.5 text-[13px] text-foreground-secondary">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[#E6B84B]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>I&apos;ve checked the UPI ID and understand payout timing isn&apos;t guaranteed.</span>
                </label>
                {showAck && !ack && <InlineError>Please confirm before requesting the withdrawal.</InlineError>}
                <div className="flex flex-col-reverse justify-between gap-2 sm:flex-row">
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    <ArrowLeft aria-hidden className="h-4 w-4" /> Back
                  </Button>
                  <Button onClick={submit} isLoading={busy} disabled={blocked}>
                    {isDemo ? "Request demo withdrawal" : "Request withdrawal"}
                  </Button>
                </div>
              </PanelBody>
            </>
          )}
        </Panel>
        <Panel className="h-fit">
          <PanelHeader title="Your balance" />
          <PanelBody>
            <DataList
              items={[
                { label: "Available", value: formatInr(balance.available) },
                { label: "Locked (cooldown)", value: formatInr(balance.locked) },
                { label: "Already reserved", value: formatInr(balance.reserved) },
              ]}
            />
            <p className="mt-3 text-micro text-foreground-muted">{COPY.balanceDescriptor} · {COPY.balanceSub}</p>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
