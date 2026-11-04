/**
 * P2P.me adapter on Base — wraps @p2pdotme/sdk@1.3.10 (pinned exactly; see
 * docs/EXTERNAL_DEPENDENCY_VERIFICATION.md). Mechanics follow the official examples
 * example/make-pay-order.ts and example/make-sell-order.ts:
 *   1. placeOrder (orderType 2=PAY, 1=SELL) — pulls NO USDC
 *   2. getOrder -> actualUsdcAmount (includes small-order fixed fee); approve exactly that
 *      (approving less makes setSellOrderUpiWithFiat revert and the Diamond CANCELS the order)
 *   3. wait for status "accepted" and the merchant pubkey
 *   4. setSellOrderUpiWithFiat(updatedFiatAmount=0n) — ECIES-encrypts the UPI id, pulls USDC to escrow
 *   5. LP pays INR off-chain and completes; on-chain "completed" is LP-asserted, not bank proof
 *
 * NOTHING here hardcodes a Diamond address or subgraph URL. Those must come from the provider
 * (verified) via configuration; preflight() refuses to run otherwise.
 */
import { createOrders, type Order, type OrdersClient, type RelayIdentity, type RelayIdentityStore } from "@p2pdotme/sdk/orders";
import { createPrices } from "@p2pdotme/sdk/prices";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { DomainError } from "@zeb/domain";

/** Circle native USDC (NOT USDbC). Source: developers.circle.com/stablecoins/usdc-contract-addresses (verified 2026-11-04). */
export const CIRCLE_USDC: Record<number, Address> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
export const CHAINS: Record<number, Chain> = { 8453: base, 84532: baseSepolia };

export const ORDER_TYPE = { BUY: 0, SELL: 1, PAY: 2 } as const;

export interface P2PConfig {
  chainId: 8453 | 84532;
  rpcUrl: string;
  diamondAddress: string;
  subgraphUrl: string;
  usdcAddress: string;
  /** keccak256 of the Diamond's deployed bytecode, as verified with the provider. Optional but recommended. */
  expectedDiamondCodeHash?: string;
}

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export function validateP2PConfig(raw: Partial<Record<keyof P2PConfig, string | number | undefined>>): P2PConfig {
  const problems: string[] = [];
  const chainId = Number(raw.chainId);
  if (chainId !== 8453 && chainId !== 84532) problems.push("P2P_CHAIN_ID must be 8453 (Base) or 84532 (Base Sepolia)");
  const addr = (k: string, v: unknown) => {
    if (typeof v !== "string" || !isAddress(v)) problems.push(`${k} must be a checksummed 0x address`);
    else if (/^0x0{40}$/i.test(v)) problems.push(`${k} must not be the zero address`);
  };
  addr("P2P_DIAMOND_ADDRESS", raw.diamondAddress);
  addr("P2P_USDC_ADDRESS", raw.usdcAddress);
  if (typeof raw.subgraphUrl !== "string" || !/^https:\/\//.test(raw.subgraphUrl) || /example\.com/.test(raw.subgraphUrl)) problems.push("P2P_SUBGRAPH_URL must be the provider's https subgraph endpoint");
  if (typeof raw.rpcUrl !== "string" || !/^https?:\/\//.test(raw.rpcUrl)) problems.push("BASE_RPC_URL must be an http(s) URL");
  if (!problems.length && CIRCLE_USDC[chainId]!.toLowerCase() !== String(raw.usdcAddress).toLowerCase()) {
    problems.push(`P2P_USDC_ADDRESS does not match Circle native USDC for chain ${chainId} (${CIRCLE_USDC[chainId]})`);
  }
  if (problems.length) throw new DomainError("P2P_CONFIG_INVALID", "P2P configuration is incomplete or invalid", { problems });
  return {
    chainId: chainId as 8453 | 84532,
    rpcUrl: String(raw.rpcUrl),
    diamondAddress: getAddress(String(raw.diamondAddress)),
    subgraphUrl: String(raw.subgraphUrl),
    usdcAddress: getAddress(String(raw.usdcAddress)),
    expectedDiamondCodeHash: raw.expectedDiamondCodeHash ? String(raw.expectedDiamondCodeHash) : undefined,
  };
}

export interface PreflightReport {
  ok: boolean;
  chainId: number | null;
  diamondHasCode: boolean;
  diamondCodeHash: string | null;
  diamondCodeHashMatches: boolean | null;
  usdcSymbol: string | null;
  usdcDecimals: number | null;
  sellPrice6: string | null;
  feeConfig: { smallOrderThreshold: string; smallOrderFixedFeePay: string; smallOrderFixedFeeSell: string } | null;
  treasury: { address: string; usdcMicros: string; allowanceMicros: string; ethWei: string } | null;
  placementLimits: unknown;
  problems: string[];
  checkedAt: string;
}

export class P2PClient {
  readonly publicClient: PublicClient;
  readonly orders: OrdersClient;
  private prices;
  constructor(
    readonly cfg: P2PConfig,
    relayIdentityStore?: RelayIdentityStore,
  ) {
    this.publicClient = createPublicClient({ chain: CHAINS[cfg.chainId], transport: http(cfg.rpcUrl, { timeout: 15_000, retryCount: 2 }) }) as PublicClient;
    this.orders = createOrders({
      publicClient: this.publicClient,
      diamondAddress: cfg.diamondAddress as Address,
      usdcAddress: cfg.usdcAddress as Address,
      subgraphUrl: cfg.subgraphUrl,
      relayIdentityStore,
    });
    this.prices = createPrices({ publicClient: this.publicClient, diamondAddress: cfg.diamondAddress as Address });
  }

  async sellPrice6(): Promise<bigint> {
    const r = await this.prices.getPriceConfig({ currency: "INR" });
    if (r.isErr()) throw new DomainError("P2P_PRICE_UNAVAILABLE", `P2P price read failed: ${r.error.code}`, undefined, { retryable: true });
    if (r.value.sellPrice <= 0n) throw new DomainError("P2P_PRICE_UNAVAILABLE", "P2P INR sell price is zero", undefined, { retryable: true });
    return r.value.sellPrice;
  }

  async feeConfig() {
    const r = await this.orders.getFeeConfig({ currency: "INR" });
    if (r.isErr()) throw new DomainError("P2P_FEE_UNAVAILABLE", `P2P fee config read failed: ${r.error.code}`, undefined, { retryable: true });
    return r.value;
  }

  /** Authoritative on-chain read (Diamond). */
  async getOrder(orderId: bigint): Promise<Order> {
    const r = await this.orders.getOrder({ orderId });
    if (r.isErr()) throw new DomainError("P2P_ORDER_READ_FAILED", `getOrder failed: ${r.error.code}`, { orderId: orderId.toString() }, { retryable: true });
    return r.value;
  }

  async usdcBalance(owner: Address): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.cfg.usdcAddress as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] })) as bigint;
  }
  async usdcAllowance(owner: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.cfg.usdcAddress as Address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, this.cfg.diamondAddress as Address],
    })) as bigint;
  }

  async preflight(treasuryAddress?: Address): Promise<PreflightReport> {
    const problems: string[] = [];
    const rep: PreflightReport = {
      ok: false,
      chainId: null,
      diamondHasCode: false,
      diamondCodeHash: null,
      diamondCodeHashMatches: null,
      usdcSymbol: null,
      usdcDecimals: null,
      sellPrice6: null,
      feeConfig: null,
      treasury: null,
      placementLimits: null,
      problems,
      checkedAt: new Date().toISOString(),
    };
    try {
      rep.chainId = await this.publicClient.getChainId();
      if (rep.chainId !== this.cfg.chainId) problems.push(`RPC chain ${rep.chainId} != configured ${this.cfg.chainId}`);
      const code = await this.publicClient.getCode({ address: this.cfg.diamondAddress as Address });
      rep.diamondHasCode = !!code && code !== "0x";
      if (!rep.diamondHasCode) problems.push("no contract code at P2P_DIAMOND_ADDRESS");
      else {
        rep.diamondCodeHash = keccak256(code as Hex);
        if (this.cfg.expectedDiamondCodeHash) {
          rep.diamondCodeHashMatches = rep.diamondCodeHash.toLowerCase() === this.cfg.expectedDiamondCodeHash.toLowerCase();
          if (!rep.diamondCodeHashMatches) problems.push("Diamond code hash differs from the verified value");
        }
      }
      rep.usdcSymbol = (await this.publicClient.readContract({ address: this.cfg.usdcAddress as Address, abi: ERC20_ABI, functionName: "symbol" })) as string;
      rep.usdcDecimals = Number(await this.publicClient.readContract({ address: this.cfg.usdcAddress as Address, abi: ERC20_ABI, functionName: "decimals" }));
      if (rep.usdcSymbol !== "USDC" || rep.usdcDecimals !== 6) problems.push(`USDC token reports ${rep.usdcSymbol}/${rep.usdcDecimals}, expected USDC/6`);
      if (rep.diamondHasCode) {
        rep.sellPrice6 = (await this.sellPrice6().catch((e: Error) => (problems.push(e.message), null)))?.toString() ?? null;
        const fee = await this.feeConfig().catch((e: Error) => (problems.push(e.message), null));
        if (fee)
          rep.feeConfig = {
            smallOrderThreshold: fee.smallOrderThreshold.toString(),
            smallOrderFixedFeePay: fee.smallOrderFixedFeePay.toString(),
            smallOrderFixedFeeSell: fee.smallOrderFixedFeeSell.toString(),
          };
      }
      if (treasuryAddress) {
        const [u, a, e] = await Promise.all([
          this.usdcBalance(treasuryAddress),
          rep.diamondHasCode ? this.usdcAllowance(treasuryAddress) : Promise.resolve(0n),
          this.publicClient.getBalance({ address: treasuryAddress }),
        ]);
        rep.treasury = { address: treasuryAddress, usdcMicros: u.toString(), allowanceMicros: a.toString(), ethWei: e.toString() };
        if (e === 0n) problems.push("treasury signer has no ETH for gas");
        if (rep.diamondHasCode) {
          const lim = await this.orders.getPlacementLimits({ userAddress: treasuryAddress });
          // Advisory only (subgraph, lags; cancelled placements may count). Diamond/RPC is authority.
          rep.placementLimits = lim.isOk() ? JSON.parse(JSON.stringify(lim.value)) : { error: lim.error.code };
        }
      }
    } catch (e) {
      problems.push(`preflight error: ${(e as Error).message.slice(0, 200)}`);
    }
    rep.ok = problems.length === 0;
    return rep;
  }
}

/* ------------------------------------------------------------------ guarded execution */

export interface SubmissionHooks {
  /** Persist the nonce about to be used BEFORE broadcasting: a crash mid-send is then detectable from chain state. */
  beforeSend(info: { nonce: number; to: Address; purpose: string }): Promise<void>;
  /** Persist BEFORE the hash is returned to the SDK: an ambiguous broadcast stays recoverable. */
  onSubmitted(info: { hash: Hex; to: Address; nonce: number; purpose: string }): Promise<void>;
}

export interface GasPolicy {
  maxFeePerGasWei: bigint;
  maxGasPerTx: bigint;
}

/**
 * Wrap a signer so the SDK can only send zero-value transactions to the Diamond or the USDC
 * token on the configured chain, with an explicit nonce and a gas ceiling.
 */
export function guardedWalletClient(inner: WalletClient, cfg: P2PConfig, pub: PublicClient, gas: GasPolicy, hooks: SubmissionHooks, purpose: string): WalletClient {
  const allow = new Set([cfg.diamondAddress.toLowerCase(), cfg.usdcAddress.toLowerCase()]);
  const account = inner.account as Account | undefined;
  if (!account) throw new DomainError("P2P_SIGNER_MISSING", "signer has no account");
  const sendTransaction = async (args: { to?: Address | null; data?: Hex; value?: bigint }) => {
    if (!args.to || !allow.has(args.to.toLowerCase())) throw new DomainError("P2P_ALLOWLIST", `refusing to send to non-allowlisted address`);
    if (args.value && args.value !== 0n) throw new DomainError("P2P_ALLOWLIST", "refusing to send native value");
    const chainId = await pub.getChainId();
    if (chainId !== cfg.chainId) throw new DomainError("P2P_CHAIN_MISMATCH", `RPC chain ${chainId} != ${cfg.chainId}`);
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const est = await pub.estimateGas({ account, to: args.to, data: args.data, value: 0n });
    const gasLimit = (est * 12n) / 10n;
    if (gasLimit > gas.maxGasPerTx) throw new DomainError("P2P_GAS_CAP", `gas ${gasLimit} exceeds cap`);
    const fees = await pub.estimateFeesPerGas();
    if ((fees.maxFeePerGas ?? 0n) > gas.maxFeePerGasWei) throw new DomainError("P2P_GAS_PRICE_CAP", "gas price above policy cap", undefined, { retryable: true });
    await hooks.beforeSend({ nonce, to: args.to, purpose });
    const hash = await inner.sendTransaction({
      account,
      chain: CHAINS[cfg.chainId],
      to: args.to,
      data: args.data,
      value: 0n,
      nonce,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    await hooks.onSubmitted({ hash, to: args.to, nonce, purpose });
    return hash;
  };
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "sendTransaction") return sendTransaction;
      if (prop === "chain") return CHAINS[cfg.chainId];
      return Reflect.get(target, prop, recv);
    },
  });
}

/* ------------------------------------------------------------------ relay identity persistence */

/** SDK relay identity persisted encrypted (the SDK default is in-memory, lost on restart). */
export function persistentRelayStore(io: { load(): Promise<string | null>; save(json: string): Promise<void> }): RelayIdentityStore {
  return {
    async get() {
      const raw = await io.load();
      return raw ? (JSON.parse(raw) as RelayIdentity) : null;
    },
    async set(identity) {
      await io.save(JSON.stringify(identity));
    },
  };
}

/** Classify an SDK OrdersError: may the transaction have been broadcast? */
export function submissionAmbiguous(code: string): boolean {
  // RECEIPT_TIMEOUT / TX_REVERTED / EVENT_WATCH_FAILED happen AFTER broadcast; TX_SUBMISSION_FAILED may also
  // follow a broadcast if the RPC dropped the response. Only validation/read errors are definitely pre-broadcast.
  return !["VALIDATION_ERROR", "CONTRACT_READ_FAILED", "SUBGRAPH_REQUEST_FAILED", "SUBGRAPH_VALIDATION_FAILED", "CIRCLE_SELECTION_FAILED", "ENCRYPTION_FAILED", "RELAY_IDENTITY_CORRUPT", "RELAY_IDENTITY_STORE_FAILED", "INVALID_ORDER_ID"].includes(code);
}
