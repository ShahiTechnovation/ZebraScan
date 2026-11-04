# Zeb Scan — READY / TESTED / BLOCKED report

Date: 2026-11-04. Everything below marked **TESTED** was executed on the build host (Windows 11, Node 24, PostgreSQL 18.4) during this delivery; nothing is claimed from inspection alone.

> **Live money is not enabled anywhere.** `mainnet-enabled` is refused by `verify:prod-config` (11 FAILs). Testnet receiving is closed until the Zcash gateway is built and proven; payouts/withdrawals are closed until a verified P2P.me configuration, permission and funded signer exist.

> **Input note:** the master prompt was truncated after §10.2 step 1 ("PAY flow … preconditions"). §10.2–§13+ (including the §13 late/short/over-payment policy) were not received. Those behaviours were implemented from §1, §3, §7 and the SDK's official examples; see "Policies chosen" below.

## Command results (executed)

| Command | Result |
| --- | --- |
| `pnpm install` | ✅ |
| `pnpm typecheck` (all 10 workspaces + tests/scripts) | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0 (ESLint web, `--noUnused*` tsc for backend) |
| `pnpm test` | ✅ 39 backend unit/contract + 40 web unit |
| `pnpm test:integration` (real PostgreSQL) | ✅ 26 tests (18 flows, 6 fault-injection, 2 reconciliation) |
| `pnpm build` | ✅ web (Next 15), API + worker (tsup bundles) |
| `pnpm test:e2e` (demo frontend, Chrome) | ✅ 23/23 — no regressions from the monorepo move |
| `pnpm test:e2e:connected` (browser → web → API → PostgreSQL ← worker) | ✅ 2/2 (Scan & Pay to payout completion; merchant register → verify email → terminal → unlock → withdrawal) |
| `pnpm dev` | ✅ API, worker and web started; `/healthz`, `/`, `/scan` 200; worker seeded demo treasury → all features available |
| Bundled `node dist/migrate.js` + `node dist/main.js` | ✅ applied migration, served health/ready/UPI/headers |
| `pnpm verify:external` | ✅ 7 verified, 9 blocked, 0 failed (`docs/evidence/…`) |
| `pnpm verify:prod-config` (mainnet-enabled sample) | ✅ correctly exits 1 with 11 FAILs |
| `docker compose up` | ❌ **NOT RUN** — Docker not installed on host |
| `cargo build` (Zcash gateway) | ❌ **NOT RUN** — no Rust toolchain on host |
| GitHub Actions CI | ❌ **NOT RUN** (workflow written, not executed) |

## READY (implemented and tested)

* **Domain**: bigint money (paise/zatoshis/micros), exact rationals, quote formula QF-2026-11-01 (hand-checked example), formal state machines for intent / payout / credit / withdrawal / merchant / link with 409 rejections.
* **Database**: 2 checksummed forward-only migrations; ledger append-only + deferred per-journal-per-currency balance triggers (tested: UPDATE/DELETE rejected, unbalanced COMMIT rejected); immutable quotes and receipts; environment column on every money row; unique active allocation per obligation; single active withdrawal per merchant.
* **Ledger/treasury**: currency-scoped double entry (ZEC, USDC_BASE, INR never netted), idempotent journals, compensating reversals, USDC holds under an advisory lock with capacity ≤ fresh chain inventory − buffer.
* **API**: all 80 operations of the route table (+SSE) with Zod in/out validation, RFC 7807-style errors, idempotency (replay / 409 on body mismatch), CSRF, origin allowlist, rate limits, helmet/CSP/HSTS, ETag, per-feature readiness. OpenAPI 3.1 committed at `docs/api/openapi.json`.
* **Auth**: Argon2id, hashed session tokens, lockout, non-enumerating reset, email verification, sessions list/revoke, step-up, RBAC (owner/finance/viewer/support), separate operator realm with TOTP + dual-control approvals.
* **Flows (demo environment, real code paths)**: Scan & Pay, terminal, counter QR, payment links (quota consumed only by confirmed payments; exhausted-before-acceptance → refund route; revoke keeps in-flight), late / underpaid / overpaid, reorg before and after acceptance (credit frozen, urgent exception), concurrent same-amount invoices matched by address, cooldown unlock worker, withdrawal reserve/split/cancel/restore exactly once, receipts with live honest status.
* **Payout executor** (P2P PAY/SELL) on the real SDK surface: order row committed before broadcast, nonce persisted pre-send, ambiguous broadcast → manual review (never resubmitted), approve exactly `actualUsdcAmount`, `updatedFiatAmount = 0n`, allowlisted guarded wallet, escrow/return/settle journals, dispute handling, retry limits. Fault-injected: 6 scenarios.
* **Reconciliation**: ledger balance, allocations vs fresh inventory, liability vs credits, escrow vs orders; discrepancy auto-pauses Scan & Pay + withdrawals and raises an urgent exception (both directions tested).
* **Frontend integration**: live store + adapters for every screen; SSE with polling fallback; real login/registration/verify/reset pages; step-up dialog; server gate reasons shown; quote errors now surfaced (previously swallowed); masked VPAs only.

## TESTED only against simulation (demo environment)

Deposit detection and P2P order progression were exercised through the **demo** scanner events and the **demo** liquidity provider (`DemoP2PExecutor`), which are refused by the code in every other environment and labelled DEMO in API responses and UI. Real chain behaviour is **not** proven.

## BLOCKED (adapters + gates exist; operator input required)

| Item | What exists | What is missing |
| --- | --- | --- |
| Zcash receiving (testnet/mainnet) | Rust gateway source (UIVK-only, mTLS, cursor feed), TS client with ZIP-321 re-validation, readiness gating | compile + implement `scan_once` against crates; testnet node/indexer; UIVK + birthday; proof of concurrent-invoice matching and reorg on testnet |
| P2P.me payouts/withdrawals | `P2PClient`, preflight, `SdkP2PExecutor`, remote/testnet signers | verified Diamond address + code hash, subgraph URL, integrator permission, circle liquidity, funded treasury + gas, third-party payout approval |
| Mainnet KMS | `KeyProvider` interface, envelope encryption + rotation | cloud KMS adapter; `verify:prod-config` blocks local KEKs |
| Operator MFA | TOTP (interim) | passkeys/WebAuthn before mainnet |
| Email | SMTP provider, outbox, templates | SMTP credentials |
| KYB | manual review queue + status gates | provider; mandatory fields per counsel |
| Legal | `LEGAL_APPROVAL_REF` / `PROVIDER_APPROVAL_REF` gates | RBI PA / PPI / FIU-IND / FEMA determination by counsel |
| Rebalancing ZEC→USDC | not implemented by design | approved venue |
| Containers / CI | Dockerfiles, compose, workflow | execution on a host with Docker / on GitHub |

## Policies chosen (conservative proposals, configurable, not partner facts)

* Quotes: 600 s lifetime (90 s demo), +300 s funding grace, +7200 s finality window; 10 confirmations (3 demo); 50 bps platform fee; 100 bps P2P spread reserve; 150 bps ZEC volatility premium; ₹1–₹2,000 per payment outside demo.
* **USDC is held at intent creation, not at quote creation** (anonymous quotes are rate-limited previews and must not lock treasury); quote creation still checks capacity. Deviation from §9.2 wording, see ADR-0004.
* Payment classification: exact within `PAYMENT_TOLERANCE_ZAT` (default 0); underpaid → not accepted, full ZEC refund liability; overpaid → invoice honoured, excess recorded as ZEC refund liability; late (after submission deadline or on a closed intent) → `late_deposit`, refund review. Refunds are never sent automatically.
* Merchant contract: net INR fixed at confirmation; treasury absorbs FX; credits locked 15 days (configurable, cannot be shortened retroactively — DB trigger).
* Payout completion = on-chain `completed` (LP-asserted) + dispute window (1800 s) + amount reconciliation; UI says "not a bank statement".

---

## Delta 2026-11-04 (TinyFish rail, Noir/OTP auth, testnet watcher, redesign)

Executed after this delta: `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅ (49 backend unit/contract + 40 web) · `pnpm test:integration` ✅ (43 tests, 6 files) · `pnpm build` ✅ · demo browser E2E ✅ 23/23 · connected browser E2E ✅ 2/2 · `pnpm ops:p2p-preflight` ✅ ran → **BLOCKED** (no TINYFISH_API_KEY).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Modes DEMO / HACKATHON_TESTNET / MAINNET_READONLY / CONTROLLED_LIVE_PILOT | READY | strict aliases; testnet `canSubmitTransactions=false`, no USDC treasury, INR payout shown as disabled |
| TinyFish payout state machine (§5.2), immutable commands, consent snapshots, per-account lease + fencing, one execute attempt per payout, separate read-only reconciliation, operator approval, hold, dual-control "verified not submitted" | TESTED (scripted port) | `tests/chaos/tinyfish-rail.test.ts` 9 scenarios incl. failed run, ambiguous queue, API rejection, recipient mismatch, provider cancel → exactly-once restore |
| Live TinyFish / P2P.me | **BLOCKED** | `TINYFISH_API_KEY` missing; unverified A–H in `docs/P2P_BROWSER_CAPABILITY.md`; `eligible_for_payout=false` |
| SDK on-chain executor | Reference only | no longer constructed outside DEMO; never a fallback |
| Noir sign-in | TESTED with generated vectors | vendor verifier quirks handled (see FEEDBACK.md); real extension signature not captured |
| Email OTP | TESTED | hashed codes, 5-attempt cap, no enumeration, not in subject |
| Passkeys | NOT IMPLEMENTED | shown as unavailable |
| zkool watcher (memo-matched, Ironwood, reorg detection, watch-only proof) | TESTED against documented schema only | **BLOCKED live**: no Linux runtime here (WSL VM platform not enabled, no Docker/Rust). No testnet txid exists yet |
| Redesign | DONE | `docs/UI_SIMPLIFICATION_AUDIT.md`, before/after screenshots |
| Secondary merchant pages | partial | new palette/nav; old layouts |
| Git history | not created | the project directory is not a git repository; the event requires a new repo with commits made during the hack |
