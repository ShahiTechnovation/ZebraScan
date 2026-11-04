# Zeb Scan production audit

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

## Decision

**NOT READY for real end-to-end INR payments.** The public frontend is a labeled demo. A real JWT-protected testnet wallet and local API/worker/DB now have a verified Ironwood invoice receipt (final evidence above). The early snapshot had none; later evidence was independently rechecked. The existing faucet broadcast is to the payer account, not proof that Zeb Scan accepted an invoice. This audit submitted no INR or ZEC transfer; concurrent work supplied the new testnet transaction. The audit deliberately changed only isolated test schemas. Existing connected-test tooling exercised simulated services; read-only readiness endpoints can refresh rate snapshots. Production build commands also regenerated tracked API/worker dist artifacts; concurrent changes were preserved.

Seven P0 findings require remediation before launch. The critical ones are agent-only settlement verification, incomplete unmatched-output accounting, memo-mode reorg failure, unconfirmed refund booking, excessive wallet credential authority, and missing last-moment execution gates. See [issue register](ISSUE_REGISTER.md).

## Build and repository facts

Windows, Node v24.14.0, pnpm 10.27.0. Next.js 15.2.9 / React 19 frontend; Fastify 5 API; TypeScript worker; PostgreSQL with five SQL migrations, durable jobs and outbox; zkool_graphql wallet; incomplete Rust alternative. No new application stack was installed. Initial dirty files were .vercelignore, scripts/dev.mjs, scripts/zkool-bootstrap.ts and wallet evidence/scripts. Another actor committed changes during inspection; they were preserved. Audit scripts/reports/evidence are the only intentional additions here.

| Command | Result | Evidence |
|---|---|---|
| pnpm install --frozen-lockfile | PASS, existing workspace frozen install; not a fresh machine/container | [install.log](evidence/audit-2026-11-04/install.log) |
| pnpm typecheck | PASS including audit TypeScript tooling (final-typecheck.log) | [typecheck.log](evidence/audit-2026-11-04/typecheck.log) |
| pnpm lint | PASS | [lint.log](evidence/audit-2026-11-04/lint.log) |
| pnpm test | PASS: 52 backend + 40 web | [test.log](evidence/audit-2026-11-04/test.log) |
| TEST_DATABASE_URL=…_test pnpm test:integration | PASS: 43; initial base credential attempt failed, overlay retry passed | [integration-retry.log](evidence/audit-2026-11-04/integration-retry.log) |
| pnpm build | PASS: web/API/worker | [build.log](evidence/audit-2026-11-04/build.log) |
| pnpm test:e2e | FAIL: 21 pass, 2 payment-link failures | [browser-e2e.log](evidence/audit-2026-11-04/browser-e2e.log) |
| pnpm test:e2e:connected | PASS: 2 scenarios; simulated chain/provider backend only | [connected-e2e.log](evidence/audit-2026-11-04/connected-e2e.log) |
| pnpm audit --prod --audit-level high | FAIL: 3 critical, 22 high, 34 moderate, 3 low | [dependency-audit.json](evidence/audit-2026-11-04/dependency-audit.json) |
| isolated defect reproducer | Five observed failures captured; these are not payment proofs | [reproductions.json](evidence/audit-2026-11-04/reproductions.json) |

The clean unit/integration suite does not cover the newly reproduced failure paths. Build success does not establish financial readiness. Cargo/container build and CI run provenance are BLOCKED: no evidence of a runnable Ironwood Rust scanner; its scan_once is an explicit error stub.

## Actual deployment

- Public alias: https://zebrascan.vercel.app — HTTP 200; demo in hydrated UI at 360 and 1440 px. Read-only browsing of home, scan, login, terminal and links recorded no JS errors or horizontal overflow. Merchant routes show a console sign-in gate; no real merchant data was created. [public-browser.json](evidence/audit-2026-11-04/public-browser.json).
- Vercel deployment: dpl_CefhRUVDEs68wS5k1m4rZX5cCskF, created 2026-11-04 21:10:44 IST. Deployment-specific URL redirects anonymous visitors to Vercel login; production alias works. Deployed source SHA is BLOCKED, not inferred from the current checkout. [vercel-inspect.log](evidence/audit-2026-11-04/vercel-inspect.log).
- Wallet: https://zebscan-zcash-test.onrender.com/graphql — account-scoped query succeeds, initial currentHeight=4582562 with no receiver transactions; final query matches the accepted Ironwood note above; unauthenticated account query HTTP 500. This proves denial for that request, not complete endpoint security.
- Local API: http://127.0.0.1:4000/healthz and /readyz HTTP 200. Testnet receiving gates open, withdrawals closed as nonredeemable. DB has migrations 0001–0005; final query has one accepted intent/output, one ZEC journal, one testnet INR journal, no merchant credits or payout commands. Wallet worker synced locally.
- Local frontend HTTP 500 during overlapping dev/build activity. No definitive root cause established; this is not asserted to be an independent product regression. Public frontend is independently verified.
- Initial mainnet endpoint GET returned 405. Final local read-only API reports synced height 3541772 with receiving disabled; imported empty watch account and auth evidence appeared concurrently. Consensus/receiver decoding/key isolation and restart certification remain BLOCKED. This audit moved no mainnet funds.
- API/worker public hosting, backups, alert delivery, monitoring retention and persistent wallet restart recovery remain BLOCKED. Render blueprint provisions only wallet servers on free ephemeral storage.

## Service result matrix

| Area | Implementation | Public testnet evidence | Mainnet read-only | Live fiat | Blocking issue |
|---|---|---|---|---|---|
| ZEC receiving | PASS: authenticated wallet/schema + existing invoice | PASS: one Ironwood receipt; runtime-final.json | PASS: local read-only sync only | NOT_APPLICABLE | ZEB-006/008/013 |
| Deposit watcher | PASS: local worker synced | PASS: one accepted receipt + one ZEC journal | PASS: local read-only status; consensus certification blocked | NOT_APPLICABLE | ZEB-003/004/005/008 |
| Quotes / ZIP-321 | PASS: code/unit/DB fixtures | PASS: quoted 836471 zatoshis received on invoice | BLOCKED: mainnet issuance disabled | NOT_APPLICABLE | ZEB-008/010/015 |
| Scan & Pay | FAIL: deployed UI is demo | PASS: one local Scan & Pay receipt; public UI still demo | BLOCKED: no verified mainnet receiver | BLOCKED: no authorized pilot | ZEB-001/002/007/011 |
| Merchant QR | FAIL: deployed UI is demo | BLOCKED: no merchant receipt | BLOCKED: receiving disabled | BLOCKED: no authorized pilot | ZEB-001/008/014/017 |
| Payment links | PASS: backend fixtures; FAIL browser fixture | BLOCKED: no real link payment | BLOCKED: receiving disabled | BLOCKED: no authorized pilot | ZEB-001/008/021 |
| Merchant ledger | PASS: immutable/balanced DB tests | BLOCKED: real receipt not observed | BLOCKED: backing not verified | BLOCKED: no settlement proof | ZEB-005/014/016 |
| TinyFish/P2P PAY | FAIL: verification/kill gates incomplete | NOT_APPLICABLE | NOT_APPLICABLE | BLOCKED: credentials/permission/funding | ZEB-002/007/010/011 |
| TinyFish/P2P SELL | FAIL: verification/kill gates incomplete | NOT_APPLICABLE | NOT_APPLICABLE | BLOCKED: credentials/permission/funding | ZEB-002/007/010/011 |
| Auth / wallet | PASS: synthetic signature/OTP tests | BLOCKED: actual wallet + SMTP missing | BLOCKED: no mainnet session evidence | NOT_APPLICABLE | ZEB-017 |
| Deployment/monitoring | FAIL: public demo; local backend | PASS: wallet tip and local sync only | PASS: local read-only sync only | BLOCKED: launch gates absent | ZEB-001/012/023 |

## Inventory and scope

The full route table is packages/contracts/src/routes.ts (auth model, idempotency, request/response schemas); registration is apps/api/src/server.ts. Handlers cover public config/rates/UPI, quotes, guest checkout, merchant/auth/wallet, payment links, balances/ledger, withdrawals/receipts, operator decisions, internal HMAC events and SSE. The selected source inventory is [inventory.json](evidence/audit-2026-11-04/inventory.json). Internal webhook handler rejects unconfigured providers; no authenticated bank webhook integration exists.

Worker jobs: scanner.poll, intents.expire, treasury.inventory, reconcile, email.deliver, outbox.dispatch, credit.unlock, payout.advance, tfpayout.advance and p2p.preflight. Only demo constructs the old executor; it is not a live fallback. Tables include quotes, intents, diversified addresses, observations, event receipts, scanner state, immutable journals/postings, credits, treasury allocations, withdrawals, payout commands/attempts/provider orders/account leases, auth/session/challenges, merchant/link state, exceptions and jobs.

Static simulation search: [simulation-inventory.txt](evidence/audit-2026-11-04/simulation-inventory.txt). Product demo code exists in apps/web/src/services/demo, DemoControls, DemoClock, DEMO_SIMULATED executor and demo API routes. Test fixtures are separately identified in tests/. No obsolete HashX/HashKey/HSP source matches were found in the scoped app/package/service scan; historical test DB names and old docs are not product runtime identifiers. Production bundle secret verification remains limited; conservative tracked-file patterns found no private-key block ([secret-scan.json](evidence/audit-2026-11-04/secret-scan.json)). Ignored seed/key files were not printed.

## Limits and source precedence

Official privacy-track version 2026-11-02 was refetched successfully via HTTPS after web-tool failures ([stadium-0.txt](evidence/audit-2026-11-04/stadium-0.txt)); event index also captured. It explicitly says mainnet NU7 is not scheduled, contradicting the code's hardcoded activation height. Follow the track/network evidence, not that constant. [Official track](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), [ZIP-321](https://zips.z.cash/zip-0321), [TinyFish profiles](https://docs.tinyfish.ai/key-concepts/browser-context-profiles).

No physical-camera, installed-wallet, Lighthouse, complete keyboard/accessibility, restore/incident drill, authoritative provider account, legal approval or money-transfer result is claimed. Those checks are BLOCKED until the stated setup/permission is present. The 126 supplied checkbox items and E01–E36 are assessed in [readiness matrix](PRODUCTION_READINESS_MATRIX.md). The genuine testnet receipt milestone is now evidenced. Next verify a connected public checkout and restart/replay safety after P0 containment; live fiat remains a separate gate.
