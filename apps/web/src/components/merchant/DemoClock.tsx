"use client";

import React from "react";
import { FastForward } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { demoConfig } from "@/config/demo";
import { formatDate } from "@/lib/format";
import { useToast } from "@/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { DemoControls } from "@/components/payments/DemoControls";

export function DemoClockControls() {
  const { demo, state } = useZeb();
  const now = useNow(5_000);
  const toast = useToast();
  if (!demo) return null;
  const offsetDays = Math.round(state.clockOffsetMs / 86_400_000);
  return (
    <DemoControls title="Demo clock">
      <Button
        size="sm"
        onClick={() => {
          demo.advanceClock(demoConfig.cooldownDays);
          toast(`Demo clock advanced ${demoConfig.cooldownDays} days`);
        }}
      >
        <FastForward aria-hidden className="h-4 w-4" /> Advance cooldown ({demoConfig.cooldownDays} days)
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          demo.advanceClock(1);
          toast("Demo clock advanced 1 day");
        }}
      >
        +1 day
      </Button>
      <p className="w-full text-label text-foreground-secondary">
        Demo date: {now ? formatDate(now) : "—"} {offsetDays !== 0 && `(+${offsetDays} days)`}. Unlocking changes eligibility only — it doesn&apos;t move INR. Use Settings → Demo &amp; data to reset everything.
      </p>
    </DemoControls>
  );
}
