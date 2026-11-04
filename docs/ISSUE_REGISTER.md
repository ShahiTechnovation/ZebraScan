# Zeb Scan issue register

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

These are the findings established in this audit, sorted by severity. This is not a claim to have found every possible defect. Runtime actions were read-only; reproductions use isolated synthetic fixtures. Proposed owners are roles, not assignments to named people. Every entry inherits the date/SHA above; request IDs are not applicable to static checks. See the evidence JSON timestamps for runtime checks.

## ZEB-001 — Remove executable demo paths from the deployed product

Severity: P0
System: UI
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Open https://zebrascan.vercel.app/scan. Public HTML and hydrated pages show a demo; screenshots at 360/1440 px confirm it. The configured testnet overlay resolves to demo because only the literal connected selects live adapters.
Expected: A real connected testnet product, or an unavailable state; never executable simulated payments.
Evidence: `apps/web/src/config/mode.ts:4`; `apps/web/src/services/registry.ts:15`; [public-browser.json](evidence/audit-2026-11-04/public-browser.json)
Root cause: Proven: default/unknown frontend mode selects demo; demo services are statically imported and shipped. This is labeled simulation, not a proven real-money misrepresentation, but violates the explicit no-demo requirement.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not present the demo as the supported product.
Minimal fix: Make product mode fail closed; remove demo adapters and controls from deployable imports. Keep fixtures in tests. Configure connected API URL before rebuilding/redeploying.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Frontend owner to implement and attach evidence.
Retest: E01/E30/E32: production bundles contain no executable simulator; unset, misspelled and testnet modes cannot select demo.

## ZEB-002 — Require authoritative settlement evidence beyond TinyFish narratives

Severity: P0
System: P2P / Ledger
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Run audit-reproduce against an isolated _test DB. agentOnlyCompletion accepts COMPLETED with no USDC amount and an empty provider reference. reconcileStep maps this verdict to PROVIDER_COMPLETED_VERIFIED; settle substitutes the authorized maximum for unknown actual spend.
Expected: No completed payout or liability extinguishment without independently authenticated order/bank-compatible evidence and actual exact amounts.
Evidence: `packages/core/src/tfpayouts.ts:132`; `packages/core/src/tfpayouts.ts:592`; `packages/core/src/tfpayouts.ts:637`; [reproductions.json](evidence/audit-2026-11-04/reproductions.json)
Root cause: Proven: a second agent run is treated as verification; schema validation is not independent evidence. Missing spend becomes a fabricated booked amount.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Keep the state provider-reported/pending. Add a trusted reconciliation adapter or audited operator evidence workflow; require actual debit and matched recipient/amount. Preserve reservation until resolved.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E22/E23/E24/E33: fabricated/repeated agent claims, missing debit or missing authoritative evidence cannot settle.

## ZEB-003 — Persist every unmatched output before invoice matching

Severity: P0
System: Zcash / Ledger
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Replay the two unknown outputs in audit-reproduce. Two receipts yield zero deposit rows and one exception containing only the first output's details.
Expected: Both owned outputs retained with stable identity, confirmations and recoverable custody/exception accounting.
Evidence: `packages/core/src/deposits.ts:55`; `packages/core/src/events.ts:60`; [reproductions.json](evidence/audit-2026-11-04/reproductions.json)
Root cause: Proven: ingestion returns before deposit_observations insert; raiseException deduplicates all unattributed deposits with null intent/withdrawal/order. Only a hash remains for subsequent events.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Introduce an unmatched owned-output record keyed by network/pool/txid/outputRef, independent of invoice association. Link exceptions to each output and create confirmed custody/refund postings exactly once.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E09/E25/E33: multiple unknown/missing-memo outputs all survive replay, restart and later attribution.

## ZEB-004 — Carry invoice attribution through memo-mode reorgs

Severity: P0
System: Zcash
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Accept a memo-matched deposit, then ingest the reorg event generated by pollZkool (memo:null). Reproducer leaves status=deposit_accepted, canonical=true, accepted=true.
Expected: Reorg invalidates the existing output and freezes its dependents regardless of current memo text.
Evidence: `packages/core/src/jobs.ts:148`; `packages/core/src/deposits.ts:52`; [reproductions.json](evidence/audit-2026-11-04/reproductions.json)
Root cause: Proven: reorg re-matches address with memo_code IS NULL; memo invoices cannot match. It becomes an unattributed exception instead.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not enable shared-address memo mode.
Minimal fix: Resolve reorgs by the persisted deposit key, not fresh invoice matching. Add a pollZkool-level memo reorg fixture.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E28: accepted memo invoice becomes noncanonical and frozen; no payout or unlock proceeds.

## ZEB-005 — Do not book unconfirmed late sightings as received ZEC

Severity: P0
System: Ledger
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Send a synthetic note_seen with zero confirmations to an expired invoice in the isolated DB. lateMempool reports mined=false, confirmations=0 and one refund journal.
Expected: A pending observation only until canonical confirmation; reorg/disappearance cannot leave fictitious ZEC assets/refund liabilities.
Evidence: `packages/core/src/deposits.ts:82`; `packages/core/src/deposits.ts:116`; [reproductions.json](evidence/audit-2026-11-04/reproductions.json)
Root cause: Proven: late handling runs before mined/confirmation checks and immediately debits zcash_asset.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Separate late observation from confirmed custody accounting; book once after finality and reconcile reversals if later reorged.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E09/E28/E33: unmined/disappeared late notes do not increase confirmed assets or refundable balance.

## ZEB-006 — Separate wallet admin signing authority from the watcher

Severity: P0
System: Security
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Inspect bootstrap's generated worker settings: the worker receives the same ES256 issuer private key used for sub=0/write=true admin tokens. Bootstrap also creates the spend-capable testnet sender on that server. No secret values were read into the report.
Expected: Receiving API/worker can only access a watch-only account; it cannot mint admin/write credentials or access a sender.
Evidence: `scripts/zkool-bootstrap.ts:41`; `scripts/zkool-bootstrap.ts:196`; `packages/providers/src/zkool.ts:140`; `packages/providers/src/zkool.ts:185`
Root cause: Proven capability escalation by configuration: choosing write=false in bearer() is voluntary when the process has the issuer key. An Unauthorized pay probe proves the selected token scope, not least privilege of the process.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Keep issuer/admin key offline or in a separate issuer service. Give the watcher externally issued short-lived account-scoped tokens; separate sender service/key store. Verify receiver key absence independently without testing a real send.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E29/E36: watcher credentials cannot access another account or obtain admin/write authority; sender compromise is outside watcher reach.

## ZEB-007 — Recheck kill switch, finality and authorization immediately before execution

Severity: P0
System: P2P / Operations
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Static trace: ops pause changes feature_gates; accepted-deposit reorg changes intent/credit status. QUEUED reads neither before startRun. Approval expiry is checked in OPERATOR_APPROVAL_REQUIRED, then may lapse while the job waits for the account lease.
Expected: Pausing, reorg, lost backing or expired consent must prevent a new money-changing run; existing ambiguous runs remain reconciled.
Evidence: `apps/api/src/handlers/ops.ts:81`; `packages/core/src/deposits.ts:272`; `packages/core/src/tfpayouts.ts:525`
Root cause: Proven missing dependency in the execution branch: no last-moment source deposit, gate, approval TTL or refreshed liquidity assertion. A per-command held flag exists but is not the global pause/reorg mechanism.
Impact: Financial truth, custody safety or forbidden product simulation is affected; launch blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Use one transaction to validate all current prerequisites and claim the execution slot; propagate reorg/kill holds to commands and preserve reconciliation. Recheck after waiting for the lease.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Operations owner to implement and attach evidence.
Retest: E28/E36/E21: queue a scripted payout, pause/reorg/expire approval, advance it; queue call count stays zero.

## ZEB-008 — Complete real receipt restart and concurrent-invoice proof

Severity: P1
System: Zcash / Deployment
Environment + network: public testnet wallet, local connected API/worker
Status: BLOCKED (remaining restart/public-UI proof; first receipt PASS)
Reproduction / observed: At 16:00 UTC no receiver note existed. At 2026-11-04T16:20:15.789Z, independent read-only wallet and DB queries matched 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, incoming pool 3/scope 0, 836471 zatoshis, block 4582568, 40 confirmations, accepted invoice and one ZEC journal. No payout command exists.
Expected: Preserve this proof through scanner/DB restart and a connected public checkout; prove multiple invoices without cross-credit.
Evidence: evidence/audit-2026-11-04/runtime-final.json; docs/evidence/testnet-checkout-pi_kddd0fe7.json; initial runtime.json retained as historical.
Root cause: First-receipt gap resolved by concurrent work. Remaining verification is blocked by no authorized service restart/production connected deployment during this audit; not evidence the successful receipt is broken.
Impact: Cannot certify continuous public operation or generalize one receipt into full production readiness.
Safe temporary mitigation: Preserve successful receipt; keep testnet nonredeemable and all live payouts disabled.
Minimal fix: Apply P0 accounting/privilege fixes, deploy connected UI, then controlled restart/replay and multi-invoice tests.
Dependencies: Persistent service setup; any additional send needs existing or new explicit bounded authorization.
Owner / next action: Zcash/operations owner to attach restart/public-UI evidence.
Retest: E04–E08/E26/E27, one effect after replay and no skipped incoming outputs.

## ZEB-009 — Keep blocked or premature credit-unlock jobs scheduled

Severity: P1
System: Worker
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Reproducer claims a job, enqueues itself for a later time, then runs the normal completion path: state becomes done. unlockCredit uses this pattern for not-due/blocked credits.
Expected: Retry remains queued after the blocker clears or cooldown ends.
Evidence: `packages/core/src/credits.ts:37`; `packages/core/src/jobs.ts:44`; `packages/core/src/events.ts:33`; [reproductions.json](evidence/audit-2026-11-04/reproductions.json)
Root cause: Proven: enqueue conflicts with the currently running job; the handler returns void and runJob overwrites it as done. LEAST also retains the earlier due time.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Return rerunInMs from the handler for not_due/blocked; let the runner reschedule under the lease. Add blocked→unblocked and early-claim tests.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E13/E27: credit eventually unlocks after recovery without operator job insertion.

## ZEB-010 — Replace legacy SDK prerequisites with verified browser-account capacity

Severity: P1
System: P2P / Treasury
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Static trace: real receiving/withdrawals require Diamond/subgraph/RPC and Base signer readiness. Treasury refresh only reads configured chain address through the old P2P client. prod-config rejects a zkool-only testnet setup as missing gateway/P2P.
Expected: Readiness and reservations reflect the selected TinyFish rail and the actual authenticated account's spendable, committed funds.
Evidence: `packages/core/src/gates.ts:59`; `packages/core/src/gates.ts:84`; `packages/core/src/reconcile.ts:18`; `scripts/verify-prod-config.ts:59`
Root cause: Proven rail migration incomplete. The old executor is not used as fallback, but legacy readiness/inventory assumptions remain.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Define a provider-account capacity source with independent verification and commitments; select gates by rail. Update prod-config to recognize authenticated zkool. Do not remove financial gates merely to open checkout.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E19/E20/E33: real rail prerequisites, unavailable capacity fails closed, no reference SDK execution.

## ZEB-011 — Provision and verify provider access before a live pilot

Severity: P1
System: P2P / Compliance
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: BLOCKED
Reproduction / observed: Current configuration has no TinyFish API key, allowed start URL, profile ID, legal reference or provider reference. No authenticated provider run was started.
Expected: Correct saved account/profile, permitted PAY/SELL actions, signer interaction, limits, funding and authoritative reconciliation documented.
Evidence: [runtime.json](evidence/audit-2026-11-04/runtime.json); docs/P2P_BROWSER_CAPABILITY.md; packages/core/src/tfdeps.ts
Root cause: BLOCKED dependency: absent credentials/permissions and no independent provider evidence. Default profile syntax does not prove a profile/account exists.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Operator configures secrets directly, obtains required approvals and performs read-only preflight. Separate exact per-transfer authorization is mandatory before live money.
Dependencies: operator provisioning/authorization and external service evidence
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E19–E24/E35: authenticated read-only evidence first; authorized pilot only after all gates.

## ZEB-012 — Deploy API/worker/database as persistent production services

Severity: P1
System: Deployment
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Verified public frontend and JWT wallet endpoint; API was found on localhost:4000 and worker rows in the local database. No public API/worker deployment identity or durable process manager was found. Render wallet uses free ephemeral storage and manual bootstrap after restart.
Expected: Independent persistent API, worker, DB and wallet, with durable recovery and a connected frontend.
Evidence: render.yaml; infra/deploy/README.md; [vercel-inspect.log](evidence/audit-2026-11-04/vercel-inspect.log); [runtime.json](evidence/audit-2026-11-04/runtime.json)
Root cause: Proven topology gap in supplied deployment manifest; continuous production operation BLOCKED without hosting/service evidence. Local HTTP 500 during overlapping dev/build is observed, but causation is unproven.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Deploy persistent services with unique environment secrets, durable wallet storage/rescan startup, health/alerts and a recorded build SHA. Use isolated Next build directories to avoid concurrent dev/build interference.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Operations owner to implement and attach evidence.
Retest: E26/E27/E32: restart/suspend recovery, public API SSE/polling, health and end-to-end connected route.

## ZEB-013 — Remove unsupported consensus assertions and validate canonical chain evidence

Severity: P1
System: Zcash
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Zkool status supplies blank hash/branch, current wall-clock tip time, constant Ironwood support and a hardcoded mainnet upgrade height. Snapshot accepts note heights without block hashes. The official track explicitly says mainnet NU7 is not scheduled. Rust scan_once always errors and its address code requests Orchard.
Expected: Network/consensus, stale tip and canonicality supported by observed node/wallet data; no customer path through an unfinished Orchard gateway.
Evidence: `packages/providers/src/zkool.ts:274`; `packages/providers/src/zkool.ts:278`; `packages/providers/src/zkool.ts:346`; `services/zcash-gateway/src/wallet.rs:133`
Root cause: Proven source contradiction and incomplete witness model. Live testnet schema/tip works, but this is not complete consensus or reorg proof.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Use network-verified node metadata/checkpoints and pinned receiver decoding; remove unsupported mainnet schedule. Quarantine Rust receiving until Ironwood scanning exists; prefer the current zkool path.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E04/E07/E12/E28: stagnant tip, wrong network, unsupported receiver and reorg all fail safely.

## ZEB-014 — Keep testnet values separate from real INR liabilities

Severity: P1
System: Ledger
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Static trace: testnet skips treasury yet uses INR asset/revenue/payable journals and merchant credits that can unlock. API capabilities and withdrawal readiness explicitly mark these nonredeemable.
Expected: Testnet proof must not create real financial revenue/liabilities or appear withdrawable; zero live INR entitlement.
Evidence: `packages/core/src/context.ts:51`; `packages/core/src/deposits.ts:193`; `packages/core/src/credits.ts:41`
Root cause: Proven accounting semantics gap, not evidence of a cross-network payout: environment columns and creditsRedeemable=false protect withdrawal.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Use test-only accounting/units or custody-only receipt records; prohibit real-INR postings and fee recognition on testnet; label balances and receipts consistently.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E13/E33: a testnet note cannot create redeemable INR, live revenue or a payout command.

## ZEB-015 — Reject stale or missing INR-reference timestamps

Severity: P1
System: Pricing
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Inspect testnetReference: missing last_updated_at becomes now; any old timestamp is accepted and lastP2POk is set to request time. createQuote has no subsequent age assertion on that rate.
Expected: Missing, future or stale price evidence closes quoting.
Evidence: `packages/core/src/rates.ts:111`; `packages/core/src/rates.ts:118`
Root cause: Proven control omission; current live rate was available, so no stale production quote was deliberately generated.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Validate provider timestamp, age, positive rate and future skew before cache/health updates. Preserve observed source time.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E18: missing/old/future timestamps rejected; fresh exact decimal succeeds.

## ZEB-016 — Do not mark skipped or incomplete financial checks as passing

Severity: P1
System: Ledger / Monitoring
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Static trace: unknown inventory yields ok=true/skipped; any frozen credit bypasses all merchant-balance comparisons; escrow reconciliation considers p2p_orders, not TinyFish provider_orders/commands.
Expected: Each check independently reports PASS/FAIL/BLOCKED; frozen accounts cannot hide unrelated drift; actual rail commitments reconcile.
Evidence: `packages/core/src/reconcile.ts:44`; `packages/core/src/reconcile.ts:63`; `packages/core/src/reconcile.ts:80`
Root cause: Proven false-green conditions and reference-rail-only reconciliation.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Use explicit skipped/blocked statuses, reconcile frozen balances separately, cover TinyFish commitments/custody/refund liabilities and wire actionable alerts.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E33: frozen credit plus unrelated imbalance fails; missing inventory is BLOCKED; TinyFish drift detected.

## ZEB-017 — Provide usable merchant authentication outside a local dev session

Severity: P1
System: Authentication
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: BLOCKED
Reproduction / observed: OTP/password and wallet challenge tests pass with generated fixtures. SMTP is absent; dev-file mail cannot reach a remote merchant. No installed Noir signature/payment proof was captured; passkeys are explicitly unavailable.
Expected: Merchant can sign in on the deployed connected product using real delivery or a verified supported wallet; guest checkout remains anonymous.
Evidence: [runtime.json](evidence/audit-2026-11-04/runtime.json); apps/web/src/services/live/noir.ts; apps/api/src/handlers/wallet.ts; apps/api/src/handlers/auth.ts
Root cause: BLOCKED deployment dependencies; generated cryptographic vectors are not real-extension interoperability evidence.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Provision SMTP and run real delivery/recovery/session tests without logging OTPs; verify installed Noir version/network and signature behavior. Keep unsupported methods disabled.
Dependencies: operator provisioning/authorization and external service evidence
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E17: secure real fallback login, replay/expiry rejection and merchant ownership isolation.

## ZEB-018 — Resolve high and critical production dependency advisories

Severity: P1
System: Security
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: pnpm audit --prod --audit-level high exits 1: 3 critical, 22 high, 34 moderate, 3 low findings at the captured registry snapshot.
Expected: No unresolved exploitable high/critical production dependencies; record applicability and patched supported versions.
Evidence: apps/web/package.json:21; packages/providers/package.json:23; packages/contracts/package.json:19; [dependency-audit.json](evidence/audit-2026-11-04/dependency-audit.json)
Root cause: Proven dependency audit failure; exploitability of every advisory was not demonstrated. Includes Next.js 15.2.9 and transitive/runtime packages.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Triage registry advisories against used features, update supported versions in a small change, regenerate lockfile and rerun build/security/functional checks. Do not assert that all reported issues are exploitable.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E29/E32: dependency audit and targeted affected-feature regressions.

## ZEB-019 — Handle stalled finality and additional deposits as recoverable custody

Severity: P1
System: Zcash / Recovery
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Static trace: expireIntents only handles awaiting_zec with no deposit; deposit_seen/confirming can remain forever beyond finality_deadline. Additional output on a closed/underpaid invoice raises an exception but no new custody/refund posting.
Expected: Every received output accountable; stale finality reaches review with a defined recovery action.
Evidence: `packages/core/src/jobs.ts:75`; `packages/core/src/deposits.ts:87`; `packages/core/src/intents.ts:47`
Root cause: Proven absence of finality deadline enforcement and complete extra-output accounting.
Impact: A major payment, recovery or deployment acceptance condition remains blocked.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Add finality review jobs; journal confirmed additional outputs by stable identity; define aggregate partial-payment policy and reconcile all refund liabilities.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: E09–E11/E25: stalled confirmations, partial top-up and second payment retained without over-credit.

## ZEB-020 — Correct status copy that overstates receipt or refund certainty

Severity: P2
System: UI
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Render pending/confirming/reorg/review checkout states: the non-awaiting QR caption says Payment received. Overpayment callout states no credit although backend honors the invoice; link exhaustion promises refund with no authorized signer workflow.
Expected: Detected, confirmed, credited and paid out distinguished; refunds remain requested/review pending until authorized and broadcast/confirmed.
Evidence: `apps/web/src/components/payments/CheckoutPanel.tsx:88`; `apps/web/src/components/payments/CheckoutPanel.tsx:178`; `packages/core/src/deposits.ts:237`
Root cause: Proven status-independent copy branches; no bank payout was demonstrated.
Impact: Operational reliability, status accuracy or regression assurance is degraded.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Render captions from exact server state; align overpayment and refund text with backend policy; add a usable ZIP-321 anchor for compatible wallets.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Frontend owner to implement and attach evidence.
Retest: E10/E11/E25/E30: every exceptional state has accurate copy and actionable recovery.

## ZEB-021 — Fix cross-tab demo link-state regression before retiring the simulator

Severity: P2
System: UI / Tests
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: pnpm test:e2e: 21 pass, 2 fail. After simulated payment in another tab, merchant link remains Active with 0 successful payments; reusable link also misses count 2.
Expected: The test fixture should preserve confirmed link usage across pages. Real linked checkouts must use server state.
Evidence: [browser-e2e.log](evidence/audit-2026-11-04/browser-e2e.log); apps/web/tests/e2e/links.spec.ts:31; apps/web/tests/e2e/links.spec.ts:83; apps/web/src/services/demo/store.ts
Root cause: Observed defect; likely localStorage snapshot overwrite between ticking tabs, but exact write race is a hypothesis. Backend link quota tests pass.
Impact: Operational reliability, status accuracy or regression assurance is degraded.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Remove demo from product first; relocate fixtures to tests and isolate/synchronize fixture state. Add connected link browser coverage rather than treating simulator success as payment evidence.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Frontend owner to implement and attach evidence.
Retest: E15/E16/E34: server-connected concurrent payer flows and quota checks; no local state authority.

## ZEB-022 — Replace stale readiness claims and broken operational instructions

Severity: P2
System: Documentation / Deployment
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: README says not deployed/no wallet runtime; a public Vercel site and authenticated wallet now exist. Older report says not a git repo and reports old test counts. Render refers to nonexistent scripts/bootstrap-testnet-watch-only.ts. verify-external contains hardcoded blocked claims instead of live checks.
Expected: Runbooks and status reflect current measured services and distinguish historical mock tests.
Evidence: README.md; docs/READINESS_REPORT.md; render.yaml; scripts/verify-external.ts
Root cause: Proven documentation drift. Old documents are not current acceptance evidence.
Impact: Operational reliability, status accuracy or regression assurance is degraded.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Use this audit as the current index; update README/runbook references when fixes/evidence land. Replace canned verification statuses with measured or explicitly not-run checks.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Operations owner to implement and attach evidence.
Retest: E26/E32: every documented command/path exists and evidence is timestamped.

## ZEB-023 — Add actual alert delivery and meaningful worker health

Severity: P2
System: Operations
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Worker health only checks the polling loop's recent activity; outbox handler marks events dispatched without external subscribers. No alert sink/restore-drill evidence supplied.
Expected: Scanner/dead-job/provider/ledger degradation reaches an operator; liveness and readiness are distinct.
Evidence: `apps/worker/src/main.ts:38`; `packages/core/src/jobs.ts:68`
Root cause: Proven observability implementation gap; backup/incident drills BLOCKED pending infrastructure/access.
Impact: Operational reliability, status accuracy or regression assurance is degraded.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Expose dependency ages, queue/dead jobs and unresolved payouts; configure verified alert delivery, persistent services and restore drills.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Operations owner to implement and attach evidence.
Retest: E26/E27/E32/E36: outage raises a delivered alert and recoveries preserve events.

## ZEB-024 — Make documented local/test commands use the correct credential overlays

Severity: P2
System: Configuration
Environment + network: current testnet/local/public demo; live-money implications are static only
Status: FAIL
Reproduction / observed: Using base .env DB credentials for zebscan_test produced authentication errors; using the existing testnet overlay credentials against the isolated zebscan_test passed all 43 tests. No credentials are included in evidence.
Expected: Documented test/start commands identify the correct sanitized configuration source and never reset a non-test database.
Evidence: [integration.log](evidence/audit-2026-11-04/integration.log); [integration-retry.log](evidence/audit-2026-11-04/integration-retry.log); .env.example; scripts/dev.mjs
Root cause: Proven local configuration drift, not an integration-code regression. The harness correctly refuses names without _test.
Impact: Operational reliability, status accuracy or regression assurance is degraded.
Safe temporary mitigation: keep live payouts disabled; do not claim the affected acceptance condition passes.
Minimal fix: Document overlay order and explicit test URL provisioning; avoid silent demo default; keep secrets out of reports and command output.
Dependencies: code change and isolated regression tests; production revalidation after deployment
Owner / next action: Backend/security owner to implement and attach evidence.
Retest: All required checks reproducible with operator-provisioned test-only DB credentials.
