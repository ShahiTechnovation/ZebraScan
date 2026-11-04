# Submission evidence — verified testnet receipt

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

## Verified receipt

- TXID: 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7
- [Public testnet explorer](https://zexplorer.app/testnet/tx/5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7)
- Invoice: pi_kddd0fe7xccewd6x2csrhykxdr; mode Scan & Pay; network testnet.
- Received/quoted: 836471 zatoshis (0.00836471 TAZ); incoming Ironwood pool 3, external scope 0, diversifier 1.
- Mined block: 4582568; DB confirmations 40 at final capture; required 1.
- Accepted observation and exactly one deposit ZEC journal verified directly. One testnet INR bookkeeping journal also exists (ZEB-014); it creates no real INR entitlement.
- INR payout: not_started; no payout command; testnet nonredeemable.
- Evidence: [independent final wallet/DB probe](evidence/audit-2026-11-04/runtime-final.json), [server checkout timeline](evidence/testnet-checkout-pi_kddd0fe7.json). The transaction was performed by concurrent work; this audit only queried its state.

The server timeline shows invoice creation, mempool detection, mining/acceptance and payout-disabled event. The historical timeline also contains spurious Additional ZEC events on confirmation updates; concurrent commit 7335aa7 fixes that behavior. Financial entries were not duplicated in the final query. Explicit restart/rescan and multiple real invoice proofs remain BLOCKED. Explorer scripted access was unavailable; the wallet and independent application DB are the captured receipt evidence.

The earlier faucet TXID b056fc3a752cc67edd6f212791846406985d387e09225cbcb3143ec8f7b0d9b2 is funding evidence for payer A, not this invoice. Use the receipt TXID above for the payment-core evidence. Never describe it as an INR payout.

## Public app and README

[Public app](https://zebrascan.vercel.app) is reachable but remains a labeled demo at the browser capture. It is not yet a real connected public checkout. README was updated concurrently during the final review; it should link this evidence and preserve the distinction between real local testnet receipt, public demo, mainnet read-only sync and unverified fiat settlement. No video/interview/submission-finalization evidence was independently captured.

## Privacy/trust

Shielding hides payment details on the public chain; the platform/wallet host sees incoming amounts/memos through viewing access. Lightwallet service sees traffic metadata. TinyFish/P2P provider/banks see relevant fiat details if that rail is authorized. No seed, spending key or checkout bearer token is included here. TAZ is worthless and cannot back redeemable INR.

## Stadium status

[Official privacy track](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), version 2026-11-02, and [event index](https://stadium.joinwebzero.com/programs/free-society-hack-2026/llms.txt) were refetched. The index lists first-session finalization at 20:00 IST on 4 November and submission close at 00:00 IST on 5 November. Actual draft/finalized/feedback/video state is BLOCKED: no authenticated Stadium record was inspected and no submission was made by this audit.

Milestones: implementation and automated fixture tests substantially evidenced; one actual public-testnet invoice receipt PASS; mainnet local read-only synchronization PASS with consensus/key-certification limits; live fiat pilot BLOCKED; full public production FAIL.
