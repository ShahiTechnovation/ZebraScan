"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { ZebLogo } from "@/components/brand/ZebLogo";
import { Button, ButtonLink } from "@/components/ui/Button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Log only a non-sensitive digest — never payment details, UPI IDs or keys.
    if (error.digest) console.warn("Zeb Scan error", error.digest);
  }, [error.digest]);
  return (
    <div className="theme-light flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center text-foreground">
      <ZebLogo />
      <span className="mt-8 inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2">
        <AlertTriangle aria-hidden className="h-5 w-5 text-warning" />
      </span>
      <h1 className="mt-4 font-display text-[24px] font-semibold tracking-[-0.02em]">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-[14px] text-foreground-secondary">
        This page hit an unexpected error. No payment action was taken. Try again, or go back to the start.
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <ButtonLink href="/" variant="secondary">
          Home
        </ButtonLink>
      </div>
    </div>
  );
}
