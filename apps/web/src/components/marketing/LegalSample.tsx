"use client";

import React, { useState } from "react";
import { Container } from "@/components/layout/Container";
import { Callout } from "@/components/ui/Blocks";
import { FormField, Input, Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export function LegalSample({ title, sections }: { title: string; sections: Array<{ h: string; p: string }> }) {
  const [sent, setSent] = useState(false);
  return (
    <Container className="py-14 sm:py-20">
      <div className="mx-auto max-w-3xl">
        <p className="eyebrow text-accent">Sample placeholder</p>
        <h1 className="mt-3 font-display text-[34px] font-semibold tracking-[-0.035em]">{title}</h1>
        <Callout tone="warning" title="Non-binding sample text" className="mt-6">
          This page is a placeholder for a demo build. It is not a final or enforceable policy, it was not written or reviewed by a lawyer, and it does not claim any
          regulatory authority, licence or exemption. A live service must publish its own reviewed terms.
        </Callout>
        <div className="mt-8 space-y-6">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-[17px] font-semibold">{s.h}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-foreground-secondary">{s.p}</p>
            </section>
          ))}
        </div>

        <section className="mt-12 rounded-panel border border-border bg-surface-1 p-5" aria-labelledby="contact-demo">
          <h2 id="contact-demo" className="text-[16px] font-semibold">
            Contact form (demo — not sent anywhere)
          </h2>
          <p className="mt-1 text-[13px] text-foreground-secondary">This form is non-functional in the demo. Nothing you type leaves your browser.</p>
          {sent ? (
            <Callout tone="info" className="mt-4" title="Not sent">
              Demo only — your message was not transmitted. For product questions, see the FAQ.
            </Callout>
          ) : (
            <form
              className="mt-4 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setSent(true);
              }}
            >
              <FormField label="Your email">{(p) => <Input type="email" autoComplete="email" {...p} />}</FormField>
              <FormField label="Message">{(p) => <Textarea {...p} />}</FormField>
              <div>
                <Button type="submit" variant="secondary">
                  Submit (demo, not sent)
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </Container>
  );
}
