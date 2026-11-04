/**
 * Runtime context shared by API and worker: DB pool, crypto, providers. Providers that are not
 * configured are `null` and their features report a closed gate with a reason — never a mock.
 */
import { createPool, type Db } from "@zeb/db";
import { environmentCapabilities, type Capabilities, type Environment } from "@zeb/domain";
import {
  CoinGeckoSource,
  DemoAddressAllocator,
  DevFileEmailProvider,
  KrakenSource,
  P2PClient,
  SmtpEmailProvider,
  validateP2PConfig,
  ZcashGatewayClient,
  ZecUsdOracle,
  ZkoolWatcher,
  type AddressAllocator,
  type EmailProvider,
  type PriceSource,
} from "@zeb/providers";
import { Envelope, LocalKeyProvider, ScopedTokenSigner } from "@zeb/security";
import type { Config } from "./config";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface CoreContext {
  env: Environment;
  caps: Capabilities;
  cfg: Config;
  db: Db;
  envelope: Envelope;
  tokens: ScopedTokenSigner;
  oracle: ZecUsdOracle | null;
  p2p: P2PClient | null;
  p2pConfigError: string | null;
  allocator: AddressAllocator | null;
  gateway: ZcashGatewayClient | null;
  zkool: ZkoolWatcher | null;
  email: EmailProvider | null;
  log: Logger;
  now(): Date;
}

/** HACKATHON_TESTNET has no USDC treasury: testnet TAZ never funds a payout, so nothing is reserved. */
export function usesTreasury(ctx: { env: Environment }): boolean {
  return ctx.env !== "testnet";
}

export const consoleLogger: Logger = {
  info: (o, m) => console.log(JSON.stringify({ level: "info", msg: m, ...(typeof o === "string" ? { msg: o } : o) })),
  warn: (o, m) => console.warn(JSON.stringify({ level: "warn", msg: m, ...(typeof o === "string" ? { msg: o } : o) })),
  error: (o, m) => console.error(JSON.stringify({ level: "error", msg: m, ...(typeof o === "string" ? { msg: o } : o) })),
};

export function buildContext(cfg: Config, opts: { db?: Db; log?: Logger; now?: () => Date; priceSources?: PriceSource[] } = {}): CoreContext {
  const env = cfg.environment;
  const db = opts.db ?? createPool(cfg.databaseUrl, { applicationName: `zeb-${env}` });
  const envelope = new Envelope(LocalKeyProvider.fromEnv(cfg.kms.keks, cfg.kms.activeKek));

  let oracle: ZecUsdOracle | null = null;
  if (env !== "demo") {
    const sources =
      opts.priceSources ??
      cfg.prices.sources.map((s) => {
        if (s === "coingecko") return new CoinGeckoSource({ apiKey: cfg.prices.coingeckoApiKey });
        if (s === "kraken") return new KrakenSource();
        throw new Error(`unknown price source ${s}`);
      });
    oracle = new ZecUsdOracle(sources, {
      minSources: Math.min(cfg.policy.priceMinSources, sources.length),
      maxAgeMs: cfg.policy.priceMaxAgeSec * 1000,
      maxDeviationBps: cfg.policy.priceMaxDeviationBps,
      maxBidAskSpreadBps: 200,
    });
  }

  let p2p: P2PClient | null = null;
  let p2pConfigError: string | null = env === "demo" ? null : "P2P provider not configured (P2P_DIAMOND_ADDRESS / P2P_SUBGRAPH_URL / BASE_RPC_URL)";
  if (cfg.p2p) {
    try {
      p2p = new P2PClient(
        validateP2PConfig({
          chainId: cfg.p2p.chainId,
          rpcUrl: cfg.p2p.rpcUrl,
          diamondAddress: cfg.p2p.diamondAddress,
          subgraphUrl: cfg.p2p.subgraphUrl,
          usdcAddress: cfg.p2p.usdcAddress,
          expectedDiamondCodeHash: cfg.p2p.diamondCodeHash,
        }),
      );
      p2pConfigError = null;
    } catch (e) {
      p2pConfigError = (e as Error).message;
    }
  }

  let gateway: ZcashGatewayClient | null = null;
  let zkool: ZkoolWatcher | null = null;
  let allocator: AddressAllocator | null = null;
  if (env === "demo") allocator = new DemoAddressAllocator(env);
  else if (cfg.zkool) {
    zkool = new ZkoolWatcher({ url: cfg.zkool.url, accountId: cfg.zkool.accountId, jwt: cfg.zkool.jwt, jwtFile: cfg.zkool.jwtFile, pools: cfg.zkool.pools, network: cfg.zkool.network, addressMode: cfg.zkool.addressMode, birthHeight: cfg.zkool.birthHeight });
    allocator = zkool;
  }
  else if (cfg.zcashGateway && cfg.zcashNetwork) {
    gateway = new ZcashGatewayClient({ url: cfg.zcashGateway.url, network: cfg.zcashNetwork, tls: cfg.zcashGateway.tls });
    allocator = gateway;
  }

  let email: EmailProvider | null = null;
  if (cfg.email.mode === "smtp") email = new SmtpEmailProvider({ url: cfg.email.url, from: cfg.email.from });
  else if (cfg.email.mode === "dev-file") email = new DevFileEmailProvider(cfg.email.dir, env);

  return {
    env,
    caps: environmentCapabilities(env),
    cfg,
    db,
    envelope,
    tokens: new ScopedTokenSigner(cfg.tokenSecret),
    oracle,
    p2p,
    p2pConfigError,
    allocator,
    gateway,
    zkool,
    email,
    log: opts.log ?? consoleLogger,
    now: opts.now ?? (() => new Date()),
  };
}
