/**
 * Operating modes. Parsed STRICTLY — an unknown or misspelled value is a fatal boot error,
 * never a silent fallback to another mode.
 */
import { DomainError } from "./errors";

export const ENVIRONMENTS = ["demo", "testnet", "mainnet-readonly", "mainnet-enabled"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export type ZcashNetwork = "mainnet" | "testnet" | "regtest";

/**
 * Spec-level names (2026-11-04 delta) → internal environment ids. Parsed strictly; one id each:
 *   DEMO → demo · HACKATHON_TESTNET → testnet · MAINNET_READONLY → mainnet-readonly ·
 *   CONTROLLED_LIVE_PILOT → mainnet-enabled (operator-approved, capped pilot; never unattended)
 */
export const ENVIRONMENT_ALIASES: Record<string, Environment> = {
  DEMO: "demo",
  HACKATHON_TESTNET: "testnet",
  MAINNET_READONLY: "mainnet-readonly",
  CONTROLLED_LIVE_PILOT: "mainnet-enabled",
};
export const ENVIRONMENT_DISPLAY: Record<Environment, string> = {
  demo: "DEMO",
  testnet: "HACKATHON_TESTNET",
  "mainnet-readonly": "MAINNET_READONLY",
  "mainnet-enabled": "CONTROLLED_LIVE_PILOT",
};

export function parseEnvironment(raw: string | undefined): Environment {
  if (raw !== undefined && raw in ENVIRONMENT_ALIASES) return ENVIRONMENT_ALIASES[raw]!;
  if (raw === undefined || raw === "") {
    throw new DomainError("SYSTEM_CONFIG", "ZEB_ENVIRONMENT is required (DEMO | HACKATHON_TESTNET | MAINNET_READONLY | CONTROLLED_LIVE_PILOT)");
  }
  if (!(ENVIRONMENTS as readonly string[]).includes(raw)) {
    throw new DomainError("SYSTEM_CONFIG", `ZEB_ENVIRONMENT="${raw.slice(0, 40)}" is not a valid environment`);
  }
  return raw as Environment;
}

export function zcashNetworkFor(env: Environment): ZcashNetwork | null {
  switch (env) {
    case "demo":
      return null; // demo never touches a chain
    case "testnet":
      return "testnet";
    case "mainnet-readonly":
    case "mainnet-enabled":
      return "mainnet";
  }
}

export interface Capabilities {
  /** Can a receiving address be issued to a customer at all? */
  canIssueReceivingAddress: boolean;
  /** Are issued addresses real chain addresses (vs non-payable demo placeholders)? */
  realChainAddresses: boolean;
  /** May the system submit money-changing chain transactions? */
  canSubmitTransactions: boolean;
  /** Are merchant credits redeemable for real INR? */
  creditsRedeemable: boolean;
  /** Label every record and receipt as TEST / DEMO. */
  label: "DEMO" | "TEST" | null;
}

export function environmentCapabilities(env: Environment): Capabilities {
  switch (env) {
    case "demo":
      return { canIssueReceivingAddress: true, realChainAddresses: false, canSubmitTransactions: false, creditsRedeemable: false, label: "DEMO" };
    case "testnet":
      // HACKATHON_TESTNET: real shielded TAZ deposits; payouts are simulated/disabled — testnet TAZ never funds a live P2P payout.
      return { canIssueReceivingAddress: true, realChainAddresses: true, canSubmitTransactions: false, creditsRedeemable: false, label: "TEST" };
    case "mainnet-readonly":
      return { canIssueReceivingAddress: false, realChainAddresses: true, canSubmitTransactions: false, creditsRedeemable: false, label: null };
    case "mainnet-enabled":
      return { canIssueReceivingAddress: true, realChainAddresses: true, canSubmitTransactions: true, creditsRedeemable: true, label: null };
  }
}

/** Guard every read/write of an environment-scoped record. */
export function assertSameEnvironment(recordEnv: string, runtimeEnv: Environment, what = "record"): void {
  if (recordEnv !== runtimeEnv) {
    throw new DomainError("SYSTEM_ENVIRONMENT_MISMATCH", `${what} belongs to environment ${recordEnv}, runtime is ${runtimeEnv}`, undefined, {
      status: 500,
    });
  }
}
