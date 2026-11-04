"use client";

import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, tone: Tone = "success") => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-2), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 3200);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="no-print pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6"
      >
        {toasts.map((t) => {
          const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "error" ? AlertTriangle : Info;
          return (
            <div
              key={t.id}
              className={cn(
                "theme-dark pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-panel border border-border bg-surface-1 px-3.5 py-3 text-[13px] text-foreground shadow-overlay animate-fade-in",
              )}
            >
              <Icon
                aria-hidden
                className={cn("mt-0.5 h-4 w-4 shrink-0", t.tone === "success" ? "text-success" : t.tone === "error" ? "text-danger" : "text-progress")}
              />
              <span className="flex-1">{t.message}</span>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="-m-1 rounded p-1 text-foreground-secondary hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
