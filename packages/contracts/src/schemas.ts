/**
 * Wire DTOs (Zod, strict). Money is ALWAYS a base-10 integer string in minor units.
 * Timestamps are ISO-8601 UTC strings.
 */
import { z } from "zod";

export const MinorStr = z.string().regex(/^(0|[1-9]\d{0,29})$/, "integer minor units as a string");
export const PositiveMinorStr = z.string().regex(/^[1-9]\d{0,29}$/, "positive integer minor units as a string");
export const Iso = z.string().datetime({ offset: true });
export const Id = z.string().regex(/^[a-z]{2,5}_[0-9a-z]{16,40}$/);
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/);

export const EnvironmentZ = z.enum(["demo", "testnet", "mainnet-readonly", "mainnet-enabled"]);
export const PaymentModeZ = z.enum(["scan_pay", "terminal", "counter_qr", "payment_link"]);
export const PrivacyModeZ = z.enum(["shielded", "transparent"]);

export const MoneyZ = z.discriminatedUnion("asset", [
  z.object({ asset: z.literal("INR"), minor: MinorStr, decimals: z.literal(2) }),
  z.object({ asset: z.literal("ZEC"), minor: MinorStr, decimals: z.literal(8) }),
  z.object({ asset: z.literal("USDC_BASE"), minor: MinorStr, decimals: z.literal(6) }),
]);

export const ErrorZ = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  currentStatus: z.string().optional(),
});
export type ApiError = z.infer<typeof ErrorZ>;

export const OkZ = z.object({ ok: z.literal(true) });

export const PageQueryZ = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const pageOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/* ------------------------------------------------------------------ public config / health / rates */
export const PublicConfigZ = z.object({
  environment: EnvironmentZ,
  label: z.enum(["DEMO", "TEST"]).nullable(),
  apiVersion: z.literal("v1"),
  minClientVersion: z.string(),
  zcashNetwork: z.enum(["mainnet", "testnet", "regtest"]).nullable(),
  privacyModes: z.array(PrivacyModeZ),
  products: z.object({ scanPay: z.boolean(), terminal: z.boolean(), counterQr: z.boolean(), paymentLinks: z.boolean(), withdrawals: z.boolean() }),
  limits: z.object({ minInrPaise: MinorStr, maxInrPaise: MinorStr }),
  quoteLifetimeSeconds: z.number().int(),
  requiredConfirmations: z.number().int(),
  fees: z.object({ platformFeeBps: z.number().int(), withdrawalFeeBps: z.number().int() }),
  disclaimers: z.array(z.string()),
  auth: z.object({ emailPassword: z.boolean(), emailOtp: z.boolean(), passkey: z.boolean(), noirWallet: z.boolean(), google: z.boolean(), emailDelivery: z.boolean() }),
  wallet: z.object({ noirNetwork: z.enum(["zcash-testnet", "zcash-mainnet"]), payWithNoir: z.boolean() }),
  payoutRail: z.enum(["P2P_TINYFISH_WEB", "DEMO_SIMULATED"]),
  modeName: z.enum(["DEMO", "HACKATHON_TESTNET", "MAINNET_READONLY", "CONTROLLED_LIVE_PILOT"]),
  capabilities: z.object({ realChainAddresses: z.boolean(), creditsRedeemable: z.boolean(), canSubmitTransactions: z.boolean() }),
  /**
   * HACKATHON_TESTNET + TESTNET_LIVE_PAYOUT_DEMO: a confirmed testnet Scan & Pay payment only authorizes an
   * operator-approved INR payout paid from Zeb Scan's own pre-funded P2P.lol USDC. False everywhere else.
   * Defaults to false so an older API (field absent) is read as "no live payouts".
   */
  liveDemoPayouts: z.boolean().default(false),
});

export const FeatureStatusZ = z.object({ available: z.boolean(), reason: z.string().nullable() });
export const PublicHealthZ = z.object({
  environment: EnvironmentZ,
  maintenance: z.boolean(),
  products: z.object({ scanPay: FeatureStatusZ, terminal: FeatureStatusZ, paymentLinks: FeatureStatusZ, withdrawals: FeatureStatusZ }),
  checkedAt: Iso,
});

export const ZecUsdRateZ = z.object({
  pair: z.literal("ZEC/USD"),
  rate: z.string(),
  sources: z.array(z.object({ source: z.string(), rate: z.string(), bid: z.string().optional(), ask: z.string().optional(), observedAt: Iso })),
  observedAt: Iso,
  stale: z.boolean(),
  confidence: z.enum(["multi_source", "single_source", "unavailable"]),
  disclaimer: z.string(),
});

export const InrUsdcRateZ = z.object({
  pair: z.literal("INR/USDC"),
  sellPrice: z.string().nullable(),
  source: z.string(),
  observedAt: Iso.nullable(),
  available: z.boolean(),
  reason: z.string().nullable(),
  disclaimer: z.string(),
});

/* ------------------------------------------------------------------ UPI */
export const UpiParseInZ = z.object({ payload: z.string().min(1).max(512) }).strict();
export const UpiParseOutZ = z.object({
  vpa: z.string(),
  vpaMasked: z.string(),
  payeeName: z.string().nullable(),
  amountInrPaise: MinorStr.nullable(),
  note: z.string().nullable(),
  support: z.enum(["supported", "supported_with_notice", "unsupported"]),
  notices: z.array(z.string()),
});

/* ------------------------------------------------------------------ quotes */
export const QuoteZ = z.object({
  id: Id,
  environment: EnvironmentZ,
  paymentMode: PaymentModeZ,
  inrPaise: MinorStr,
  zecZatoshis: MinorStr,
  requiredUsdcMicros: MinorStr,
  platformFeeInrPaise: MinorStr,
  estimatedP2PFeeUsdcMicros: MinorStr,
  estimatedP2PFeeInrPaise: MinorStr,
  networkFeePolicy: z.string(),
  totalZecZatoshis: MinorStr,
  zecUsdRate: z.string(),
  inrPerUsdcRate: z.string(),
  priceSource: z.string(),
  p2pSource: z.string(),
  observedAt: Iso,
  expiresAt: Iso,
  fundingDeadline: Iso,
  finalityDeadline: Iso,
  fiatGuaranteePolicyId: z.string(),
  privacyMode: PrivacyModeZ,
  maxSlippageBps: z.number().int(),
  paymentEligible: z.boolean(),
  disabledReason: z.string().optional(),
  executionNotGuaranteed: z.boolean(),
  formulaVersion: z.string(),
});
export type Quote = z.infer<typeof QuoteZ>;

export const CreateQuoteInZ = z
  .object({
    mode: PaymentModeZ,
    inrPaise: PositiveMinorStr,
    privacyPreference: PrivacyModeZ.default("shielded"),
    merchantHandle: z.string().max(64).optional(),
    linkSlug: z.string().max(64).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ checkout / intents */
export const TimelineEventZ = z.object({ id: z.string(), at: Iso, type: z.string(), label: z.string(), detail: z.string().optional() });

export const DepositPublicZ = z.object({
  id: z.string(),
  pool: z.string(),
  valueZatoshis: MinorStr,
  confirmations: z.number().int(),
  requiredConfirmations: z.number().int(),
  firstSeenAt: Iso,
  acceptedAt: Iso.nullable(),
  canonical: z.boolean(),
  /** Only for transparent payments where an explorer link is meaningful. */
  publicTxid: z.string().nullable(),
});

export const PayoutPublicZ = z.object({
  status: z.string(),
  orderType: z.literal("PAY"),
  orderReference: z.string().nullable(),
  matching: z.boolean(),
  updatedAt: Iso,
  honestStatus: z.string(),
});

export const CheckoutPublicZ = z.object({
  id: Id,
  mode: PaymentModeZ,
  environment: EnvironmentZ,
  label: z.enum(["DEMO", "TEST"]).nullable(),
  merchant: z.object({ displayName: z.string(), handle: z.string(), verified: z.boolean() }).nullable(),
  link: z.object({ slug: z.string(), title: z.string() }).nullable(),
  quote: QuoteZ,
  zcash: z.object({
    network: z.enum(["mainnet", "testnet", "regtest", "demo"]),
    address: z.string(),
    zip321Uri: z.string(),
    /** Invoice memo code (memo-matched testnet watcher). Must be sent as the memo if the wallet ignores ZIP-321 memos. */
    memo: z.string().nullable(),
    payable: z.boolean(),
    invoiceAddressId: z.string(),
    poolPreference: PrivacyModeZ,
    currentConfirmations: z.number().int(),
    requiredConfirmations: z.number().int(),
  }),
  status: z.string(),
  statusVersion: z.number().int(),
  receivedZatoshis: MinorStr,
  exceptionReason: z.string().nullable(),
  deposits: z.array(DepositPublicZ),
  recipient: z.object({ vpaMasked: z.string(), payeeName: z.string().nullable() }).nullable(),
  payout: PayoutPublicZ.nullable(),
  timeline: z.array(TimelineEventZ),
  paymentObservedAt: Iso.optional(),
  receiptId: z.string().optional(),
  refreshedTo: z.string().nullable(),
  customerNote: z.string(),
  createdAt: Iso,
  accessPolicy: z.object({ canCancel: z.boolean(), canRefresh: z.boolean(), canRequestRefund: z.boolean() }),
});
export type CheckoutPublic = z.infer<typeof CheckoutPublicZ>;

export const CheckoutCreatedZ = z.object({ checkout: CheckoutPublicZ, accessToken: z.string(), accessExpiresAt: Iso });

export const ScanPayIntentInZ = z
  .object({
    quoteId: Id,
    payee: z.object({
      vpa: z.string().min(3).max(120),
      payeeName: z.string().max(80).optional(),
      source: z.enum(["qr_camera", "qr_upload", "qr_paste", "manual"]),
    }),
    payeeConfirmed: z.literal(true),
    refundPreference: z.enum(["manual_review", "return_address"]).default("manual_review"),
    customerNote: z.string().max(140).optional(),
  })
  .strict();

export const TerminalIntentInZ = z.object({ quoteId: Id, customerNote: z.string().max(140).optional() }).strict();
export const LinkCheckoutInZ = z.object({ quoteId: Id, customerNote: z.string().max(140).optional() }).strict();
export const CounterCheckoutInZ = z.object({ quoteId: Id, customerNote: z.string().max(140).optional() }).strict();
export const RefundDetailsInZ = z.object({ zcashAddress: z.string().min(20).max(600), contactNote: z.string().max(280).optional() }).strict();

/* ------------------------------------------------------------------ auth */
export const RegisterInZ = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) }).strict();
export const LoginInZ = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256), totp: z.string().regex(/^\d{6}$/).optional() }).strict();
export const TokenInZ = z.object({ token: z.string().min(20).max(200) }).strict();
export const ForgotInZ = z.object({ email: z.string().email().max(254) }).strict();
export const ResetInZ = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(256) }).strict();
export const StepUpInZ = z.object({ password: z.string().min(1).max(256) }).strict();

export const SessionInfoZ = z.object({ id: z.string(), createdAt: Iso, lastSeenAt: Iso, userAgent: z.string().nullable(), current: z.boolean() });
export const AuthResultZ = z.object({ userId: z.string(), emailVerified: z.boolean(), csrfToken: z.string() });

export const WalletChallengeInZ = z.object({ action: z.enum(["login", "link_wallet"]).default("login") }).strict();
export const WalletChallengeZ = z.object({ challengeId: z.string(), message: z.string(), network: z.enum(["zcash-testnet", "zcash-mainnet"]), expiresAt: Iso });
export const WalletVerifyInZ = z
  .object({
    challengeId: z.string().min(8).max(80),
    signature: z.string().regex(/^(0x)?[0-9a-fA-F]{130}$/),
    pubkey: z.string().regex(/^(0x)?[0-9a-fA-F]{66}([0-9a-fA-F]{64})?$/),
    address: z.string().min(26).max(40),
    signingMode: z.enum(["derived", "current", "legacy_index0"]),
  })
  .strict();
export const OtpVerifyInZ = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/) }).strict();

export const P2PReadinessZ = z.object({ rail: z.literal("P2P_TINYFISH_WEB"), eligible_for_payout: z.boolean(), reasons: z.array(z.string()), lastCheckedAt: Iso.nullable() });
export const CapabilityReportZ = z.object({ id: z.string(), status: z.enum(["PASS", "BLOCKED"]), reasons: z.array(z.string()), runId: z.string().nullable(), observedUrl: z.string().nullable(), accountFingerprint: z.string().nullable(), createdAt: Iso });
export const AdminPayoutZ = z.object({
  id: z.string(),
  flow: z.enum(["SCAN_PAY", "MERCHANT_WITHDRAWAL"]),
  mode: z.string(),
  recipientVpaMasked: z.string(),
  requestedInrPaise: MinorStr,
  maxUsdcDebitMicros: MinorStr,
  state: z.string(),
  stateReason: z.string().nullable(),
  held: z.boolean(),
  commandHash: z.string(),
  approvedBy: z.string().nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export const AdminPayoutDetailZ = AdminPayoutZ.extend({
  attempts: z.array(z.object({ id: z.string(), kind: z.string(), runId: z.string().nullable(), status: z.string(), outcome: z.string().nullable(), createdAt: Iso })),
  providerOrder: z.object({ providerOrderId: z.string(), providerStatus: z.string(), verifiedAt: Iso.nullable() }).nullable(),
});

/* ------------------------------------------------------------------ merchants */
export const MerchantStatusZ = z.enum(["draft", "pending_review", "verified", "restricted", "suspended", "closed"]);
export const PreferencesZ = z.object({
  defaultPrivacy: PrivacyModeZ,
  allowTransparent: z.boolean(),
  notifyOnCredit: z.boolean(),
  notifyOnWithdrawal: z.boolean(),
  showZecOnReceipts: z.boolean(),
});
export const MerchantZ = z.object({
  id: Id,
  environment: EnvironmentZ,
  handle: z.string(),
  displayName: z.string(),
  legalName: z.string().nullable(),
  businessType: z.string().nullable(),
  category: z.string(),
  country: z.string(),
  status: MerchantStatusZ,
  logoUrl: z.string().nullable(),
  counterSlug: z.string(),
  receivingEnabled: z.boolean(),
  preferences: PreferencesZ,
  createdAt: Iso,
  version: z.number().int(),
});
export type MerchantDto = z.infer<typeof MerchantZ>;

export const MerchantSessionZ = z.object({
  authenticated: z.boolean(),
  userId: z.string().nullable(),
  emailVerified: z.boolean(),
  csrfToken: z.string().nullable(),
  merchant: MerchantZ.nullable(),
  role: z.enum(["owner", "finance", "viewer", "support"]).nullable(),
  scopes: z.array(z.string()),
  gates: z.object({
    canReceive: z.boolean(),
    canWithdraw: z.boolean(),
    reasons: z.array(z.string()),
  }),
  stepUpValidUntil: Iso.nullable(),
});

export const CreateMerchantInZ = z
  .object({
    displayName: z.string().min(2).max(80),
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]{2,30}$/),
    category: z.string().min(2).max(40),
    legalName: z.string().max(160).optional(),
    businessType: z.enum(["individual", "sole_proprietor", "partnership", "llp", "private_limited", "other"]).optional(),
  })
  .strict();
export const UpdateMerchantInZ = z
  .object({
    expectedVersion: z.number().int(),
    displayName: z.string().min(2).max(80).optional(),
    category: z.string().min(2).max(40).optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
  })
  .strict();
export const UpdatePreferencesInZ = PreferencesZ.partial().strict();

export const PayoutDestinationZ = z.object({
  id: Id,
  kind: z.literal("upi_vpa"),
  vpaMasked: z.string(),
  beneficiaryName: z.string().nullable(),
  status: z.enum(["pending_verification", "cooling_off", "verified", "rejected", "removed"]),
  usableAfter: Iso.nullable(),
  createdAt: Iso,
});
export const CreatePayoutDestinationInZ = z.object({ vpa: z.string().min(3).max(120), beneficiaryName: z.string().max(80).optional() }).strict();
export const UpdatePayoutDestinationInZ = z.object({ beneficiaryName: z.string().max(80) }).strict();

export const MetricsZ = z.object({
  acceptedPayments: z.number().int(),
  acceptedVolumeInrPaise: MinorStr,
  pendingPayments: z.number().int(),
  activeLinks: z.number().int(),
  asOf: Iso,
  source: z.literal("ledger"),
});

export const CounterQrZ = z.object({ slug: z.string(), url: z.string(), retiredSlugs: z.array(z.string()), note: z.string() });
export const PublicMerchantZ = z.object({
  handle: z.string(),
  displayName: z.string(),
  logoUrl: z.string().nullable(),
  verified: z.boolean(),
  receivingActive: z.boolean(),
  limits: z.object({ minInrPaise: MinorStr, maxInrPaise: MinorStr }),
  label: z.enum(["DEMO", "TEST"]).nullable(),
});

/* ------------------------------------------------------------------ links */
export const LinkStatusZ = z.enum(["active", "revoked", "expired", "exhausted"]);
export const LinkZ = z.object({
  id: Id,
  merchantId: Id,
  slug: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  reference: z.string(),
  amountMode: z.enum(["fixed", "variable"]),
  fixedInrPaise: MinorStr.nullable(),
  minInrPaise: MinorStr.nullable(),
  maxInrPaise: MinorStr.nullable(),
  reusable: z.boolean(),
  useLimit: z.number().int().nullable(),
  successfulUses: z.number().int(),
  expiresAt: Iso.nullable(),
  allowNote: z.boolean(),
  status: LinkStatusZ,
  revokedAt: Iso.nullable(),
  duplicatedFrom: z.string().nullable(),
  views: z.number().int(),
  createdAt: Iso,
  version: z.number().int(),
});
export const CreateLinkInZ = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    reference: z.string().max(60).default(""),
    amountMode: z.enum(["fixed", "variable"]),
    fixedInrPaise: PositiveMinorStr.optional(),
    minInrPaise: PositiveMinorStr.optional(),
    maxInrPaise: PositiveMinorStr.optional(),
    reusable: z.boolean().default(true),
    useLimit: z.number().int().min(1).max(1_000_000).nullable().default(null),
    expiresAt: Iso.nullable().default(null),
    allowNote: z.boolean().default(false),
  })
  .strict();
export const UpdateLinkInZ = z
  .object({ expectedVersion: z.number().int(), title: z.string().min(1).max(80).optional(), description: z.string().max(500).optional(), reference: z.string().max(60).optional(), allowNote: z.boolean().optional() })
  .strict();
export const PublicLinkZ = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  amountMode: z.enum(["fixed", "variable"]),
  fixedInrPaise: MinorStr.nullable(),
  minInrPaise: MinorStr,
  maxInrPaise: MinorStr,
  allowNote: z.boolean(),
  status: LinkStatusZ,
  expiresAt: Iso.nullable(),
  merchant: z.object({ displayName: z.string(), handle: z.string(), verified: z.boolean(), logoUrl: z.string().nullable() }),
  label: z.enum(["DEMO", "TEST"]).nullable(),
});

/* ------------------------------------------------------------------ transactions / balance */
export const TransactionZ = z.object({
  id: Id,
  mode: PaymentModeZ,
  status: z.string(),
  inrPaise: MinorStr,
  platformFeeInrPaise: MinorStr,
  zecZatoshis: MinorStr,
  receivedZatoshis: MinorStr,
  privacyMode: PrivacyModeZ,
  linkId: z.string().nullable(),
  creditId: z.string().nullable(),
  creditStatus: z.string().nullable(),
  receiptId: z.string().nullable(),
  createdAt: Iso,
  acceptedAt: Iso.nullable(),
  label: z.enum(["DEMO", "TEST"]).nullable(),
});
export const TransactionDetailZ = TransactionZ.extend({
  timeline: z.array(TimelineEventZ),
  deposits: z.array(DepositPublicZ),
  finality: z.object({ requiredConfirmations: z.number().int(), currentConfirmations: z.number().int(), canonical: z.boolean() }),
  reconciliation: z.object({ state: z.enum(["pending", "reconciled", "discrepancy"]), lastCheckedAt: Iso.nullable() }),
});

export const BalanceZ = z.object({
  merchantId: Id,
  currency: z.literal("INR"),
  pendingInrPaise: MinorStr,
  lockedInrPaise: MinorStr,
  availableInrPaise: MinorStr,
  reservedInrPaise: MinorStr,
  withdrawnInrPaise: MinorStr,
  liabilityInrPaise: MinorStr,
  redeemable: z.boolean(),
  lastReconciledAt: Iso.nullable(),
  disclaimer: z.string(),
});
export const BalanceEntryZ = z.object({
  id: z.string(),
  journalId: z.string(),
  at: Iso,
  kind: z.string(),
  account: z.string(),
  direction: z.enum(["credit", "debit"]),
  amountInrPaise: MinorStr,
  memo: z.string(),
  refId: z.string().nullable(),
});
export const SettlementZ = z.object({
  creditId: Id,
  intentId: z.string().nullable(),
  amountInrPaise: MinorStr,
  status: z.string(),
  lockedAt: Iso.nullable(),
  unlocksAt: Iso.nullable(),
  availableAt: Iso.nullable(),
  withdrawalId: z.string().nullable(),
  policyVersion: z.string(),
});

/* ------------------------------------------------------------------ withdrawals */
export const WithdrawalQuoteInZ = z.object({ inrPaise: PositiveMinorStr }).strict();
export const WithdrawalQuoteZ = z.object({
  inrPaise: MinorStr,
  feeInrPaise: MinorStr,
  payoutInrPaise: MinorStr,
  requiredUsdcMicros: MinorStr,
  estimatedP2PFeeUsdcMicros: MinorStr,
  sellPrice: z.string(),
  executable: z.boolean(),
  blockers: z.array(z.string()),
  observedAt: Iso,
  disclaimer: z.string(),
});
export const CreateWithdrawalInZ = z.object({ inrPaise: PositiveMinorStr, payoutDestinationId: Id }).strict();
export const WithdrawalZ = z.object({
  id: Id,
  merchantId: Id,
  inrPaise: MinorStr,
  feeInrPaise: MinorStr,
  payoutInrPaise: MinorStr,
  requiredUsdcMicros: MinorStr,
  payoutVpaMasked: z.string(),
  status: z.string(),
  orderReference: z.string().nullable(),
  failureReason: z.string().nullable(),
  recoveredAt: Iso.nullable(),
  timeline: z.array(TimelineEventZ),
  createdAt: Iso,
  updatedAt: Iso,
  label: z.enum(["DEMO", "TEST"]).nullable(),
});

/* ------------------------------------------------------------------ receipts / support */
export const ReceiptZ = z.object({
  id: Id,
  kind: z.enum(["payment", "withdrawal"]),
  environment: EnvironmentZ,
  label: z.enum(["DEMO", "TEST"]).nullable(),
  issuedAt: Iso,
  status: z.string(),
  statusNote: z.string(),
  inrPaise: MinorStr,
  totalInrPaise: MinorStr.nullable(),
  zecZatoshis: MinorStr.nullable(),
  privacyMode: PrivacyModeZ.nullable(),
  merchantName: z.string().nullable(),
  recipientVpaMasked: z.string().nullable(),
  title: z.string(),
  verification: z.enum(["wallet_verified", "simulated"]),
  validationHash: z.string(),
});
export const SupportCaseInZ = z
  .object({
    category: z.enum(["refund", "dispute", "payout_delay", "deposit_issue", "other"]),
    reason: z.string().min(10).max(2000),
    checkoutId: Id.optional(),
    withdrawalId: Id.optional(),
  })
  .strict();
export const SupportCaseZ = z.object({
  id: z.string(),
  category: z.string(),
  status: z.string(),
  checkoutId: z.string().nullable(),
  withdrawalId: z.string().nullable(),
  createdAt: Iso,
});

/* ------------------------------------------------------------------ ops */
export const TreasurySnapshotZ = z.object({
  at: Iso,
  environment: EnvironmentZ,
  zecVaultZatoshis: MinorStr,
  zecPendingZatoshis: MinorStr,
  usdcInventoryMicros: MinorStr,
  usdcInventoryObservedAt: Iso.nullable(),
  usdcHeldMicros: MinorStr,
  usdcInFlightMicros: MinorStr,
  usdcFreeMicros: z.string(),
  merchantLiabilityInrPaise: MinorStr,
  payoutLiabilityInrPaise: MinorStr,
  payoutQueue: z.number().int(),
  stale: z.boolean(),
  providerStatus: z.record(z.string(), z.string()),
});
export const OpsActionInZ = z.object({ reason: z.string().min(5).max(500), feature: z.string().max(60).optional() }).strict();
export const OpsDecisionInZ = z.object({ decision: z.enum(["retry_payout", "queue_refund", "accept_deposit", "reject", "close"]), reason: z.string().min(5).max(500), approvalId: Id.optional() }).strict();

/* ------------------------------------------------------------------ internal */
export const ZcashEventInZ = z
  .object({
    eventId: z.string().min(8).max(200),
    kind: z.enum(["note_seen", "note_confirmed", "note_reorged"]),
    network: z.enum(["mainnet", "testnet", "regtest"]),
    pool: z.enum(["orchard", "sapling", "transparent", "ironwood"]),
    txid: z.string().regex(/^[0-9a-f]{64}$/),
    outputRef: z.string().min(1).max(200),
    valueZatoshis: PositiveMinorStr,
    address: z.string().min(20).max(600),
    blockHeight: z.number().int().nullable(),
    blockHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    confirmations: z.number().int().min(0),
    scanVersion: z.string().max(80),
  })
  .strict();

export const P2PEventInZ = z
  .object({
    eventId: z.string().min(8).max(200),
    type: z.enum(["placed", "accepted", "paid", "completed", "cancelled"]),
    chainId: z.number().int(),
    orderId: z.string().regex(/^\d+$/),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    blockNumber: z.string().regex(/^\d+$/),
  })
  .strict();

export const DemoDepositInZ = z.object({ kind: z.enum(["exact", "underpaid", "overpaid"]), confirmations: z.number().int().min(0).max(100).default(0) }).strict();
