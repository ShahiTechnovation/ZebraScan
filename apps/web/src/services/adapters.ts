/**
 * Typed integration contracts. The UI only talks to these interfaces.
 * - Demo implementations live in src/services/demo/ (local, simulated, localStorage).
 * - Live implementations do NOT exist in this build; see docs/INTEGRATION_HANDOFF.md.
 * No wallet seeds, viewing keys, RPC credentials or treasury keys may ever be
 * passed to or stored in the frontend — live adapters must call a backend.
 */
import type {
  CheckoutIntent,
  DepositStatus,
  LedgerEntry,
  Merchant,
  MerchantCredit,
  P2POrder,
  PaymentLink,
  PaymentPrivacy,
  PaymentQuote,
  QuoteSource,
  TreasurySnapshot,
  Withdrawal,
} from "@/types/domain";
import type { CheckoutInput, LinkInput, OnboardingInput, SimulatedDeposit } from "./demo/engine";

export interface RateReading {
  /** USD micro per 1 ZEC. */
  usdMicroPerZec: number;
  /** Paise per 1 USDC. */
  inrPerUsdcMinor: number;
  source: QuoteSource;
  provider: string;
  fetchedAt: number;
  expiresAt: number;
}

export interface RatesAdapter {
  getRates(): Promise<RateReading>;
  quote(inrMinor: number, privacy: PaymentPrivacy): Promise<PaymentQuote>;
}

export interface ZcashPaymentAdapter {
  /** Creates an intent with a UNIQUE receiving address and a locked quote. */
  createPaymentIntent(input: CheckoutInput): Promise<CheckoutIntent>;
  getIntent(id: string): Promise<CheckoutIntent | null>;
  /** Live: wallet viewing-key scanning; never explorer screenshots or user-reported txids. */
  subscribeDepositState(id: string, cb: (status: DepositStatus) => void): () => void;
  /** Demo only — undefined on live adapters. */
  simulateDeposit?(id: string, kind: SimulatedDeposit): Promise<void>;
  advanceConfirmation?(id: string): Promise<void>;
  startRefund?(id: string): Promise<void>;
  completeRefund?(id: string): Promise<void>;
  /** Live: close an unfunded checkout and issue a NEW quote + NEW address (server-side refresh). */
  refreshIntent?(id: string): Promise<CheckoutIntent>;
  /** Live: payer supplies a Zcash refund address for an exception (reviewed by an operator). */
  submitRefundAddress?(id: string, zcashAddress: string): Promise<void>;
}

export interface P2PPayoutAdapter {
  getOrder(id: string): Promise<P2POrder | null>;
  /** Demo only progression controls. */
  advanceOrder?(id: string): Promise<void>;
  failOrder?(id: string, kind: "failed" | "disputed"): Promise<void>;
  recoverOrder?(id: string, how: "retry" | "refund"): Promise<void>;
}

export interface MerchantAdapter {
  onboard(input: OnboardingInput): Promise<Merchant>;
  updateMerchant(id: string, patch: Partial<Merchant>): Promise<void>;
  regenerateCounterSlug(id: string): Promise<void>;
  createLink(merchantId: string, input: LinkInput): Promise<PaymentLink>;
  updateLink(id: string, patch: Partial<Pick<PaymentLink, "title" | "description" | "reference" | "allowNote">>): Promise<void>;
  revokeLink(id: string): Promise<void>;
  duplicateLink(id: string): Promise<PaymentLink>;
  recordLinkView(id: string): Promise<void>;
  requestWithdrawal(merchantId: string, inrMinor: number): Promise<Withdrawal>;
  cancelWithdrawal(id: string): Promise<void>;
  recoverWithdrawal(id: string): Promise<void>;
  /** Demo only. */
  advanceWithdrawal?(id: string): Promise<void>;
  failWithdrawal?(id: string, kind: "failed" | "disputed"): Promise<void>;
  resolveDispute?(id: string, outcome: "completed" | "failed"): Promise<void>;
}

export interface LedgerAdapter {
  getCredits(merchantId: string): Promise<MerchantCredit[]>;
  getLedger(merchantId: string): Promise<LedgerEntry[]>;
  getTreasury(): Promise<TreasurySnapshot>;
}

export interface ZebServices {
  kind: "demo" | "live";
  rates: RatesAdapter;
  zcash: ZcashPaymentAdapter;
  p2p: P2PPayoutAdapter;
  merchant: MerchantAdapter;
  ledger: LedgerAdapter;
}
