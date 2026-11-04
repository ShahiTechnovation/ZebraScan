# Operator runbook — audited current commands

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

This supplements existing docs/RUNBOOKS.md and OPERATIONS/*.md. It describes existing code and measured services; it does not grant transfer permission. Keep HACKATHON_TESTNET, MAINNET_READONLY and any future live environment isolated.

## Read-only diagnosis

1. Record git rev-parse HEAD and git status --short. Do not print .env or secret files.
2. Run pnpm exec tsx scripts/audit-readonly.ts. It reads existing configuration and performs read-only DB/GraphQL/HTTP queries; it does not sync/bootstrap or send. Output includes only configured-variable booleans, aggregates, chain metadata and public note values; no memo/seed/key/token. Evidence writes to the dated audit folder.
3. Check /healthz and /readyz separately. Current local API is localhost:4000. A ready testnet receiving feature does not enable withdrawals. Inspect scanner_state age, height/lag, dead jobs and exception counts via authorized DB tooling.
4. Inspect public https://zebrascan.vercel.app and compare its mode/build to the API. Vercel Ready only proves a deployment artifact; current alias is demo.
5. TinyFish preflight command exists: pnpm ops:p2p-preflight. Load approved non-demo configuration first; this writes a capability report and starts a read-only agent only when credentials exist. Current credentials are absent. Never substitute another account/session or click a final payment action.

## Local services / migrations

Existing documented launcher is pnpm dev:testnet (scripts/dev.mjs overlays .env, var/secrets/testnet.env, var/secrets/testnet-worker.env). It launches API/worker/web and the worker mutates its operational DB; it is not an audit-only command. Correct NEXT_PUBLIC_ZEB_MODE to connected in operator config only after ZEB-001 is repaired. Check configuration source and environment before launch. Migrations: pnpm db:status / pnpm db:migrate; deployment bundles: node dist/migrate.js before API/worker. Do not run migrations against an unidentified DB.

Do not run next dev and next build in the same output directory. Use NEXT_DIST_DIR for an isolated audit/connected build. Current frontend 500 during overlapping work needs recheck in an isolated process.

## Tests (destructive only to isolated test DB)

Provision TEST_DATABASE_URL ending in _test directly in the shell/secret manager. The harness drops/recreates public schema; never supply a customer/deployment DB. Run pnpm test:integration. Existing zebscan_test passed with testnet-overlay credentials; base .env credentials failed. audit-reproduce.ts uses the same destructive test harness and records known defects, not payment success. Connected browser suite uses E2E_DATABASE_URL ending in _test and an independent .next-connected directory.

## Wallet / recovery

Do not run zkool-bootstrap.ts during a read-only audit: it creates/deletes accounts and handles seeds; --faucet requests a testnet transfer. Its generated watcher issuer key is overprivileged (ZEB-006). Current Render free disks are ephemeral; a restart may require manual watch-only UFVK/birthday restoration and rescan. Durable automatic restoration is not yet proven. The Render comment references a nonexistent bootstrap-testnet-watch-only.ts; the actual script is scripts/zkool-bootstrap.ts and needs security correction before production reuse.

For deposits, preserve all notes and hashes before attribution. Missing memo, late, underpaid, extra and reorg cases go to review. Never make a viewing-key service sign a refund. No authorized refund execution procedure is implemented, so promise review rather than completion.

## Payout incident / kill switch

Keep live payouts disabled. Existing ops pause writes feature_gates and per-command hold sets held, but the global switch is not sufficient for already queued TinyFish commands (ZEB-007). Prevent new execution through deployment/process controls while preserving incoming accounting and separate read-only reconciliation. Never restart an ambiguous submission as a new payment. Retain run ID, provider order ID, immutable consent, attempt and lease; seek authoritative original-order resolution.

No backup restore, secret rotation, hosted-worker failover, live provider logout or bank dispute drill was executed. Those are BLOCKED, not documented as successful. No irreversible transfer instructions are supplied until exact authorization and the repaired execution gates exist.

## Testnet live payout demo (TESTNET_LIVE_PAYOUT_DEMO — strict opt-in, off by default)

**Honest framing.** INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet payment only authorizes it (the event guide's "a shielded payment authorises the purchase" pattern). TAZ has no value and is never booked as INR; testnet books stay ZEC-only. Scan & Pay only — merchant credits/withdrawals stay non-redeemable on testnet.

**Gate** (all required, validated at boot, re-checked at every use): `ZEB_ENVIRONMENT=HACKATHON_TESTNET`, `TESTNET_LIVE_PAYOUT_DEMO=true` (exactly `true`/`false`), `LIVE_PAYOUTS_ENABLED=true`, `0 < PILOT_MAX_PAYOUT_INR_PAISE <= 20000` (Rs 200), `0 < PILOT_DAILY_MAX_USDC_MICROS <= 3000000` (3 USDC). Execution additionally needs `LEGAL_APPROVAL_REF`, `PROVIDER_APPROVAL_REF` (the operator's own sign-off references), `TINYFISH_API_KEY` and `P2P_ALLOWED_START_URL=https://app.p2p.lol/` in the env of **both** API and worker (a worker without the key records a rail-unavailable exception that then blocks that payment's execution). Gate off ⇒ testnet behaves exactly as before (`payout.disabled`, no payout command) — `tests/chaos/testnet-live-demo.test.ts`.

**Flow.** Confirmed testnet Scan & Pay → immutable payout command (EXECUTE_AFTER_APPROVAL, commandHash, consent snapshot) → caps (over cap ⇒ PREFLIGHT_BLOCKED with the amounts) → read-only TinyFish preflight (logged-in profile, SELL UI, visible USDC ≥ max debit) → **operator approval bound to the hash, TTL `OPERATOR_APPROVAL_TTL_SECONDS`** → exactly one execute run: app.p2p.lol SELL of exactly the authorized max USDC debit to the command's UPI ID, "Place Order" once, stop if the shown INR payout is below the authorized INR → separate read-only reconciliation → UI. A run finishing, agent prose or a screenshot is never completion; failed/ambiguous after a possible click ⇒ OUTCOME_UNKNOWN_REVIEW with the account lease kept and no automatic retry. RECONCILED additionally needs independent settlement evidence (no production entry path exists yet), so the UI normally ends at "INR transfer in progress" once P2P.lol reports the order paid; the recipient sees the INR in their UPI app.

**Operator CLI** (`scripts/payout-approve.ts`, loads `.env` + overlays like `scripts/dev.mjs`):

```
pnpm exec tsx scripts/payout-approve.ts --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env
pnpm exec tsx scripts/payout-approve.ts --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env --approve <payoutId> --hash <commandHash> --operator <name>
pnpm exec tsx scripts/payout-approve.ts --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env --advance <payoutId>
pnpm exec tsx scripts/payout-approve.ts --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env --hold <payoutId> --operator <name> --reason "<why>"
```

The listing shows flow, full UPI, INR, exact sell USDC, caps, environment, commandHash (recomputed) and state. `--approve` refuses a hash mismatch. `--advance` (or the worker, after approval) starts the REAL TinyFish run; both use the same per-payout job lease, so they never run concurrently. `--hold` is the per-payout kill switch; setting `TESTNET_LIVE_PAYOUT_DEMO=false` and restarting stops all further execution (approved-but-unstarted commands are held, none executes).
