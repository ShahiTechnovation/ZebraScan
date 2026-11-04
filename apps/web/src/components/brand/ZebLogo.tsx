import React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Zeb Scan mark: a bold "Z" framed by three QR finder-corner brackets
 * (top-left, top-right, bottom-left) — a scan target resolving into a payment.
 */
export function ZebMark({ size = 28, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      <rect width="32" height="32" rx="7" fill="#E6B84B" />
      <g fill="none" stroke="#111719" strokeWidth="2" strokeLinecap="square">
        <path d="M5 10V5h5" />
        <path d="M22 5h5v5" />
        <path d="M5 22v5h5" />
      </g>
      <path d="M10.5 10.5h11L10.5 21.5h11" fill="none" stroke="#111719" strokeWidth="3.2" strokeLinejoin="miter" strokeLinecap="square" />
      <rect x="23.5" y="23.5" width="3.5" height="3.5" fill="#111719" />
    </svg>
  );
}

export function ZebLogo({ href = "/", className, size = 28, wordmark = true }: { href?: string | null; className?: string; size?: number; wordmark?: boolean }) {
  const inner = (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <ZebMark size={size} />
      {wordmark && <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground">Zeb Scan</span>}
    </span>
  );
  if (href === null) return inner;
  return (
    <Link href={href} aria-label="Zeb Scan home" className="inline-flex rounded-input">
      {inner}
    </Link>
  );
}
