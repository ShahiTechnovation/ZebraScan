import type { Metadata } from "next";
import { Container } from "@/components/layout/Container";
import { FaqList } from "@/components/marketing/Primitives";
import { ButtonLink } from "@/components/ui/Button";
import { FAQ, type FaqItem } from "@/content/faq";

export const metadata: Metadata = { title: "FAQ", description: "Honest answers about Zeb Scan payments, privacy, merchant balances and payouts." };

const GROUPS: FaqItem["group"][] = ["Paying", "Merchants", "Settlement", "Privacy & safety"];

export default function FaqPage() {
  return (
    <Container className="py-14 sm:py-20">
      <div className="grid gap-10 lg:grid-cols-[1fr_2fr]">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="eyebrow text-accent">FAQ</p>
          <h1 className="mt-3 font-display text-[34px] font-semibold tracking-[-0.035em]">Questions, answered honestly.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-foreground-secondary">
            If something isn&apos;t guaranteed, we say so. Merchants can also find payment and withdrawal states explained in the help center.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <ButtonLink href="/how-it-works" variant="outline">
              How it works
            </ButtonLink>
            <ButtonLink href="/app/help" variant="ghost">
              Merchant help center
            </ButtonLink>
          </div>
        </div>
        <div className="space-y-10">
          {GROUPS.map((g) => (
            <section key={g} aria-labelledby={`faq-${g}`}>
              <h2 id={`faq-${g}`} className="mb-3 text-[16px] font-semibold">
                {g}
              </h2>
              <FaqList items={FAQ.filter((f) => f.group === g)} />
            </section>
          ))}
        </div>
      </div>
    </Container>
  );
}
