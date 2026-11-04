/**
 * Verifies a deployment configuration BEFORE it is allowed to run. Exits 1 on any FAIL.
 * Performs read-only network checks (P2P preflight, gateway status) when configured.
 *
 *   ZEB_ENVIRONMENT=testnet ... pnpm verify:prod-config
 */
import { loadConfig } from "@zeb/core";
import { P2PClient, validateP2PConfig, ZcashGatewayClient } from "@zeb/providers";
import type { Address } from "viem";

type Level = "PASS" | "WARN" | "FAIL";
const results: Array<[Level, string]> = [];
const add = (l: Level, m: string) => results.push([l, m]);

let cfg;
try {
  cfg = loadConfig();
  add("PASS", `configuration parses (environment=${cfg.environment})`);
} catch (e) {
  add("FAIL", `configuration rejected: ${(e as Error).message}`);
  report();
}
const env = cfg!.environment;
const mainnet = env === "mainnet-readonly" || env === "mainnet-enabled";
const live = env !== "demo";

const entropy = new Set(cfg!.tokenSecret).size;
add(entropy >= 16 ? "PASS" : "FAIL", `ZEB_TOKEN_SECRET entropy (${entropy} distinct chars)`);
add(cfg!.internalHmacSecret ? "PASS" : live ? "FAIL" : "WARN", "INTERNAL_HMAC_SECRET configured");
add(!mainnet || cfg!.kms.provider !== "local" ? "PASS" : "FAIL", `KMS provider "${cfg!.kms.provider}" (local KEKs are demo/testnet only)`);
add(!mainnet || cfg!.cookieSecure ? "PASS" : "FAIL", "Secure cookies");
add(!mainnet || cfg!.webOrigins.every((o) => o.startsWith("https://")) ? "PASS" : "FAIL", `WEB_ORIGINS are https (${cfg!.webOrigins.join(", ")})`);
add(!mainnet || cfg!.appBaseUrl.startsWith("https://") ? "PASS" : "FAIL", "APP_BASE_URL is https");
const dbu = new URL(cfg!.databaseUrl);
const localDb = ["localhost", "127.0.0.1", "postgres"].includes(dbu.hostname);
add(!mainnet || localDb || dbu.searchParams.get("sslmode") === "require" || dbu.searchParams.get("sslmode") === "verify-full" ? "PASS" : "FAIL", "database connection requires TLS");
add(cfg!.email.mode !== "none" ? "PASS" : live ? "WARN" : "PASS", `email delivery: ${cfg!.email.mode}`);
add(!mainnet || cfg!.email.mode === "smtp" ? "PASS" : "FAIL", "mainnet uses a real email provider");

if (env === "mainnet-enabled") {
  add(cfg!.approvals.legal ? "PASS" : "FAIL", "LEGAL_APPROVAL_REF recorded");
  add(cfg!.approvals.provider ? "PASS" : "FAIL", "PROVIDER_APPROVAL_REF recorded");
  add(cfg!.signer.mode === "remote" ? "PASS" : "FAIL", "Base signer is a remote isolated signer");
}

if (live) {
  if (!cfg!.p2p) add(env === "mainnet-readonly" ? "WARN" : "FAIL", "P2P provider configured (Diamond / subgraph / RPC)");
  else {
    try {
      const p2p = new P2PClient(validateP2PConfig({ ...cfg!.p2p, expectedDiamondCodeHash: cfg!.p2p.diamondCodeHash }));
      add("PASS", "P2P configuration shape valid (Circle USDC, non-zero Diamond, https subgraph)");
      const pre = await p2p.preflight((cfg!.treasuryAddress ?? undefined) as Address | undefined);
      add(pre.ok ? "PASS" : "FAIL", `P2P preflight: ${pre.ok ? "ok" : pre.problems.join("; ")}`);
      if (!cfg!.p2p.diamondCodeHash) add("WARN", "P2P_DIAMOND_CODE_HASH not pinned (recommended: provider-verified code hash)");
    } catch (e) {
      add("FAIL", `P2P configuration: ${(e as Error).message}`);
    }
  }
  if (!cfg!.zcashGateway) add(env === "mainnet-readonly" ? "WARN" : "FAIL", "Zcash gateway configured");
  else {
    add(cfg!.zcashGateway.tls ? "PASS" : "FAIL", "Zcash gateway uses mTLS");
    try {
      const st = await new ZcashGatewayClient({ url: cfg!.zcashGateway.url, network: cfg!.zcashNetwork!, tls: cfg!.zcashGateway.tls }).status();
      add(st.network === cfg!.zcashNetwork ? "PASS" : "FAIL", `gateway network ${st.network}`);
      add(st.ironwoodSupported ? "PASS" : "FAIL", "gateway reports NU6.3/Ironwood support");
      add(st.state === "synced" ? "PASS" : "FAIL", `gateway scanner state ${st.state} (tip ${st.tipHeight}, scanned ${st.scannedHeight})`);
    } catch (e) {
      add("FAIL", `gateway unreachable: ${(e as Error).message}`);
    }
  }
  add(cfg!.signer.mode !== "none" || env === "mainnet-readonly" ? "PASS" : "WARN", `Base signer mode: ${cfg!.signer.mode}`);
}

report();

function report(): never {
  for (const [l, m] of results) console.log(`${l.padEnd(4)}  ${m}`);
  const fails = results.filter(([l]) => l === "FAIL").length;
  console.log(`\n${fails ? `${fails} FAIL — do not deploy` : "no failures"}`);
  process.exit(fails ? 1 : 0);
}
