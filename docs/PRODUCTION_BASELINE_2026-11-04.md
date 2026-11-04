# Production implementation baseline — 2026-11-04

Starting HEAD: `84b996f` on `main` (newer than the requested `85c50ed`). Existing frontend edits and audit artifacts are present and must be preserved. This snapshot precedes implementation; it is not a readiness declaration.

Preserved payment: testnet invoice `pi_kddd0fe7xccewd6x2csrhykxdr`, TXID `5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7`, 836471 zatoshis, mined height 4582568. Its existing receipt and append-only journals must survive. Historical INR postings require an explicit compensating entry, never deletion.

Environments: testnet receiving only; separate mainnet read-only stack. Mainnet receiving and all external money movement remain unauthorized. Public web is https://zebrascan.vercel.app; deployment provenance and API reachability require fresh verification. Local testnet web was reported on port 3001; mainnet API uses 4100, so connected test servers must use separate ports.

Initial source re-evaluation (fresh regression results will replace these statuses in the delivery report):

| Audit IDs | Status at baseline | Current evidence |
| --- | --- | --- |
| 001, 020 | OPEN / concurrent edits | web mode registry/provider and checkout copy need complete review |
| 002, 007 | OPEN | core/tfpayouts.ts trusts browser completion and lacks final transactional gates |
| 003–005, 014, 019 | OPEN | core/deposits.ts drops unmatched notes; reorg rematches memo; late mempool books refunds; testnet books INR |
| 006 | OPEN | core/config.ts and providers/zkool.ts accept JWT issuer key in runtime |
| 008 | FIXED, pending replay verification | accepted-note replay guard present; original payment retained |
| 009 | OPEN | jobs.ts ignores unlockCredit result and completes early-claimed job |
| 010, 013, 015, 016 | OPEN | legacy capacity, chain witness, rate timestamp and reconciliation checks |
| 011 | BLOCKED external | HEAD includes first real read-only TinyFish preflight; authentication/funding/permission not established |
| 012, 017, 023 | BLOCKED external / partial code | persistent hosted stack, real login interoperability, delivered alerts need evidence |
| 018, 021, 024 | UNVERIFIED | fresh dependency audit, connected browser tests and isolated DB overlay needed |
| 022 | OPEN | prior audit is historical, not current readiness evidence |

Evidence already exists under `docs/evidence/audit-2026-11-04/`; new commands and redacted results belong in `docs/evidence/final-production/`. No keys, full viewing keys, tokens, OTPs, cookies or decrypted memos belong in these documents. Mainnet NU7 scheduling follows ZIP-259; the old claim that it is unscheduled is obsolete. Activation still requires actual chain evidence.
