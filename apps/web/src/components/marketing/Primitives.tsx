import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/Container";
import type { FaqItem } from "@/content/faq";

export function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-20 border-t border-border py-16 sm:py-20 lg:py-24", className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionIntro({ eyebrow, title, description, className }: { eyebrow?: string; title: React.ReactNode; description?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-2xl", className)}>
      {eyebrow && <p className="eyebrow mb-3 text-accent">{eyebrow}</p>}
      <h2 className="font-display text-[28px] font-semibold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[34px]">{title}</h2>
      {description && <p className="mt-3 text-[15px] leading-relaxed text-foreground-secondary">{description}</p>}
    </div>
  );
}

export function FaqList({ items, className }: { items: FaqItem[]; className?: string }) {
  return (
    <div className={cn("divide-y divide-border rounded-panel border border-border bg-surface-1", className)}>
      {items.map((f) => (
        <details key={f.q} className="group">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 text-[15px] font-medium text-foreground sm:px-5 [&::-webkit-details-marker]:hidden">
            {f.q}
            <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-foreground-secondary transition-transform group-open:rotate-180" />
          </summary>
          <p className="px-4 pb-4 text-[14px] leading-relaxed text-foreground-secondary sm:px-5">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

export function IllustrativeTag({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border border-gold/50 bg-gold/10 px-2.5 py-0.5 font-mono text-micro font-medium uppercase tracking-[0.06em] text-accent", className)}>
      Illustrative flow · not live
    </span>
  );
}
