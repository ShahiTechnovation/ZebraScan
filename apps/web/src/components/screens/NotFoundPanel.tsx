import React from "react";
import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";

export function NotFoundPanel({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2 text-foreground-secondary">
        <SearchX aria-hidden className="h-5 w-5" />
      </span>
      <h1 className="mt-4 font-display text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-foreground-secondary">{body}</p>
      <ButtonLink href={href} variant="secondary" className="mt-6">
        {cta}
      </ButtonLink>
    </div>
  );
}
