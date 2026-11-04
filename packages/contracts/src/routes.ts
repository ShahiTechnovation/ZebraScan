/**
 * The normative route table (spec §5). The API registers exactly these routes (validation via the
 * same Zod schemas), the OpenAPI document is generated from it, and the web client's method types
 * are inferred from it. A route missing a handler fails API boot.
 */
import { z } from "zod";
import * as S from "./schemas";

export type Auth =
  | "public" // anyone (rate limited)
  | "scoped" // checkout/withdrawal access token OR owning merchant session
  | "user" // authenticated user (any realm=merchant), merchant optional
  | "merchant" // authenticated user with a merchant membership
  | "operator" // operator realm + MFA
  | "internal"; // mTLS / HMAC-signed service-to-service

export interface RouteDef {
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  auth: Auth;
  /** Requires Idempotency-Key header (all public state-changing commands). */
  idempotent: boolean;
  /** Requires recent step-up re-authentication. */
  stepUp?: boolean;
  /** Merchant permission required (merchant auth). */
  permission?: string;
  /** Requires dual control approval id for operator actions. */
  dualControl?: boolean;
  /** Only registered in the demo environment. */
  demoOnly?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status?: number;
  summary: string;
  tags: string[];
}

const idP = z.object({ id: S.Id });
const slugP = z.object({ slug: z.string().min(3).max(64) });
const handleP = z.object({ handle: z.string().min(3).max(64) });

const r = <T extends RouteDef>(d: T) => d;

export const ROUTES = {
  /* public */
  getPublicConfig: r({ operationId: "getPublicConfig", method: "GET", path: "/api/v1/public/config", auth: "public", idempotent: false, response: S.PublicConfigZ, summary: "Environment, products, limits, disclaimers", tags: ["public"] }),
  getPublicHealth: r({ operationId: "getPublicHealth", method: "GET", path: "/api/v1/public/health", auth: "public", idempotent: false, response: S.PublicHealthZ, summary: "Per-product availability", tags: ["public"] }),
  getZecUsdRate: r({ operationId: "getZecUsdRate", method: "GET", path: "/api/v1/rates/zec-usd", auth: "public", idempotent: false, response: S.ZecUsdRateZ, summary: "Reference ZEC/USD rate (not executable)", tags: ["rates"] }),
  getInrUsdcRate: r({ operationId: "getInrUsdcRate", method: "GET", path: "/api/v1/rates/inr-usdc", auth: "public", idempotent: false, response: S.InrUsdcRateZ, summary: "P2P INR/USDC configured price", tags: ["rates"] }),
  parseUpi: r({ operationId: "parseUpi", method: "POST", path: "/api/v1/upi/parse", auth: "public", idempotent: false, body: S.UpiParseInZ, response: S.UpiParseOutZ, summary: "Validate a scanned upi://pay payload", tags: ["scan-pay"] }),
  createQuote: r({ operationId: "createQuote", method: "POST", path: "/api/v1/quotes", auth: "public", idempotent: true, body: S.CreateQuoteInZ, response: S.QuoteZ, status: 201, summary: "Create an immutable signed quote", tags: ["quotes"] }),
  getQuote: r({ operationId: "getQuote", method: "GET", path: "/api/v1/quotes/:id", auth: "public", idempotent: false, params: idP, response: S.QuoteZ, summary: "Quote terms (never regenerated under the same id)", tags: ["quotes"] }),

  /* scan & pay */
  createScanPayIntent: r({ operationId: "createScanPayIntent", method: "POST", path: "/api/v1/scan-pay/intents", auth: "public", idempotent: true, body: S.ScanPayIntentInZ, response: S.CheckoutCreatedZ, status: 201, summary: "Create a Scan & Pay intent", tags: ["scan-pay"] }),
  getScanPayIntent: r({ operationId: "getScanPayIntent", method: "GET", path: "/api/v1/scan-pay/intents/:id", auth: "scoped", idempotent: false, params: idP, response: S.CheckoutPublicZ, summary: "Scan & Pay status", tags: ["scan-pay"] }),
  cancelScanPayIntent: r({ operationId: "cancelScanPayIntent", method: "POST", path: "/api/v1/scan-pay/intents/:id/cancel", auth: "scoped", idempotent: true, params: idP, response: S.CheckoutPublicZ, summary: "Cancel while safe", tags: ["scan-pay"] }),

  /* auth */
  register: r({ operationId: "register", method: "POST", path: "/api/v1/auth/register", auth: "public", idempotent: false, body: S.RegisterInZ, response: S.AuthResultZ, status: 201, summary: "Register (email + password)", tags: ["auth"] }),
  login: r({ operationId: "login", method: "POST", path: "/api/v1/auth/login", auth: "public", idempotent: false, body: S.LoginInZ, response: S.AuthResultZ, summary: "Sign in", tags: ["auth"] }),
  logout: r({ operationId: "logout", method: "POST", path: "/api/v1/auth/logout", auth: "user", idempotent: false, response: S.OkZ, summary: "Sign out", tags: ["auth"] }),
  verifyEmail: r({ operationId: "verifyEmail", method: "POST", path: "/api/v1/auth/verify-email", auth: "public", idempotent: false, body: S.TokenInZ, response: S.OkZ, summary: "Verify email token", tags: ["auth"] }),
  resendVerification: r({ operationId: "resendVerification", method: "POST", path: "/api/v1/auth/verify-email/resend", auth: "user", idempotent: false, response: S.OkZ, summary: "Resend verification email", tags: ["auth"] }),
  forgotPassword: r({ operationId: "forgotPassword", method: "POST", path: "/api/v1/auth/forgot-password", auth: "public", idempotent: false, body: S.ForgotInZ, response: S.OkZ, summary: "Request reset (never reveals account existence)", tags: ["auth"] }),
  resetPassword: r({ operationId: "resetPassword", method: "POST", path: "/api/v1/auth/reset-password", auth: "public", idempotent: false, body: S.ResetInZ, response: S.OkZ, summary: "Reset password; revokes all sessions", tags: ["auth"] }),
  listSessions: r({ operationId: "listSessions", method: "GET", path: "/api/v1/auth/sessions", auth: "user", idempotent: false, response: z.object({ items: z.array(S.SessionInfoZ) }), summary: "Active sessions", tags: ["auth"] }),
  revokeSession: r({ operationId: "revokeSession", method: "DELETE", path: "/api/v1/auth/sessions/:id", auth: "user", idempotent: false, params: idP, response: S.OkZ, summary: "Revoke a session", tags: ["auth"] }),
  stepUp: r({ operationId: "stepUp", method: "POST", path: "/api/v1/auth/step-up", auth: "user", idempotent: false, body: S.StepUpInZ, response: z.object({ validUntil: S.Iso }), summary: "Re-authenticate for sensitive actions", tags: ["auth"] }),

  /* wallet + passwordless auth (delta spec §8) */
  walletChallenge: r({ operationId: "walletChallenge", method: "POST", path: "/api/v1/auth/challenge", auth: "public", idempotent: false, body: S.WalletChallengeInZ, response: S.WalletChallengeZ, status: 201, summary: "Single-use, origin-bound wallet sign-in challenge (ASCII)", tags: ["auth"] }),
  walletVerify: r({ operationId: "walletVerify", method: "POST", path: "/api/v1/auth/wallet/verify", auth: "public", idempotent: false, body: S.WalletVerifyInZ, response: S.AuthResultZ, summary: "Verify a Noir signMessage signature and start a session", tags: ["auth"] }),
  emailOtpRequest: r({ operationId: "emailOtpRequest", method: "POST", path: "/api/v1/auth/email/otp", auth: "public", idempotent: false, body: S.ForgotInZ, response: S.OkZ, summary: "Send a one-time sign-in code (never reveals account existence)", tags: ["auth"] }),
  emailOtpVerify: r({ operationId: "emailOtpVerify", method: "POST", path: "/api/v1/auth/email/otp/verify", auth: "public", idempotent: false, body: S.OtpVerifyInZ, response: S.AuthResultZ, summary: "Verify the emailed code and start a session", tags: ["auth"] }),
  getAuthSession: r({ operationId: "getAuthSession", method: "GET", path: "/api/v1/auth/session", auth: "public", idempotent: false, response: S.MerchantSessionZ, summary: "Current session (alias of /merchants/session)", tags: ["auth"] }),
  getPublicConfigV2: r({ operationId: "getPublicConfigV2", method: "GET", path: "/api/v1/config/public", auth: "public", idempotent: false, response: S.PublicConfigZ, summary: "Alias of /public/config", tags: ["public"] }),
  scanParse: r({ operationId: "scanParse", method: "POST", path: "/api/v1/scan/parse", auth: "public", idempotent: false, body: S.UpiParseInZ, response: S.UpiParseOutZ, summary: "Alias of /upi/parse", tags: ["scan-pay"] }),
  getP2PReadiness: r({ operationId: "getP2PReadiness", method: "GET", path: "/api/v1/providers/p2p/readiness", auth: "public", idempotent: false, response: S.P2PReadinessZ, summary: "Sanitized payout-rail readiness (eligible_for_payout strictly false until verified)", tags: ["payouts"] }),

  /* merchants */
  getMerchantSession: r({ operationId: "getMerchantSession", method: "GET", path: "/api/v1/merchants/session", auth: "public", idempotent: false, response: S.MerchantSessionZ, summary: "Current principal, merchant, gates", tags: ["merchants"] }),
  createMerchant: r({ operationId: "createMerchant", method: "POST", path: "/api/v1/merchants", auth: "user", idempotent: true, body: S.CreateMerchantInZ, response: S.MerchantZ, status: 201, summary: "Register a business (KYB starts in draft)", tags: ["merchants"] }),
  getMyMerchant: r({ operationId: "getMyMerchant", method: "GET", path: "/api/v1/merchants/me", auth: "merchant", permission: "merchant.read", idempotent: false, response: S.MerchantZ, summary: "My merchant profile", tags: ["merchants"] }),
  updateMyMerchant: r({ operationId: "updateMyMerchant", method: "PATCH", path: "/api/v1/merchants/me", auth: "merchant", permission: "merchant.update", idempotent: true, body: S.UpdateMerchantInZ, response: S.MerchantZ, summary: "Update profile (optimistic version)", tags: ["merchants"] }),
  submitKyb: r({ operationId: "submitKyb", method: "POST", path: "/api/v1/merchants/me/kyb/submit", auth: "merchant", permission: "merchant.update", idempotent: true, response: S.MerchantZ, summary: "Submit for KYB review (draft → pending_review)", tags: ["merchants"] }),
  listPayoutDestinations: r({ operationId: "listPayoutDestinations", method: "GET", path: "/api/v1/merchants/me/payout-destinations", auth: "merchant", permission: "payout_destination.manage", idempotent: false, response: z.object({ items: z.array(S.PayoutDestinationZ) }), summary: "Payout destinations (masked)", tags: ["merchants"] }),
  createPayoutDestination: r({ operationId: "createPayoutDestination", method: "POST", path: "/api/v1/merchants/me/payout-destinations", auth: "merchant", permission: "payout_destination.manage", stepUp: true, idempotent: true, body: S.CreatePayoutDestinationInZ, response: S.PayoutDestinationZ, status: 201, summary: "Add encrypted payout VPA (review + cooling-off)", tags: ["merchants"] }),
  updatePayoutDestination: r({ operationId: "updatePayoutDestination", method: "PATCH", path: "/api/v1/merchants/me/payout-destinations/:id", auth: "merchant", permission: "payout_destination.manage", stepUp: true, idempotent: true, params: idP, body: S.UpdatePayoutDestinationInZ, response: S.PayoutDestinationZ, summary: "Update beneficiary name (re-review)", tags: ["merchants"] }),
  deletePayoutDestination: r({ operationId: "deletePayoutDestination", method: "DELETE", path: "/api/v1/merchants/me/payout-destinations/:id", auth: "merchant", permission: "payout_destination.manage", stepUp: true, idempotent: true, params: idP, response: S.OkZ, summary: "Remove payout destination", tags: ["merchants"] }),
  getPreferences: r({ operationId: "getPreferences", method: "GET", path: "/api/v1/merchants/me/preferences", auth: "merchant", permission: "merchant.read", idempotent: false, response: S.PreferencesZ, summary: "Preferences", tags: ["merchants"] }),
  updatePreferences: r({ operationId: "updatePreferences", method: "PATCH", path: "/api/v1/merchants/me/preferences", auth: "merchant", permission: "merchant.update", idempotent: true, body: S.UpdatePreferencesInZ, response: S.PreferencesZ, summary: "Update preferences", tags: ["merchants"] }),
  getMetrics: r({ operationId: "getMetrics", method: "GET", path: "/api/v1/merchants/me/metrics", auth: "merchant", permission: "balance.read", idempotent: false, response: S.MetricsZ, summary: "Ledger-backed metrics", tags: ["merchants"] }),

  /* terminal / counter */
  createTerminalIntent: r({ operationId: "createTerminalIntent", method: "POST", path: "/api/v1/merchant-terminal/intents", auth: "merchant", permission: "terminal.create", idempotent: true, body: S.TerminalIntentInZ, response: S.CheckoutCreatedZ, status: 201, summary: "Fixed-INR terminal invoice", tags: ["terminal"] }),
  getTerminalIntent: r({ operationId: "getTerminalIntent", method: "GET", path: "/api/v1/merchant-terminal/intents/:id", auth: "scoped", idempotent: false, params: idP, response: S.CheckoutPublicZ, summary: "Terminal invoice status", tags: ["terminal"] }),
  getCounterQr: r({ operationId: "getCounterQr", method: "GET", path: "/api/v1/merchants/me/counter-qr", auth: "merchant", permission: "merchant.read", idempotent: false, response: S.CounterQrZ, summary: "Counter landing link (never a static ZEC address)", tags: ["terminal"] }),
  regenerateCounterQr: r({ operationId: "regenerateCounterQr", method: "POST", path: "/api/v1/merchants/me/counter-qr", auth: "merchant", permission: "merchant.update", idempotent: true, response: S.CounterQrZ, summary: "Regenerate counter slug (old slug retired)", tags: ["terminal"] }),
  getPublicMerchant: r({ operationId: "getPublicMerchant", method: "GET", path: "/api/v1/m/:handle", auth: "public", idempotent: false, params: handleP, response: S.PublicMerchantZ, summary: "Public merchant metadata", tags: ["terminal"] }),
  createCounterCheckout: r({ operationId: "createCounterCheckout", method: "POST", path: "/api/v1/m/:handle/checkouts", auth: "public", idempotent: true, params: handleP, body: S.CounterCheckoutInZ, response: S.CheckoutCreatedZ, status: 201, summary: "Payer-initiated counter checkout", tags: ["terminal"] }),

  /* links */
  createLink: r({ operationId: "createLink", method: "POST", path: "/api/v1/links", auth: "merchant", permission: "links.write", idempotent: true, body: S.CreateLinkInZ, response: S.LinkZ, status: 201, summary: "Create payment link", tags: ["links"] }),
  listLinks: r({ operationId: "listLinks", method: "GET", path: "/api/v1/links", auth: "merchant", permission: "links.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(S.LinkZ), summary: "List links", tags: ["links"] }),
  getLink: r({ operationId: "getLink", method: "GET", path: "/api/v1/links/:id", auth: "merchant", permission: "links.read", idempotent: false, params: idP, response: S.LinkZ, summary: "Link detail", tags: ["links"] }),
  updateLink: r({ operationId: "updateLink", method: "PATCH", path: "/api/v1/links/:id", auth: "merchant", permission: "links.write", idempotent: true, params: idP, body: S.UpdateLinkInZ, response: S.LinkZ, summary: "Metadata-only edit", tags: ["links"] }),
  revokeLink: r({ operationId: "revokeLink", method: "POST", path: "/api/v1/links/:id/revoke", auth: "merchant", permission: "links.write", idempotent: true, params: idP, response: S.LinkZ, summary: "Revoke (in-flight checkouts preserved)", tags: ["links"] }),
  duplicateLink: r({ operationId: "duplicateLink", method: "POST", path: "/api/v1/links/:id/duplicate", auth: "merchant", permission: "links.write", idempotent: true, params: idP, response: S.LinkZ, status: 201, summary: "Duplicate into a new link", tags: ["links"] }),
  getPublicLink: r({ operationId: "getPublicLink", method: "GET", path: "/api/v1/pay/:slug", auth: "public", idempotent: false, params: slugP, response: S.PublicLinkZ, summary: "Public link data (opening does not consume quota)", tags: ["links"] }),
  createLinkCheckout: r({ operationId: "createLinkCheckout", method: "POST", path: "/api/v1/pay/:slug/checkouts", auth: "public", idempotent: true, params: slugP, body: S.LinkCheckoutInZ, response: S.CheckoutCreatedZ, status: 201, summary: "Create a link checkout", tags: ["links"] }),

  /* checkout */
  getCheckout: r({ operationId: "getCheckout", method: "GET", path: "/api/v1/checkout/:id", auth: "scoped", idempotent: false, params: idP, response: S.CheckoutPublicZ, summary: "Shared checkout payload", tags: ["checkout"] }),
  refreshCheckout: r({ operationId: "refreshCheckout", method: "POST", path: "/api/v1/checkout/:id/refresh", auth: "scoped", idempotent: true, params: idP, response: S.CheckoutCreatedZ, status: 201, summary: "New quote + new address for an unfunded checkout", tags: ["checkout"] }),
  submitRefundDetails: r({ operationId: "submitRefundDetails", method: "POST", path: "/api/v1/checkout/:id/refund-details", auth: "scoped", idempotent: true, params: idP, body: S.RefundDetailsInZ, response: S.CheckoutPublicZ, summary: "Provide a Zcash refund address (reviewed)", tags: ["checkout"] }),

  /* merchant data */
  listTransactions: r({ operationId: "listTransactions", method: "GET", path: "/api/v1/transactions", auth: "merchant", permission: "balance.read", idempotent: false, query: S.PageQueryZ.extend({ mode: S.PaymentModeZ.optional(), status: z.string().max(40).optional() }), response: S.pageOf(S.TransactionZ), summary: "Transactions", tags: ["ledger"] }),
  getTransaction: r({ operationId: "getTransaction", method: "GET", path: "/api/v1/transactions/:id", auth: "merchant", permission: "balance.read", idempotent: false, params: idP, response: S.TransactionDetailZ, summary: "Transaction detail", tags: ["ledger"] }),
  getBalance: r({ operationId: "getBalance", method: "GET", path: "/api/v1/balance", auth: "merchant", permission: "balance.read", idempotent: false, response: S.BalanceZ, summary: "INR-denominated platform balance", tags: ["ledger"] }),
  listBalanceEntries: r({ operationId: "listBalanceEntries", method: "GET", path: "/api/v1/balance/entries", auth: "merchant", permission: "balance.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(S.BalanceEntryZ), summary: "Immutable journal entries", tags: ["ledger"] }),
  listSettlements: r({ operationId: "listSettlements", method: "GET", path: "/api/v1/settlements", auth: "merchant", permission: "balance.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(S.SettlementZ), summary: "Credit unlock schedule", tags: ["ledger"] }),

  /* withdrawals */
  quoteWithdrawal: r({ operationId: "quoteWithdrawal", method: "POST", path: "/api/v1/withdrawals/quote", auth: "merchant", permission: "withdrawal.request", idempotent: false, body: S.WithdrawalQuoteInZ, response: S.WithdrawalQuoteZ, summary: "Conservative withdrawal estimate", tags: ["withdrawals"] }),
  createWithdrawal: r({ operationId: "createWithdrawal", method: "POST", path: "/api/v1/withdrawals", auth: "merchant", permission: "withdrawal.request", stepUp: true, idempotent: true, body: S.CreateWithdrawalInZ, response: S.WithdrawalZ, status: 201, summary: "Reserve credits and queue SELL payout", tags: ["withdrawals"] }),
  listWithdrawals: r({ operationId: "listWithdrawals", method: "GET", path: "/api/v1/withdrawals", auth: "merchant", permission: "balance.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(S.WithdrawalZ), summary: "Withdrawals", tags: ["withdrawals"] }),
  getWithdrawal: r({ operationId: "getWithdrawal", method: "GET", path: "/api/v1/withdrawals/:id", auth: "merchant", permission: "balance.read", idempotent: false, params: idP, response: S.WithdrawalZ, summary: "Withdrawal status", tags: ["withdrawals"] }),
  cancelWithdrawal: r({ operationId: "cancelWithdrawal", method: "POST", path: "/api/v1/withdrawals/:id/cancel", auth: "merchant", permission: "withdrawal.cancel", idempotent: true, params: idP, response: S.WithdrawalZ, summary: "Cancel only before provider commitment", tags: ["withdrawals"] }),

  /* receipts / support */
  getReceipt: r({ operationId: "getReceipt", method: "GET", path: "/api/v1/receipts/:id", auth: "scoped", idempotent: false, params: idP, response: S.ReceiptZ, summary: "Redacted receipt", tags: ["receipts"] }),
  downloadReceipt: r({ operationId: "downloadReceipt", method: "GET", path: "/api/v1/receipts/:id/download", auth: "scoped", idempotent: false, params: idP, response: z.object({ receipt: S.ReceiptZ, signedAt: S.Iso, algorithm: z.literal("HMAC-SHA256"), signature: z.string() }), summary: "Signed JSON receipt", tags: ["receipts"] }),
  createSupportCase: r({ operationId: "createSupportCase", method: "POST", path: "/api/v1/support/cases", auth: "scoped", idempotent: true, body: S.SupportCaseInZ, response: S.SupportCaseZ, status: 201, summary: "Open a case", tags: ["support"] }),
  listSupportCases: r({ operationId: "listSupportCases", method: "GET", path: "/api/v1/support/cases", auth: "merchant", permission: "support.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(S.SupportCaseZ), summary: "My cases", tags: ["support"] }),

  /* ops */
  opsLogin: r({ operationId: "opsLogin", method: "POST", path: "/api/v1/ops/login", auth: "public", idempotent: false, body: S.LoginInZ.extend({ totp: z.string().regex(/^\d{6}$/) }), response: S.AuthResultZ, summary: "Operator realm sign-in (password + TOTP; passkeys required before mainnet)", tags: ["ops"] }),
  opsHealth: r({ operationId: "opsHealth", method: "GET", path: "/api/v1/ops/health", auth: "operator", permission: "ops.read", idempotent: false, response: z.record(z.string(), z.unknown()), summary: "Internal health", tags: ["ops"] }),
  opsTreasury: r({ operationId: "opsTreasury", method: "GET", path: "/api/v1/ops/treasury", auth: "operator", permission: "ops.read", idempotent: false, response: S.TreasurySnapshotZ, summary: "Treasury snapshot", tags: ["ops"] }),
  opsReconciliation: r({ operationId: "opsReconciliation", method: "GET", path: "/api/v1/ops/reconciliation", auth: "operator", permission: "ops.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(z.record(z.string(), z.unknown())), summary: "Reconciliation runs", tags: ["ops"] }),
  opsJobs: r({ operationId: "opsJobs", method: "GET", path: "/api/v1/ops/jobs", auth: "operator", permission: "ops.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(z.record(z.string(), z.unknown())), summary: "Jobs", tags: ["ops"] }),
  opsExceptions: r({ operationId: "opsExceptions", method: "GET", path: "/api/v1/ops/exceptions", auth: "operator", permission: "ops.read", idempotent: false, query: S.PageQueryZ, response: S.pageOf(z.record(z.string(), z.unknown())), summary: "Open exceptions", tags: ["ops"] }),
  opsAudit: r({ operationId: "opsAudit", method: "GET", path: "/api/v1/ops/audit", auth: "operator", permission: "ops.audit", idempotent: false, query: S.PageQueryZ, response: S.pageOf(z.record(z.string(), z.unknown())), summary: "Audit log", tags: ["ops"] }),
  opsPause: r({ operationId: "opsPause", method: "POST", path: "/api/v1/ops/pause", auth: "operator", permission: "ops.pause", idempotent: true, body: S.OpsActionInZ, response: S.OkZ, summary: "Pause a feature (single operator; safe direction)", tags: ["ops"] }),
  opsResume: r({ operationId: "opsResume", method: "POST", path: "/api/v1/ops/resume", auth: "operator", permission: "ops.pause", dualControl: true, idempotent: true, body: S.OpsActionInZ.extend({ approvalId: S.Id.optional() }), response: z.object({ status: z.enum(["pending_approval", "executed"]), approvalId: z.string() }), summary: "Resume a feature (dual control)", tags: ["ops"] }),
  opsRetryJob: r({ operationId: "opsRetryJob", method: "POST", path: "/api/v1/ops/job/:id/retry", auth: "operator", permission: "ops.retry", idempotent: true, params: idP, body: S.OpsActionInZ, response: S.OkZ, summary: "Retry a dead job", tags: ["ops"] }),
  opsDecideException: r({ operationId: "opsDecideException", method: "POST", path: "/api/v1/ops/exception/:id/decide", auth: "operator", permission: "ops.decide", dualControl: true, idempotent: true, params: idP, body: S.OpsDecisionInZ, response: z.object({ status: z.enum(["pending_approval", "executed"]), approvalId: z.string() }), summary: "Decide an exception (dual control)", tags: ["ops"] }),
  opsApprove: r({ operationId: "opsApprove", method: "POST", path: "/api/v1/ops/approvals/:id/approve", auth: "operator", permission: "ops.decide", idempotent: true, params: idP, response: S.OkZ, summary: "Second operator approves a pending action", tags: ["ops"] }),

  /* admin: P2P web-automation payouts (operator realm) */
  adminP2PPreflight: r({ operationId: "adminP2PPreflight", method: "POST", path: "/api/v1/admin/p2p/preflight", auth: "operator", permission: "ops.read", idempotent: true, response: z.object({ queued: z.literal(true) }), status: 202, summary: "Queue a READ-ONLY TinyFish capability probe", tags: ["payouts"] }),
  adminP2PCapabilities: r({ operationId: "adminP2PCapabilities", method: "GET", path: "/api/v1/admin/p2p/capabilities", auth: "operator", permission: "ops.read", idempotent: false, response: z.object({ items: z.array(S.CapabilityReportZ), readiness: S.P2PReadinessZ }), summary: "Capability reports (redacted)", tags: ["payouts"] }),
  adminListPayouts: r({ operationId: "adminListPayouts", method: "GET", path: "/api/v1/admin/payouts", auth: "operator", permission: "ops.read", idempotent: false, response: z.object({ items: z.array(S.AdminPayoutZ) }), summary: "Payout commands", tags: ["payouts"] }),
  adminGetPayout: r({ operationId: "adminGetPayout", method: "GET", path: "/api/v1/admin/payouts/:id", auth: "operator", permission: "ops.read", idempotent: false, params: idP, response: S.AdminPayoutDetailZ, summary: "Payout command, attempts and provider order", tags: ["payouts"] }),
  adminApprovePayout: r({ operationId: "adminApprovePayout", method: "POST", path: "/api/v1/admin/payouts/:id/approve", auth: "operator", permission: "ops.approve_treasury", stepUp: true, idempotent: true, params: idP, body: z.object({ commandHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), response: S.OkZ, summary: "Approve the exact reviewed payout terms (TTL-bound)", tags: ["payouts"] }),
  adminReconcilePayout: r({ operationId: "adminReconcilePayout", method: "POST", path: "/api/v1/admin/payouts/:id/reconcile", auth: "operator", permission: "ops.decide", idempotent: true, params: idP, response: S.OkZ, summary: "Read-only provider reconciliation (never starts a payment)", tags: ["payouts"] }),
  adminHoldPayout: r({ operationId: "adminHoldPayout", method: "POST", path: "/api/v1/admin/payouts/:id/hold", auth: "operator", permission: "ops.pause", idempotent: true, params: idP, body: S.OpsActionInZ, response: S.OkZ, summary: "Emergency hold", tags: ["payouts"] }),
  adminPayoutNotSubmitted: r({ operationId: "adminPayoutNotSubmitted", method: "POST", path: "/api/v1/admin/payouts/:id/verified-not-submitted", auth: "operator", permission: "ops.decide", dualControl: true, idempotent: true, params: idP, body: S.OpsActionInZ.extend({ approvalId: S.Id.optional() }), response: z.object({ status: z.enum(["pending_approval", "executed"]), approvalId: z.string() }), summary: "Dual control: mark an unknown outcome as verified never-submitted", tags: ["payouts"] }),

  /* internal */
  internalZcashEvents: r({ operationId: "internalZcashEvents", method: "POST", path: "/api/v1/internal/zcash/events", auth: "internal", idempotent: false, body: S.ZcashEventInZ, response: z.object({ accepted: z.boolean(), duplicate: z.boolean() }), summary: "Scanner deposit events", tags: ["internal"] }),
  internalP2PEvents: r({ operationId: "internalP2PEvents", method: "POST", path: "/api/v1/internal/p2p/events", auth: "internal", idempotent: false, body: S.P2PEventInZ, response: z.object({ accepted: z.boolean(), duplicate: z.boolean() }), summary: "P2P order events (re-verified on chain)", tags: ["internal"] }),
  internalWebhook: r({ operationId: "internalWebhook", method: "POST", path: "/api/v1/internal/webhooks/:provider", auth: "internal", idempotent: false, params: z.object({ provider: z.string().regex(/^[a-z0-9-]{2,32}$/) }), body: z.record(z.string(), z.unknown()), response: z.object({ accepted: z.boolean() }), summary: "Verified provider webhooks", tags: ["internal"] }),

  /* demo only */
  demoSimulateDeposit: r({ operationId: "demoSimulateDeposit", method: "POST", path: "/api/v1/demo/checkout/:id/simulate-deposit", auth: "scoped", idempotent: true, demoOnly: true, params: idP, body: S.DemoDepositInZ, response: S.CheckoutPublicZ, summary: "DEMO ONLY: simulate a non-payable deposit", tags: ["demo"] }),
  demoAdvanceConfirmations: r({ operationId: "demoAdvanceConfirmations", method: "POST", path: "/api/v1/demo/checkout/:id/advance", auth: "scoped", idempotent: true, demoOnly: true, params: idP, response: S.CheckoutPublicZ, summary: "DEMO ONLY: add a simulated confirmation", tags: ["demo"] }),
} as const satisfies Record<string, RouteDef>;

export type OperationId = keyof typeof ROUTES;
type R = typeof ROUTES;
export type BodyOf<K extends OperationId> = R[K] extends { body: infer B extends z.ZodType } ? z.input<B> : undefined;
export type ParamsOf<K extends OperationId> = R[K] extends { params: infer P extends z.ZodType } ? z.input<P> : undefined;
export type QueryOf<K extends OperationId> = R[K] extends { query: infer Q extends z.ZodType } ? z.input<Q> : undefined;
export type ResponseOf<K extends OperationId> = z.output<R[K]["response"]>;
