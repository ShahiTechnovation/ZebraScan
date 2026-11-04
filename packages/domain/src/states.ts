/**
 * Formal state machines (spec §3). Transitions are validated against these matrices by
 * domain commands; anything not listed is rejected with STATE_TRANSITION_REJECTED (HTTP 409).
 * No status may be invented outside these enums.
 */
import { DomainError } from "./errors";

type Matrix<S extends string> = Readonly<Record<S, readonly S[]>>;

function machine<S extends string>(name: string, states: readonly S[], matrix: Matrix<S>, terminal: readonly S[]) {
  for (const s of states) if (!(s in matrix)) throw new Error(`${name}: missing matrix row for ${s}`);
  return {
    name,
    states,
    terminal,
    can(from: S, to: S): boolean {
      return matrix[from]?.includes(to) ?? false;
    },
    assert(from: S, to: S, ctx?: Record<string, unknown>): void {
      if (!matrix[from]?.includes(to)) {
        throw new DomainError("STATE_TRANSITION_REJECTED", `${name}: ${from} → ${to} is not allowed`, { from, to, ...ctx }, {
          status: 409,
          currentStatus: from,
        });
      }
    },
    isTerminal(s: S): boolean {
      return terminal.includes(s);
    },
    is(value: string): value is S {
      return (states as readonly string[]).includes(value);
    },
  };
}

/* ---------------------------------------------------------- payment intent (deposit stage) */
export const INTENT_STATUSES = [
  "created",
  "quoted",
  "awaiting_zec",
  "deposit_seen",
  "confirming",
  "deposit_accepted",
  "expired_without_funds",
  "late_deposit",
  "underpaid",
  "overpaid",
  "chain_reorg_review",
  "manual_review",
  "refund_queued",
  "refunded",
  "rejected",
  "cancelled",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const intentMachine = machine<IntentStatus>(
  "PaymentIntent",
  INTENT_STATUSES,
  {
    created: ["quoted", "rejected"],
    quoted: ["awaiting_zec", "rejected"],
    awaiting_zec: ["deposit_seen", "confirming", "expired_without_funds", "cancelled"],
    deposit_seen: ["confirming", "chain_reorg_review", "awaiting_zec"],
    confirming: ["deposit_accepted", "underpaid", "overpaid", "chain_reorg_review", "manual_review"],
    deposit_accepted: ["chain_reorg_review", "manual_review", "refund_queued"],
    // Expired/cancelled intents keep watching their address forever; funds arriving later become late_deposit.
    expired_without_funds: ["late_deposit"],
    cancelled: ["late_deposit"],
    late_deposit: ["refund_queued", "manual_review"],
    underpaid: ["refund_queued", "manual_review"],
    overpaid: ["deposit_accepted", "refund_queued", "manual_review"],
    chain_reorg_review: ["confirming", "awaiting_zec", "manual_review"],
    manual_review: ["deposit_accepted", "refund_queued", "rejected"],
    refund_queued: ["refunded", "manual_review"],
    refunded: [],
    rejected: [],
  },
  ["refunded", "rejected"],
);

/* ---------------------------------------------------------- Scan & Pay payout (PAY, orderType 2) */
export const PAYOUT_STATUSES = [
  "not_started",
  "payout_queued",
  "order_placing",
  "placed",
  "merchant_accepted",
  "usdc_escrowed",
  "inr_processing",
  "provider_completed",
  "payout_reconciled",
  "completed",
  "not_liquid",
  "provider_timeout",
  "cancelled",
  "provider_failed",
  "disputed",
  "manual_review",
  "refund_queued",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const payoutMachine = machine<PayoutStatus>(
  "ScanPayPayout",
  PAYOUT_STATUSES,
  {
    not_started: ["payout_queued"],
    payout_queued: ["order_placing", "not_liquid", "manual_review", "refund_queued"],
    // order_placing is ambiguous until the chain is checked: never jump back to queued blindly.
    order_placing: ["placed", "provider_failed", "manual_review"],
    placed: ["merchant_accepted", "cancelled", "provider_timeout", "manual_review"],
    merchant_accepted: ["usdc_escrowed", "cancelled", "provider_timeout", "manual_review"],
    usdc_escrowed: ["inr_processing", "provider_completed", "disputed", "cancelled", "manual_review"],
    inr_processing: ["provider_completed", "disputed", "cancelled", "manual_review"],
    provider_completed: ["payout_reconciled", "disputed", "manual_review"],
    payout_reconciled: ["completed"],
    completed: [],
    not_liquid: ["payout_queued", "refund_queued", "manual_review"],
    provider_timeout: ["payout_queued", "refund_queued", "manual_review"],
    cancelled: ["payout_queued", "refund_queued", "manual_review"],
    provider_failed: ["payout_queued", "refund_queued", "manual_review"],
    disputed: ["provider_completed", "cancelled", "manual_review"],
    manual_review: ["payout_queued", "provider_completed", "refund_queued", "cancelled"],
    refund_queued: [],
  },
  ["completed", "refund_queued"],
);

/* ---------------------------------------------------------- merchant credit */
export const CREDIT_STATUSES = ["credit_prepared", "credit_locked", "credit_available", "withdrawal_reserved", "extinguished", "frozen", "reversed", "split"] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const creditMachine = machine<CreditStatus>(
  "MerchantCredit",
  CREDIT_STATUSES,
  {
    credit_prepared: ["credit_locked", "frozen"],
    credit_locked: ["credit_available", "frozen"],
    credit_available: ["withdrawal_reserved", "frozen", "split"],
    withdrawal_reserved: ["extinguished", "credit_available", "frozen"],
    frozen: ["credit_locked", "credit_available", "reversed"],
    extinguished: [],
    reversed: [],
    // A partially withdrawn credit is closed and replaced by two children (reserved part + remainder).
    split: [],
  },
  ["extinguished", "reversed", "split"],
);

/* ---------------------------------------------------------- withdrawal (SELL, orderType 1) */
export const WITHDRAWAL_STATUSES = [
  "requested",
  "funds_reserved",
  "awaiting_provider",
  "order_placing",
  "placed",
  "merchant_accepted",
  "usdc_escrowed",
  "inr_processing",
  "provider_completed",
  "reconciled",
  "completed",
  "failed_recoverable",
  "cancel_requested",
  "cancelled",
  "disputed",
  "manual_review",
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const withdrawalMachine = machine<WithdrawalStatus>(
  "Withdrawal",
  WITHDRAWAL_STATUSES,
  {
    requested: ["funds_reserved", "cancelled", "manual_review"],
    funds_reserved: ["awaiting_provider", "cancel_requested", "manual_review"],
    awaiting_provider: ["order_placing", "cancel_requested", "failed_recoverable", "manual_review"],
    order_placing: ["placed", "failed_recoverable", "manual_review"],
    placed: ["merchant_accepted", "cancel_requested", "failed_recoverable", "manual_review"],
    merchant_accepted: ["usdc_escrowed", "cancel_requested", "failed_recoverable", "manual_review"],
    usdc_escrowed: ["inr_processing", "provider_completed", "disputed", "failed_recoverable", "manual_review"],
    inr_processing: ["provider_completed", "disputed", "failed_recoverable", "manual_review"],
    provider_completed: ["reconciled", "disputed", "manual_review"],
    reconciled: ["completed"],
    completed: [],
    // Only after the chain proves nothing is in flight may reserved credits be restored (→ cancelled).
    failed_recoverable: ["awaiting_provider", "cancelled", "manual_review"],
    cancel_requested: ["cancelled", "placed", "merchant_accepted", "manual_review"],
    cancelled: [],
    disputed: ["provider_completed", "failed_recoverable", "manual_review"],
    manual_review: ["awaiting_provider", "provider_completed", "failed_recoverable", "cancelled"],
  },
  ["completed", "cancelled"],
);

/* ---------------------------------------------------------- payment link (independent of checkouts) */
export const LINK_STATUSES = ["active", "revoked", "expired", "exhausted"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export function deriveLinkStatus(link: { revokedAt: Date | null; expiresAt: Date | null; useLimit: number | null; successfulUses: number }, now: Date): LinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && now >= link.expiresAt) return "expired";
  if (link.useLimit !== null && link.successfulUses >= link.useLimit) return "exhausted";
  return "active";
}

/* ---------------------------------------------------------- KYB */
export const MERCHANT_STATUSES = ["draft", "pending_review", "verified", "restricted", "suspended", "closed"] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];
export const merchantMachine = machine<MerchantStatus>(
  "Merchant",
  MERCHANT_STATUSES,
  {
    draft: ["pending_review", "closed"],
    pending_review: ["verified", "restricted", "draft", "closed"],
    verified: ["restricted", "suspended", "closed"],
    restricted: ["verified", "suspended", "closed"],
    suspended: ["verified", "restricted", "closed"],
    closed: [],
  },
  ["closed"],
);

/* ---------------------------------------------------------- P2P on-chain order status → our status */
export type P2POnchainStatus = "placed" | "accepted" | "paid" | "completed" | "cancelled";

/**
 * Map an authoritative on-chain order read (getOrder, Diamond) to our payout status.
 * "paid" on-chain means USDC pulled into escrow — NOT that the recipient's bank was credited.
 * "completed" on-chain means the LP marked it complete; we still require reconciliation.
 */
export function payoutStatusFromOnchain(s: P2POnchainStatus, dispute: "none" | "open" | "resolved"): PayoutStatus {
  if (dispute === "open") return "disputed";
  switch (s) {
    case "placed":
      return "placed";
    case "accepted":
      return "merchant_accepted";
    case "paid":
      return "usdc_escrowed";
    case "completed":
      return "provider_completed";
    case "cancelled":
      return "cancelled";
  }
}

/* ---------------------------------------------------------- P2P web-automation payout (TinyFish) */
export const TF_PAYOUT_STATES = [
  "CREATED",
  "POLICY_CHECKED",
  "LIQUIDITY_RESERVED",
  "READONLY_PREFLIGHT_RUNNING",
  "PREFLIGHT_VERIFIED",
  "OPERATOR_APPROVAL_REQUIRED",
  "QUEUED",
  "AGENT_RUNNING",
  "ORDER_SUBMISSION_OBSERVED",
  "PROVIDER_ACCEPTED",
  "FIAT_TRANSFER_REPORTED",
  "PROVIDER_COMPLETED_VERIFIED",
  "RECONCILED",
  "PREFLIGHT_BLOCKED",
  "EXPIRED",
  "USER_ABORTED",
  "AGENT_FAILED_BEFORE_COMMIT",
  "OUTCOME_UNKNOWN_REVIEW",
  "PROVIDER_CANCELLED",
  "PROVIDER_DISPUTED",
  "PAYOUT_FAILED_RECOVERY",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type TfPayoutState = (typeof TF_PAYOUT_STATES)[number];

/**
 * A TinyFish run finishing (`COMPLETED`) never advances past ORDER_SUBMISSION_OBSERVED by itself;
 * PROVIDER_COMPLETED_VERIFIED requires a separate read-only reconciliation of a stable order id.
 * Any ambiguity after a possible final click goes to OUTCOME_UNKNOWN_REVIEW, which can only be left
 * via read-only reconciliation (order found) or an operator-verified "never submitted" decision.
 */
export const tfPayoutMachine = machine<TfPayoutState>(
  "TinyFishPayout",
  TF_PAYOUT_STATES,
  {
    CREATED: ["POLICY_CHECKED", "PREFLIGHT_BLOCKED", "EXPIRED", "USER_ABORTED"],
    POLICY_CHECKED: ["LIQUIDITY_RESERVED", "PREFLIGHT_BLOCKED", "EXPIRED"],
    LIQUIDITY_RESERVED: ["READONLY_PREFLIGHT_RUNNING", "PREFLIGHT_VERIFIED", "PREFLIGHT_BLOCKED", "EXPIRED"],
    READONLY_PREFLIGHT_RUNNING: ["PREFLIGHT_VERIFIED", "PREFLIGHT_BLOCKED"],
    PREFLIGHT_VERIFIED: ["OPERATOR_APPROVAL_REQUIRED", "QUEUED", "PREFLIGHT_BLOCKED", "EXPIRED"],
    OPERATOR_APPROVAL_REQUIRED: ["QUEUED", "EXPIRED", "USER_ABORTED", "PREFLIGHT_BLOCKED"],
    QUEUED: ["AGENT_RUNNING", "AGENT_FAILED_BEFORE_COMMIT", "OUTCOME_UNKNOWN_REVIEW"],
    AGENT_RUNNING: ["ORDER_SUBMISSION_OBSERVED", "AGENT_FAILED_BEFORE_COMMIT", "OUTCOME_UNKNOWN_REVIEW"],
    ORDER_SUBMISSION_OBSERVED: ["PROVIDER_ACCEPTED", "FIAT_TRANSFER_REPORTED", "PROVIDER_COMPLETED_VERIFIED", "PROVIDER_CANCELLED", "PROVIDER_DISPUTED", "OUTCOME_UNKNOWN_REVIEW"],
    PROVIDER_ACCEPTED: ["FIAT_TRANSFER_REPORTED", "PROVIDER_COMPLETED_VERIFIED", "PROVIDER_CANCELLED", "PROVIDER_DISPUTED", "OUTCOME_UNKNOWN_REVIEW"],
    FIAT_TRANSFER_REPORTED: ["PROVIDER_COMPLETED_VERIFIED", "PROVIDER_CANCELLED", "PROVIDER_DISPUTED", "OUTCOME_UNKNOWN_REVIEW"],
    PROVIDER_COMPLETED_VERIFIED: ["RECONCILED", "OUTCOME_UNKNOWN_REVIEW"],
    RECONCILED: [],
    PREFLIGHT_BLOCKED: ["LIQUIDITY_RESERVED", "PAYOUT_FAILED_RECOVERY", "EXPIRED"],
    EXPIRED: ["PAYOUT_FAILED_RECOVERY"],
    USER_ABORTED: ["PAYOUT_FAILED_RECOVERY"],
    AGENT_FAILED_BEFORE_COMMIT: ["PREFLIGHT_VERIFIED", "PAYOUT_FAILED_RECOVERY"],
    OUTCOME_UNKNOWN_REVIEW: ["ORDER_SUBMISSION_OBSERVED", "PROVIDER_ACCEPTED", "FIAT_TRANSFER_REPORTED", "PROVIDER_COMPLETED_VERIFIED", "PROVIDER_CANCELLED", "PROVIDER_DISPUTED", "AGENT_FAILED_BEFORE_COMMIT"],
    PROVIDER_CANCELLED: ["PAYOUT_FAILED_RECOVERY"],
    PROVIDER_DISPUTED: ["PROVIDER_COMPLETED_VERIFIED", "PROVIDER_CANCELLED", "OUTCOME_UNKNOWN_REVIEW"],
    PAYOUT_FAILED_RECOVERY: ["REFUND_PENDING", "PREFLIGHT_VERIFIED"],
    REFUND_PENDING: ["REFUNDED"],
    REFUNDED: [],
  },
  ["RECONCILED", "REFUNDED"],
);
