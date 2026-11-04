"use client";

import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { ZebMark } from "@/components/brand/ZebLogo";
import { Button, ButtonLink } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Blocks";
import { ConnectedAuth } from "./ConnectedAuth";
import { ConnectWalletButton } from "./ConnectWallet";

function safeNext(next: string | null): string {
  return next && next.startsWith("/app") && !next.startsWith("//") ? next : "/app";
}

export function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { ready, merchant, live } = useZeb();

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-12">
      <div className="panel w-full p-6 sm:p-8">
        <div className="flex items-center justify-between">
          <ZebMark size={40} />
          <span className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2.5 py-1 text-micro font-medium text-accent">
            <ShieldCheck className="h-3.5 w-3.5" /> Shielded Zcash
          </span>
        </div>
        <h1 className="mt-4 font-display text-[26px] font-semibold tracking-[-0.03em]">Merchant sign in</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">
          Access your QR terminal, payment links and real-time settlement console.
        </p>

        {!ready ? (
          <div className="mt-6">
            <PageSkeleton />
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {merchant ? (
              <Button className="w-full" onClick={() => router.push(next)}>
                Continue as {merchant.businessName} <ArrowRight aria-hidden className="h-4 w-4" />
              </Button>
            ) : (
              <>
                <ConnectWalletButton
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-gold text-[14px] font-medium text-ink shadow-sm hover:bg-gold-hover transition-colors"
                  label="Sign in with Noir Wallet"
                />

                <div className="rounded-panel border border-border bg-surface-2 p-3 text-[13px] text-foreground-secondary">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Sparkles className="h-4 w-4 text-accent" /> New to Zeb Scan?
                  </div>
                  <p className="mt-1 text-micro text-foreground-muted">
                    Set up your merchant profile and link your Shielded Zcash wallet in minutes.
                  </p>
                  <ButtonLink href="/onboarding" variant="secondary" size="sm" className="mt-2.5 w-full">
                    <Wallet aria-hidden className="h-4 w-4" /> Onboard with Noir Wallet
                  </ButtonLink>
                </div>

                {live && (
                  <>
                    <div className="flex items-center gap-3 text-micro text-foreground-muted">
                      <span className="h-px flex-1 bg-border" /> or password <span className="h-px flex-1 bg-border" />
                    </div>
                    <ConnectedAuth next={next} />
                  </>
                )}
              </>
            )}
          </div>
        )}

        <p className="mt-6 border-t border-border pt-4 text-label text-foreground-secondary">
          Just paying someone?{" "}
          <Link href="/scan" className="link font-medium">
            Use Scan &amp; Pay
          </Link>{" "}
          — no account needed.
        </p>
      </div>
    </div>
  );
}
