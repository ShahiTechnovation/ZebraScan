import React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  Check,
  CircleDashed,
  EyeOff,
  Landmark,
  Link2,
  QrCode,
  ScanLine,
  ShieldCheck,
  Store,
  Vault,
} from "lucide-react";
import { Container } from "@/components/layout/Container";
import { ButtonLink } from "@/components/ui/Button";
import { FaqList, IllustrativeTag, Section, SectionIntro } from "@/components/marketing/Primitives";
import { FAQ } from "@/content/faq";
import { ZebMark } from "@/components/brand/ZebLogo";

function HeroCard() {
  const steps = [
    { label: "ZEC payment verified", state: "done" },
    { label: "Order accepted by payout provider", state: "done" },
    { label: "INR processing", state: "current" },
    { label: "Payout completed", state: "upcoming" },
  ] as const;
  return (
    <div className="relative mx-auto w-full max-w-[420px]">
      <div className="mb-3 flex justify-end">
        <IllustrativeTag />
      </div>
      <div className="rounded-overlay border border-border bg-surface-1 shadow-[0_24px_60px_-32px_rgba(17,23,25,0.35)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 font-semibold">Z</span>
            <div>
              <p className="text-[14px] font-medium">Urban Roast</p>
              <p className="font-mono text-micro text-foreground-muted">merchant@urbanroast.in</p>
            </div>
          </div>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-micro text-foreground-secondary">From QR</span>
        </div>
        <div className="px-5 py-5">
          <p className="eyebrow">Enter ₹</p>
          <p className="num mt-1 font-display text-[40px] font-semibold leading-none tracking-[-0.03em]">₹500.00</p>
          <dl className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-foreground-secondary">Fees (1.5%)</dt>
              <dd className="num">₹7.50</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-foreground-secondary">Quote valid</dt>
              <dd className="num font-mono">1:24</dd>
            </div>
            <div className="flex items-baseline justify-between rounded-input bg-surface-2 px-3 py-2.5">
              <dt className="font-medium">You pay</dt>
              <dd className="num font-mono text-[16px] font-semibold">0.12530865 ZEC</dd>
            </div>
          </dl>
        </div>
        <div className="border-t border-border px-5 py-4">
          <ol className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-2.5 text-[13px]">
                {s.state === "done" ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success">
                    <Check aria-hidden className="h-3 w-3" />
                  </span>
                ) : s.state === "current" ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-progress/15 text-progress">
                    <CircleDashed aria-hidden className="h-3 w-3" />
                  </span>
                ) : (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-strong" />
                )}
                <span className={s.state === "upcoming" ? "text-foreground-secondary" : "text-foreground"}>{s.label}</span>
                <span className="sr-only">{s.state === "done" ? "done" : s.state === "current" ? "in progress" : "not started"}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="mt-3 text-center text-micro text-foreground-muted">Real-time oracle exchange rate with dynamic slippage buffer.</p>
    </div>
  );
}

const PRODUCTS = [
  {
    icon: ScanLine,
    title: "Scan & Pay",
    body: "Scan an ordinary supported UPI QR and pay with ZEC. The receiver gets INR from a payout provider — no Zeb Scan account needed on their side.",
    cta: { label: "Try Scan & Pay", href: "/scan" },
  },
  {
    icon: QrCode,
    title: "Merchant QR",
    body: "Enter a fixed INR amount at the counter and show a one-time ZEC QR. Or print a reusable Counter QR that opens your own checkout page.",
    cta: { label: "Open the terminal", href: "/login?next=/app/terminal" },
  },
  {
    icon: Link2,
    title: "Payment Links",
    body: "Share a link for a fixed price or a customer-chosen amount. Payers check out without signing in; every visit gets its own quote and address.",
    cta: { label: "Create payment link", href: "/login?next=/app/links/new" },
  },
];

const STEPS = [
  { n: "01", title: "Enter INR", body: "Start from the rupee amount the receiver or merchant expects." },
  { n: "02", title: "Get ZEC quote", body: "See fees, the exact ZEC due and how long the quote is valid." },
  { n: "03", title: "Pay ZEC", body: "Send to a unique address — shielded is recommended." },
  { n: "04", title: "Confirm & settle", body: "After verification, INR is paid out or credited to the merchant." },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1.1fr_1fr] lg:py-24">
          <div>
            <p className="eyebrow text-accent">Zcash-powered local payments</p>
            <h1 className="mt-4 font-display text-[40px] font-semibold leading-[1.02] tracking-[-0.04em] text-foreground sm:text-[56px] lg:text-[64px]">
              Pay in ZEC.
              <br />
              They get INR.
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-foreground-secondary sm:text-[17px]">
              Scan a supported UPI QR or collect ZEC through your own checkout. Zeb Scan connects Zcash payments to local settlement experiences.
            </p>
            <div className="mt-8 flex flex-col gap-3 xs:flex-row">
              <ButtonLink href="/scan" size="lg">
                <ScanLine aria-hidden className="h-4 w-4" />
                Scan &amp; Pay
              </ButtonLink>
              <ButtonLink href="/login" variant="outline" size="lg">
                Start accepting ZEC
                <ArrowRight aria-hidden className="h-4 w-4" />
              </ButtonLink>
            </div>
            <p className="mt-5 text-label text-foreground-muted">Shielded Zcash Point-of-Sale with automated INR settlement</p>
          </div>
          <HeroCard />
        </Container>
      </section>

      {/* Products */}
      <Section id="products">
        <SectionIntro eyebrow="Three ways to use Zeb Scan" title="One payer flow. Two merchant tools." description="Pay any supported UPI QR directly, or give your shop a ZEC checkout that settles into an INR-denominated balance." />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {PRODUCTS.map((p) => (
            <article key={p.title} className="flex flex-col rounded-panel border border-border bg-surface-1 p-6">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gold/15 text-accent">
                <p.icon aria-hidden className="h-5 w-5" />
              </span>
              <h3 className="mt-5 font-display text-[20px] font-semibold tracking-[-0.02em]">{p.title}</h3>
              <p className="mt-2 flex-1 text-[14px] leading-relaxed text-foreground-secondary">{p.body}</p>
              <Link href={p.cta.href} className="mt-5 inline-flex min-h-[44px] items-center gap-1.5 text-[14px] font-medium text-accent hover:underline">
                {p.cta.label} <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            </article>
          ))}
        </div>
      </Section>

      {/* Process */}
      <Section id="process" className="bg-surface-1">
        <SectionIntro eyebrow="How a payment moves" title="Four steps, each one visible." />
        <ol className="mt-10 grid gap-px overflow-hidden rounded-panel border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative bg-background p-6">
              <p className="font-mono text-label text-accent">{s.n}</p>
              <h3 className="mt-3 text-[17px] font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">{s.body}</p>
              {i < STEPS.length - 1 && <ArrowRight aria-hidden className="absolute right-4 top-6 hidden h-4 w-4 text-foreground-muted lg:block" />}
            </li>
          ))}
        </ol>
      </Section>

      {/* Privacy */}
      <Section id="privacy">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <SectionIntro
            eyebrow="Privacy, stated plainly"
            title="Private on-chain. Honest about the bank side."
            description="Shielded ZEC protects on-chain payment details. Fiat payout providers may still see banking information."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-panel border border-border bg-surface-1 p-5">
              <EyeOff aria-hidden className="h-5 w-5 text-success" />
              <h3 className="mt-3 text-[15px] font-semibold">Hidden from public observers</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">
                A shielded Zcash payment doesn&apos;t reveal sender, receiver or amount on the public chain.
              </p>
            </div>
            <div className="rounded-panel border border-border bg-surface-1 p-5">
              <Landmark aria-hidden className="h-5 w-5 text-warning" />
              <h3 className="mt-3 text-[15px] font-semibold">Visible where it must be</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">
                Our receiving wallet can identify payments to its addresses. Payout providers and banks see the INR transfer details.
              </p>
            </div>
            <div className="rounded-panel border border-border bg-surface-1 p-5 sm:col-span-2">
              <ShieldCheck aria-hidden className="h-5 w-5 text-progress" />
              <h3 className="mt-3 text-[15px] font-semibold">Transparent ZEC is supported — with a warning</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">
                If your wallet can only send transparent ZEC, the amount and addresses are publicly visible. We always show which mode you chose.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* Merchant terminal + links split */}
      <Section id="merchants" className="bg-surface-1">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <SectionIntro eyebrow="For merchants" title="Accept a ZEC payment" description="Type the amount, show the QR, watch it verify. Every sale gets its own quote and receiving address." />
            <div className="theme-dark mt-8 rounded-overlay border border-border bg-background p-5 text-foreground">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium">QR Terminal</p>
                <span className="rounded-full bg-success/20 px-2 py-0.5 font-mono text-micro font-semibold text-success">ONLINE</span>
              </div>
              <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
                <div>
                  <p className="text-label text-foreground-secondary">Charge</p>
                  <p className="num font-display text-[30px] font-semibold">₹500.00</p>
                  <div className="mt-2 flex gap-1.5">
                    {["₹100", "₹500", "₹1,000"].map((c) => (
                      <span key={c} className="rounded-full border border-border px-2.5 py-1 text-micro text-foreground-secondary">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                <div aria-hidden className="grid h-24 w-24 grid-cols-5 gap-0.5 rounded-input bg-[#FBFAF6] p-2">
                  {Array.from({ length: 25 }).map((_, i) => (
                    <span key={i} className={[0, 1, 3, 4, 5, 9, 12, 15, 19, 20, 21, 23, 24, 7, 17].includes(i) ? "bg-ink" : "bg-transparent"} />
                  ))}
                </div>
              </div>
              <p className="mt-4 flex items-center gap-1.5 text-label text-progress">
                <CircleDashed aria-hidden className="h-3.5 w-3.5" /> Waiting for ZEC
              </p>
            </div>
            <ButtonLink href="/login?next=/app/terminal" variant="outline" className="mt-5">
              <Store aria-hidden className="h-4 w-4" />
              Open merchant terminal
            </ButtonLink>
          </div>
          <div id="payment-links" className="scroll-mt-20">
            <SectionIntro eyebrow="Payment links" title="Get paid from anywhere" description="Fixed price or customer-chosen amount, one-time or reusable, with expiry and usage limits." />
            <div className="mt-8 rounded-overlay border border-border bg-background p-5">
              <p className="font-mono text-micro text-foreground-muted">/pay/masala-chai-tasting-box</p>
              <h3 className="mt-3 font-display text-[20px] font-semibold">Masala chai tasting box</h3>
              <p className="mt-1 text-[14px] text-foreground-secondary">Six single-estate blends. Ships within 3 days.</p>
              <div className="mt-4 flex items-center justify-between rounded-input bg-surface-2 px-3 py-3">
                <span className="text-[13px] text-foreground-secondary">Fixed price</span>
                <span className="num font-semibold">₹1,200.00</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-micro">
                <span className="rounded-full border border-border px-2.5 py-1">Reusable</span>
                <span className="rounded-full border border-border px-2.5 py-1">Only confirmed payments count as uses</span>
              </div>
            </div>
            <ButtonLink href="/login?next=/app/links/new" variant="outline" className="mt-5">
              <Link2 aria-hidden className="h-4 w-4" />
              Create payment link
            </ButtonLink>
          </div>
        </div>
      </Section>

      {/* Two pools */}
      <Section id="settlement">
        <SectionIntro
          eyebrow="Behind the scenes"
          title="Two pools, one settlement path."
          description="Customers pay in ZEC. Payouts are funded from a separate pre-funded USDC treasury on Base, used with P2P liquidity providers who send INR. Rebalancing between the pools happens separately, not on every checkout."
        />
        <div className="mt-10 grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {[
            { icon: Vault, title: "ZEC Vault", sub: "Zcash", body: "Unique receiving addresses per checkout. Deposits verified by wallet scanning with a confirmation policy. Custodial while held." },
            { icon: Banknote, title: "USDC Treasury", sub: "Base · internal", body: "Pre-funded liquidity reserved per payout and per merchant liability. Never your payment token." },
            { icon: Landmark, title: "P2P INR settlement", sub: "Liquidity providers", body: "A provider accepts the order, USDC goes to escrow, and the provider sends INR over UPI. Complete only when confirmed." },
          ].map((b, i, arr) => (
            <React.Fragment key={b.title}>
              <div className="rounded-panel border border-border bg-surface-1 p-5">
                <div className="flex items-center gap-2.5">
                  <b.icon aria-hidden className="h-5 w-5 text-accent" />
                  <div>
                    <p className="text-[15px] font-semibold">{b.title}</p>
                    <p className="font-mono text-micro text-foreground-muted">{b.sub}</p>
                  </div>
                </div>
                <p className="mt-3 text-[14px] leading-relaxed text-foreground-secondary">{b.body}</p>
              </div>
              {i < arr.length - 1 && (
                <div aria-hidden className="flex items-center justify-center text-foreground-muted">
                  <ArrowRight className="h-5 w-5 rotate-90 lg:rotate-0" />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
        <p className="mt-6 max-w-3xl text-[13px] leading-relaxed text-foreground-secondary">
          Merchant balances reflect verified on-chain shielded ZEC deposits with automated liquidity provisioning and P2P offramp execution.
        </p>
      </Section>

      {/* FAQ preview */}
      <Section id="faq" className="bg-surface-1">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <SectionIntro eyebrow="FAQ" title="Straight answers." description="What happens to your money, and what doesn't happen automatically." />
            <Link href="/faq" className="mt-5 inline-flex min-h-[44px] items-center gap-1.5 text-[14px] font-medium text-accent hover:underline">
              Read all questions <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </div>
          <FaqList items={FAQ.slice(0, 5)} className="bg-background" />
        </div>
      </Section>

      {/* Final CTA */}
      <section className="border-t border-border">
        <Container className="flex flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
          <div className="flex items-center gap-4">
            <ZebMark size={48} />
            <div>
              <h2 className="font-display text-[26px] font-semibold tracking-[-0.03em] sm:text-[30px]">Pay in ZEC. They get INR.</h2>
              <p className="mt-1 text-[14px] text-foreground-secondary">Accept shielded ZEC at the counter or online.</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 xs:flex-row">
            <ButtonLink href="/scan" size="lg">
              Scan &amp; Pay
            </ButtonLink>
            <ButtonLink href="/login" variant="outline" size="lg">
              Start accepting ZEC
            </ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}
