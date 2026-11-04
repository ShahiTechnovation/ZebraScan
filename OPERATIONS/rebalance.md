# Manual treasury rebalancing and solvency check

There is no automatic ZEC liquidation and no bridge. The operator rebalances by hand:

1. `pnpm reconcile`: confirm the ledger balances and outstanding INR obligations (Scan & Pay commands + unlocked merchant credits).
2. Read the P2P.me spendable USDC with the read-only preflight. Compare it against obligations plus the safety buffer.
3. If short: pause Scan & Pay and withdrawals (`feature_gates`), then top up the P2P.me account from an operator-controlled USDC source **outside Zeb Scan**.
4. If ZEC must be sold, use an approved venue manually with the offline signer. Record it as a journal (no code path does this).
5. Re-run the preflight, then reopen features.

Testnet: TAZ has no value. Test-only merchant credits are not redeemable, and no rebalancing applies.
