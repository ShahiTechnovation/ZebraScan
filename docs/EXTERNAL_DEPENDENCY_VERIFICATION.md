# External dependency verification matrix

Checked **2026-11-04** (Asia/Kolkata) with `pnpm verify:external` (read-only; never signs or sends).
Raw evidence: [`docs/evidence/external-verification-2026-11-04.json`](evidence/external-verification-2026-11-04.json).
Re-run before every environment promotion. **Unknowns are not invented**: anything not verified is `blocked` and its feature gate stays closed.

| Dependency | Version / ref | Verified via | Network | Addresses / identifiers | Auth / approval needed | Error model | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **ZEC/USD — CoinGecko** | `/api/v3/simple/price` | live call | n/a | `ids=zcash`, `include_last_updated_at` | none (optional demo/pro key; check ToS before production) | HTTP 429/5xx retried with jitter + per-host circuit breaker | **verified** — $1286.1955 @ 13:21:34Z |
| **ZEC/USD — Kraken** | `/0/public/AssetPairs` → `/0/public/Ticker` | live call | n/a | pair resolved at runtime: `XZECZUSD` (altname `ZECUSD`, quote `ZUSD`) | none | `error[]` array → typed `RATE_PROVIDER_ERROR` | **verified** — bid 1282.50 / ask 1283.13 |
| **Oracle policy** | `packages/providers/src/prices.ts` | live call | n/a | median of ≥2 fresh sources, ≤150 bps deviation, ≤120 s age, ≤200 bps bid/ask | — | `RATE_UNAVAILABLE`, `RATE_DIVERGENCE` (no fallback number) | **verified** — median 1282.815 (sources 25 bps apart) |
| **Base mainnet RPC** | `https://mainnet.base.org` | `eth_chainId`, `getCode`, ERC-20 reads | Base 8453 | — | none (public RPC rate-limited; use a dedicated provider in prod) | viem errors → typed | **verified** — chain 8453 |
| **Circle native USDC (Base)** | Circle docs | on-chain `symbol()`/`decimals()`/code hash | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, code hash `0xa6705a10…fefab` | — | config validation rejects any other address (USDbC `0xd9aA…b6CA` explicitly rejected; returns `USDbC`) | **verified** |
| **Circle USDC (Base Sepolia)** | Circle docs | on-chain reads | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, code hash `0xedc5281a…9d6c` | — | — | **verified** |
| **@p2pdotme/sdk** | `1.3.10` (exact pin; = npm latest), upstream HEAD `e453d2f1` | npm registry + source read of `orders.d.ts`, `example/make-pay-order.ts`, `src/orders/README.md` | Base | deps viem 2.47.6, zod 4.3.6, neverthrow 8.2.0 | — | `neverthrow` `Result`; `OrdersErrorCode` mapped to ambiguous / non-ambiguous submission | **verified** (package) |
| **P2P.me Diamond / subgraph / ABI / code hash** | — | — | Base / Base Sepolia | **none supplied** (official examples use `0x000…` placeholders) | integrator whitelist, circle access, payout rights for third-party beneficiaries, limits | — | **blocked** |
| **P2P liquidity & permission** | — | — | — | treasury wallet eligibility, placement limits (subgraph is advisory) | provider + legal confirmation | — | **blocked** |
| **Funded Base treasury signer** | — | — | — | none | remote isolated signer (mainnet); key file allowed only on Base Sepolia | — | **blocked** |
| **librustzcash crates** | `zcash_client_backend 0.25.0`, `zcash_client_sqlite 0.23.0`, `zcash_keys 0.17.0`, `zcash_address 0.14.0`, `zcash_protocol 0.11.0`, `zip321 0.10.0`, `zip32 0.3.0` (all published 2026-10-21 / 09-29) | crates.io API | — | — | — | — | **verified** (versions); Ironwood/NU7 support in these exact versions **not yet confirmed by build/test** |
| **Zebra / Zaino** | Zebra `v7.0.0` (2026-10-22), Zaino `0.10.1` (2026-09-29) | GitHub releases API | — | — | — | — | **verified** (release metadata) |
| **NU6.3 "Ironwood"** | activated 2026-07-28 at height 3,428,143 (per brief; z.cash/upgrade/nu6-3) | not independently re-checked against a node | mainnet | — | — | gateway must report the active branch | **unknown** until the gateway reads a node |
| **NU7** | planned ≈ 2026-11-05, height 3,543,405 (testnet already upgraded) | brief + Zebra 7.0.0 release | mainnet | — | — | runtime reads chain; never assumed | **unknown** (not activated as of this check) |
| **Zcash gateway (this repo)** | `services/zcash-gateway` | — | testnet/mainnet | — | node/indexer endpoint, UIVK, birthday, mTLS certs | — | **blocked** (no Rust toolchain on build host; never compiled) |
| **Email delivery** | SMTP via nodemailer | — | — | — | SMTP credentials | `email_outbox` state `undeliverable`/`failed` | **blocked** (dev-file provider used in demo/testnet) |
| **Secret manager / KMS** | `KeyProvider` interface | unit-tested `LocalKeyProvider` | — | — | cloud KMS adapter + IAM | `verify:prod-config` FAILs local KEKs on mainnet | **blocked** for mainnet |
| **Merchant KYB provider** | manual review queue | — | — | — | provider selection; fields decided by counsel | — | **blocked** |
| **Legal / regulatory** | RBI PA Directions (2025), PPI rules, FIU-IND VDA guidance, FEMA, UPI terms | — | India | — | qualified counsel | `LEGAL_APPROVAL_REF` required for `mainnet-enabled` | **blocked** |
| **UPI payout proof** | P2P on-chain `completed` (LP-asserted) + dispute window | — | — | — | provider evidence policy | receipts say "not a bank statement" | **partial**: only LP-asserted proof exists |
| **ZEC→USDC rebalance venue** | — | — | — | — | approved venue | — | **blocked** (no atomic swap is claimed) |

## How the code enforces this matrix

* `validateP2PConfig` refuses zero addresses, `example.com` subgraphs, non-Circle USDC and wrong chain ids; `P2PClient.preflight` checks chain id, Diamond bytecode (+ optional pinned code hash), USDC symbol/decimals, fee/price reads, treasury gas.
* `readiness()` closes each product with a human-readable reason when its dependency is missing or stale; quotes become `paymentEligible: false` with `disabledReason`.
* `scripts/verify-prod-config.ts` fails deployment for any mainnet-unsafe setting (local KMS, http origins, missing approvals, file signer, missing gateway/P2P, no TLS to DB).
