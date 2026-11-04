import React from "react";
import { BadgeInfo } from "lucide-react";
import type { Merchant } from "@/types/domain";

export function MerchantIdentity({ merchant, subtitle }: { merchant: Merchant; subtitle?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 font-display text-[18px] font-semibold">
        {merchant.logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={merchant.logoDataUrl} alt={`${merchant.businessName} logo`} className="h-full w-full object-cover" />
        ) : (
          merchant.businessName.slice(0, 1).toUpperCase()
        )}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[16px] font-semibold text-foreground">{merchant.businessName}</p>
        <p className="flex items-center gap-1 text-label text-foreground-secondary">
          {subtitle ?? (
            <>
              <BadgeInfo aria-hidden className="h-3.5 w-3.5" /> {merchant.category} · {merchant.isSample ? "sample demo merchant" : "demo merchant"}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
