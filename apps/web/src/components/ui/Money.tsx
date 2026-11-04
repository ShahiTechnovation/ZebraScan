import React from "react";
import { cn } from "@/lib/utils";
import { formatInr, formatUsdc, formatZec } from "@/lib/money";

export function Inr({ minor, className, whole }: { minor: number; className?: string; whole?: boolean }) {
  return <span className={cn("num", className)}>{formatInr(minor, { whole })}</span>;
}

export function Zec({ zat, className, fixed, unit = true }: { zat: string; className?: string; fixed?: boolean; unit?: boolean }) {
  return (
    <span className={cn("num font-mono", className)}>
      {formatZec(zat, { fixed })}
      {unit && <span className="ml-1 font-sans text-[0.8em] text-foreground-secondary">ZEC</span>}
    </span>
  );
}

export function Usdc({ micro, className }: { micro: string; className?: string }) {
  return (
    <span className={cn("num font-mono", className)}>
      {formatUsdc(micro)}
      <span className="ml-1 font-sans text-[0.8em] text-foreground-secondary">USDC</span>
    </span>
  );
}

/** Large amount display: INR headline with ZEC beneath. */
export function MoneyDisplay({ inrMinor, zecZat, label, className }: { inrMinor: number; zecZat?: string; label?: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && <p className="eyebrow mb-1">{label}</p>}
      <p className="num font-display text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[32px]">{formatInr(inrMinor)}</p>
      {zecZat && (
        <p className="mt-0.5 text-[14px] text-foreground-secondary">
          <Zec zat={zecZat} fixed />
        </p>
      )}
    </div>
  );
}
