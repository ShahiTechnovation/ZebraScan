"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  CalendarClock,
  ChevronDown,
  HelpCircle,
  LayoutGrid,
  Link2,
  ListOrdered,
  LogOut,
  Menu,
  Plus,
  QrCode,
  ReceiptText,
  ScanLine,
  Settings,
  Store,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useZeb } from "@/providers/ZebProvider";
import { api, errorMessage } from "@/services/live/api";
import { ZebLogo, ZebMark } from "@/components/brand/ZebLogo";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Blocks";
import { ModeBadge, ModeBanner } from "./ModeBanner";
import { COPY } from "@/config/mode";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

/** Four primary destinations only (delta spec §9.2). Everything else lives in the profile menu. */
export const PRIMARY_NAV: NavItem[] = [
  { name: "Home", href: "/app", icon: LayoutGrid },
  { name: "Receive", href: "/app/terminal", icon: QrCode },
  { name: "Links", href: "/app/links", icon: Link2 },
  { name: "Activity", href: "/app/transactions", icon: ListOrdered },
];
const SECONDARY_NAV: NavItem[] = [
  { name: "Balance & withdraw", href: "/app/balance", icon: Wallet },
  { name: "Counter QR", href: "/app/counter-qr", icon: Store },
  { name: "Settlements", href: "/app/settlements", icon: CalendarClock },
  { name: "Withdrawals", href: "/app/withdrawals", icon: ArrowDownToLine },
  { name: "Receipts", href: "/app/receipts", icon: ReceiptText },
  { name: "Settings", href: "/app/settings", icon: Settings },
  { name: "Help", href: "/app/help", icon: HelpCircle },
];
const MOBILE_TABS: NavItem[] = PRIMARY_NAV;

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => (href === "/app" ? pathname === "/app" : pathname === href || pathname.startsWith(href + "/"));
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const isActive = useIsActive();
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 items-center gap-2.5 rounded-input px-3 text-[14px] transition-colors",
                active ? "bg-surface-2 font-medium text-foreground" : "text-foreground-secondary hover:bg-surface-2/60 hover:text-foreground",
              )}
            >
              {active && <span aria-hidden className="absolute left-0 top-2 h-6 w-[3px] rounded-r bg-gold" />}
              <item.icon aria-hidden className={cn("h-4 w-4", active && "text-gold")} />
              {item.name}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center border-b border-border px-4">
        <ZebLogo href="/app" />
      </div>
      <div className="p-3">
        <ButtonLink href="/scan" className="w-full" onClick={onNavigate}>
          <ScanLine aria-hidden className="h-4 w-4" />
          Scan &amp; Pay
        </ButtonLink>
      </div>
      <nav aria-label="Merchant console" className="flex-1 overflow-y-auto px-3 pb-3">
        <NavList items={PRIMARY_NAV} onNavigate={onNavigate} />
        <div className="my-3 border-t border-border" />
        <NavList items={SECONDARY_NAV} onNavigate={onNavigate} />
      </nav>
      <div className="border-t border-border p-4 text-micro leading-relaxed text-foreground-muted">{COPY.tagline}</div>
    </div>
  );
}

function ShopMenu() {
  const { state, merchant, demo, live } = useZeb();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!merchant) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 max-w-[220px] items-center gap-2 rounded-full border border-border bg-surface-1 pl-1.5 pr-3 text-[13px] hover:border-border-strong"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-[12px] font-semibold">
          {merchant.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={merchant.logoDataUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            merchant.businessName.slice(0, 1).toUpperCase()
          )}
        </span>
        <span className="truncate font-medium">{merchant.businessName}</span>
        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-foreground-secondary" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-72 rounded-overlay border border-border bg-surface-1 p-1.5 shadow-overlay animate-scale-in">
          <p className="px-2.5 pb-1 pt-1.5 text-micro text-foreground-muted">{live ? "Your business" : "Active merchant accounts"}</p>
          {state.merchants.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={m.id === merchant.id}
              type="button"
              onClick={() => {
                demo?.switchMerchant(m.id);
                setOpen(false);
              }}
              className={cn("flex w-full items-center justify-between gap-2 rounded-input px-2.5 py-2 text-left text-[13px] hover:bg-surface-2", m.id === merchant.id && "text-foreground")}
            >
              <span className="truncate">{m.businessName}</span>
              {m.id === merchant.id && <span className="text-micro text-gold">Current</span>}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          {SECONDARY_NAV.map((n) => (
            <Link key={n.href} role="menuitem" href={n.href} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-input px-2.5 py-2 text-[13px] hover:bg-surface-2">
              <n.icon aria-hidden className="h-4 w-4 text-foreground-secondary" /> {n.name}
            </Link>
          ))}
          <div className="my-1 border-t border-border" />
          {!live && (
            <Link role="menuitem" href="/onboarding" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-input px-2.5 py-2 text-[13px] hover:bg-surface-2">
              <Plus aria-hidden className="h-4 w-4" /> Add another merchant
            </Link>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={async () => {
              if (live) await live.signOut();
              else demo?.signOut();
              setOpen(false);
              router.push("/login");
            }}
            className="flex w-full items-center gap-2 rounded-input px-2.5 py-2 text-left text-[13px] text-foreground-secondary hover:bg-surface-2"
          >
            <LogOut aria-hidden className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Connected mode: server-reported readiness gates (KYB, email, provider availability) — never hidden. */
function LiveGates() {
  const { live, merchant } = useZeb();
  const [sent, setSent] = React.useState<string | null>(null);
  if (!live || !merchant || live.session.gates.reasons.length === 0) return null;
  return (
    <div role="status" className="mb-5 rounded-panel border border-warning/40 bg-warning/[0.07] px-4 py-3 text-[13px] text-foreground-secondary">
      <p className="font-medium text-foreground">Some actions are not available yet</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {live.session.gates.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {!live.session.emailVerified && (
        <button
          type="button"
          className="link mt-2 text-label"
          onClick={async () => {
            try {
              await api.call("resendVerification");
              setSent(live.config?.auth.emailDelivery ? "Verification email sent." : "Email delivery is not configured on this server.");
            } catch (e) {
              setSent(errorMessage(e));
            }
          }}
        >
          Resend verification email
        </button>
      )}
      {sent && <p className="mt-1 text-micro">{sent}</p>}
    </div>
  );
}

function Gate() {
  const { isDemo, demo, state, live } = useZeb();
  const router = useRouter();
  const hasSample = state.merchants.some((m) => m.isSample);
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <ZebMark size={44} />
      <h1 className="mt-4 font-display text-[24px] font-semibold tracking-[-0.02em]">Merchant console</h1>
      {isDemo ? (
        <>
          <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">
            Open the sample demo merchant or set up your own demo shop. Everything stays in this browser.
          </p>
          <div className="mt-6 flex w-full flex-col gap-2">
            {hasSample && (
              <Button
                onClick={() => {
                  demo?.signInSample();
                  router.refresh();
                }}
              >
                Explore demo merchant account
              </Button>
            )}
            <ButtonLink href="/onboarding" variant="secondary">
              Set up a new demo merchant
            </ButtonLink>
            <ButtonLink href="/" variant="ghost">
              Back to home
            </ButtonLink>
          </div>
        </>
      ) : live ? (
        <>
          <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">
            {live.session.authenticated ? "Create your business profile to start accepting ZEC." : "Sign in to manage your terminal, payment links and INR-denominated balance."}
          </p>
          <div className="mt-6 flex w-full flex-col gap-2">
            {live.session.authenticated ? <ButtonLink href="/onboarding">Create business profile</ButtonLink> : <ButtonLink href="/login">Sign in or create an account</ButtonLink>}
            <ButtonLink href="/" variant="ghost">Back to home</ButtonLink>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">
            {COPY.notConnected} Merchant sign-in requires a real authentication provider, which this build does not include.
          </p>
          <ButtonLink href="/" variant="secondary" className="mt-6">
            Back to home
          </ButtonLink>
        </>
      )}
    </div>
  );
}

const PUBLIC_APP_PATHS = ["/app/help"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, merchant } = useZeb();
  const pathname = usePathname();
  const isActive = useIsActive();
  const [menuOpen, setMenuOpen] = useState(false);
  const gated = !merchant && !PUBLIC_APP_PATHS.includes(pathname);

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="theme-light min-h-screen bg-background text-foreground">
      <ModeBanner />
      <div>
        <header className="no-print sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-[1040px] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Open navigation menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground-secondary hover:bg-surface-2 hover:text-foreground lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <ZebLogo href="/app" />
            <ModeBadge className="ml-1" />
          </div>
          {merchant && (
            <nav aria-label="Merchant" className="hidden items-center gap-1 lg:flex">
              {PRIMARY_NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={isActive(n.href) ? "page" : undefined}
                  className={cn("rounded-full px-3.5 py-2 text-[14px] transition-colors", isActive(n.href) ? "bg-surface-2 font-medium text-foreground" : "text-foreground-secondary hover:text-foreground")}
                >
                  {n.name}
                </Link>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2">
            <Link href="/scan" className="hidden h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-foreground-secondary hover:text-foreground md:inline-flex">
              <ScanLine aria-hidden className="h-4 w-4" /> Pay
            </Link>
            <ShopMenu />
          </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1040px] px-4 pb-28 pt-8 sm:px-6 lg:pb-16">
          {!ready ? <PageSkeleton /> : gated ? <Gate /> : (
            <>
              <LiveGates />
              {children}
            </>
          )}
        </main>
      </div>

      {merchant && (
        <nav aria-label="Primary tabs" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-nav/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <ul className="mx-auto grid max-w-lg grid-cols-4">
            {MOBILE_TABS.map((t) => {
              const active = isActive(t.href);
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px]", active ? "font-medium text-gold" : "text-foreground-secondary hover:text-foreground")}
                  >
                    <t.icon aria-hidden className="h-5 w-5" />
                    {t.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Navigation">
        <div className="theme-light relative h-full bg-surface-nav">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMenuOpen(false)}
            className="absolute right-2 top-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-secondary hover:bg-surface-2"
          >
            <X className="h-5 w-5" />
          </button>
          <SidebarContent onNavigate={() => setMenuOpen(false)} />
        </div>
      </Drawer>
    </div>
  );
}

export function MerchantPageHeader({
  title,
  description,
  actions,
  back,
  badge,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  badge?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-label text-foreground-secondary hover:text-foreground">
            ← {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-[24px] font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-foreground-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
