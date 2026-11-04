# ADR-0004 — Hold USDC at intent creation, not at quote creation
Status: accepted (deviation from §9.2 wording)

Quotes are public, anonymous and rate-limited; letting each one lock treasury USDC would let anyone exhaust liquidity. Quote creation *checks* capacity (and marks the quote ineligible if short); the hold (`deposit_hold`) is taken atomically when an intent consumes the quote, and is converted, never duplicated, through `direct_payout` / `merchant_credit_backing` / `withdrawal`.
