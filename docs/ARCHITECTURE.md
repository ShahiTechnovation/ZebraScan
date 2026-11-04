# Architecture

```
browser ──HTTPS──▶ apps/web (Next.js 15)          no keys, masked data only
   │  cookie session + CSRF / scoped checkout token
   ▼
apps/api (Fastify) ──SQL──▶ PostgreSQL 16+  ◀──SQL── apps/worker (durable jobs)
   │   no signing keys        source of truth          │  only process that may sign (Base)
   │                          ledger · outbox · jobs   │
   └──mTLS──▶ services/zcash-gateway (Rust, UIVK only) ◀┘  pull deposits / push events
                     │ gRPC (TLS)                        │ viem + @p2pdotme/sdk (guarded)
                     ▼                                   ▼
               Zaino / lightwalletd / Zebra        Base (P2P Diamond, Circle USDC)
```

## Packages

| Path | Role |
| --- | --- |
| `packages/domain` | money, rationals, quote formula, state machines, UPI, ZIP-321, environments — pure |
| `packages/db` | pg pool, `tx()` with serialization retry, checksummed migrations |
| `packages/ledger` | chart of accounts, journal posting, balances, treasury allocations |
| `packages/security` | Argon2id, envelope encryption, scoped tokens, TOTP, RBAC, redaction |
| `packages/providers` | price feeds/oracle, P2P client + guarded wallet, signers, gateway client, email |
| `packages/contracts` | Zod DTOs, route table, OpenAPI generator, typed browser client |
| `packages/core` | config, context, all domain commands (quotes, intents, deposits, credits, withdrawals, payouts, reconciliation, jobs) shared by API and worker |

## Money-changing invariants

1. Every money-changing command runs in one PostgreSQL transaction that locks the aggregate, validates the transition, posts balanced journals, writes SSE/outbox events and bumps the version.
2. Frontend callbacks never advance financial state; only scanner events (gateway) and authoritative on-chain reads (worker) do.
3. Each journal balances per currency (enforced in code and by a deferred DB trigger); history is append-only.
4. A USDC obligation has at most one active allocation; allocations never exceed a fresh chain observation.
5. Reserved credits return to available only through a compensating journal after the chain proves nothing is in flight.

## State machines

See `packages/domain/src/states.ts` (intent, payout, credit, withdrawal, merchant, link). Unit tests assert illegal transitions are rejected.

## ADRs

* [0001 Monorepo, Fastify, PostgreSQL as authority](adr/0001-stack.md)
* [0002 No custom contracts; P2P.me via the official SDK](adr/0002-no-custom-contracts.md)
* [0003 Watch-only Rust gateway on librustzcash](adr/0003-zcash-gateway.md)
* [0004 Hold USDC at intent, not at quote](adr/0004-holds-at-intent.md)
* [0005 Demo environment in the backend](adr/0005-demo-environment.md)
