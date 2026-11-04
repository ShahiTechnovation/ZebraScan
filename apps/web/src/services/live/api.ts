/**
 * Connected-mode API access. The browser only ever holds:
 *  - an HttpOnly session cookie (merchant realm) it cannot read,
 *  - a per-session CSRF token (memory only),
 *  - per-checkout scoped access tokens (bearer credentials for ONE checkout each).
 * No keys, seeds, RPC credentials or payout details are ever stored client-side.
 */
import { ApiClientError, createApiClient } from "@zeb/contracts";

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

let csrf: string | null = null;
export function setCsrf(token: string | null) {
  csrf = token;
}

const TOKENS_KEY = "zebscan.checkoutAccess.v1";
type TokenMap = Record<string, { token: string; exp: number; receiptId?: string }>;

function readTokens(): TokenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(TOKENS_KEY) ?? "{}") as TokenMap;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v.token === "string" && v.exp > now));
  } catch {
    return {};
  }
}

export const checkoutTokens = {
  get(id: string): string | null {
    return readTokens()[id]?.token ?? null;
  },
  set(id: string, token: string, expIso: string) {
    const all = readTokens();
    all[id] = { ...all[id], token, exp: Date.parse(expIso) };
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  },
  linkReceipt(checkoutId: string, receiptId: string) {
    const all = readTokens();
    if (!all[checkoutId] || all[checkoutId]!.receiptId === receiptId) return;
    all[checkoutId] = { ...all[checkoutId]!, receiptId };
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  },
  checkoutForReceipt(receiptId: string): string | null {
    return Object.entries(readTokens()).find(([, v]) => v.receiptId === receiptId)?.[0] ?? null;
  },
  ids(): string[] {
    return Object.keys(readTokens());
  },
};

export const api = createApiClient({
  baseUrl: API_BASE,
  csrfToken: () => csrf,
  accessToken: (id) => (id ? checkoutTokens.get(id) : null),
});

/* ------------------------------------------------------------------ step-up re-authentication */

type StepUpPrompt = () => Promise<string | null>;
let stepUpPrompt: StepUpPrompt | null = null;
export function registerStepUpPrompt(fn: StepUpPrompt | null) {
  stepUpPrompt = fn;
}

/** Run a sensitive command; if the server asks for step-up, prompt for the password once and retry with the SAME idempotency key. */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiClientError) || e.code !== "AUTH_STEP_UP_REQUIRED" || !stepUpPrompt) throw e;
    const password = await stepUpPrompt();
    if (!password) throw new Error("Confirmation cancelled.");
    await api.call("stepUp", { body: { password } });
    return fn();
  }
}

export function newKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Human-readable error text for the UI (server messages are already user-safe). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiClientError) return e.body.message;
  return e instanceof Error ? e.message : "Something went wrong.";
}
