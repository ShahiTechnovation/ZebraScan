# Provider liquidity (existing P2P.me account via TinyFish): no pool, no contract

Zeb Scan does **not** deploy a liquidity pool, escrow, vault or any EVM contract. INR payouts come only from the operator's **existing, independently funded** P2P.me account, which TinyFish drives in its default Browser Context Profile.

## Rules enforced in code (`packages/core/src/tfpayouts.ts`, `gates.ts`)
* A confirmed ZEC deposit creates an obligation. It does **not** mint USDC or replenish the P2P.me balance, and no ZEC is auto-swapped.
* Before any payout: a fresh read-only capability preflight (`pnpm ops:p2p-preflight`) has to show the right domain and account, plus a spendable USDC figure. That figure is operational evidence, not proof of funds.
* `free_capacity = verified_spendable − reserved − pending − safety_buffer`. A reservation is made per checkout under a DB lock, so the same balance can't be reserved twice.
* Unknown or stale balance → `BLOCKED` / manual review. Insufficient balance → no payout and no promise of instant settlement.
* Every real-money execution needs operator approval. `HACKATHON_TESTNET` and `MAINNET_READONLY` never enqueue a real TinyFish job.
* Completion is never inferred from a TinyFish summary, a screenshot or an order click. Reconciliation reads provider order details separately, and on ambiguity the job freezes with no retry and alerts the operator.

## Current status
BLOCKED: `TINYFISH_API_KEY` is not configured on this deployment, so the logged-in session, spendable USDC and payout finality are unverified. See `docs/P2P_BROWSER_CAPABILITY.md`.

## Manual rebalancing
See `OPERATIONS/rebalance.md`.
