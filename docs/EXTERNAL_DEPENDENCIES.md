# External dependency and permission inventory

**Final evidence update — 2026-11-04T16:20:15.789Z (21:50 IST), SHA 7335aa7cec3cdaee5128d4e612acbab24c96393a.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note 5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7, 836471 zatoshis, block 4582568, 40 confirmations in the DB, accepted invoice pi_kddd0fe7xccewd6x2csrhykxdr, exactly one ZEC journal, payout not_started. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at 2026-11-04T16:26:09.200Z: synced 3541772, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.

Audit date: 4 November 2026 (IST). Runtime snapshot: 2026-11-04T16:00:03.891Z (21:30 IST). Initial SHA: 7d4151afe4ea7102fd61882ca36151ab8df404cd; runtime SHA: 2ac7d18b7d946e75ce89310fa0e1a407fdc46401; branch: main. The shared checkout changed during inspection. Claims below apply to the recorded snapshots, not an immutable deployment certification.

| Dependency | Current evidence / availability | Status / required next evidence |
|---|---|---|
| Zcash testnet lightwallet | Render config uses https://testnet.zec.rocks:443; authenticated currentHeight and local synced row observed | PASS for tip and one real Ironwood invoice receipt |
| zkool_graphql | pinned Docker digest/config; schema evidence and scoped query work | PASS connectivity/one Ironwood receipt; reorg/restart certification FAIL/BLOCKED |
| Receiver B | UFVK import/birthday in bootstrap evidence; one final incoming Ironwood note | PASS receipt; least-privilege authority FAIL ZEB-006 |
| Payer A | existing faucet claim contains TXID and broadcasting status | PASS receipt matched from concurrent send; audit did not submit it |
| Mainnet wallet | separate Render service/key names; HTTP GET 405 | PASS local read-only sync; actual consensus/key isolation/restart verification BLOCKED |
| Rust gateway | explicit sync stub, Orchard receiver code, no successful compile evidence | NOT_IMPLEMENTED as a usable NU7 scanner; must not become fallback |
| ZEC/USD oracle | CoinGecko + Kraken sources; runtime local readiness available | PASS point-in-time source availability; no uptime guarantee |
| INR/USDC | CoinGecko testnet reference; no fiat redemption | FAIL timestamp policy ZEB-015; mainnet executable rate BLOCKED |
| TinyFish SDK | @tiny-fish/sdk 0.11.0; queue with use_profile:true, optional profile_id, maxRetries:0 | PASS static SDK integration/profile syntax; actual credential/account BLOCKED |
| Saved P2P browser profile | no configured key/start URL/profile; default profile not observed | BLOCKED; operator must configure secrets directly and verify correct account read-only |
| P2P PAY/SELL rights/limits | no provider-confirmed automation, eligibility or order limits | BLOCKED; provider/account owner permission |
| Payout funding/signatures | no verified spendable P2P account inventory or authorized signer | BLOCKED; browser automation cannot provide custody/signatures/funding |
| Independent payout proof | second TinyFish narrative only; no bank/provider authenticated adapter | NOT_IMPLEMENTED; ZEB-002 |
| USDC reserves/replenishment | legacy chain-address inventory; manual rebalance runbook | BLOCKED actual capacity; no ZEC→USDC conversion integration |
| Email delivery | dev-file configured, SMTP absent | BLOCKED remote merchant OTP/recovery delivery |
| Noir extension | SDK 0.1.9; generated signature vectors pass | BLOCKED real installed testnet extension signature/network/send proof |
| Passkeys | advertised unavailable | NOT_IMPLEMENTED |
| DB | PostgreSQL accessible; five migrations, durable tables | PASS local; hosted DB/backup/restore BLOCKED |
| KMS/secret manager | LocalKeyProvider only; ignored local secrets | NOT_IMPLEMENTED production KMS; key custody is not certified |
| Public web | Vercel alias HTTP 200, real browser inspected | FAIL required product mode: ships demo |
| Persistent API/worker/wallet | local API/worker only evidenced; Render free ephemeral wallet | BLOCKED continuous deployment/restart drill |
| Monitoring/alerts | DB exceptions, liveness and readiness; no alert subscriber | NOT_IMPLEMENTED external alert delivery |
| Legal/KYB/provider approval | no approval refs/proof supplied | BLOCKED; obtain qualified review separately, no legal conclusion made here |
| Stadium submission | official index/track refetched; no authenticated submission state | BLOCKED actual finalized submission status/video/feedback proof; testnet receipt now available |

[Official track](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), [event index](https://stadium.joinwebzero.com/programs/free-society-hack-2026/llms.txt), [TinyFish Browser Context Profiles](https://docs.tinyfish.ai/key-concepts/browser-context-profiles), [ZIP-321](https://zips.z.cash/zip-0321). The profile docs describe selecting saved browser context; they do not establish P2P permission or payment settlement. [P2P SDK reference](https://github.com/p2pdotme/p2pdotme-sdk) remains reference-only; its executor must not be connected as a fallback.

Read-only preflight was not started because required application credentials are absent. A connector's separate browser session would not prove that this deployment's configured profile is authenticated. No secret, session token, password, seed or private key is requested in chat. Provision through the operator's secret store.
