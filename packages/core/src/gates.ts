/**
 * Per-feature readiness. A failing dependency closes only the features that need it, with an
 * explicit reason the UI can show. Nothing here ever "opens" a gate by falling back to a mock.
 */
import { many, maybeOne } from "@zeb/db";
import type { CoreContext } from "./context";
import { health, readP2P, readZecUsd } from "./rates";

export type Feature = "scanPay" | "terminal" | "paymentLinks" | "withdrawals";
export interface FeatureState {
  available: boolean;
  reason: string | null;
}
export interface Readiness {
  checkedAt: Date;
  db: boolean;
  priceFeed: FeatureState;
  p2p: FeatureState;
  scanner: FeatureState;
  treasury: FeatureState;
  signer: FeatureState;
  approvals: FeatureState;
  paused: Record<string, string>;
  features: Record<Feature, FeatureState>;
}

const ok: FeatureState = { available: true, reason: null };
const no = (reason: string): FeatureState => ({ available: false, reason });

let cache: { at: number; v: Readiness } | null = null;
export function resetReadinessCache() {
  cache = null;
}

export async function readiness(ctx: CoreContext, opts: { fresh?: boolean } = {}): Promise<Readiness> {
  const now = ctx.now();
  if (!opts.fresh && cache && now.getTime() - cache.at < 5_000) return cache.v;
  const env = ctx.env;
  const isDemo = env === "demo";

  let db = true;
  let paused: Record<string, string> = {};
  try {
    const rows = await many<{ feature: string; enabled: boolean; reason: string }>(ctx.db, `SELECT feature, enabled, reason FROM feature_gates WHERE environment=$1`, [env]);
    paused = Object.fromEntries(rows.filter((r) => !r.enabled).map((r) => [r.feature, r.reason]));
  } catch {
    db = false;
  }

  const priceMaxAge = ctx.cfg.policy.priceMaxAgeSec * 1000;
  // Probe stale dependencies directly (bounded by provider timeouts) instead of trusting another process.
  if (!isDemo) {
    const probes: Promise<unknown>[] = [];
    if (ctx.oracle && (!health.lastZecOk || now.getTime() - health.lastZecOk > 30_000)) probes.push(readZecUsd(ctx).catch(() => undefined));
    if ((ctx.p2p || env === "testnet") && (!health.lastP2POk || now.getTime() - health.lastP2POk > 30_000)) probes.push(readP2P(ctx).catch(() => undefined));
    await Promise.all(probes);
  }
  const priceFeed = isDemo ? ok : !ctx.oracle ? no("No ZEC/USD price source configured") : health.lastZecOk && now.getTime() - health.lastZecOk < priceMaxAge ? ok : no(health.lastZecError ? `Live ZEC/USD rate unavailable: ${health.lastZecError}` : "Live ZEC/USD rate not yet verified");
  const p2p = isDemo ? ok : env === "testnet" && !ctx.p2p ? (health.lastP2POk && now.getTime() - health.lastP2POk < 120_000 ? ok : no(health.lastP2PError ? `INR/USDC reference rate unavailable: ${health.lastP2PError}` : "INR/USDC reference rate not yet verified")) : !ctx.p2p ? no(ctx.p2pConfigError ?? "P2P provider not configured") : health.lastP2POk && now.getTime() - health.lastP2POk < 120_000 ? ok : no(health.lastP2PError ? `P2P provider unreachable: ${health.lastP2PError}` : "P2P provider not yet verified");

  let scanner: FeatureState = isDemo ? ok : no("Zcash watcher not configured (ZCASH_GATEWAY_URL or ZKOOL_GRAPHQL_URL)");
  if (!isDemo && (ctx.cfg.zcashGateway || ctx.cfg.zkool) && db) {
    const s = await maybeOne<{ status: string; ironwood_supported: boolean; tip_height: string | null; scanned_height: string | null; tip_observed_at: Date | null; updated_at: Date }>(
      ctx.db,
      `SELECT status, ironwood_supported, tip_height, scanned_height, tip_observed_at, updated_at FROM scanner_state WHERE environment=$1 AND network=$2`,
      [env, ctx.cfg.zcashNetwork],
    );
    if (!s) scanner = no("Zcash scanner has not reported status yet");
    else if (!s.ironwood_supported) scanner = no("Zcash scanner does not report NU6.3/Ironwood support; invoice creation halted");
    else if (s.status !== "synced") scanner = no(`Zcash scanner is ${s.status}`);
    else if (now.getTime() - new Date(s.updated_at).getTime() > 120_000) scanner = no("Zcash scanner status is stale");
    else if (s.tip_height && s.scanned_height && BigInt(s.tip_height) - BigInt(s.scanned_height) > BigInt(ctx.cfg.policy.scannerMaxLagBlocks)) scanner = no("Zcash scanner is behind the chain tip");
    else if (s.tip_observed_at && now.getTime() - new Date(s.tip_observed_at).getTime() > ctx.cfg.policy.scannerMaxTipAgeSec * 1000) scanner = no("Zcash chain tip is stale");
    else scanner = ok;
  }

  let treasury: FeatureState = ok;
  if (db) {
    const inv = await maybeOne<{ observed_at: Date }>(ctx.db, `SELECT observed_at FROM treasury_inventory WHERE environment=$1 AND asset='USDC_BASE' ORDER BY observed_at DESC LIMIT 1`, [env]);
    if (!inv) treasury = no("USDC treasury balance has never been verified");
    else if (now.getTime() - new Date(inv.observed_at).getTime() > ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000) treasury = no("USDC treasury balance is stale");
  } else treasury = no("database unavailable");

  const signer = isDemo ? ok : ctx.cfg.signer.mode === "none" ? no("No Base treasury signer configured") : ctx.caps.canSubmitTransactions ? ok : no(`Transactions are not permitted in ${env}`);
  const approvals = env === "mainnet-enabled" && (!ctx.cfg.approvals.legal || !ctx.cfg.approvals.provider) ? no("Legal and provider approvals are not recorded (LEGAL_APPROVAL_REF / PROVIDER_APPROVAL_REF)") : ok;

  const receiving = (): FeatureState => {
    if (!db) return no("Service unavailable");
    if (!ctx.caps.canIssueReceivingAddress) return no(`Receiving payments is disabled in ${env}`);
    if (!approvals.available) return approvals;
    if (!ctx.allocator) return no("Zcash watcher not configured");
    for (const s of ctx.env === "testnet" ? [scanner, priceFeed, p2p] : [scanner, priceFeed, p2p, treasury]) if (!s.available) return s;
    return ok;
  };
  const gate = (feature: Feature, base: FeatureState): FeatureState => (paused[feature] ? no(`Paused: ${paused[feature]}`) : paused.all ? no(`Paused: ${paused.all}`) : base);

  const recv = receiving();
  // HACKATHON_TESTNET: Scan & Pay accepts real TAZ; the INR payout leg is shown as disabled, not faked.
  const scanPayBase = !recv.available ? recv : env === "testnet" || signer.available ? ok : no(`Scan & Pay payouts unavailable: ${signer.reason}`);
  const withdrawBase = !db ? no("Service unavailable") : !ctx.caps.creditsRedeemable && !isDemo ? no(`Credits are not redeemable in ${env}`) : !approvals.available ? approvals : !p2p.available ? p2p : !signer.available ? signer : !treasury.available ? treasury : ok;

  const v: Readiness = {
    checkedAt: now,
    db,
    priceFeed,
    p2p,
    scanner,
    treasury,
    signer,
    approvals,
    paused,
    features: {
      scanPay: gate("scanPay", scanPayBase),
      terminal: gate("terminal", recv),
      paymentLinks: gate("paymentLinks", recv),
      withdrawals: gate("withdrawals", withdrawBase),
    },
  };
  cache = { at: now.getTime(), v };
  return v;
}

export function featureFor(mode: "scan_pay" | "terminal" | "counter_qr" | "payment_link"): Feature {
  return mode === "scan_pay" ? "scanPay" : mode === "payment_link" ? "paymentLinks" : "terminal";
}
