"use client";

import React, { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getOperationMode } from "@/config/mode";
import type { DemoState, Merchant, UiOperationMode } from "@/types/domain";
import type { ZebServices } from "@/services/adapters";
import { getServices } from "@/services/registry";
import { demoStore } from "@/services/demo/store";
import { demoSession } from "@/services/demo/services";
import { emptyState } from "@/services/demo/engine";
import { liveStore, type LiveStore } from "@/services/live/store";
import { errorMessage, registerStepUpPrompt } from "@/services/live/api";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

interface ZebContextValue {
  /** False until client storage (demo) or the backend (connected) has been read. */
  ready: boolean;
  mode: UiOperationMode;
  /** Adapters, or null when connected mode has no live adapters configured. */
  services: ZebServices | null;
  /** Money actions are possible (demo adapters, or configured live adapters). */
  canTransact: boolean;
  isDemo: boolean;
  state: DemoState;
  merchant: Merchant | null;
  demo: typeof demoSession | null;
  /** Connected mode: the live store (session, config, on-demand loaders). */
  live: LiveStore | null;
}

const ZebContext = createContext<ZebContextValue | null>(null);
const CONNECTED_EMPTY = emptyState(0);
const noopSubscribe = () => () => undefined;
const nullSnapshot = () => null;

export function ZebProvider({ children }: { children: React.ReactNode }) {
  const mode = getOperationMode();
  const services = getServices();
  const isDemo = mode === "demo" && services?.kind === "demo";
  const live = mode === "connected" && services?.kind === "live" ? liveStore : null;
  const store = isDemo ? demoStore : live;
  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? nullSnapshot, demoStore.getServerSnapshot);

  useEffect(() => {
    if (!isDemo) return;
    const t = window.setInterval(() => demoStore.tick(), 1000);
    return () => window.clearInterval(t);
  }, [isDemo]);

  const value = useMemo<ZebContextValue>(() => {
    const state = store ? snapshot ?? CONNECTED_EMPTY : CONNECTED_EMPTY;
    const merchant = state.merchants.find((m) => m.id === state.session.merchantId) ?? null;
    return {
      ready: store ? snapshot !== null : true,
      mode,
      services,
      canTransact: services !== null && (!live || !live.error),
      isDemo,
      state,
      merchant,
      demo: isDemo ? demoSession : null,
      live,
    };
  }, [snapshot, isDemo, mode, services, store, live]);

  return (
    <ZebContext.Provider value={value}>
      {children}
      {live && <StepUpDialog />}
    </ZebContext.Provider>
  );
}

export function useZeb(): ZebContextValue {
  const ctx = useContext(ZebContext);
  if (!ctx) throw new Error("useZeb must be used inside <ZebProvider>");
  return ctx;
}

/** Ticking "now" including the demo clock offset. Null until mounted (hydration-safe). */
export function useNow(intervalMs = 1000): number | null {
  const { state } = useZeb();
  const offset = state.clockOffsetMs;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now() + offset);
    const t = window.setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs, offset]);
  return now;
}

/**
 * Connected mode: load a public resource on demand (and keep checkouts live via SSE).
 * In demo mode this is a no-op and reports `loading: false`.
 */
export function useLiveResource(kind: "checkout" | "link" | "counter" | "receipt", key: string): { loading: boolean; error: string | null } {
  const { live } = useZeb();
  const [st, setSt] = useState<{ loading: boolean; error: string | null }>({ loading: !!live, error: null });
  useEffect(() => {
    if (!live || !key) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    setSt({ loading: true, error: null });
    const p =
      kind === "checkout"
        ? live.loadCheckout(key).then((c) => {
            if (c) stop = live.watchCheckout(key, () => undefined);
          })
        : kind === "link"
          ? live.ensurePublicLink(key)
          : kind === "counter"
            ? live.ensurePublicMerchant(key)
            : live.ensureReceipt(key);
    p.then(() => !cancelled && setSt({ loading: false, error: null })).catch((e) => !cancelled && setSt({ loading: false, error: errorMessage(e) }));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [live, kind, key]);
  return st;
}

/** Password re-confirmation for sensitive commands (payout destination, withdrawal). */
function StepUpDialog() {
  const [pending, setPending] = useState<((pw: string | null) => void) | null>(null);
  const [pw, setPw] = useState("");
  useEffect(() => {
    registerStepUpPrompt(() => new Promise<string | null>((resolve) => setPending(() => resolve)));
    return () => registerStepUpPrompt(null);
  }, []);
  const close = (value: string | null) => {
    pending?.(value);
    setPending(null);
    setPw("");
  };
  return (
    <Modal open={!!pending} onClose={() => close(null)} title="Confirm it's you" description="For your security, re-enter your password to continue with this sensitive action.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          close(pw);
        }}
      >
        <label htmlFor="stepup-pw" className="text-label font-medium text-foreground-secondary">
          Password
        </label>
        <input id="stepup-pw" type="password" autoComplete="current-password" className="input w-full" value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!pw}>
            Confirm
          </Button>
        </div>
      </form>
    </Modal>
  );
}
