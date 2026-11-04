# P2P.me browser capability (TinyFish, read-only)

- Checked: 2026-11-04T17:25:59.869Z (environment mainnet-readonly)
- Result: **BLOCKED**
- TinyFish run: 1b619cd8-bfd2-4aeb-9e16-7336d9acdf36
- Final page origin: https://app.p2p.lol
- Operational account fingerprint: 404a234c538bf9bb3eefc499bbb3c284 (keyed hash; the account id itself is not stored)
- Start URL: https://app.p2p.lol/ · profile: explicit profile_id

## Blockers
- orders require a wallet signature/extension/OTP that a hosted browser cannot provide
- spendable USDC balance not visible

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
