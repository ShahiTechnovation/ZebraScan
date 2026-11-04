/**
 * Chart of accounts (starting point — the treasury accountant must review before live use).
 * Every journal balances within EACH currency; ZEC, USDC and INR are never netted against
 * each other in a single posting. Cross-currency economics are linked via per-currency
 * clearing accounts plus valuation snapshots, not via fake 1:1 postings.
 */
import type { AssetCode } from "@zeb/domain";

export interface AccountDef {
  code: string;
  currency: AssetCode;
  normal: "debit" | "credit";
  perMerchant: boolean;
  description: string;
}

const defs = [
  // --- native asset inventory
  { code: "zcash_asset", currency: "ZEC", normal: "debit", perMerchant: false, description: "ZEC held in the custodial vault (zatoshis)" },
  { code: "zec_inventory_clearing", currency: "ZEC", normal: "credit", perMerchant: false, description: "Offset for ZEC acquired in exchange for INR obligations" },
  { code: "customer_refunds_due", currency: "ZEC", normal: "credit", perMerchant: false, description: "ZEC owed back to payers (late/under/over-payments, cancelled payouts)" },
  { code: "base_usdc_asset", currency: "USDC_BASE", normal: "debit", perMerchant: false, description: "Native USDC on Base in the treasury signer wallet" },
  { code: "usdc_in_p2p_escrow", currency: "USDC_BASE", normal: "debit", perMerchant: false, description: "USDC pulled into P2P Diamond escrow for an order" },
  { code: "usdc_settlement_outflow", currency: "USDC_BASE", normal: "debit", perMerchant: false, description: "USDC released to LPs for completed INR payouts" },
  { code: "p2p_fee_expense_usdc", currency: "USDC_BASE", normal: "debit", perMerchant: false, description: "P2P small-order fixed fees paid" },
  { code: "usdc_funding_equity", currency: "USDC_BASE", normal: "credit", perMerchant: false, description: "Operator funding of the USDC treasury" },
  // --- INR-denominated assets (valuation) and liabilities
  { code: "crypto_inventory_valuation", currency: "INR", normal: "debit", perMerchant: false, description: "INR value of crypto received, at quote-time valuation" },
  { code: "merchant_credits_locked", currency: "INR", normal: "credit", perMerchant: true, description: "Merchant INR credits in cooldown (liability)" },
  { code: "merchant_credits_available", currency: "INR", normal: "credit", perMerchant: true, description: "Merchant INR credits withdrawable (liability)" },
  { code: "merchant_credits_withdrawal_reserved", currency: "INR", normal: "credit", perMerchant: true, description: "Merchant INR credits reserved for an in-flight withdrawal (liability)" },
  { code: "payout_pending_to_recipient", currency: "INR", normal: "credit", perMerchant: false, description: "Scan & Pay INR owed to UPI recipients (liability)" },
  { code: "fee_revenue", currency: "INR", normal: "credit", perMerchant: false, description: "Platform fee revenue" },
  { code: "fx_gain_loss", currency: "INR", normal: "debit", perMerchant: false, description: "Realised FX difference between quote valuation and execution" },
  { code: "loss_reserve", currency: "INR", normal: "debit", perMerchant: false, description: "Provisions for disputes / losses" },
] as const satisfies readonly AccountDef[];

export type AccountCode = (typeof defs)[number]["code"];
export const CHART: Record<AccountCode, AccountDef> = Object.fromEntries(defs.map((d) => [d.code, d])) as Record<AccountCode, AccountDef>;
