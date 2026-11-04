# Runbooks

All actions are audited. Money-moving decisions need two operators (`POST /api/v1/ops/exception/{id}/decide` → second operator `POST /ops/approvals/{id}/approve` → re-submit with `approvalId`).

| Incident | Detection | Action |
| --- | --- | --- |
| **Reconciliation discrepancy** | urgent exception `reconciliation_discrepancy`; Scan & Pay + withdrawals auto-paused | Run `pnpm reconcile`, read failed checks. Fix root cause (never edit ledger rows — post compensating journals via code). Resume with dual control (`/ops/resume`). |
| **Reorg after acceptance** | `reorg_after_acceptance` (urgent); credit `frozen`, payout held if not committed | Check gateway status/tip. If the note re-confirms canonically, decide `accept_deposit`; if gone, `reject`/refund route. If a payout was already committed, treat as loss event and record in `loss_reserve`. |
| **Ambiguous broadcast** (`ambiguous_submission`, `approve_ambiguous`) | payout/withdrawal `manual_review` | Inspect treasury nonce history on Base explorer; identify the tx; if an order exists, set `onchain_order_id` and `retry_payout`; never resubmit blindly. Credits stay reserved. |
| **Payout stuck / overdue** | `payout_completion_overdue` | Contact LP via P2P provider; raise dispute through provider process if needed. |
| **Order disputed** | `order_disputed` | Collect evidence; outcome is read from chain; do not restore credits while escrow is open. |
| **Price feed outage / divergence** | readiness `priceFeed` closed | No action needed for safety (quotes refuse). Investigate provider; consider adding a third source. |
| **Scanner stale / error** | readiness `scanner` closed; invoice creation halts | Check node/indexer sync, gateway logs; `POST /internal/backfill` from last safe height (≥ birthday). |
| **Late / under / overpayment** | exceptions + payer refund-address form | Verify refund address out of band; send via isolated signer with two-person approval; record refund journal. |
| **Key rotation** | scheduled | Add new KEK id, set `ZEB_ACTIVE_KEK`, run rotation job (re-seal), retire old KEK after verification. Rotate `ZEB_TOKEN_SECRET` only with planned session/token invalidation. |
| **Backup / restore** | daily | PITR on PostgreSQL. After restore: pause all features, reconcile, rescan gateway from last safe checkpoint, compare chain balances, then resume with dual control. |
| **Credential compromise** | — | Pause `all`; revoke sessions (`UPDATE sessions SET revoked_at=now()`), rotate secrets; for treasury signer: move funds per custody policy, revoke allowances (`approve(0)`). |
