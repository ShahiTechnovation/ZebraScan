/** Small HTTP helper: timeout, bounded retries with jitter, and a per-host circuit breaker. */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface Breaker {
  failures: number;
  openUntil: number;
}
const breakers = new Map<string, Breaker>();

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const host = new URL(url).host;
  const br = breakers.get(host) ?? { failures: 0, openUntil: 0 };
  breakers.set(host, br);
  if (br.openUntil > Date.now()) throw new HttpError(`circuit open for ${host}`, null, true);
  const retries = opts.retries ?? 2;
  const f = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5_000);
    try {
      const res = await f(url, {
        method: opts.method ?? "GET",
        headers: { accept: "application/json", "user-agent": "zeb-scan/0.2 (+server)", ...opts.headers },
        body: opts.body,
        signal: ac.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new HttpError(`HTTP ${res.status} from ${host}`, res.status, retryable);
      }
      const json = (await res.json()) as T;
      br.failures = 0;
      return json;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof HttpError ? e.retryable : true;
      if (!retryable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.floor(Math.random() * 150)));
    } finally {
      clearTimeout(t);
    }
  }
  br.failures += 1;
  if (br.failures >= 5) br.openUntil = Date.now() + 30_000;
  throw lastErr instanceof Error ? lastErr : new HttpError(String(lastErr), null, true);
}

export function resetBreakers() {
  breakers.clear();
}
