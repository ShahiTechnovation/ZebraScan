"use client";

import React from "react";
import { EyeOff, Eye, Timer, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCountdown } from "@/lib/format";
import { formatInr, formatUsdc, formatZec } from "@/lib/money";
import type { PaymentPrivacy, PaymentQuote } from "@/types/domain";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { COPY } from "@/config/mode";

export function SourceBadge({ source }: { source: "demo" | "live" }) {
  return source === "demo" ? (
    <StatusBadge tone="accent">Demo rate</StatusBadge>
  ) : (
    <StatusBadge tone="success">Live rate</StatusBadge>
  );
}

export function RateExpiry({ expiresAt, now, className }: { expiresAt: number; now: number | null; className?: string }) {
  if (now === null) return null;
  const left = expiresAt - now;
  const expired = left <= 0;
  return (
    <span
      className={cn("num inline-flex items-center gap-1.5 font-mono text-label", expired ? "text-danger" : left < 20_000 ? "text-warning" : "text-foreground-secondary", className)}
      aria-live={left < 20_000 ? "polite" : "off"}
    >
      <Timer aria-hidden className="h-3.5 w-3.5" />
      {expired ? "Quote expired" : `Quote valid ${formatCountdown(left)}`}
    </span>
  );
}

export function PrivacyBadge({ privacy }: { privacy: PaymentPrivacy }) {
  return privacy === "shielded" ? (
    <StatusBadge tone="success" icon={EyeOff}>
      Shielded
    </StatusBadge>
  ) : (
    <StatusBadge tone="warning" icon={Eye}>
      Transparent
    </StatusBadge>
  );
}

export function PrivacyChoice({
  value,
  onChange,
  allowTransparent = true,
  disabled,
}: {
  value: PaymentPrivacy;
  onChange: (p: PaymentPrivacy) => void;
  allowTransparent?: boolean;
  disabled?: boolean;
}) {
  const opts: Array<{ v: PaymentPrivacy; title: string; body: string; icon: typeof EyeOff }> = [
    { v: "shielded", title: "Shielded (recommended)", body: "Hides amount and addresses from public chain observers.", icon: EyeOff },
    { v: "transparent", title: "Transparent", body: "Amount and addresses are publicly visible on the Zcash chain.", icon: Eye },
  ];
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1.5 text-label font-medium text-foreground-secondary">Privacy mode</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {opts.map((o) => {
          const unavailable = o.v === "transparent" && !allowTransparent;
          const checked = value === o.v;
          return (
            <label
              key={o.v}
              className={cn(
                "flex min-h-[44px] cursor-pointer gap-2.5 rounded-panel border p-3 transition-colors",
                checked ? "border-gold bg-gold/[0.07]" : "border-border hover:border-border-strong",
                unavailable && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                name="privacy"
                className="mt-1 accent-[#E6B84B]"
                checked={checked}
                disabled={unavailable}
                onChange={() => onChange(o.v)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <o.icon aria-hidden className="h-3.5 w-3.5" />
                  {o.title}
                </span>
                <span className="mt-0.5 block text-label text-foreground-secondary">{unavailable ? "Not accepted by this merchant." : o.body}</span>
              </span>
            </label>
          );
        })}
      </div>
      {value === "transparent" && (
        <p role="alert" className="flex items-start gap-1.5 text-label text-warning">
          <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          Transparent ZEC exposes the payment amount and addresses publicly on-chain. Choose shielded unless your wallet can't send it.
        </p>
      )}
      <p className="text-micro leading-relaxed text-foreground-muted">{COPY.privacyHelper}</p>
    </fieldset>
  );
}

/** Full quote breakdown. Fees reconcile: total = amount + protocol + platform. */
export function QuoteCard({
  quote,
  now,
  recipientLabel = "Recipient gets",
  className,
}: {
  quote: PaymentQuote;
  now: number | null;
  recipientLabel?: string;
  className?: string;
}) {
  const rows: Array<[string, React.ReactNode]> = [
    [recipientLabel, formatInr(quote.inrMinor)],
    [`Protocol fee (${quote.protocolFeeBps / 100}%)`, formatInr(quote.protocolFeeInrMinor)],
    [`Platform fee (${quote.platformFeeBps / 100}%)`, formatInr(quote.platformFeeInrMinor)],
  ];
  return (
    <div className={cn("rounded-panel border border-border bg-surface-1", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-[13px] font-semibold text-foreground">Payment quote</p>
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={quote.source} />
          <PrivacyBadge privacy={quote.privacy} />
        </div>
      </div>
      <dl className="space-y-2 px-4 py-3 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-foreground-secondary">{k}</dt>
            <dd className="num text-foreground">{v}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t border-border pt-2">
          <dt className="font-medium text-foreground">Total in INR</dt>
          <dd className="num font-medium text-foreground">{formatInr(quote.totalInrMinor)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-foreground-secondary">Treasury settlement (USDC on Base)</dt>
          <dd className="num font-mono text-foreground-secondary">{formatUsdc(quote.usdcMicro)} USDC</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 rounded-input bg-surface-2 px-3 py-2.5">
          <dt className="font-semibold text-foreground">You pay</dt>
          <dd className="num font-mono text-[17px] font-semibold text-foreground">{formatZec(quote.zecZat, { fixed: true })} ZEC</dd>
        </div>
      </dl>
      <div className="space-y-1 border-t border-border px-4 py-2.5 text-micro text-foreground-muted">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            1 ZEC = ${(quote.usdMicroPerZec / 1e6).toFixed(2)} · 1 USDC = {formatInr(quote.inrPerUsdcMinor)} · {quote.provider}
          </span>
          <RateExpiry expiresAt={quote.expiresAt} now={now} />
        </div>
        {quote.source === "demo" && <p className="font-medium text-accent">{COPY.illustrative}</p>}
      </div>
    </div>
  );
}
