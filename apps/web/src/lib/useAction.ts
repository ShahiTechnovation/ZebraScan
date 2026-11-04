"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/providers/ToastProvider";

/** Wrap an async service call: busy flag, error → toast + returned message. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      setBusy(true);
      try {
        const value = await fn();
        if (success) toast(success);
        return { ok: true, value };
      } catch (e) {
        const error = e instanceof Error ? e.message : "Something went wrong.";
        toast(error, "error");
        return { ok: false, error };
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
