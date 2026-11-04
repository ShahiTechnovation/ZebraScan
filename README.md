# Zeb Scan — Pay in ZEC. They get INR.

Monorepo: Next.js frontend, Fastify API, durable worker, watch-only Zcash gateway (Rust), shared typed packages.

> **Status:** demo + connected-to-DEMO-backend fully working and tested. **No live money is enabled.** Testnet/mainnet money paths are gated closed until the blockers in [`docs/READINESS_REPORT.md`](docs/READINESS_REPORT.md) are resolved (Zcash gateway build/proof, verified P2P.me configuration and permission, KMS, legal approval).

## Layout
```
apps/web        Next.js 15 UI (demo adapters + live adapters)
apps/api        Fastify API (/api/v1, OpenAPI 3.1, SSE)
apps/worker     PostgreSQL-leased jobs: payouts (P2P PAY/SELL), unlocks, expiry, scanner, reconciliation, email
services/zcash-gateway   Rust, UIVK-only receiving service (NOT yet compiled — see its README)
packages/*      domain · db · ledger · security · providers · contracts · core
tests/          unit · contracts · integration · chaos     (web e2e under apps/web/tests)
infra/          docker, deploy notes        docs/   architecture, ADRs, API, security, runbooks, evidence
```

## Quick start (local, DEMO backend)
```bash
pnpm install
cp .env.example .env && pnpm exec tsx scripts/gen-dev-secrets.ts >> .env   # then set DATABASE_URL
pnpm db:migrate
NEXT_PUBLIC_ZEB_MODE=connected NEXT_PUBLIC_API_BASE_URL=http://localhost:4000 pnpm dev
```
Frontend-only demo (no backend): `pnpm --filter @zeb/web dev` with `NEXT_PUBLIC_ZEB_MODE=demo`.

## Commands
| | |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | all workspaces |
| `pnpm test` | unit + contract + web unit |
| `TEST_DATABASE_URL=…_test pnpm test:integration` | API/worker flows, fault injection, reconciliation on real PostgreSQL |
| `pnpm test:e2e` | demo-mode browser E2E (build web first) |
| `E2E_DATABASE_URL=…_test pnpm test:e2e:connected` | browser → API → PostgreSQL ← worker |
| `pnpm verify:external` | read-only checks of price feeds, Base/USDC, SDK, crates → `docs/evidence/` |
| `pnpm verify:prod-config` | deployment gate (exit 1 on any FAIL) |
| `pnpm reconcile`, `pnpm openapi`, `pnpm seed:test` | ops helpers (seed refuses mainnet) |

## Docs
[Readiness](docs/READINESS_REPORT.md) · [Dependency matrix](docs/EXTERNAL_DEPENDENCY_VERIFICATION.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Quote formula](docs/QUOTE_FORMULA.md) · [Security](docs/SECURITY.md) · [Runbooks](docs/RUNBOOKS.md) · [Integration](docs/INTEGRATION_HANDOFF.md)

Shielded ZEC protects on-chain details only; the INR payout provider and banks still see banking information. Zeb Scan is custodial and merchant balances are INR-denominated platform credits, not bank money.
