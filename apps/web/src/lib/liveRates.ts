/**
 * Browser-side cache of live reference rates from /api/rates (CoinGecko + Kraken median).
 * Used by the demo-mode quote builder so displayed ZEC amounts match the real market, not a
 * hard-coded constant. Exact integer units: usdMicroPerZec (1e-6 USD), inrPerUsdcMinor (paise).
 */
export interface LiveRates {
  usdMicroPerZec: number;
  inrPerUsdcMinor: number;
  provider: string;
  fetchedAt: number;
}

const FRESH_MS = 120_000;
let cached: LiveRates | null = null;
let inflight: Promise<LiveRates | null> | null = null;

/** Latest live rates if fetched within the last 2 minutes, else null (caller falls back, labelled). */
export function latestLiveRates(now = Date.now()): LiveRates | null {
  return cached && now - cached.fetchedAt < FRESH_MS ? cached : null;
}

export async function fetchLiveRates(): Promise<LiveRates | null> {
  if (typeof window === "undefined") return null;
  const fresh = latestLiveRates();
  if (fresh && Date.now() - fresh.fetchedAt < 30_000) return fresh;
  inflight ??= (async () => {
    try {
      const r = await fetch("/api/rates", { cache: "no-store" });
      if (!r.ok) return latestLiveRates();
      const j = (await r.json()) as { ok?: boolean; zecUsd?: number; inrPerUsdc?: number; provider?: string };
      if (!j.ok || !(typeof j.zecUsd === "number" && j.zecUsd > 0) || !(typeof j.inrPerUsdc === "number" && j.inrPerUsdc > 0)) return latestLiveRates();
      cached = {
        usdMicroPerZec: Math.round(j.zecUsd * 1_000_000),
        inrPerUsdcMinor: Math.round(j.inrPerUsdc * 100),
        provider: j.provider ?? "Live market reference",
        fetchedAt: Date.now(),
      };
      return cached;
    } catch {
      return latestLiveRates();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
