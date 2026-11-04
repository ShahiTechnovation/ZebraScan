"use client";

import React from "react";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useZeb } from "@/providers/ZebProvider";

/** Visually distinct container for demo-only simulation controls. Renders only in local demo mode or against a DEMO-environment backend. */
export function DemoControls({ title = "Demo controls", children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  const { isDemo, live } = useZeb();
  if (!isDemo && live?.config?.environment !== "demo") return null;
  return (
    <section aria-label={title} className={cn("no-print rounded-panel border border-dashed border-gold/60 bg-gold/[0.05] p-3.5", className)}>
      <p className="mb-2.5 flex items-center gap-1.5 font-mono text-micro font-semibold uppercase tracking-[0.08em] text-accent">
        <FlaskConical aria-hidden className="h-3.5 w-3.5" />
        {title} · simulation only
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}
