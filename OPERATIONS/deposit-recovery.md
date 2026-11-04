# Deposit recovery and edge cases

Every incoming shielded note (scope 0, Sapling or Ironwood) seen by the watch-only account becomes a `deposit_observations` row keyed by `(environment, network, pool, txid, output_ref)`. `output_ref` = `txid:p<pool>:d<diversifierIndex>:<zatoshis>:<occurrence>`, which stays the same across the mempool sighting and the mined sighting. Ingestion is idempotent: `inbound_event_receipts(source, event_id)` makes a replay a no-op, so a restart or re-poll never credits twice.

| Situation | Deterministic state | Operator action |
| --- | --- | --- |
| Note to an issued invoice address, exact amount, ≥ N confirmations | `confirming → accepted` (one receipt, one credit / payout command) | none |
| Seen in mempool only | `deposit_seen` (display only: "Payment detected") | none; never treated as paid |
| Underpaid | not accepted; full ZEC refund liability recorded | manual refund review (`/operator`) |
| Overpaid | invoice honoured; excess recorded as ZEC refund liability | manual refund of the excess |
| Paid after the deadline / on a closed invoice | `late_deposit`; refund liability; warning exception | manual refund; addresses stay monitored forever |
| Second payment to the same invoice | `extra_deposit` exception; never silently absorbed | refund review |
| Note to an address we never issued (e.g. the account's default UA, or memo missing in memo mode) | `unattributed_deposit` urgent exception; no credit | identify the payer off-band; manual refund |
| Reorg before acceptance | observation marked non-canonical; intent waits again | none (automatic) |
| Reorg after acceptance | downstream frozen + urgent exception; journals never deleted | review; if an external payout already started, treat as potential loss |
| Watcher catching up from birth height | `scanner_state.status=syncing`; receiving gate closed ("Zcash scanner is syncing") | wait; no attribution happens until synced |
| zkool DB recreated (free-tier restart) | allocator skips used indexes; bootstrap re-imports UFVK with birth → rescan | run `pnpm zkool:bootstrap` |

Refunds are **never automatic**: they need a separately hardened spending signer and explicit operator approval. On testnet they are processed by hand from the offline receiver seed.

## Reconcile
`pnpm reconcile` checks ledger balance, liabilities against credits, and allocations. A discrepancy pauses Scan & Pay and withdrawals and raises an urgent exception.
