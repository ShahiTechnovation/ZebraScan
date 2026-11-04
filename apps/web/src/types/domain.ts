/**
 * Zeb Scan domain model.
 * Money: INR in paise (integer number), ZEC in zatoshis (bigint as decimal string),
 * USDC in 6-decimal micro-units (bigint as decimal string). Never floats.
 */

export type UiOperationMode = "demo" | "connected";

export type PaymentMode = "scan_pay" | "terminal" | "counter_qr" | "payment_link";
export type PaymentPrivacy = "shielded" | "transparent";

export type DepositStatus =
  | "awaiting"
  | "detected"
  | "confirming"
  | "accepted"
  | "expired"
  | "underpaid"
  | "overpaid"
  | "late"
  | "refund_pending"
  | "refunded"
  /** Connected mode: held for operator review (reorg, manual review, rejected). */
  | "under_review";

export type P2PStatus =
  | "not_started"
  | "placed"
  | "accepted"
  | "usdc_escrowed"
  | "inr_processing"
  | "completed"
  | "cancelled"
  | "failed"
  | "disputed"
  /** Connected mode: held for operator review. */
  | "under_review";

export type CreditStatus = "pending" | "locked" | "available" | "withdrawal_reserved" | "withdrawn";

export type WithdrawalStatus =
  | "requested"
  | "matching"
  | "accepted"
  | "escrowed"
  | "processing"
  | "completed"
  | "failed"
  | "disputed"
  | "cancelled"
  /** Connected mode: cancellation requested; waiting for on-chain confirmation. */
  | "cancelling"
  /** Connected mode: held for operator review. */
  | "under_review";

export type QuoteSource = "demo" | "live";

export interface PaymentQuote {
  id: string;
  createdAt: number;
  expiresAt: number;
  source: QuoteSource;
  /** Who supplied the rates (e.g. "Demo constants"). */
  provider: string;
  privacy: PaymentPrivacy;
  /** INR the recipient / merchant invoice is for (paise). */
  inrMinor: number;
  protocolFeeBps: number;
  platformFeeBps: number;
  protocolFeeInrMinor: number;
  platformFeeInrMinor: number;
  /** inrMinor + fees (paise). */
  totalInrMinor: number;
  /** Paise per 1 USDC (e.g. 9000 = ₹90.00). */
  inrPerUsdcMinor: number;
  /** USD micro-units per 1 ZEC (e.g. 45_000_000 = $45). */
  usdMicroPerZec: number;
  /** USDC (micro) needed to cover totalInrMinor. */
  usdcMicro: string;
  /** ZEC (zatoshi) due from the payer. */
  zecZat: string;
}

export interface MerchantPreferences {
  defaultPrivacy: PaymentPrivacy;
  allowTransparent: boolean;
  notifyOnCredit: boolean;
  notifyOnWithdrawal: boolean;
  showZecOnReceipts: boolean;
}

export interface Merchant {
  id: string;
  businessName: string;
  handle: string;
  category: string;
  logoDataUrl?: string;
  payoutUpi: string;
  beneficiaryName: string;
  /** Slug used for the reusable counter QR landing (/m/[counterSlug]). */
  counterSlug: string;
  retiredCounterSlugs: string[];
  createdAt: number;
  isSample: boolean;
  preferences: MerchantPreferences;
}

export interface MerchantSession {
  merchantId: string | null;
  startedAt: number | null;
  opsUnlocked: boolean;
}

export type LinkAmountMode = "fixed" | "variable";
export type PaymentLinkStatus = "active" | "expired" | "revoked" | "exhausted";

export interface PaymentLink {
  id: string;
  merchantId: string;
  slug: string;
  title: string;
  description: string;
  amountMode: LinkAmountMode;
  fixedInrMinor: number | null;
  minInrMinor: number | null;
  maxInrMinor: number | null;
  reusable: boolean;
  /** null = unlimited successful payments. */
  useLimit: number | null;
  expiresAt: number | null;
  allowNote: boolean;
  reference: string;
  revokedAt: number | null;
  createdAt: number;
  /** Demo-only view counter (labelled as such in UI). */
  views: number;
  duplicatedFrom?: string;
  /** Connected mode: authoritative values from the backend (client-side derivation is skipped). */
  liveStatus?: PaymentLinkStatus;
  liveSuccessfulUses?: number;
}

export interface UpiRecipient {
  vpa: string;
  /** Only when encoded in QR — never independently verified. */
  payeeName?: string;
  source: "qr_camera" | "qr_upload" | "qr_paste" | "manual";
  requestedInrMinor?: number;
  note?: string;
}

export interface ZecDeposit {
  id: string;
  checkoutId: string;
  /** Unique output identity: in live mode the wallet's (txid, output index). Demo: synthetic. */
  outputRef: string;
  zecZat: string;
  privacy: PaymentPrivacy;
  detectedAt: number;
  confirmations: number;
  requiredConfirmations: number;
  acceptedAt: number | null;
  simulated: boolean;
  /** Only a verified public txid may produce explorer links (never in demo). */
  publicTxid: string | null;
}

export interface TimelineEvent {
  at: number;
  kind: string;
  label: string;
  detail?: string;
}

export interface CheckoutIntent {
  id: string;
  mode: PaymentMode;
  merchantId: string | null;
  linkId: string | null;
  createdAt: number;
  quote: PaymentQuote;
  privacy: PaymentPrivacy;
  /** Unique per intent — never reused. */
  receivingAddress: string;
  /** Exact QR payload. Demo: zebscan-demo://checkout/<id>... */
  qrPayload: string;
  depositStatus: DepositStatus;
  deposit: ZecDeposit | null;
  recipient: UpiRecipient | null;
  p2pOrderId: string | null;
  customerNote: string;
  exceptionReason: string | null;
  events: TimelineEvent[];
  simulated: boolean;
  /** Connected mode: environment label ("TEST"/"DEMO") and whether the address can receive real ZEC. */
  envLabel?: "TEST" | "DEMO" | null;
  payable?: boolean;
  canCancel?: boolean;
  canRefresh?: boolean;
  refreshedTo?: string | null;
  receiptId?: string | null;
  /** Invoice memo code (memo-matched testnet watcher); must be included when paying. */
  memo?: string | null;
  network?: "mainnet" | "testnet" | "regtest" | "demo";
}

export interface MerchantCredit {
  id: string;
  merchantId: string;
  checkoutId: string;
  depositId: string;
  inrMinor: number;
  status: CreditStatus;
  createdAt: number;
  lockedAt: number | null;
  unlockAt: number | null;
  availableAt: number | null;
  withdrawalId: string | null;
  /** When a credit is split for a partial withdrawal. */
  parentCreditId: string | null;
}

export type LedgerKind =
  | "credit_pending"
  | "credit_locked"
  | "credit_available"
  | "withdrawal_reserved"
  | "withdrawal_completed"
  | "withdrawal_released";

export interface LedgerEntry {
  id: string;
  merchantId: string;
  at: number;
  kind: LedgerKind;
  direction: "credit" | "debit" | "memo";
  inrMinor: number;
  refId: string;
  description: string;
}

export interface P2POrder {
  id: string;
  /** PAY (orderType 2) for Scan & Pay; SELL for merchant cash-out. */
  orderType: "PAY" | "SELL";
  orderTypeCode: number;
  status: P2PStatus;
  /** True while the order is placed and waiting for a liquidity provider. */
  matching: boolean;
  checkoutId: string | null;
  withdrawalId: string | null;
  inrMinor: number;
  usdcMicro: string;
  recipientVpa: string;
  createdAt: number;
  events: TimelineEvent[];
  simulated: boolean;
}

export interface Withdrawal {
  id: string;
  merchantId: string;
  inrMinor: number;
  feeInrMinor: number;
  payoutInrMinor: number;
  usdcMicro: string;
  payoutUpi: string;
  beneficiaryName: string;
  status: WithdrawalStatus;
  createdAt: number;
  updatedAt: number;
  p2pOrderId: string;
  reservedCreditIds: string[];
  /** Set when a failed/cancelled withdrawal's funds were explicitly restored. */
  recoveredAt: number | null;
  events: TimelineEvent[];
  simulated: boolean;
}

export interface Receipt {
  id: string;
  checkoutId: string;
  merchantId: string | null;
  mode: PaymentMode;
  issuedAt: number;
  inrMinor: number;
  totalInrMinor: number;
  zecZat: string;
  privacy: PaymentPrivacy;
  merchantName: string | null;
  recipientVpaMasked: string | null;
  title: string;
  verification: "simulated" | "wallet_verified";
  simulated: boolean;
}

export interface TreasurySnapshot {
  at: number;
  source: QuoteSource;
  zecVaultZat: string;
  zecPendingZat: string;
  usdcTotalMicro: string;
  usdcReservedMicro: string;
  usdcInFlightMicro: string;
  usdcAvailableMicro: string;
  refillThresholdMicro: string;
  merchantLiabilityInrMinor: number;
  payoutQueue: number;
  rebalancing: "idle" | "scheduled";
  providerStatus: "simulated" | "not_connected";
}

export interface DemoState {
  version: number;
  seededAt: number;
  /** Demo-only clock offset used by "advance time" controls. */
  clockOffsetMs: number;
  session: MerchantSession;
  merchants: Merchant[];
  links: PaymentLink[];
  checkouts: CheckoutIntent[];
  credits: MerchantCredit[];
  ledger: LedgerEntry[];
  orders: P2POrder[];
  withdrawals: Withdrawal[];
  receipts: Receipt[];
  treasuryUsdcTotalMicro: string;
  counter: number;
}
