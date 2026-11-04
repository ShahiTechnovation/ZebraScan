/**
 * Client-side demo store: in-memory snapshot persisted to localStorage.
 * SSR-safe: the server snapshot is always `null` ("not ready"), so nothing
 * persisted is rendered until after hydration.
 */
import { demoConfig } from "@/config/demo";
import type { DemoState } from "@/types/domain";
import { reconcile } from "./engine";
import { buildSeed } from "./seed";

type Listener = () => void;

let state: DemoState | null = null;
const listeners = new Set<Listener>();
let storageBound = false;

export function demoNow(s: DemoState | null = state): number {
  return Date.now() + (s?.clockOffsetMs ?? 0);
}

function read(): DemoState {
  try {
    const raw = window.localStorage.getItem(demoConfig.storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (parsed && parsed.version === demoConfig.seedVersion && Array.isArray(parsed.checkouts)) return parsed;
    }
  } catch {
    /* corrupted or unavailable storage → reseed */
  }
  return buildSeed(Date.now());
}

function write(s: DemoState) {
  try {
    window.localStorage.setItem(demoConfig.storageKey, JSON.stringify(s));
  } catch {
    /* storage full / private mode: keep in memory only */
  }
}

function emit() {
  for (const l of listeners) l();
}

function ensureLoaded(): DemoState {
  if (state) return state;
  const loaded = read();
  state = reconcile(loaded, demoNow(loaded));
  write(state);
  if (!storageBound) {
    storageBound = true;
    window.addEventListener("storage", (e) => {
      if (e.key !== demoConfig.storageKey) return;
      state = null;
      ensureLoaded();
      emit();
    });
  }
  return state;
}

export const demoStore = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getSnapshot(): DemoState | null {
    if (typeof window === "undefined") return null;
    return ensureLoaded();
  },
  getServerSnapshot(): DemoState | null {
    return null;
  },
  /** Apply a pure transition. Throws through engine DemoErrors untouched. */
  update(fn: (s: DemoState, now: number) => DemoState) {
    const cur = ensureLoaded();
    const next = fn(cur, demoNow(cur));
    if (next === cur) return;
    state = next;
    write(next);
    emit();
  },
  tick() {
    if (!state) return;
    const next = reconcile(state, demoNow(state));
    if (next !== state) {
      state = next;
      write(next);
      emit();
    }
  },
  reset() {
    state = buildSeed(Date.now());
    write(state);
    emit();
  },
};
