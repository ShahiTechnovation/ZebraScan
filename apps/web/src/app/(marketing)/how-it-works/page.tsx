import type { Metadata } from "next";
import React from "react";
import { ArrowRight, Eye, EyeOff, Link2, QrCode, ScanLine } from "lucide-react";
import { Container } from "@/components/layout/Container";
import { ButtonLink } from "@/components/ui/Button";
import { Section, SectionIntro } from "@/components/marketing/Primitives";
import { demoConfig } from "@/config/demo";

export const metadata: Metadata = {
  title: "How it works",
  description: "How Scan & Pay, the merchant QR terminal and payment links work, and how the ZEC Vault and USDC Treasury settle INR.",
};

const MODES = [
  {
    id: "scan-pay",
    icon: ScanLine,
    title: "Scan & Pay",
    who: "For anyone paying a UPI QR. The receiver doesn't need a Zeb Scan account.",
    stages: [
      ["Read the QR", "Scan, upload or paste a upi://pay QR, or type a UPI ID. You confirm the receiver before anything else."],
      ["Lock a quote", "Enter INR. See fees, the exact ZEC due and the quote expiry (90 seconds)."],
      ["Pay ZEC", "Send to a unique receiving address. Our wallet detects the deposit by scanning, then waits for confirmations."],
      ["INR payout", "A P2P PAY order funded by our USDC treasury is placed. A liquidity provider sends INR to the UPI receiver."],
    ],
    outcomes: ["Completed — provider confirmed the INR transfer", "Failed — retried with another provider, or ZEC refunded", "Disputed — held for review"],
    cta: { href: "/scan", label: "Try Scan & Pay" },
  },
  {
    id: "merchant-qr",
    icon: QrCode,
    title: "Merchant QR Terminal & Counter QR",
    who: "For shops that onboard. Charge a fixed INR amount, or let customers enter one from a printed Counter QR.",
    stages: [
      ["Enter the amount", "At the counter, type ₹500 and create a checkout with a locked quote."],
      ["Customer pays ZEC", "The QR is unique to this sale. A Counter QR opens your checkout page and makes a fresh address each time."],
      ["Verified & credited", "Once verified, your dashboard shows an INR-denominated credit: Pending → Locked → Available after cooldown."],
      ["Withdraw", "Request a withdrawal. A P2P SELL order sends INR to your registered UPI-linked account when a provider completes it."],
    ],
    outcomes: ["Credit locked during cooldown", "Available to withdraw after cooldown", "Underpaid, overpaid or late payments held for refund — no credit"],
    cta: { href: "/login?next=/app/terminal", label: "Open the terminal demo" },
  },
  {
    id: "payment-links",
    icon: Link2,
    title: "Payment Links",
    who: "For merchants selling online, by chat or by invoice.",
    stages: [
      ["Create a link", "Fixed price or a customer-chosen amount within limits. One-time or reusable, with optional expiry and use cap."],
      ["Customer checks out", "No sign-in. They see your name and exact INR terms, then get a fresh quote and unique address."],
      ["Only confirmed payments count", "Opening the link or abandoning a checkout never uses up a one-time link."],
      ["Same settlement", "Credits follow the same cooldown and withdrawal path as the terminal."],
    ],
    outcomes: ["Active", "Exhausted — use limit reached by confirmed payments", "Expired or revoked — no new checkouts"],
    cta: { href: "/login?next=/app/links/new", label: "Create a demo link" },
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <Container className="py-14 sm:py-20">
        <p className="eyebrow text-accent">How it works</p>
        <h1 className="mt-3 max-w-3xl font-display text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[44px]">
          Three ways to pay or get paid. One honest settlement path.
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-foreground-secondary">
          Every Zeb Scan payment starts in ZEC and ends in INR. What happens in between depends on whether you&apos;re paying a UPI QR directly or a merchant is
          collecting through their own checkout.
        </p>
        <nav aria-label="Jump to mode" className="mt-8 flex flex-wrap gap-2">
          {MODES.map((m) => (
            <a key={m.id} href={`#${m.id}`} className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-surface-1 px-4 text-[14px] hover:border-border-strong">
              <m.icon aria-hidden className="h-4 w-4 text-accent" />
              {m.title}
            </a>
          ))}
        </nav>
      </Container>

      {MODES.map((m, idx) => (
        <Section key={m.id} id={m.id} className={idx % 2 === 0 ? "bg-surface-1" : undefined}>
          <div className="grid gap-10 lg:grid-cols-[1fr_1.5fr]">
            <div>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gold/15 text-accent">
                <m.icon aria-hidden className="h-5 w-5" />
              </span>
              <h2 className="mt-4 font-display text-[28px] font-semibold tracking-[-0.03em]">{m.title}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{m.who}</p>
              <h3 className="mt-6 text-label font-semibold uppercase tracking-[0.06em] text-foreground-secondary">Possible outcomes</h3>
              <ul className="mt-2 space-y-1.5">
                {m.outcomes.map((o) => (
                  <li key={o} className="flex gap-2 text-[14px] text-foreground-secondary">
                    <span aria-hidden className="mt-2 h-1 w-1 shrink-0 bg-foreground-muted" />
                    {o}
                  </li>
                ))}
              </ul>
              <ButtonLink href={m.cta.href} variant="outline" className="mt-6">
                {m.cta.label} <ArrowRight aria-hidden className="h-4 w-4" />
              </ButtonLink>
            </div>
            <ol className="grid gap-px overflow-hidden rounded-panel border border-border bg-border sm:grid-cols-2">
              {m.stages.map(([t, b], i) => (
                <li key={t} className="bg-background p-5">
                  <p className="font-mono text-label text-accent">Stage {i + 1}</p>
                  <h3 className="mt-2 text-[16px] font-semibold">{t}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-foreground-secondary">{b}</p>
                </li>
              ))}
            </ol>
          </div>
        </Section>
      ))}

      <Section id="privacy">
        <SectionIntro eyebrow="Shielded vs transparent" title="Choose shielded whenever your wallet allows it." />
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-panel border border-border bg-surface-1 p-6">
            <EyeOff aria-hidden className="h-5 w-5 text-success" />
            <h3 className="mt-3 text-[17px] font-semibold">Shielded</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">
              Sender, receiver and amount are hidden from public chain observers. Our receiving wallet verifies the payment using its own viewing capability — a public
              explorer can&apos;t, and that&apos;s by design.
            </p>
          </div>
          <div className="rounded-panel border border-border bg-surface-1 p-6">
            <Eye aria-hidden className="h-5 w-5 text-warning" />
            <h3 className="mt-3 text-[17px] font-semibold">Transparent</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">
              Works with more wallets, but the amount and addresses are publicly visible on-chain. You&apos;ll see a warning before paying this way.
            </p>
          </div>
        </div>
        <p className="mt-5 text-[14px] text-foreground-secondary">
          Either way, the INR payout happens in the banking system: payout providers and banks see the transfer details they need.
        </p>
      </Section>

      <Section id="risk" className="bg-surface-1">
        <SectionIntro
          eyebrow="Waiting, cooldowns and balances"
          title="What takes time, and why."
          description="Being clear about timing and liabilities matters more than looking instant."
        />
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            ["Payout waiting", "A Scan & Pay payout waits for ZEC confirmations, then for a liquidity provider to accept and complete the INR transfer. It isn't complete until the provider confirms."],
            [
              "Merchant cooldown",
              `New merchant credits are locked before they can be withdrawn. This demo uses an example ${demoConfig.cooldownDays}-day policy — not a live contractual promise.`,
            ],
            ["Balances are liabilities", "A merchant's balance is an INR-denominated amount Zeb Scan owes. It is not a bank deposit. A live service must back it with reserved liquidity."],
          ].map(([t, b]) => (
            <div key={t} className="rounded-panel border border-border bg-background p-5">
              <h3 className="text-[16px] font-semibold">{t}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">{b}</p>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
