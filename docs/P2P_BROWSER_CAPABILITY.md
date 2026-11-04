# P2P.me browser capability (TinyFish, read-only)

- Checked: 2026-11-04T16:38:03.525Z (environment mainnet-readonly)
- Result: **BLOCKED**
- TinyFish run: 176cd99b-7fc3-4e3d-b577-302d4ae3f059
- Final page origin: https://app.p2p.me
- Operational account fingerprint: 7ee6ced6da030612f18d9c43944edbea (keyed hash; the account id itself is not stored)
- Start URL: https://app.p2p.me/ · profile: default Browser Context Profile (use_profile: true)

## Blockers
- profile is not authenticated (login page shown)
- PAY (Scan & Pay) flow not available
- SELL flow not available
- provider blocker: The page shows a login screen. No authenticated account is visible. The account handle, Pay/Sell UI availability, USDC balance, limits/blockers, and wallet sign
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
