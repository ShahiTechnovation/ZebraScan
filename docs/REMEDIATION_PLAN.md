# Ordered remediation plan

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

The first business milestone—a genuine public testnet invoice receipt—was completed by concurrent work and independently verified. Preserve that evidence; P0 containment, connected public UI and restart/replay proof are next. Mainnet customer receiving and INR execution remain disabled. Owners are proposed roles. No broad implementation changes were made during this diagnosis.

| Order | Smallest correct change / owner | Dependencies | Acceptance |
|---|---|---|---|
| 0 | Backend/security: stop agent-only completion; enforce last-moment execution gates; isolate wallet issuer authority (ZEB-002/006/007) | trusted evidence contract; scoped token issuer | E21/E28/E29/E36 fixtures fail closed |
| 1 | Frontend: remove product demo imports/default; deploy connected testnet with clear unavailable states (ZEB-001) | reachable API, build env | no simulator in production; correct testnet config |
| 2 | Backend: persist unmatched outputs, fix memo reorg attribution and confirmation-gated custody accounting (ZEB-003/004/005/019) | small DB migration + existing scanner | five reproductions replaced with intended-state assertions; E08–E12/E28 |
| 3 | Zcash/operations: preserve the verified receipt and prove restart/replay/public UI | secure isolated sender, watched receiver, exact cap/destination authorization; no fiat | E04–E08: TXID, incoming note, block/confirmation, DB journal, UI; restart replay once |
| 4 | Backend: separate testnet books, repair unlock retry, finality timeout and real reserve/reconciliation model (ZEB-009/014/016/019) | custody evidence; no testnet INR entitlement | E09/E13/E27/E33 |
| 5 | Frontend/auth: all three connected journeys, correct exceptional-state copy, SMTP/Noir fallback, link concurrency | connected API + real auth channel | E01/E02/E14–E18/E25/E30/E34, 360px keyboard/camera fallback |
| 6 | Provider integration: read-only configured profile/account proof; replace legacy readiness/capacity; record permissions | operator-configured TinyFish key, provider rights, funded account | E19/E20/E35; zero money-changing calls |
| 7 | Operations/security: patch dependency advisories, persistent hosting, wallet restart/rescan, backup/restore, alerts and current runbooks | deployment access/approved infrastructure | E26/E27/E29/E31/E32/E36 |
| 8 | Mainnet read-only compatibility, financial/legal review | separate UFVK/birthday/network/secrets and qualified review | no receiving customer commitments or spending; evidence-backed gate |
| 9 | Separately authorized tiny real-money PAY/SELL pilot | all P0 fixed, actual capacity, legal/provider approval, exact source/destination/max, signer and kill switch | E22/E23/E24 actual authoritative reconciliation; never funded by TAZ |

Immediate next patch: make the production UI incapable of selecting demo, and retain payout-disabled status. The next receiving patch must fix unmatched/reorg accounting before further test payments. Prioritize issues proven dangerous over cosmetic work.

For each patch run pnpm typecheck, pnpm lint, pnpm test, TEST_DATABASE_URL=…_test pnpm test:integration, production build and targeted affected browser/fault tests. Re-run external evidence only after relevant changes. Do not rewrite tests to accept the observed defects. Never repair a payment by manually inserting a successful deposit/payout or changing a status directly.

Stop conditions for a real transfer: missing exact authorization; wrong network/receiver; unknown provider order; wallet/2FA/signature prompt without authorized operator; insufficient or stale verified backing. An elapsed timeout is not permission or proof of failure-before-submit.
