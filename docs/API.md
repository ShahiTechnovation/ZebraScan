# API conventions (v1)

* Base `/api/v1`; OpenAPI 3.1: [`docs/api/openapi.json`](api/openapi.json) (regenerate with `pnpm openapi`; CI fails if stale) and live at `GET /api/v1/openapi.json`.
* Money is always a base-10 integer **string** in minor units: `inrPaise`, `zecZatoshis`, `usdcMicros`. Timestamps ISO-8601 UTC.
* Errors: `{ code, message, requestId, retryable, details?, currentStatus? }`, codes namespaced (`AUTH_*`, `QR_*`, `QUOTE_*`, `WALLET_*`, `LIQUIDITY_*`, `P2P_*`, `COMPLIANCE_*`, `LEDGER_*`, `WITHDRAWAL_*`, `RATE_*`, `STATE_*`, `SYSTEM_*`). Rejected state transitions → 409 with `currentStatus`.
* `Idempotency-Key` required on every public state-changing command; scoped to principal + operation + body hash; replays return the original response (`Idempotent-Replayed: true`); same key, different body → 409 `IDEMPOTENCY_KEY_REUSED`. Retention 48 h (30 days for money commands).
* `X-Request-Id` accepted/echoed. GETs return weak `ETag`; send `If-None-Match` for 304 polling.
* Realtime: `GET /api/v1/events?resource=checkout:{id}|withdrawal:{id}|merchant:me` (SSE, `Last-Event-ID` replay, 15 s heartbeat, access re-checked every 30 s, 30 min max).
* Health: `/healthz` (process), `/readyz` (per-feature capabilities; 503 only when the DB is down).
* Clients: `@zeb/contracts` `createApiClient()` validates responses against the same schemas.
