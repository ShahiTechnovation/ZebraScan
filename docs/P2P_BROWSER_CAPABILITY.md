# P2P.me browser capability (TinyFish, read-only)

- Checked: 2026-11-04T16:41:04.852Z (environment mainnet-readonly)
- Result: **BLOCKED**
- TinyFish run: 6b0e63aa-6ba3-49c4-800e-6af4375e17a3
- Final page origin: https://app.p2p.lol
- Operational account fingerprint: 2c5763d485c1a575035a9dd9a960646a (keyed hash; the account id itself is not stored)
- Start URL: https://app.p2p.lol/ · profile: default Browser Context Profile (use_profile: true)

## Blockers
- profile is not authenticated (login page shown)
- orders require a wallet signature/extension/OTP that a hosted browser cannot provide
- provider blocker: Account appears anonymous (no account handle, wallet address, or profile identifier visible) — no known user identity confirmed.
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
