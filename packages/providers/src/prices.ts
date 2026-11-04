/**
 * ZEC/USD market-rate oracle. This is a REFERENCE price for quoting, never a promise of execution.
 * Sources (verified 2026-11-04, see docs/EXTERNAL_DEPENDENCY_VERIFICATION.md):
 *  - CoinGecko  GET /api/v3/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true
 *  - Kraken     GET /0/public/AssetPairs?pair=ZECUSD  -> resolves pair key (XZECZUSD)
 *               GET /0/public/Ticker?pair=<key>        -> a=[ask], b=[bid], c=[last]
 * Policy: require >= minSources fresh sources, reject spreads/deviation over thresholds, take the
 * median. Values stay exact decimal strings -> Rational; no float arithmetic.
 */
import { DomainError, deviationBps, median, parseRational, toDecimalString, type Rational } from "@zeb/domain";
import { fetchJson, type FetchOpts } from "./http";

export interface PriceObservation {
  source: string;
  rate: Rational;
  rateText: string;
  bid?: string;
  ask?: string;
  observedAt: Date;
  fetchedAt: Date;
  raw: unknown;
}

export interface PriceSource {
  readonly name: string;
  fetch(): Promise<PriceObservation>;
}

/** Normalise a provider decimal (strings or JSON numbers) into an exact decimal string. */
export function decimalText(v: unknown, field: string): string {
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) && /[1-9]/.test(v)) return v;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // JSON numbers from the provider: take the shortest round-trip repr, reject exponents.
    const s = String(v);
    if (/^\d+(\.\d+)?$/.test(s)) return s;
  }
  throw new DomainError("RATE_PROVIDER_MALFORMED", `${field} is not a positive decimal`);
}

export class CoinGeckoSource implements PriceSource {
  readonly name = "coingecko";
  constructor(private opts: { baseUrl?: string; apiKey?: string; http?: FetchOpts } = {}) {}
  async fetch(): Promise<PriceObservation> {
    const base = this.opts.baseUrl ?? "https://api.coingecko.com/api/v3";
    const headers: Record<string, string> = this.opts.apiKey ? { "x-cg-demo-api-key": this.opts.apiKey } : {};
    const raw = await fetchJson<{ zcash?: { usd?: unknown; last_updated_at?: unknown } }>(
      `${base}/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true&precision=full`,
      { ...this.opts.http, headers },
    );
    const usd = raw.zcash?.usd;
    const ts = raw.zcash?.last_updated_at;
    if (typeof ts !== "number") throw new DomainError("RATE_PROVIDER_MALFORMED", "coingecko response missing last_updated_at");
    const text = decimalText(usd, "coingecko zcash.usd");
    return { source: this.name, rate: parseRational(text), rateText: text, observedAt: new Date(ts * 1000), fetchedAt: new Date(), raw };
  }
}

export class KrakenSource implements PriceSource {
  readonly name = "kraken";
  private pairKey: string | null = null;
  constructor(private opts: { baseUrl?: string; http?: FetchOpts } = {}) {}

  private async resolvePair(base: string): Promise<string> {
    if (this.pairKey) return this.pairKey;
    const r = await fetchJson<{ error: string[]; result?: Record<string, { altname?: string; base?: string; quote?: string }> }>(
      `${base}/0/public/AssetPairs?pair=ZECUSD`,
      this.opts.http,
    );
    if (r.error?.length) throw new DomainError("RATE_PROVIDER_ERROR", `kraken AssetPairs: ${r.error.join(";").slice(0, 120)}`);
    const entry = Object.entries(r.result ?? {}).find(([, v]) => v.altname === "ZECUSD" && v.quote === "ZUSD");
    if (!entry) throw new DomainError("RATE_PROVIDER_MALFORMED", "kraken ZECUSD pair not found");
    this.pairKey = entry[0];
    return entry[0];
  }

  async fetch(): Promise<PriceObservation> {
    const base = this.opts.baseUrl ?? "https://api.kraken.com";
    const key = await this.resolvePair(base);
    const r = await fetchJson<{ error: string[]; result?: Record<string, { a: string[]; b: string[]; c: string[] }> }>(
      `${base}/0/public/Ticker?pair=${encodeURIComponent(key)}`,
      this.opts.http,
    );
    if (r.error?.length) throw new DomainError("RATE_PROVIDER_ERROR", `kraken Ticker: ${r.error.join(";").slice(0, 120)}`);
    const t = r.result?.[key];
    if (!t) throw new DomainError("RATE_PROVIDER_MALFORMED", "kraken ticker missing pair");
    const ask = decimalText(t.a[0], "kraken ask");
    const bid = decimalText(t.b[0], "kraken bid");
    const a = parseRational(ask);
    const b = parseRational(bid);
    // Mid price as an exact rational.
    const mid: Rational = { n: a.n * b.d + b.n * a.d, d: 2n * a.d * b.d };
    const now = new Date();
    // Kraken's public ticker has no timestamp; fetch time is the observation time.
    return { source: this.name, rate: mid, rateText: toDecimalString(mid, 8), bid, ask, observedAt: now, fetchedAt: now, raw: { pair: key, a: t.a, b: t.b, c: t.c } };
  }
}

export interface OraclePolicy {
  minSources: number;
  maxAgeMs: number;
  maxDeviationBps: number;
  maxBidAskSpreadBps: number;
}

export interface OracleReading {
  rate: Rational;
  rateText: string;
  observations: PriceObservation[];
  failures: Array<{ source: string; error: string }>;
  observedAt: Date;
}

export class ZecUsdOracle {
  constructor(
    private sources: PriceSource[],
    private policy: OraclePolicy,
  ) {
    if (sources.length === 0) throw new Error("oracle needs at least one source");
  }

  async read(now = new Date()): Promise<OracleReading> {
    const settled = await Promise.allSettled(this.sources.map((s) => s.fetch()));
    const obs: PriceObservation[] = [];
    const failures: Array<{ source: string; error: string }> = [];
    settled.forEach((r, i) => {
      const name = this.sources[i]!.name;
      if (r.status === "rejected") return failures.push({ source: name, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 200) });
      const o = r.value;
      if (!Number.isFinite(o.observedAt.getTime()) || o.observedAt.getTime() > now.getTime()+30_000 || o.rate.n <= 0n || o.rate.d <= 0n) return failures.push({ source: name, error: "invalid or future price observation" });
      if (now.getTime() - o.observedAt.getTime() > this.policy.maxAgeMs) return failures.push({ source: name, error: "stale" });
      if (o.bid && o.ask) {
        const spread = deviationBps(parseRational(o.bid), parseRational(o.ask));
        if (spread > BigInt(this.policy.maxBidAskSpreadBps)) return failures.push({ source: name, error: `bid/ask spread ${spread}bps too wide` });
      }
      obs.push(o);
    });
    if (obs.length < this.policy.minSources) {
      throw new DomainError("RATE_UNAVAILABLE", `Live ZEC/USD rate unavailable (${obs.length}/${this.policy.minSources} sources)`, { failures }, { retryable: true });
    }
    for (let i = 0; i < obs.length; i++)
      for (let j = i + 1; j < obs.length; j++) {
        const dev = deviationBps(obs[i]!.rate, obs[j]!.rate);
        if (dev > BigInt(this.policy.maxDeviationBps)) {
          throw new DomainError("RATE_DIVERGENCE", `ZEC/USD sources disagree by ${dev}bps`, { sources: obs.map((o) => [o.source, o.rateText]) }, { retryable: true });
        }
      }
    const rate = median(obs.map((o) => o.rate));
    const oldest = obs.reduce((m, o) => (o.observedAt < m ? o.observedAt : m), obs[0]!.observedAt);
    return { rate, rateText: toDecimalString(rate, 8), observations: obs, failures, observedAt: oldest };
  }
}
