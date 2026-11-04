# Zeb Scan — frontend specification

## 1. Product modes

| Mode (`PaymentMode`) | Who | Flow | Settlement |
| --- | --- | --- | --- |
| `scan_pay` | Any payer, no account | Read UPI QR / VPA → INR amount → quote → pay ZEC to unique address → verified → P2P **PAY** order (type 2) → provider sends INR to the UPI receiver | Direct payout; complete only when the provider confirms |
| `terminal` | Onboarded merchant | Fixed INR → one-time checkout + ZEC QR | INR-denominated merchant credit: pending → locked → available after cooldown → withdrawal (P2P **SELL**) |
| `counter_qr` | Onboarded merchant | Permanent QR → `/m/[handle]` → payer enters INR → new checkout | Same as terminal |
| `payment_link` | Onboarded merchant | `/pay/[slug]` (fixed or bounded variable INR) → new checkout per visit | Same as terminal |

Two internal pools: **ZEC Vault** (Zcash receiving wallet; custodial while held) and **USDC Treasury** (pre-funded, Base; funds P2P payouts and backs merchant liabilities). Rebalancing is asynchronous. USDC is never the customer's payment token. INR only, ZEC only.

## 2. Demo vs live

- `NEXT_PUBLIC_ZEB_MODE=demo` → `demoServices` (local, deterministic, `localStorage`). Every simulated surface is labelled: DEMO badge, "Illustrative prices · not market data", "Preview QR — cannot receive real ZEC", "Simulated receipt — not proof of a bank transfer".
- `NEXT_PUBLIC_ZEB_MODE=connected` → `liveServices` from `src/services/registry.ts`. In this build that is `null`: the UI shows "Live payments are not connected in this build." and disables money actions. **No fallback to demo.**
- Demo-only controls (wallet simulator, payout simulator, demo clock) render inside `<DemoControls>` only when `isDemo`; optional adapter methods (`simulateDeposit?`, `advanceOrder?`, …) are absent on live adapters by contract.
- Demo QR payloads encode `zebscan-demo://checkout/<id>?amount=…&payable=false`; demo addresses are `zebscan-demo-address-<id>-not-payable`. Neither resembles a real Zcash address. A production ZIP-321 URI (`zcash:<address>?amount=<zec>`) may only be built from an adapter-returned address.

## 3. Domain model (`src/types/domain.ts`)

Money: INR **paise** (integer), ZEC **zatoshis** (bigint string, 1 ZEC = 10⁸), USDC **micro-units** (bigint string, 6 decimals). No floats as source of truth. INR formatted with `Intl.NumberFormat('en-IN')`; ZEC up to 8 decimals with exact copy.

Entities: `Merchant`, `MerchantSession`, `PaymentLink`, `CheckoutIntent`, `PaymentQuote`, `ZecDeposit`, `MerchantCredit`, `LedgerEntry`, `Withdrawal`, `P2POrder`, `Receipt`, `TreasurySnapshot`, `UiOperationMode`.

Discriminators: `PaymentMode`, `PaymentPrivacy`, `DepositStatus`, `P2PStatus`, `CreditStatus`, `WithdrawalStatus` exactly as specified.

### Quote math (demo constants in `src/config/demo.ts`)

```
protocolFee = round_half_up(inr × 100 / 10000)
platformFee = round_half_up(inr × 50 / 10000)
total       = inr + protocolFee + platformFee
usdcMicro   = ceil(total × 10⁶ / 9000)           # 1 USDC = ₹90.00
zecZat      = ceil(usdcMicro × 10⁸ / 45_000_000) # 1 ZEC = $45 (USDC≈USD)
lifetime    = 90 s
```
Example: ₹500 → fees ₹7.50 → ₹507.50 → 5.638889 USDC → 0.12530865 ZEC.

Withdrawals: spread 0.75% (demo), minimum ₹100, USDC sold = ceil(amount / 90).

## 4. Invariants (enforced in `services/demo/engine.ts`, tested in `tests/unit/engine.test.ts`)

1. One unique address and quote per checkout; refresh creates a new intent.
2. One deposit output → at most one credit or one payout (output ref + idempotent transitions; replays throw).
3. Credits are liabilities; available only after cooldown (`demoConfig.cooldownDays`, example 15 days).
4. Credits require accepted ZEC (simulated in demo).
5. Treasury snapshot partitions USDC into reserved / in-flight / available with no double counting.
6. Scanning a QR moves nothing.
7. PAY is order type 2; SELL for cash-out; an order is never complete because it was placed.
8. Shielded deposits are verified by the wallet, not by an explorer; explorer links only for a verified public txid (never in demo).
9. Expired/late/underpaid/overpaid funds go to exception/refund states; never silently discarded.
10. Payment links: only confirmed payments consume uses; a payment confirming after exhaustion/revocation is held for refund.
11. Withdrawals reserve credits FIFO (splitting partially used credits); failure restores funds only via explicit `recoverWithdrawal`, exactly once.

## 5. Adapter contracts (`src/services/adapters.ts`)

```ts
interface RatesAdapter { getRates(): Promise<RateReading>; quote(inrMinor, privacy): Promise<PaymentQuote> }
interface ZcashPaymentAdapter {
  createPaymentIntent(input: CheckoutInput): Promise<CheckoutIntent>;   // unique address + locked quote
  getIntent(id): Promise<CheckoutIntent | null>;
  subscribeDepositState(id, cb): () => void;                           // wallet-scanning driven
  simulateDeposit?/advanceConfirmation?/startRefund?/completeRefund?    // demo only
}
interface P2PPayoutAdapter { getOrder(id); advanceOrder?; failOrder?; recoverOrder? }
interface MerchantAdapter {
  onboard; updateMerchant; regenerateCounterSlug;
  createLink; updateLink /* metadata only */; revokeLink; duplicateLink; recordLinkView;
  requestWithdrawal; cancelWithdrawal; recoverWithdrawal;
  advanceWithdrawal?; failWithdrawal?; resolveDispute?                  // demo only
}
interface LedgerAdapter { getCredits(merchantId); getLedger(merchantId); getTreasury() }
```

UI reads the reactive demo snapshot through `useZeb()` / `useMerchantData()`; a live implementation should expose the same shapes through a data-sync layer (e.g. server-sent events or polling into the same hook).

## 6. Persistence

`src/services/demo/store.ts` — `useSyncExternalStore` with a `null` server snapshot (nothing persisted renders during SSR), versioned key `zebscan.demo.v3`, reseeds on version mismatch or corruption, syncs across tabs via the `storage` event, 1 s reconcile tick for quote expiry and cooldown unlocks. A demo clock offset supports "Advance cooldown".
