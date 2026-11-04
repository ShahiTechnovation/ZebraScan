/**
 * Noir Wallet (Zcash) client helpers — browser only, loaded lazily. @noir-wallet/sdk 0.1.9.
 *  - connect() only from a direct user click; getAccounts() is silent restore, NOT authentication.
 *  - Testnet is a separate extension build ("[Testnet] Noir Wallet"); there is no getNetwork(), so
 *    recipients are validated by prefix here (utest1 / ztestsapling on testnet).
 *  - A wallet-returned txid is NOT payment proof: Zeb Scan's own watcher confirms deposits.
 */
import { api, errorMessage, setCsrf } from "./api";

export type NoirState = "checking" | "not_installed" | "installed" | "connected";

async function sdk() {
  return import("@noir-wallet/sdk");
}

/** The provider may appear after first render; poll briefly after hydration. */
export async function detectNoir(timeoutMs = 1500): Promise<boolean> {
  const { getNoirWallet } = await sdk();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getNoirWallet()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !!getNoirWallet();
}

export async function connectNoir(): Promise<{ shielded: string | null }> {
  const { getNoirWallet } = await sdk();
  const w = getNoirWallet();
  if (!w) throw new Error("Noir Wallet is not installed.");
  const c = (await w.zcash.connect()) as { shielded?: string | null };
  return { shielded: c?.shielded ?? null };
}

/** Server challenge → wallet signMessage (derived identity) → server verification → session. */
export async function signInWithNoir(action: "login" | "link_wallet" = "login"): Promise<{ userId: string; emailVerified: boolean }> {
  const { getNoirWallet } = await sdk();
  const w = getNoirWallet();
  if (!w) throw new Error("Noir Wallet is not installed.");
  await w.zcash.connect();
  const ch = await api.call("walletChallenge", { body: { action } });
  let sig: { signature: string; pubkey: string; address: string; signingMode: string };
  try {
    sig = await w.zcash.signMessage(ch.message, { signingMode: "derived" });
  } catch (e) {
    // Rejection or unsupported (e.g. some hardware wallets cannot sign messages) is not a compromise.
    throw new Error(`Wallet signature not available: ${errorMessage(e)}. You can continue with email instead.`);
  }
  const r = await api.call("walletVerify", {
    body: { challengeId: ch.challengeId, signature: sig.signature, pubkey: sig.pubkey, address: sig.address, signingMode: sig.signingMode as "derived" },
  });
  setCsrf(r.csrfToken);
  return { userId: r.userId, emailVerified: r.emailVerified };
}

export function zatToDecimal(zat: string): string {
  const v = BigInt(zat);
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${v / 100_000_000n}${frac ? `.${frac}` : ""}`;
}

/** User-approved shielded send of the exact invoice amount and memo. */
export async function payWithNoir(p: { to: string; zat: string; memo: string | null; network: "testnet" | "mainnet" }): Promise<string> {
  const ok = p.network === "testnet" ? /^(utest1|ztestsapling1)/.test(p.to) : /^(u1|zs1)/.test(p.to);
  if (!ok) throw new Error("This invoice address does not match the wallet network.");
  const { getNoirWallet } = await sdk();
  const w = getNoirWallet();
  if (!w) throw new Error("Noir Wallet is not installed.");
  await w.zcash.connect();
  return w.zcash.sendTransaction({ to: p.to, amount: zatToDecimal(p.zat), ...(p.memo ? { memo: p.memo } : {}), fundingSource: "shielded" });
}
