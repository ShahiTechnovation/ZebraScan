# P2P.me browser capability (TinyFish, read-only)

- Checked: 2026-11-04T14:28:05.635Z (environment mainnet-readonly)
- Result: **BLOCKED**
- TinyFish run: not started
- Final page origin: n/a
- Operational account fingerprint: n/a (keyed hash; the account id itself is not stored)
- Start URL: https://app.p2p.me/ · profile: default Browser Context Profile (use_profile: true)

## Blockers
- TINYFISH_API_KEY not configured

## Unverified dependencies (delta spec §1 A–H) — a logged-in profile proves none of these
- A. P2P.me permits automation of user-directed payments for third-party Zeb Scan customers
- B. the default profile is authenticated to the correct domain/account
- C. orders can be signed in a hosted browser without private keys/extension interaction
- D. funded, spendable Base USDC and fees
- E. limits / KYC / circle eligibility allow PAY and SELL
- F. an independent way to verify a payout beyond agent prose
- G. a licensed/permitted operating model
- H. wallet signature serialization for server verification (Noir: see docs/READINESS_REPORT.md)

`eligible_for_payout` stays false until this report is PASS, fresh, and live payouts are explicitly enabled by the operator.
