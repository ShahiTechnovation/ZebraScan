"use client";

import React from "react";
import { cn } from "@/lib/utils";

/** Large INR entry. Keeps the raw text; parse with parseInrToMinor. */
export function CurrencyInput({
  value,
  onChange,
  id,
  size = "lg",
  className,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  size?: "md" | "lg";
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size">) {
  return (
    <div
      className={cn(
        "flex items-center rounded-input border border-border bg-surface-2 transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40",
        rest["aria-invalid"] && "border-danger focus-within:border-danger",
        className,
      )}
    >
      <span aria-hidden className={cn("pl-3.5 font-display font-semibold text-foreground-secondary", size === "lg" ? "text-[26px]" : "text-[16px]")}>
        ₹
      </span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d.,]/g, "");
          if (v.length <= 12) onChange(v);
        }}
        className={cn(
          "num w-full min-w-0 bg-transparent px-2 font-display font-semibold text-foreground placeholder:text-foreground-muted focus:outline-none",
          size === "lg" ? "h-16 text-[30px]" : "h-11 text-[16px]",
        )}
        {...rest}
      />
      <span className="pr-3.5 text-label font-medium text-foreground-secondary">INR</span>
    </div>
  );
}

export function AmountChips({ values, onPick }: { values: number[]; onPick: (minor: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Quick amounts">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className="num inline-flex h-11 items-center rounded-full border border-border bg-surface-1 px-4 text-[14px] font-medium text-foreground hover:border-border-strong md:h-9"
        >
          ₹{new Intl.NumberFormat("en-IN").format(v / 100)}
        </button>
      ))}
    </div>
  );
}
