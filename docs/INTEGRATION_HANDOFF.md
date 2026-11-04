# Frontend ↔ backend integration (implemented)

The frontend's adapter contracts (`apps/web/src/services/adapters.ts`) now have live implementations in `apps/web/src/services/live/`, registered when `NEXT_PUBLIC_ZEB_MODE=connected` **and** `NEXT_PUBLIC_API_BASE_URL` is set. Without the URL, connected mode still shows "Live payments are not connected" — there is no fallback to demo.

| UI need | Backend |
| --- | --- |
| Rates / quote preview | `GET /rates/zec-usd`, `GET /rates/inr-usdc`, `POST /quotes` (errors are shown, never a fallback number) |
| Scan & Pay / terminal / counter / link checkout | `POST /quotes` → `POST /scan-pay/intents` · `/merchant-terminal/intents` · `/m/{handle}/checkouts` · `/pay/{slug}/checkouts`; access token stored per checkout |
| Live status | SSE `/events?resource=checkout:{id}` + polling fallback; `GET /checkout/{id}` |
| Refresh expired invoice | `POST /checkout/{id}/refresh` (new quote + new address) |
| Exceptions | refund-address form → `POST /checkout/{id}/refund-details` |
| Merchant data | `/merchants/session`, `/links`, `/transactions`, `/settlements`, `/balance/entries`, `/withdrawals`, `/receipts/{id}`; SSE `merchant:me` |
| Auth | `/auth/register|login|logout|verify-email|forgot-password|reset-password|step-up` (step-up dialog on `AUTH_STEP_UP_REQUIRED`) |
| Simulator controls | only when the backend reports `environment: "demo"` (`/demo/checkout/{id}/…`) |

Mapping notes: backend states without a UI equivalent map to the new honest `under_review` (deposit/P2P/withdrawal) and `cancelling` (withdrawal) statuses; the P2P small-order fee is shown as a fixed protocol fee (0 bps); VPAs are only ever displayed masked.
