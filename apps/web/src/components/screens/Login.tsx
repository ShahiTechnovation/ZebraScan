"use client";

import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Mail, Wallet } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { COPY } from "@/config/mode";
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
  const { ready, isDemo, demo, merchant, state, live } = useZeb();
  const sample = state.merchants.find((m) => m.isSample);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-12">
      <div className="panel w-full p-6 sm:p-8">
        <ZebMark size={40} />
        <h1 className="mt-4 font-display text-[26px] font-semibold tracking-[-0.03em]">Merchant sign in</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-foreground-secondary">
          Manage your QR terminal, payment links and INR-denominated balance.
        </p>
        {!ready ? (
          <div className="mt-6">
            <PageSkeleton />
          </div>
        ) : live ? (
          <div className="mt-6">
            {merchant ? (
              <Button className="w-full" onClick={() => router.push(next)}>
                Continue as {merchant.businessName} <ArrowRight aria-hidden className="h-4 w-4" />
              </Button>
            ) : (
              <div className="space-y-4">
                <ConnectWalletButton className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-gold text-[14px] font-medium text-ink hover:bg-gold-hover" label="Sign in with Noir Wallet or email code" />
                <div className="flex items-center gap-3 text-micro text-foreground-muted"><span className="h-px flex-1 bg-border" /> or use a password <span className="h-px flex-1 bg-border" /></div>
                <ConnectedAuth next={next} />
              </div>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {isDemo && merchant && (
              <Button className="w-full" onClick={() => router.push(next)}>
                Continue as {merchant.businessName} <ArrowRight aria-hidden className="h-4 w-4" />
              </Button>
            )}
            {isDemo && sample && (
              <Button
                variant={merchant ? "secondary" : "primary"}
                className="w-full"
                onClick={() => {
                  demo?.signInSample();
                  router.push(next);
                }}
              >
                Explore demo merchant account
              </Button>
            )}
            {isDemo && (
              <ButtonLink href="/onboarding" variant="secondary" className="w-full">
                Set up a new demo merchant
              </ButtonLink>
            )}

            <div className="flex items-center gap-3 py-2 text-micro text-foreground-muted">
              <span className="h-px flex-1 bg-border" /> Real sign-in <span className="h-px flex-1 bg-border" />
            </div>
            <Button variant="outline" className="w-full" disabled aria-describedby="auth-nc">
              <Mail aria-hidden className="h-4 w-4" /> Continue with email · Not connected
            </Button>
            <Button variant="outline" className="w-full" disabled aria-describedby="auth-nc">
              <Wallet aria-hidden className="h-4 w-4" /> Sign in with a wallet · Not connected
            </Button>
            <p id="auth-nc" className="text-micro leading-relaxed text-foreground-muted">
              No authentication provider is connected in this build, so no codes or emails are sent. {isDemo ? "Demo sessions stay in this browser." : COPY.notConnected}
            </p>
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
