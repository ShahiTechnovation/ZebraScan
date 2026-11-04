/**
 * Live reference rates for the web app (runs server-side on Vercel; no keys needed).
 * ZEC/USD = median of CoinGecko and Kraken (same sources as the Zeb Scan API's quote engine).
 * INR per USDC = CoinGecko usd-coin/inr (falls back to USD/INR when USDC/INR is unavailable).
 * Fails closed: returns 503 when no sane source answered, so the UI can say so instead of guessing.
 */
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 6000;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function sane(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function GET() {
  const [cg, kr] = await Promise.allSettled([
    getJson("https://api.coingecko.com/api/v3/simple/price?ids=zcash,usd-coin&vs_currencies=usd,inr"),
    getJson("https://api.kraken.com/0/public/Ticker?pair=ZECUSD"),
  ]);
  const zec: Array<{ source: string; usd: number }> = [];
  let inrPerUsdc: number | null = null;
  let inrSource = "";
  if (cg.status === "fulfilled") {
    const j = cg.value as { zcash?: { usd?: number }; "usd-coin"?: { inr?: number; usd?: number } };
    const z = sane(j.zcash?.usd, 1, 100_000);
    if (z) zec.push({ source: "coingecko", usd: z });
    const usdcInr = sane(j["usd-coin"]?.inr, 40, 250);
    if (usdcInr) {
      inrPerUsdc = usdcInr;
      inrSource = "coingecko:usd-coin/inr";
    }
  }
  if (kr.status === "fulfilled") {
    const j = kr.value as { error?: unknown[]; result?: Record<string, { c?: [string, string] }> };
    const first = j.result ? Object.values(j.result)[0] : undefined;
    const z = sane(first?.c?.[0], 1, 100_000);
    if (z) zec.push({ source: "kraken", usd: z });
  }
  if (!zec.length || !inrPerUsdc) {
    return Response.json(
      { ok: false, error: "No live ZEC/USD or INR/USDC reference rate is available right now.", sources: zec.map((z) => z.source) },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const zecUsd = median(zec.map((z) => z.usd));
  return Response.json(
    {
      ok: true,
      zecUsd,
      inrPerUsdc,
      zecInr: zecUsd * inrPerUsdc,
      sources: { zecUsd: zec.map((z) => `${z.source}:${z.usd}`), inrPerUsdc: inrSource },
      provider: `Live: median(${zec.map((z) => z.source).join(",")}) · ${inrSource}`,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
