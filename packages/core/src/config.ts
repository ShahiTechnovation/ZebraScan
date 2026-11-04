/**
 * Strict configuration. Unknown environment values, missing secrets, or mainnet use of dev-only
 * providers are FATAL at boot. Every policy number is configurable and risk-owned; the defaults
 * below are conservative PROPOSALS, not verified partner facts (spec §7.3).
 */
import { DomainError, parseEnvironment, zcashNetworkFor, type Environment, type ZcashNetwork } from "@zeb/domain";
import { loadPemFromEnv } from "@zeb/providers";

export interface Policy {
  quoteLifetimeSec: number;
  /** After quote expiry, a broadcast seen before this grace still counts as on-time. */
  fundingGraceSec: number;
  /** Window after the funding deadline in which confirmations may complete. */
  finalityWindowSec: number;
  requiredConfirmations: number;
  platformFeeBps: number;
  p2pSpreadReserveBps: number;
  zecVolatilityPremiumBps: number;
  minInrPaise: bigint;
  maxInrPaise: bigint;
  creditCooldownSec: number;
  creditPolicyVersion: string;
  withdrawalFeeBps: number;
  minWithdrawalInrPaise: bigint;
  payoutDestinationCoolingSec: number;
  treasuryBufferMicros: bigint;
  treasuryInventoryMaxAgeSec: number;
  paymentToleranceZat: bigint;
  stepUpValiditySec: number;
  sessionTtlSec: number;
  payoutAcceptTimeoutSec: number;
  payoutCompletionTimeoutSec: number;
  /** Wait after LP-asserted on-chain completion before marking completed (dispute window). */
  payoutDisputeWindowSec: number;
  maxPayoutAttempts: number;
  priceMaxAgeSec: number;
  priceMaxDeviationBps: number;
  priceMinSources: number;
  scannerMaxLagBlocks: number;
  scannerMaxTipAgeSec: number;
}

export interface Config {
  environment: Environment;
  zcashNetwork: ZcashNetwork | null;
  databaseUrl: string;
  apiPort: number;
  apiHost: string;
  webOrigins: string[];
  appBaseUrl: string;
  tokenSecret: string;
  internalHmacSecret: string | null;
  kms: { provider: "local"; keks: string; activeKek: string };
  zcashGateway: { url: string; accountId: string; tls?: { certPath: string; keyPath: string; caPath: string } } | null;
  /** HACKATHON_TESTNET watch-only watcher (zkool_graphql UFVK account, memo-matched invoices). */
  zkool: { url: string; accountId: number; network: "testnet" | "mainnet"; jwt?: string; jwtPrivateKeyPem?: string; pools: number; addressMode: "rotate" | "memo"; birthHeight?: number } | null;
  p2p: { chainId: string; rpcUrl: string; diamondAddress: string; subgraphUrl: string; usdcAddress: string; diamondCodeHash?: string } | null;
  treasuryAddress: string | null;
  signer: { mode: "none" } | { mode: "testnet-file"; keyFile: string } | { mode: "remote"; url: string; authHeader?: string };
  prices: { sources: string[]; coingeckoApiKey?: string };
  email: { mode: "none" } | { mode: "smtp"; url: string; from: string } | { mode: "dev-file"; dir: string };
  approvals: { legal: string | null; provider: string | null };
  /** Payout rail. P2P_TINYFISH_WEB is the only live rail; the SDK executor is reference-only and never a fallback. */
  payoutRail: "P2P_TINYFISH_WEB" | "DEMO_SIMULATED";
  tinyfish: { apiKey: string | null; startUrl: string | null; profileId?: string; extraOrigins: string[] };
  pilot: {
    livePayoutsEnabled: boolean;
    requireOperatorApproval: true;
    maxUnattendedPayoutInrPaise: 0n;
    maxPayoutInrPaise: bigint;
    dailyMaxUsdcMicros: bigint;
    capabilityMaxAgeSec: number;
    approvalTtlSec: number;
    runMaxDurationSec: number;
    runMaxSteps: number;
  };
  cookieSecure: boolean;
  policy: Policy;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new DomainError("SYSTEM_CONFIG", `${key} must be a non-negative integer`);
  const v = Number(raw);
  if (v < min || v > max) throw new DomainError("SYSTEM_CONFIG", `${key} must be between ${min} and ${max}`);
  return v;
}
function big(env: Env, key: string, dflt: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new DomainError("SYSTEM_CONFIG", `${key} must be an integer string`);
  return BigInt(raw);
}
function req(env: Env, key: string): string {
  const v = env[key];
  if (!v) throw new DomainError("SYSTEM_CONFIG", `${key} is required`);
  return v;
}

export function loadConfig(env: Env = process.env): Config {
  const environment = parseEnvironment(env.ZEB_ENVIRONMENT);
  const expectedNet = zcashNetworkFor(environment);
  if (env.ZCASH_NETWORK && env.ZCASH_NETWORK !== expectedNet) {
    throw new DomainError("SYSTEM_CONFIG", `ZCASH_NETWORK=${env.ZCASH_NETWORK} conflicts with environment ${environment} (expects ${expectedNet})`);
  }
  const tokenSecret = req(env, "ZEB_TOKEN_SECRET");
  if (tokenSecret.length < 32) throw new DomainError("SYSTEM_CONFIG", "ZEB_TOKEN_SECRET must be at least 32 characters");

  const gwUrl = env.ZCASH_GATEWAY_URL;
  const zcashGateway =
    gwUrl && environment !== "demo"
      ? {
          url: gwUrl.replace(/\/$/, ""),
          accountId: env.ZCASH_ACCOUNT_ID ?? "0",
          tls: env.ZCASH_GATEWAY_TLS_CERT ? { certPath: req(env, "ZCASH_GATEWAY_TLS_CERT"), keyPath: req(env, "ZCASH_GATEWAY_TLS_KEY"), caPath: req(env, "ZCASH_GATEWAY_TLS_CA") } : undefined,
        }
      : null;

  let zkool: Config["zkool"] = null;
  if (env.ZKOOL_GRAPHQL_URL) {
    // zkool watch-only watcher: HACKATHON_TESTNET (receiving) or MAINNET_READONLY (monitoring only;
    // mainnet-readonly never opens payouts). Never in demo or mainnet-enabled.
    if (environment !== "testnet" && environment !== "mainnet-readonly") throw new DomainError("SYSTEM_CONFIG", "ZKOOL_GRAPHQL_URL is only permitted in HACKATHON_TESTNET or MAINNET_READONLY");
    if (zcashGateway) throw new DomainError("SYSTEM_CONFIG", "configure either ZCASH_GATEWAY_URL or ZKOOL_GRAPHQL_URL, not both");
    const zNet = environment === "testnet" ? "testnet" : "mainnet";
    if (env.ZKOOL_NETWORK && env.ZKOOL_NETWORK !== zNet) throw new DomainError("SYSTEM_CONFIG", `ZKOOL_NETWORK=${env.ZKOOL_NETWORK} conflicts with environment ${environment} (expects ${zNet})`);
    if (env.ZCASH_SPEND_KEY_REF) throw new DomainError("SYSTEM_CONFIG", "ZCASH_SPEND_KEY_REF must be blank on API/worker processes (watch-only)");
    const mode = env.ZKOOL_ADDRESS_MODE ?? "rotate";
    if (mode !== "rotate" && mode !== "memo") throw new DomainError("SYSTEM_CONFIG", "ZKOOL_ADDRESS_MODE must be rotate or memo");
    let pem: string | undefined;
    try {
      pem = loadPemFromEnv({ file: env.ZKOOL_JWT_PRIVATE_KEY_FILE, pem: env.ZKOOL_JWT_PRIVATE_KEY });
    } catch (e) {
      throw new DomainError("SYSTEM_CONFIG", `ZKOOL_JWT_PRIVATE_KEY_FILE unreadable: ${(e as Error).message.slice(0, 80)}`);
    }
    if (!pem && !env.ZKOOL_JWT && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.ZKOOL_GRAPHQL_URL)) {
      throw new DomainError("SYSTEM_CONFIG", "a non-local ZKOOL_GRAPHQL_URL requires JWT auth (ZKOOL_JWT_PRIVATE_KEY_FILE)");
    }
    zkool = {
      url: env.ZKOOL_GRAPHQL_URL,
      accountId: int(env, "ZKOOL_ACCOUNT_ID", 1, 1, 1_000_000),
      network: zNet,
      jwt: env.ZKOOL_JWT || undefined,
      jwtPrivateKeyPem: pem,
      pools: int(env, "ZKOOL_ADDRESS_POOLS", 4, 1, 15),
      addressMode: mode,
      birthHeight: env.ZKOOL_BIRTH_HEIGHT ? int(env, "ZKOOL_BIRTH_HEIGHT", 0, 1, 100_000_000) : undefined,
    };
  }

  const p2p =
    env.P2P_DIAMOND_ADDRESS && environment !== "demo"
      ? {
          chainId: req(env, "P2P_CHAIN_ID"),
          rpcUrl: req(env, "BASE_RPC_URL"),
          diamondAddress: req(env, "P2P_DIAMOND_ADDRESS"),
          subgraphUrl: req(env, "P2P_SUBGRAPH_URL"),
          usdcAddress: req(env, "P2P_USDC_ADDRESS"),
          diamondCodeHash: env.P2P_DIAMOND_CODE_HASH || undefined,
        }
      : null;
  if (p2p && environment === "testnet" && p2p.chainId !== "84532") throw new DomainError("SYSTEM_CONFIG", "testnet must use Base Sepolia (84532) for P2P");
  if (p2p && environment.startsWith("mainnet") && p2p.chainId !== "8453") throw new DomainError("SYSTEM_CONFIG", "mainnet must use Base (8453) for P2P");

  const signerMode = env.BASE_SIGNER_MODE ?? "none";
  let signer: Config["signer"];
  if (signerMode === "none") signer = { mode: "none" };
  else if (signerMode === "testnet-file") {
    if (environment !== "testnet") throw new DomainError("SYSTEM_CONFIG", "BASE_SIGNER_MODE=testnet-file is only permitted in testnet");
    signer = { mode: "testnet-file", keyFile: req(env, "BASE_SIGNER_KEY_FILE") };
  } else if (signerMode === "remote") signer = { mode: "remote", url: req(env, "BASE_SIGNER_URL"), authHeader: env.BASE_SIGNER_AUTH };
  else throw new DomainError("SYSTEM_CONFIG", `BASE_SIGNER_MODE=${signerMode} is not valid (none|testnet-file|remote)`);

  const emailMode = env.EMAIL_MODE ?? "none";
  let email: Config["email"];
  if (emailMode === "none") email = { mode: "none" };
  else if (emailMode === "smtp") email = { mode: "smtp", url: req(env, "SMTP_URL"), from: req(env, "EMAIL_FROM") };
  else if (emailMode === "dev-file") {
    if (environment.startsWith("mainnet")) throw new DomainError("SYSTEM_CONFIG", "EMAIL_MODE=dev-file is not permitted on mainnet");
    email = { mode: "dev-file", dir: env.EMAIL_DEV_DIR ?? "./var/dev-mail" };
  } else throw new DomainError("SYSTEM_CONFIG", `EMAIL_MODE=${emailMode} is not valid (none|smtp|dev-file)`);

  const kmsProvider = env.ZEB_KMS_PROVIDER ?? "local";
  if (kmsProvider !== "local") throw new DomainError("SYSTEM_CONFIG", `ZEB_KMS_PROVIDER=${kmsProvider} has no adapter in this build; implement KeyProvider (docs/SECURITY.md)`);

  const isDemo = environment === "demo";
  const policy: Policy = {
    quoteLifetimeSec: int(env, "QUOTE_LIFETIME_SECONDS", isDemo ? 90 : 600, 30, 3600),
    fundingGraceSec: int(env, "FUNDING_GRACE_SECONDS", isDemo ? 30 : 300, 0, 3600),
    finalityWindowSec: int(env, "FINALITY_WINDOW_SECONDS", 7200, 60, 172_800),
    // Testnet evidence demo: 1 block (event guide). Mainnet values require risk review.
    requiredConfirmations: int(env, "REQUIRED_CONFIRMATIONS", isDemo ? 3 : environment === "testnet" ? 1 : 10, 1, 1000),
    platformFeeBps: int(env, "PLATFORM_FEE_BPS", 50, 0, 1000),
    p2pSpreadReserveBps: int(env, "P2P_SPREAD_RESERVE_BPS", 100, 0, 2000),
    zecVolatilityPremiumBps: int(env, "ZEC_VOLATILITY_PREMIUM_BPS", 150, 0, 2000),
    minInrPaise: big(env, "MIN_INR_PAISE", 100n),
    maxInrPaise: big(env, "MAX_INR_PAISE", isDemo ? 1_000_000n : 200_000n),
    creditCooldownSec: int(env, "CREDIT_COOLDOWN_SECONDS", 15 * 86_400, 0, 365 * 86_400),
    creditPolicyVersion: env.CREDIT_POLICY_VERSION ?? "cooldown-proposal-2026-11",
    withdrawalFeeBps: int(env, "WITHDRAWAL_FEE_BPS", 75, 0, 1000),
    minWithdrawalInrPaise: big(env, "MIN_WITHDRAWAL_INR_PAISE", 10_000n),
    payoutDestinationCoolingSec: int(env, "PAYOUT_DEST_COOLING_SECONDS", isDemo ? 0 : 86_400, 0, 30 * 86_400),
    treasuryBufferMicros: big(env, "TREASURY_BUFFER_MICROS", 50_000_000n),
    treasuryInventoryMaxAgeSec: int(env, "TREASURY_INVENTORY_MAX_AGE_SECONDS", isDemo ? 10 * 365 * 86_400 : 300, 30, 10 * 365 * 86_400),
    paymentToleranceZat: big(env, "PAYMENT_TOLERANCE_ZAT", 0n),
    stepUpValiditySec: int(env, "STEP_UP_VALIDITY_SECONDS", 300, 60, 3600),
    sessionTtlSec: int(env, "SESSION_TTL_SECONDS", 7 * 86_400, 600, 30 * 86_400),
    payoutAcceptTimeoutSec: int(env, "PAYOUT_ACCEPT_TIMEOUT_SECONDS", 900, 60, 86_400),
    payoutCompletionTimeoutSec: int(env, "PAYOUT_COMPLETION_TIMEOUT_SECONDS", 3600, 300, 7 * 86_400),
    payoutDisputeWindowSec: int(env, "PAYOUT_DISPUTE_WINDOW_SECONDS", isDemo ? 0 : 1800, 0, 7 * 86_400),
    maxPayoutAttempts: int(env, "MAX_PAYOUT_ATTEMPTS", 3, 1, 10),
    priceMaxAgeSec: int(env, "PRICE_MAX_AGE_SECONDS", 120, 5, 3600),
    priceMaxDeviationBps: int(env, "PRICE_MAX_DEVIATION_BPS", 150, 1, 5000),
    priceMinSources: int(env, "PRICE_MIN_SOURCES", 2, 1, 5),
    scannerMaxLagBlocks: int(env, "SCANNER_MAX_LAG_BLOCKS", 3, 0, 1000),
    scannerMaxTipAgeSec: int(env, "SCANNER_MAX_TIP_AGE_SECONDS", 900, 60, 86_400),
  };
  if (policy.minInrPaise <= 0n || policy.minInrPaise > policy.maxInrPaise) throw new DomainError("SYSTEM_CONFIG", "MIN_INR_PAISE must be > 0 and <= MAX_INR_PAISE");

  return {
    environment,
    zcashNetwork: expectedNet,
    databaseUrl: req(env, "DATABASE_URL"),
    apiPort: int(env, "API_PORT", 4000, 1, 65535),
    apiHost: env.API_HOST ?? "127.0.0.1",
    webOrigins: (env.WEB_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()).filter(Boolean),
    appBaseUrl: (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    tokenSecret,
    internalHmacSecret: env.INTERNAL_HMAC_SECRET && env.INTERNAL_HMAC_SECRET.length >= 32 ? env.INTERNAL_HMAC_SECRET : null,
    kms: { provider: "local", keks: req(env, "ZEB_LOCAL_KEKS"), activeKek: req(env, "ZEB_ACTIVE_KEK") },
    zcashGateway,
    zkool,
    p2p,
    treasuryAddress: env.TREASURY_ADDRESS || null,
    signer,
    prices: { sources: (env.PRICE_SOURCES ?? "coingecko,kraken").split(",").map((s) => s.trim()).filter(Boolean), coingeckoApiKey: env.COINGECKO_API_KEY || undefined },
    email,
    approvals: { legal: env.LEGAL_APPROVAL_REF || null, provider: env.PROVIDER_APPROVAL_REF || null },
    payoutRail: (() => {
      const r = env.PAYOUT_RAIL ?? (environment === "demo" ? "DEMO_SIMULATED" : "P2P_TINYFISH_WEB");
      if (r !== "P2P_TINYFISH_WEB" && r !== "DEMO_SIMULATED") throw new DomainError("SYSTEM_CONFIG", `PAYOUT_RAIL=${r} is not valid (P2P_TINYFISH_WEB | DEMO_SIMULATED)`);
      if (r === "DEMO_SIMULATED" && environment !== "demo") throw new DomainError("SYSTEM_CONFIG", "PAYOUT_RAIL=DEMO_SIMULATED is only permitted in DEMO");
      return r;
    })(),
    // TINYFISH_API_KEY is read by the worker/API process only; it never reaches the web bundle.
    tinyfish: { apiKey: env.TINYFISH_API_KEY || null, startUrl: env.P2P_ALLOWED_START_URL || null, profileId: env.TINYFISH_PROFILE_ID || undefined, extraOrigins: (env.P2P_ALLOWED_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
    pilot: {
      livePayoutsEnabled: env.LIVE_PAYOUTS_ENABLED === "true",
      requireOperatorApproval: true,
      maxUnattendedPayoutInrPaise: 0n,
      maxPayoutInrPaise: big(env, "PILOT_MAX_PAYOUT_INR_PAISE", 0n),
      dailyMaxUsdcMicros: big(env, "PILOT_DAILY_MAX_USDC_MICROS", 0n),
      capabilityMaxAgeSec: int(env, "P2P_CAPABILITY_MAX_AGE_SECONDS", 1800, 60, 86_400),
      approvalTtlSec: int(env, "OPERATOR_APPROVAL_TTL_SECONDS", 900, 60, 86_400),
      runMaxDurationSec: int(env, "TINYFISH_MAX_DURATION_SECONDS", 150, 30, 900),
      runMaxSteps: int(env, "TINYFISH_MAX_STEPS", 28, 5, 100),
    },
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : environment !== "demo",
    policy,
  };
}
