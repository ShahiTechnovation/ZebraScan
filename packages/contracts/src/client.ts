/**
 * Typed API client derived from the route table. Browser-safe (fetch only). Used by the web app's
 * connected adapters. Responses are validated with the same Zod schemas the server uses, so a
 * contract drift fails loudly instead of rendering a wrong number.
 */
import { ROUTES, type BodyOf, type OperationId, type ParamsOf, type QueryOf, type ResponseOf } from "./routes";
import type { ApiError } from "./schemas";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message);
    this.name = "ApiClientError";
  }
  get code() {
    return this.body.code;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Read the CSRF token for cookie-authenticated mutations. */
  csrfToken?: () => string | null;
  /** Bearer token for scoped (checkout) access, per resource. */
  accessToken?: (resourceId: string | undefined) => string | null;
  fetchImpl?: typeof fetch;
  /** Generate an Idempotency-Key. Callers should pass one explicitly to make retries safe. */
  newKey?: () => string;
}

type Args<K extends OperationId> = (ParamsOf<K> extends undefined ? { params?: undefined } : { params: ParamsOf<K> }) &
  (BodyOf<K> extends undefined ? { body?: undefined } : { body: BodyOf<K> }) &
  (QueryOf<K> extends undefined ? { query?: undefined } : { query?: QueryOf<K> }) & { idempotencyKey?: string; accessToken?: string; signal?: AbortSignal };

function randomKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createApiClient(opts: ClientOptions) {
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call<K extends OperationId>(op: K, args: Args<K> = {} as Args<K>): Promise<ResponseOf<K>> {
    const def = ROUTES[op];
    const params = (args.params ?? {}) as Record<string, string>;
    let path: string = def.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
    if (args.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) path += `?${s}`;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (def.method !== "GET") {
      headers["content-type"] = "application/json";
      const csrf = opts.csrfToken?.();
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    if (def.idempotent) headers["idempotency-key"] = args.idempotencyKey ?? (opts.newKey ?? randomKey)();
    const token = args.accessToken ?? opts.accessToken?.(params.id);
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await f(`${opts.baseUrl}${path}`, {
      method: def.method,
      headers,
      credentials: "include",
      body: def.method === "GET" ? undefined : JSON.stringify(args.body ?? {}),
      signal: args.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const body = (json as ApiError) ?? { code: "SYSTEM_BAD_RESPONSE", message: `HTTP ${res.status}`, requestId: "", retryable: res.status >= 500 };
      throw new ApiClientError(res.status, body);
    }
    const parsed = def.response.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError(502, { code: "SYSTEM_CONTRACT_MISMATCH", message: `Response for ${op} did not match the contract`, requestId: res.headers.get("x-request-id") ?? "", retryable: false });
    }
    return parsed.data as ResponseOf<K>;
  }
  return { call };
}
export type ApiClient = ReturnType<typeof createApiClient>;
