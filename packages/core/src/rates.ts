/**
 * Rate reads with short in-process caches and persisted, hashed snapshots for audit.
 * Demo uses fictional constants (1 ZEC = $45, 1 USDC = ₹90) that are ONLY reachable in `demo`.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "@zeb/db";
import { DomainError, newId, parseRational, type Rational } from "@zeb/domain";
import { canonicalJson } from "@zeb/security";
import { decimalText, fetchJson } from "@zeb/providers";
import type { CoreContext } from "./context";

export interface ZecUsdRead {
  rate: Rational;
  rateText: string;
  source: string;
  observedAt: Date;
  sources: Array<{ source: string; rate: string; bid?: string; ask?: string; observedAt: string }>;
  confidence: "multi_source" | "single_source";
}

export interface P2PRead {
  sellPrice6: bigint;
  fee: { smallOrderThreshold: bigint; smallOrderFixedFeePay: bigint; smallOrderFixedFeeSell: bigint };
  source: string;
  observedAt: Date;
}

export const DEMO_RATES = {
  zecUsd: "45",
  sellPrice6: 90_000_000n,
  fee: { smallOrderThreshold: 10_000_000n, smallOrderFixedFeePay: 50_000n, smallOrderFixedFeeSell: 50_000n },
  source: "demo-constants (fictional, not market data)",
} as const;

let zecCache: { at: number; v: ZecUsdRead } | null = null;
let p2pCache: { at: number; v: P2PRead } | null = null;
export const health = {
  lastZecOk: 0,
  lastZecError: null as string | null,
  lastP2POk: 0,
  lastP2PError: null as string | null,
};

export function resetRateCaches() {
  zecCache = null;
  p2pCache = null;
}

export async function readZecUsd(ctx: CoreContext): Promise<ZecUsdRead> {
  const now = ctx.now();
  if (ctx.env === "demo") {
    return {
      rate: parseRational(DEMO_RATES.zecUsd),
      rateText: DEMO_RATES.zecUsd,
      source: DEMO_RATES.source,
      observedAt: now,
      sources: [{ source: DEMO_RATES.source, rate: DEMO_RATES.zecUsd, observedAt: now.toISOString() }],
      confidence: "single_source",
    };
  }
  if (zecCache && now.getTime() - zecCache.at < 10_000) return zecCache.v;
  if (!ctx.oracle) throw new DomainError("RATE_UNAVAILABLE", "No ZEC/USD price source configured", undefined, { retryable: false });
  try {
    const r = await ctx.oracle.read(now);
    const v: ZecUsdRead = {
      rate: r.rate,
      rateText: r.rateText,
      source: `median(${r.observations.map((o) => o.source).join(",")})`,
      observedAt: r.observedAt,
      sources: r.observations.map((o) => ({ source: o.source, rate: o.rateText, bid: o.bid, ask: o.ask, observedAt: o.observedAt.toISOString() })),
      confidence: r.observations.length > 1 ? "multi_source" : "single_source",
    };
    zecCache = { at: now.getTime(), v };
    health.lastZecOk = now.getTime();
    health.lastZecError = null;
    return v;
  } catch (e) {
    health.lastZecError = (e as Error).message;
    throw e;
  }
}

export async function readP2P(ctx: CoreContext): Promise<P2PRead> {
  const now = ctx.now();
  if (ctx.env === "demo") return { sellPrice6: DEMO_RATES.sellPrice6, fee: { ...DEMO_RATES.fee }, source: DEMO_RATES.source, observedAt: now };
  if (p2pCache && now.getTime() - p2pCache.at < 15_000) return p2pCache.v;
  if (!ctx.p2p && ctx.env === "testnet") return testnetReference(ctx, now);
  if (!ctx.p2p) throw new DomainError("LIQUIDITY_PROVIDER_UNAVAILABLE", ctx.p2pConfigError ?? "P2P provider not configured", undefined, { retryable: false });
  try {
    const [sellPrice6, fee] = await Promise.all([ctx.p2p.sellPrice6(), ctx.p2p.feeConfig()]);
    const v: P2PRead = {
      sellPrice6,
      fee: { smallOrderThreshold: fee.smallOrderThreshold, smallOrderFixedFeePay: fee.smallOrderFixedFeePay, smallOrderFixedFeeSell: fee.smallOrderFixedFeeSell },
      source: `p2p-diamond:${ctx.p2p.cfg.chainId}:${ctx.p2p.cfg.diamondAddress}`,
      observedAt: now,
    };
    p2pCache = { at: now.getTime(), v };
    health.lastP2POk = now.getTime();
    health.lastP2PError = null;
    return v;
  } catch (e) {
    health.lastP2PError = (e as Error).message;
    throw e;
  }
}

/**
 * HACKATHON_TESTNET only: a real USDC/INR market reference (CoinGecko usd-coin/inr) so quotes show
 * honest INR values. No P2P fee applies because no payout is ever executed on testnet.
 */
async function testnetReference(_ctx: CoreContext, now: Date): Promise<P2PRead> {
  if (p2pCache && now.getTime() - p2pCache.at < 60_000) return p2pCache.v;
  try {
    const r = await fetchJson<{ "usd-coin"?: { inr?: unknown; last_updated_at?: number } }>("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=inr&include_last_updated_at=true", { timeoutMs: 5_000 });
    const text = decimalText(r["usd-coin"]?.inr, "coingecko usd-coin.inr");
    const [w = "0", f = ""] = text.split(".");
    const sellPrice6 = BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
    const v: P2PRead = { sellPrice6, fee: { smallOrderThreshold: 0n, smallOrderFixedFeePay: 0n, smallOrderFixedFeeSell: 0n }, source: "coingecko:usd-coin/inr (HACKATHON_TESTNET reference — no payout)", observedAt: new Date((r["usd-coin"]?.last_updated_at ?? now.getTime() / 1000) * 1000) };
    p2pCache = { at: now.getTime(), v };
    health.lastP2POk = now.getTime();
    health.lastP2PError = null;
    return v;
  } catch (e) {
    health.lastP2PError = (e as Error).message;
    throw new DomainError("RATE_UNAVAILABLE", "INR/USDC reference rate unavailable", undefined, { retryable: true });
  }
}

export async function persistSnapshot(q: Queryable, ctx: CoreContext, kind: "zec_usd" | "p2p_price" | "p2p_fee", source: string, value: string, payload: unknown, observedAt: Date): Promise<string> {
  const id = newId("rateSnapshot");
  const body = canonicalJson(payload);
  await q.query(`INSERT INTO rate_snapshots(id, environment, kind, source, value, payload, observed_at, payload_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    id,
    ctx.env,
    kind,
    source,
    value,
    body,
    observedAt,
    createHash("sha256").update(body).digest("hex"),
  ]);
  return id;
}
