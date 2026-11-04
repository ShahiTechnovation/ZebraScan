# Financial invariants and audit results

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

| Invariant | Evidence / implementation | Result and limits |
|---|---|---|
| Exact money, integer strings on wire | domain/money, rational, quote; DB NUMERIC/INT8 string parsers; 92 unit tests | PASS core math; zkool numeric value adapter uses toFixed(8), so strict no-float wallet boundary is not met |
| Unique output identity, never amount-only matching | deposits unique key; address/memo queries; memo-matching fixture | PASS mapped fixture; FAIL unmatched persistence and memo reorg |
| Confirmed canonical receipt before assets/fulfillment | evaluateAcceptance and confirmation policy | FAIL late unmined refund journal; canonical block identity incomplete |
| No testnet→live INR | environment capability false, createPayoutCommand rejects testnet, withdrawal readiness false | PASS guard inspection/unit evidence; testnet INR books still need separation |
| Immutable quote / consent | quote input hash, consumed_by, DB immutability; intent authorization snapshot | PASS fixture; quote itself is not beneficiary-bound until intent consent; reservation begins at intent (ADR-0004) |
| Exactly-once journal per business event | journal event key + lines hash, DB balance/append-only triggers | PASS integration; does not compensate for missing observations |
| Credit backing / double cashout | holds, locked credits, merchant lock, available balance recheck, unique active withdrawal | PASS fixture controls; actual assets/account capacity BLOCKED |
| Cooldown is server-controlled | unlockCredit and durable job | FAIL blocked/early self-reschedule can be marked done |
| Confirmed extra/unmatched funds remain owed | exception/refund handling | FAIL missing unmatched records; incomplete extra-output books |
| Payout attempt persisted before submit, no blind retry | payout_attempts, maxRetries:0, account lease, ambiguous states | PASS scripted failure tests; real provider behavior BLOCKED |
| Kill switch / reorg stop new execution | ops feature gates, held flag, source status | FAIL QUEUED branch does not recheck global gate/source/finality/TTL |
| Provider completion independently evidenced | evaluateReconcile → settle | FAIL agent narrative accepted; unknown debit booked as maximum |
| Every liability reconciles to known assets | reconciliation_runs | FAIL stale check says true, frozen credits bypass comparison, TinyFish commitments absent |
| History immutable, corrections compensated | SQL triggers + postJournal reversals | PASS DB fixtures; operator recovery policy and real refund signer BLOCKED |
| Ledger values are not bank deposits | balance disclaimer and TEST label | PASS disclosure present; public tagline/demo and conditional captions need ZEB-001/020 |
| No viewing-key refund signing | receiving workflow and review states | PASS no automatic receiving-key refund; authorized refund execution NOT_IMPLEMENTED |

Core source anchors: `packages/ledger/src/journal.ts:84`; `packages/core/src/withdrawals.ts:89`; `packages/core/src/deposits.ts:134`; `packages/core/src/tfpayouts.ts:635`; `packages/core/src/reconcile.ts:31`. Full reproduction results: [reproductions.json](evidence/audit-2026-11-04/reproductions.json).

Required balancing model: confirmed ZEC custody must reconcile to inventory clearing plus customer refunds; INR liabilities require verified real backing; USDC commitments must reconcile to the specific provider account and actual debits. A balanced journal alone is insufficient if its asset is unconfirmed, its output was omitted, or its debit was guessed. Testnet TAZ remains worthless and cannot back any redeemable INR liability.

The automated tests prove isolated mechanics; the final wallet/DB probe additionally proves one real testnet receipt. Neither proves real INR backing or bank delivery. Do not report successful payment merely because a journal balances or a browser run completes.
