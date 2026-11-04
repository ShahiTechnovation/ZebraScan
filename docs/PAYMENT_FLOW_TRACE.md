# Observed payment-flow trace

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

Scope labels: **source** means inspected code; **fixture** means isolated simulated chain/provider tests; **runtime** means read-only current services. None of these labels alone proves a real end-to-end payment.

## A — Scan & Pay

1. Public /scan offers camera/upload/paste/manual input (runtime screenshot). Deployment selects demo services, so the customer journey stops before a real quote. In connected source, ScanPayWizard → live/services → /api/v1/upi/parse preserves the VPA; dynamic references are warned about, not independently verified.
2. POST /api/v1/quotes → createQuote → live ZEC/USD + INR reference → immutable quote row and rate snapshots. All wire amounts are integer strings. Eligibility uses readiness; testnet skips USDC backing. Fixture tests pass; current local /readyz reports price/scanner ready. Stale INR timestamps remain ZEB-015.
3. POST /api/v1/scan-pay/intents → createIntent checks quote ownership by environment/mode, expiry/consumption and confirmed payee; burns diversifier index, allocates UA, then atomically saves address/intent/authorization and consumes quote before returning a scoped checkout token. A rolled-back allocation may burn an unused wallet address; it is not shown to the customer. DB contains the testnet intent later accepted in the final evidence; it was not created by this audit.
4. Checkout shows ZIP-321/address, exact amount, memo if fallback mode, network and Noir action. Noir send returns a TXID but does not advance server state. Real installed wallet/network behavior BLOCKED.
5. scanner.poll → pollZkool → schema/token probe → wallet sync/status → incoming scope-0 notes → diversified index or memo mapping → ingestScannerEvent. Seen → confirming → deposit_accepted only at threshold. Initial runtime had no receiver notes; final verification matched the real Ironwood note, invoice, quote and one ZEC journal. Unmatched, memo reorg and unconfirmed late accounting fail the reproductions.
6. The verified testnet deposit acceptance recorded a ZEC leg and INR-denominated nonredeemable bookkeeping, emitted payout disabled and issued a receipt; no payout command. Testnet receiving cannot demonstrate INR delivery.
7. Mainnet source branch would reserve capacity and create immutable SCAN_PAY command. CREATED → POLICY_CHECKED → LIQUIDITY_RESERVED → READONLY_PREFLIGHT_RUNNING → OPERATOR_APPROVAL_REQUIRED → QUEUED → AGENT_RUNNING → ORDER_SUBMISSION_OBSERVED → provider states → PROVIDER_COMPLETED_VERIFIED → RECONCILED. This path is BLOCKED by missing access/authorization and unsafe verification/execution checks.
8. Receipt is server-generated, status follows backend; no bank-compatible payment evidence exists. Successful fixture payout tests are explicitly simulated.

## B — Merchant QR terminal

1. Merchant auth uses real API password/OTP or derived wallet-signature challenge in connected mode. Public product is demo; real SMTP/installed wallet proof missing. Resource ownership/RBAC tests pass.
2. Terminal → authenticated merchant checkout endpoint → same quote/address/intent path; business verification required in mainnet-enabled. No unique permanent INR-to-ZEC quote is reused.
3. Confirmed accepted note → one merchant_credit + locked INR ledger entry + backing conversion outside testnet + unlock job, in one DB transaction. No merchant-terminal note observed; the real receipt is Scan & Pay only.
4. unlockCredit checks cooldown, open exceptions, canonicality, merchant status and allocation, then posts locked→available. Testnet skips backing and remains nonredeemable. Blocked/early job rescheduling fails ZEB-009.
5. Withdrawal quote checks eligible balance/destination/readiness; createWithdrawal locks merchant/credits, prevents another active withdrawal, reserves FIFO credits and treasury. Fixture confirms balance preservation and cancel/restore. Simultaneous double-cashout stress is not separately proven.
6. SELL payout uses MERCHANT_WITHDRAWAL command; ambiguous attempts retain reservations and require reconciliation. Provider cancellation can restore via compensation, but the authoritative cancellation/settlement source is still missing. No actual withdrawal was made.

## C — Payment links

1. Authenticated creation persists fixed/variable bounds, expiry, reusable/use-limit and slug. linkDto builds URL from APP_BASE_URL. Public opening does not consume usage.
2. Each payer checkout gets a new quote/address/intent; server rechecks link state/amount under lock. Revoke stops new attempts while in-flight intent remains accountable.
3. Acceptance locks the link and increments successful_uses; if exhausted, ZEC is routed to refund review without credit. Unbacked refund promises need corrected copy; authorized refund execution is not implemented.
4. Merchant credit/cooldown/withdrawal follows B. Backend quota/revoke fixtures pass. Demo cross-tab browser fixtures fail (21/23 overall); connected real-payment link journey remains BLOCKED.

## Exceptions / recovery

| Trigger | Actual path | Remaining gap |
|---|---|---|
| Missing/incorrect memo or unknown address | urgent exception; returns before observation insert | second unmatched output loses individual details (ZEB-003) |
| Expired/cancelled invoice | late_deposit + refund liability | unmined note already booked (ZEB-005) |
| Confirmed underpay | underpaid + refund review, no fulfillment | subsequent top-ups only exception, incomplete custody book (ZEB-019) |
| Confirmed overpay | honor quoted amount; excess refund liability | frontend exception copy differs (ZEB-020) |
| Reorg | chain_reorg_review, freeze credit, urgent exception | memo reorg fails attribution; pending TinyFish command not held (ZEB-004/007) |
| Submission timeout | OUTCOME_UNKNOWN_REVIEW, no blind retry | independent authoritative resolution missing (ZEB-002) |
| Finality never arrives | deposit_seen/confirming indefinitely | finality_deadline not enforced (ZEB-019) |

Evidence: [runtime.json](evidence/audit-2026-11-04/runtime.json), [reproductions.json](evidence/audit-2026-11-04/reproductions.json), [integration-retry.log](evidence/audit-2026-11-04/integration-retry.log), [browser-e2e.log](evidence/audit-2026-11-04/browser-e2e.log). Source anchors and exact retests are in [issue register](ISSUE_REGISTER.md).
