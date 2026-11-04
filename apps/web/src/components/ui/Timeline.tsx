import React from "react";
import { Check, Circle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";

export type StepState = "done" | "current" | "upcoming" | "failed" | "skipped";

export interface StepItem {
  key: string;
  label: React.ReactNode;
  detail?: React.ReactNode;
  state: StepState;
  at?: number;
}

/** Vertical progress stepper. Status is always conveyed by text + icon, not colour. */
export function Stepper({ steps, className, label }: { steps: StepItem[]; className?: string; label: string }) {
  return (
    <ol aria-label={label} className={cn("relative", className)}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0" aria-current={s.state === "current" ? "step" : undefined}>
            {!last && (
              <span aria-hidden className={cn("absolute left-[11px] top-6 h-[calc(100%-20px)] w-px", s.state === "done" ? "bg-success/50" : "bg-border")} />
            )}
            <span
              aria-hidden
              className={cn(
                "relative z-[1] mt-0.5 inline-flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border",
                s.state === "done" && "border-success/60 bg-success/15 text-success",
                s.state === "current" && "border-progress bg-progress/15 text-progress",
                s.state === "upcoming" && "border-border-strong bg-surface-2 text-foreground-muted",
                s.state === "failed" && "border-danger/60 bg-danger/15 text-danger",
                s.state === "skipped" && "border-border bg-surface-2 text-foreground-muted opacity-60",
              )}
            >
              {s.state === "done" ? (
                <Check className="h-3 w-3" />
              ) : s.state === "failed" ? (
                <X className="h-3 w-3" />
              ) : s.state === "current" ? (
                <span className="h-2 w-2 rounded-full bg-progress" />
              ) : (
                <Circle className="h-2 w-2" />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={cn("text-[13px] font-medium", s.state === "upcoming" || s.state === "skipped" ? "text-foreground-secondary" : "text-foreground")}>
                {s.label}
                <span className="sr-only">
                  {" "}
                  — {s.state === "done" ? "completed" : s.state === "current" ? "in progress" : s.state === "failed" ? "failed" : s.state === "skipped" ? "skipped" : "not started"}
                </span>
              </p>
              {s.detail && <p className="mt-0.5 text-label leading-relaxed text-foreground-secondary">{s.detail}</p>}
              {s.at && <p className="num mt-0.5 font-mono text-micro text-foreground-muted">{formatDateTime(s.at)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Chronological event log. */
export function EventLog({ events, className }: { events: Array<{ at: number; label: string; detail?: string; kind?: string }>; className?: string }) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  return (
    <ol className={cn("space-y-3", className)}>
      {sorted.map((e, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-muted" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{e.label}</p>
            {e.detail && <p className="text-label text-foreground-secondary">{e.detail}</p>}
            <p className="num font-mono text-micro text-foreground-muted">{formatDateTime(e.at)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
