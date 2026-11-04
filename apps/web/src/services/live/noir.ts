/**
 * Noir Wallet (Zcash) client helpers, browser only. Matches @noir-wallet/sdk 0.1.9 and the Noir
 * Wallet 1.0.40 extension ("Noir Wallet" = mainnet build, "[Testnet] Noir Wallet" = testnet build).
 *
 * What the installed SDK and extension actually do (read from their shipped code):
 *  - A `world: "MAIN"` content script defines `window.noirwallet` at document_start
 *    ({ isNoirWallet: true, version, zcash }, non-writable, non-configurable) and then dispatches
 *    `noirwallet#initialized` on window. The page CSP does not apply to that injection and the
 *    provider talks to the extension only via window.postMessage, so our CSP is not involved.
 *  - Its content scripts match only https://* and http://localhost/* (any port). On
 *    http://127.0.0.1 or a LAN IP there is no provider at all.
 *  - `zcash.request({ method, params })` rejects with `Error(message)`, e.g. "User rejected the
 *    request". Approvals open in an extension window created by its service worker.
 *  - SDK 0.1.9 `ZcashAPI` is a thin wrapper over `request` with the same method names and params as
 *    below. We call the provider directly so a click handler posts the wallet request synchronously,
 *    with no dynamic import or other await before it.
 *  - Mainnet and testnet are separate builds that define the same global (the first enabled one
 *    wins). There is no getNetwork(), so the network is derived from address prefixes.
 *  - connect() only from a direct user click. A wallet-returned txid is NOT payment proof: Zeb
 *    Scan's own watcher confirms deposits.
 */
import type { SignMessageResult, ZcashProvider } from "@noir-wallet/sdk";
import { api, errorMessage, setCsrf } from "./api";

export type NoirState = "checking" | "not_installed" | "installed" | "connected";
export type NoirNetwork = "testnet" | "mainnet";
export interface NoirConnection {
  transparent: string | null;
  shielded: string | null;
  /** Network implied by the returned addresses; null when the prefixes are not recognised. */
  network: NoirNetwork | null;
}

const INITIALIZED_EVENT = "noirwallet#initialized";

type InjectedNoir = { isNoirWallet?: boolean; version?: string; zcash?: Partial<ZcashProvider> };

function injected(): InjectedNoir | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { noirwallet?: InjectedNoir }).noirwallet ?? null;
}

/** Same rule as the SDK's getZcashProvider() (`window.noirwallet.isNoirWallet`), plus a shape check. */
export function getNoirProvider(): ZcashProvider | null {
  const w = injected();
  return w?.isNoirWallet && w.zcash && typeof w.zcash.request === "function" ? (w.zcash as ZcashProvider) : null;
}

/** Extension version string (e.g. "1.0.40"); absent on older builds. */
export function noirVersion(): string | null {
  return injected()?.version ?? null;
}

/**
 * Resolves true as soon as the provider exists. It normally already does (document_start). Otherwise
 * wait for `noirwallet#initialized` (what the SDK's detectProvider() listens for) and poll, until
 * `timeoutMs` (the SDK's default is 3000).
 */
export function detectNoir(timeoutMs = 3000): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (getNoirProvider()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const ok = !!getNoirProvider();
      if (!ok && Date.now() - started < timeoutMs) return;
      window.removeEventListener(INITIALIZED_EVENT, check);
      window.clearInterval(timer);
      resolve(ok);
    };
    window.addEventListener(INITIALIZED_EVENT, check);
    const timer = window.setInterval(check, 100);
  });
}

/** Calls `cb` when the provider is injected later than our detection window. Returns an unsubscribe. */
export function onNoirInitialized(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => {
    if (getNoirProvider()) cb();
  };
  window.addEventListener(INITIALIZED_EVENT, handler);
  return () => window.removeEventListener(INITIALIZED_EVENT, handler);
}

/** Non-null when this page is on an origin where the Noir extension never injects its provider. */
export function noirOriginProblem(
  loc: { protocol: string; hostname: string; port: string } | null = typeof window === "undefined" ? null : window.location,
): string | null {
  if (!loc || loc.protocol === "https:" || (loc.protocol === "http:" && loc.hostname === "localhost")) return null;
  const port = loc.port ? `:${loc.port}` : "";
  return `Noir Wallet does not run on ${loc.protocol}//${loc.hostname}${port}. It only runs on https:// sites and http://localhost, so open http://localhost${port} on this computer instead.`;
}

/** Zcash network implied by an address prefix (unified, Sapling, TEX, transparent P2PKH/P2SH). */
export function addressNetwork(addr: string | null | undefined): NoirNetwork | null {
  if (!addr) return null;
  if (/^(utest1|ztestsapling1|textest1|tm|t2)/.test(addr)) return "testnet";
  if (/^(u1|zs1|tex1|t1|t3)/.test(addr)) return "mainnet";
  return null;
}

/**
 * If both builds are enabled, both content scripts answer every request (two overlapping approval
 * windows) and whichever answers first wins, so a wrong-network answer usually means "both are on".
 */
export function networkMismatchMessage(wallet: NoirNetwork, expected: NoirNetwork): string {
  return expected === "testnet"
    ? `Noir Wallet answered from Zcash ${wallet}, but this Zeb Scan uses Zcash testnet. Open chrome://extensions, turn off "Noir Wallet" and keep only "[Testnet] Noir Wallet" on (with both on, every request opens two approval windows and the wrong one can answer), then reload this page.`
    : `Noir Wallet answered from Zcash ${wallet}, but this Zeb Scan uses Zcash mainnet. Open chrome://extensions, turn off "[Testnet] Noir Wallet" and keep only "Noir Wallet" on, then reload this page.`;
}

/** The wallet's own error text. The extension rejects with Error(message); other shapes are tolerated, never swallowed. */
export function walletErrorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown; code?: unknown };
    const m = typeof o.message === "string" && o.message ? o.message : typeof o.error === "string" && o.error ? o.error : null;
    if (m) return o.code !== undefined ? `${m} (code ${String(o.code)})` : m;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e ?? "unknown error");
}

const HINTS: [RegExp, string][] = [
  [/rejected/i, "Click the button again and approve the request in the Noir Wallet window."],
  [/timeout/i, "The Noir Wallet window was not answered in time. Try again."],
  [/not authorized|reconnect/i, "Connect Noir Wallet again, then retry."],
  [/no accounts? (selected|available)/i, "Select an account in the Noir Wallet window."],
  // Chrome's text when the extension was reloaded, turned off/on or updated after this page loaded.
  [/extension context invalidated/i, "Noir Wallet was reloaded or switched after this page opened. Reload this page, then try again."],
];

function withHint(walletMessage: string): string {
  const hint = HINTS.find(([re]) => re.test(walletMessage))?.[1];
  return `${walletMessage}${/[.!?]$/.test(walletMessage) ? "" : "."}${hint ? ` ${hint}` : ""}`;
}

/** An error raised by the wallet itself; the message keeps the wallet's own text verbatim. */
export class NoirWalletError extends Error {
  constructor(
    readonly walletMessage: string,
    context: string,
  ) {
    super(`${context}: ${withHint(walletMessage)}`);
    this.name = "NoirWalletError";
  }
}

/** Text to show the user for any failure in a Noir flow (wallet, API or anything else). */
export function noirErrorMessage(e: unknown): string {
  return e instanceof Error ? errorMessage(e) || walletErrorText(e) : walletErrorText(e);
}

function requireProvider(): ZcashProvider {
  const p = getNoirProvider();
  if (p) return p;
  const origin = noirOriginProblem();
  if (origin) throw new Error(origin);
  throw new Error(
    injected()
      ? "Noir Wallet is present but exposes no Zcash provider. Update or re-enable the extension, then reload this page."
      : "Noir Wallet is not installed or not enabled in this browser profile. Install it, then reload this page.",
  );
}

/**
 * Request accounts (opens the Noir approval window). Call it straight from a click handler: the
 * request is posted synchronously, before the first await. With `expected`, a wallet on the other
 * network is rejected with instructions instead of failing later on the server.
 */
export async function connectNoir(expected?: NoirNetwork | null): Promise<NoirConnection> {
  const provider = requireProvider();
  let res: unknown;
  try {
    res = await provider.request({ method: "zcash_requestAccounts" });
  } catch (e) {
    throw new NoirWalletError(walletErrorText(e), "Noir Wallet connection failed");
  }
  const r = (res ?? null) as { transparent?: unknown; shielded?: unknown } | null;
  const transparent = typeof r?.transparent === "string" && r.transparent ? r.transparent : null;
  const shielded = typeof r?.shielded === "string" && r.shielded ? r.shielded : null;
  if (!transparent && !shielded) throw new Error("Noir Wallet returned no account. Unlock Noir Wallet, select an account, and try again.");
  const network = addressNetwork(shielded) ?? addressNetwork(transparent);
  if (expected && network && network !== expected) throw new Error(networkMismatchMessage(network, expected));
  return { transparent, shielded, network };
}

/** connect → server challenge → wallet signMessage (derived identity) → server verification → session. */
export async function signInWithNoir(action: "login" | "link_wallet" = "login", expected: NoirNetwork | null = null): Promise<{ userId: string; emailVerified: boolean }> {
  // First statement on purpose: zcash_requestAccounts is posted inside the user's click.
  const conn = await connectNoir(expected);
  const ch = await api.call("walletChallenge", { body: { action } });
  const net: NoirNetwork = ch.network === "zcash-mainnet" ? "mainnet" : "testnet";
  if (conn.network && conn.network !== net) throw new Error(networkMismatchMessage(conn.network, net));
  let sig: SignMessageResult | null;
  try {
    sig = (await requireProvider().request({ method: "zcash_signMessage", params: [ch.message, { signingMode: "derived" }] })) as SignMessageResult | null;
  } catch (e) {
    // Rejection or unsupported (e.g. some hardware wallets cannot sign messages) is not a compromise.
    throw new Error(`Wallet signature not available: ${withHint(walletErrorText(e))} You can continue with email instead.`);
  }
  if (!sig?.signature || !sig.pubkey || !sig.address) throw new Error("Noir Wallet returned an empty signature. Unlock the wallet and try again, or continue with email.");
  const sigNet = addressNetwork(sig.address);
  if (sigNet && sigNet !== net) throw new Error(networkMismatchMessage(sigNet, net));
  const r = await api.call("walletVerify", {
    body: { challengeId: ch.challengeId, signature: sig.signature, pubkey: sig.pubkey, address: sig.address, signingMode: sig.signingMode ?? "derived" },
  });
  setCsrf(r.csrfToken);
  return { userId: r.userId, emailVerified: r.emailVerified };
}

export function zatToDecimal(zat: string): string {
  const v = BigInt(zat);
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${v / 100_000_000n}${frac ? `.${frac}` : ""}`;
}

/** User-approved shielded send of the exact invoice amount and memo. Call it straight from a click. */
export async function payWithNoir(p: { to: string; zat: string; memo: string | null; network: NoirNetwork }): Promise<string> {
  if (addressNetwork(p.to) !== p.network) throw new Error(`This invoice address is not a Zcash ${p.network} address, so Noir Wallet cannot pay it.`);
  if (!/^(utest1|ztestsapling1|u1|zs1)/.test(p.to)) throw new Error("Pay with Noir Wallet sends shielded payments only. Scan the QR or copy the address to pay this transparent invoice.");
  await connectNoir(p.network);
  let txid: unknown;
  try {
    txid = await requireProvider().request({
      method: "zcash_sendTransaction",
      params: [{ to: p.to, amount: zatToDecimal(p.zat), ...(p.memo ? { memo: p.memo } : {}), fundingSource: "shielded" }],
    });
  } catch (e) {
    throw new NoirWalletError(walletErrorText(e), "Noir Wallet payment failed");
  }
  if (typeof txid !== "string" || !txid) throw new Error("Noir Wallet did not return a transaction id. Check Noir Wallet's activity before paying again.");
  return txid;
}
