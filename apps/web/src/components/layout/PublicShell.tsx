"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { ZebLogo } from "@/components/brand/ZebLogo";
import { ButtonLink } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Modal";
import { ModeBadge, ModeBanner } from "@/components/layout/ModeBanner";
import { Container } from "./Container";
import { ConnectWalletButton } from "@/components/screens/ConnectWallet";
import { useZeb } from "@/providers/ZebProvider";

/** Payment-first public nav (delta spec §9.2): Pay and Receive only; the rest lives in the footer. */
const NAV = [
  { label: "Pay", href: "/scan" },
  { label: "Receive", href: "/login" },
];

export { Container };

export function PublicHeader({ minimal }: { minimal?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="no-print sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Container className="flex h-16 items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <ZebLogo />
          {!minimal && (
            <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded-full px-3 py-2 text-[14px] text-foreground-secondary transition-colors hover:text-foreground">
                  {n.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ModeBadge className="hidden xs:inline-flex" />
          {!minimal && (
            <>
              <Link href="/login" className="hidden rounded-full px-3 py-2 text-[13px] font-medium text-foreground-secondary hover:text-foreground md:inline-flex">
                Sign in
              </Link>
              <span className="hidden md:inline-flex">
                <ConnectWalletButton />
              </span>
            </>
          )}
          {minimal && (
            <Link href="/faq" className="rounded-full px-3 py-2 text-[13px] text-foreground-secondary hover:text-foreground">
              Need help?
            </Link>
          )}
          {!minimal && (
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground hover:bg-surface-2 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
        </div>
      </Container>
      <Drawer open={open} onClose={() => setOpen(false)} title="Menu" side="right">
        <div className="theme-light flex h-full flex-col bg-background text-foreground">
          <div className="flex h-16 items-center justify-between border-b border-border px-4">
            <ZebLogo />
            <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-surface-2">
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav aria-label="Mobile" className="flex flex-col p-2">
            {[{ label: "Home", href: "/" }, ...NAV].map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="rounded-input px-3 py-3 text-[15px] text-foreground hover:bg-surface-2">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto space-y-2 border-t border-border p-4">
            <ButtonLink href="/scan" variant="secondary" className="w-full" onClick={() => setOpen(false)}>
              Scan &amp; Pay
            </ButtonLink>
            <ButtonLink href="/login" className="w-full" onClick={() => setOpen(false)}>
              Open merchant demo
            </ButtonLink>
          </div>
        </div>
      </Drawer>
    </header>
  );
}

export function PublicFooter() {
  const { isDemo, live } = useZeb();
  const testnet = !isDemo && live?.config?.label === "TEST";
  const cols = [
    {
      title: "Product",
      links: [
        { label: "Scan & Pay", href: "/scan" },
        { label: "How it works", href: "/how-it-works" },
        { label: "FAQ", href: "/faq" },
      ],
    },
    {
      title: "Merchants",
      links: [
        { label: "Open merchant demo", href: "/login" },
        { label: "Set up a demo merchant", href: "/onboarding" },
        { label: "Merchant help", href: "/app/help" },
      ],
    },
    {
      title: "Legal (samples)",
      links: [
        { label: "Privacy (sample)", href: "/privacy" },
        { label: "Terms (sample)", href: "/terms" },
      ],
    },
  ];
  return (
    <footer className="no-print border-t border-border bg-surface-1">
      <Container className="grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <ZebLogo />
          <p className="mt-3 text-[13px] leading-relaxed text-foreground-secondary">Pay in ZEC. They get INR.</p>
          <p className="mt-4 inline-flex items-center gap-2 text-label text-accent">
            <ModeBadge /> {testnet ? "Zcash testnet · TAZ has no value · no real INR" : "Demo · no live funds"}
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="eyebrow mb-3">{c.title}</p>
            <ul className="space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[14px] text-foreground-secondary hover:text-foreground">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Container>
      <div className="border-t border-border">
        <Container className="py-5 text-micro leading-relaxed text-foreground-muted">
          {testnet
            ? "HACKATHON_TESTNET: shielded payments are real Zcash testnet transactions (TAZ, no monetary value), detected by a watch-only viewing key. No INR is ever paid out and balances are not redeemable."
            : "Zeb Scan is a frontend demonstration. Demo only. These are simulated transactions, not real payments or bank transfers. Prices shown are illustrative, not market data."}{" "}
          Zeb Scan is not affiliated with or endorsed by the Zcash project, UPI/NPCI, Base or P2P.me.
        </Container>
      </div>
    </footer>
  );
}

export function PublicShell({ children, minimal }: { children: React.ReactNode; minimal?: boolean }) {
  return (
    <div className="theme-light flex min-h-screen flex-col bg-background text-foreground">
      <ModeBanner />
      <PublicHeader minimal={minimal} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
