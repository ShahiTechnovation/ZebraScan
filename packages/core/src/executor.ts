/**
 * P2P execution boundary used by the payout state machine.
 *  - SdkP2PExecutor: real @p2pdotme/sdk calls through a guarded wallet client (allowlist, explicit
 *    nonce, gas cap, hash persisted before return).
 *  - DemoP2PExecutor: DEMO ONLY simulated liquidity provider; every state it reports is persisted
 *    on the order row and every resulting event is labelled simulated. Refused outside `demo`.
 */
import type { Address, Hex, WalletClient } from "viem";
import { many, maybeOne, type Db } from "@zeb/db";
import { DomainError, type Environment } from "@zeb/domain";
import { guardedWalletClient, submissionAmbiguous, type GasPolicy, type P2PClient } from "@zeb/providers";

export interface OnchainOrder {
  orderId: bigint;
  status: "placed" | "accepted" | "paid" | "completed" | "cancelled";
  disputeStatus: "none" | "open" | "resolved";
  usdcAmount: bigint;
  fiatAmount: bigint;
  actualUsdcAmount: bigint;
  actualFiatAmount: bigint;
  fixedFeePaid: bigint;
  acceptedMerchant: string;
  pubkey: string;
  placedAt: bigint;
  acceptedAt: bigint;
  paidAt: bigint;
  completedAt: bigint;
  circleId: bigint;
}

export interface SubmitHooks {
  beforeSend(nonce: number): Promise<void>;
  onSubmitted(hash: string, nonce: number): Promise<void>;
}

export interface P2PExecutor {
  readonly kind: "sdk" | "demo";
  readonly treasuryAddress: string;
  placeOrder(a: { rowId: string; orderType: 1 | 2; usdcAmount: bigint; fiatAmount6: bigint }, hooks: SubmitHooks): Promise<{ hash: string; orderId: bigint | null }>;
  getOrder(orderId: bigint): Promise<OnchainOrder>;
  approve(amount: bigint, hooks: SubmitHooks): Promise<string>;
  allowance(): Promise<bigint>;
  setUpi(a: { orderId: bigint; paymentAddress: string; merchantPublicKey: string }, hooks: SubmitHooks): Promise<string>;
  cancel(orderId: bigint, hooks: SubmitHooks): Promise<string>;
  receiptStatus(hash: string): Promise<"success" | "reverted" | "pending">;
  /** Committed (latest-block) nonce of the treasury account. */
  confirmedNonce(): Promise<number>;
  /** Locate the order created by a mined place transaction (authoritative read after lookup). */
  findOrderByPlaceTx(hash: string, expect: { fiatAmount6: bigint }): Promise<bigint | null>;
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly ambiguous: boolean,
    public readonly code: string,
  ) {
    super(message);
  }
}

export class SdkP2PExecutor implements P2PExecutor {
  readonly kind = "sdk" as const;
  readonly treasuryAddress: string;
  constructor(
    private client: P2PClient,
    private signer: WalletClient,
    private gas: GasPolicy,
  ) {
    if (!signer.account) throw new DomainError("P2P_SIGNER_MISSING", "signer has no account");
    this.treasuryAddress = signer.account.address;
  }

  private wallet(hooks: SubmitHooks, purpose: string) {
    return guardedWalletClient(
      this.signer,
      this.client.cfg,
      this.client.publicClient,
      this.gas,
      { beforeSend: async ({ nonce }) => hooks.beforeSend(nonce), onSubmitted: async ({ hash, nonce }) => hooks.onSubmitted(hash, nonce) },
      purpose,
    );
  }

  private unwrap<T>(r: { isErr(): boolean; error?: { code: string; message: string }; value?: T }, what: string): T {
    if (r.isErr()) {
      const code = r.error!.code;
      throw new SubmissionError(`${what} failed: ${code}`, submissionAmbiguous(code), code);
    }
    return r.value as T;
  }

  async placeOrder(a: { orderType: 1 | 2; usdcAmount: bigint; fiatAmount6: bigint }, hooks: SubmitHooks) {
    const user = this.treasuryAddress as Address;
    const r = await this.client.orders.placeOrder.execute({
      walletClient: this.wallet(hooks, "placeOrder"),
      waitForReceipt: true,
      orderType: a.orderType,
      currency: "INR",
      user,
      recipientAddr: user,
      amount: a.usdcAmount,
      fiatAmount: a.fiatAmount6,
      fiatAmountLimit: 0n,
    });
    const v = this.unwrap(r, "placeOrder");
    return { hash: v.hash, orderId: v.meta?.orderId ?? null };
  }

  async getOrder(orderId: bigint): Promise<OnchainOrder> {
    const o = await this.client.getOrder(orderId);
    return { ...o, acceptedMerchant: o.acceptedMerchant, pubkey: o.pubkey };
  }

  async approve(amount: bigint, hooks: SubmitHooks) {
    const r = await this.client.orders.approveUsdc.execute({ walletClient: this.wallet(hooks, "approveUsdc"), waitForReceipt: true, amount });
    return this.unwrap(r, "approveUsdc").hash;
  }

  allowance() {
    return this.client.usdcAllowance(this.treasuryAddress as Address);
  }

  async setUpi(a: { orderId: bigint; paymentAddress: string; merchantPublicKey: string }, hooks: SubmitHooks) {
    const r = await this.client.orders.setSellOrderUpiWithFiat.execute({
      walletClient: this.wallet(hooks, "setSellOrderUpiWithFiat"),
      waitForReceipt: true,
      orderId: a.orderId,
      paymentAddress: a.paymentAddress,
      merchantPublicKey: a.merchantPublicKey,
      updatedFiatAmount: 0n, // keep the original fiat: the approved actualUsdcAmount stays exact
    });
    return this.unwrap(r, "setSellOrderUpiWithFiat").hash;
  }

  async cancel(orderId: bigint, hooks: SubmitHooks) {
    const r = await this.client.orders.cancelOrder.execute({ walletClient: this.wallet(hooks, "cancelOrder"), waitForReceipt: true, orderId });
    return this.unwrap(r, "cancelOrder").hash;
  }

  async receiptStatus(hash: string) {
    try {
      const rc = await this.client.publicClient.getTransactionReceipt({ hash: hash as Hex });
      return rc.status === "success" ? "success" : "reverted";
    } catch {
      return "pending";
    }
  }

  confirmedNonce() {
    return this.client.publicClient.getTransactionCount({ address: this.treasuryAddress as Address, blockTag: "latest" });
  }

  async findOrderByPlaceTx(_hash: string, expect: { fiatAmount6: bigint }) {
    // The SDK's receipt decode is best-effort. Fall back to the (advisory) subgraph, then confirm on chain.
    const r = await this.client.orders.getOrders({ userAddress: this.treasuryAddress as Address, skip: 0, limit: 20 });
    if (r.isErr()) return null;
    const candidates = r.value.filter((o) => o.fiatAmount === expect.fiatAmount6 && o.status === "placed");
    if (candidates.length !== 1) return null; // ambiguous or not indexed yet: never guess
    const onchain = await this.client.getOrder(candidates[0]!.orderId);
    return onchain.fiatAmount === expect.fiatAmount6 ? onchain.orderId : null;
  }
}

/* ------------------------------------------------------------------ demo */

interface DemoOrderState extends Omit<OnchainOrder, "orderId" | "usdcAmount" | "fiatAmount" | "actualUsdcAmount" | "actualFiatAmount" | "fixedFeePaid" | "placedAt" | "acceptedAt" | "paidAt" | "completedAt" | "circleId"> {
  orderId: string;
  usdcAmount: string;
  fiatAmount: string;
  actualUsdcAmount: string;
  fixedFeePaid: string;
  placedAt: number;
  acceptedAt: number;
  paidAt: number;
  completedAt: number;
}

export class DemoP2PExecutor implements P2PExecutor {
  readonly kind = "demo" as const;
  readonly treasuryAddress = "demo-treasury";
  private nonce = 0;
  constructor(
    private db: Db,
    env: Environment,
    private fee = 50_000n,
    private timing: { acceptAfterMs: number; completeAfterMs: number } = { acceptAfterMs: 2_000, completeAfterMs: 4_000 },
  ) {
    if (env !== "demo") throw new DomainError("SYSTEM_CONFIG", "DemoP2PExecutor is only permitted in the demo environment");
  }
  private async load(orderId: bigint): Promise<{ rowId: string; s: DemoOrderState }> {
    const row = await maybeOne<{ id: string; last_onchain: DemoOrderState }>(this.db, `SELECT id, last_onchain FROM p2p_orders WHERE environment='demo' AND onchain_order_id=$1`, [orderId.toString()]);
    if (!row?.last_onchain) throw new DomainError("P2P_ORDER_READ_FAILED", "demo order not found");
    return { rowId: row.id, s: row.last_onchain };
  }
  private async save(rowId: string, s: DemoOrderState) {
    await this.db.query(`UPDATE p2p_orders SET last_onchain=$2 WHERE id=$1`, [rowId, JSON.stringify(s)]);
  }
  async placeOrder(a: { rowId: string; usdcAmount: bigint; fiatAmount6: bigint }, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    const ids = await many<{ m: string | null }>(this.db, `SELECT max(onchain_order_id) AS m FROM p2p_orders WHERE environment='demo'`);
    const orderId = BigInt(ids[0]?.m ?? "1000") + 1n;
    const hash = `0xdemo${orderId.toString(16).padStart(60, "0")}`;
    const now = Date.now();
    const s: DemoOrderState = {
      orderId: orderId.toString(),
      status: "placed",
      disputeStatus: "none",
      usdcAmount: a.usdcAmount.toString(),
      fiatAmount: a.fiatAmount6.toString(),
      actualUsdcAmount: (a.usdcAmount + this.fee).toString(),
      fixedFeePaid: this.fee.toString(),
      acceptedMerchant: "demo-liquidity-provider",
      pubkey: "",
      placedAt: now,
      acceptedAt: 0,
      paidAt: 0,
      completedAt: 0,
    };
    await this.db.query(`UPDATE p2p_orders SET last_onchain=$2 WHERE id=$1`, [a.rowId, JSON.stringify(s)]);
    await hooks.onSubmitted(hash, n);
    return { hash, orderId };
  }
  async getOrder(orderId: bigint): Promise<OnchainOrder> {
    const { rowId, s } = await this.load(orderId);
    const now = Date.now();
    // Simulated LP: accepts ~2s after placement, completes ~4s after escrow.
    if (s.status === "placed" && now - s.placedAt >= this.timing.acceptAfterMs) Object.assign(s, { status: "accepted", acceptedAt: now, pubkey: "d".repeat(128) });
    else if (s.status === "paid" && now - s.paidAt >= this.timing.completeAfterMs) Object.assign(s, { status: "completed", completedAt: now });
    await this.save(rowId, s);
    return {
      orderId,
      status: s.status,
      disputeStatus: s.disputeStatus,
      usdcAmount: BigInt(s.usdcAmount),
      fiatAmount: BigInt(s.fiatAmount),
      actualUsdcAmount: BigInt(s.actualUsdcAmount),
      actualFiatAmount: s.status === "completed" ? BigInt(s.fiatAmount) : 0n,
      fixedFeePaid: BigInt(s.fixedFeePaid),
      acceptedMerchant: s.acceptedMerchant,
      pubkey: s.pubkey,
      placedAt: BigInt(Math.floor(s.placedAt / 1000)),
      acceptedAt: BigInt(Math.floor(s.acceptedAt / 1000)),
      paidAt: BigInt(Math.floor(s.paidAt / 1000)),
      completedAt: BigInt(Math.floor(s.completedAt / 1000)),
      circleId: 0n,
    };
  }
  private demoAllowance = 0n;
  async approve(amount: bigint, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    this.demoAllowance = amount;
    const hash = `0xdemoapprove${n.toString(16).padStart(53, "0")}`;
    await hooks.onSubmitted(hash, n);
    return hash;
  }
  async allowance() {
    return this.demoAllowance;
  }
  async setUpi(a: { orderId: bigint }, hooks: SubmitHooks) {
    const { rowId, s } = await this.load(a.orderId);
    if (s.status !== "accepted") throw new SubmissionError("demo order not accepted", false, "ORDER_NOT_ACCEPTED");
    const n = this.nonce++;
    await hooks.beforeSend(n);
    Object.assign(s, { status: "paid", paidAt: Date.now() });
    await this.save(rowId, s);
    const hash = `0xdemoupi${n.toString(16).padStart(57, "0")}`;
    await hooks.onSubmitted(hash, n);
    return hash;
  }
  async cancel(orderId: bigint, hooks: SubmitHooks) {
    const { rowId, s } = await this.load(orderId);
    const n = this.nonce++;
    await hooks.beforeSend(n);
    s.status = "cancelled";
    await this.save(rowId, s);
    const hash = `0xdemocancel${n.toString(16).padStart(54, "0")}`;
    await hooks.onSubmitted(hash, n);
    return hash;
  }
  async receiptStatus() {
    return "success" as const;
  }
  async confirmedNonce() {
    return this.nonce;
  }
  async findOrderByPlaceTx() {
    return null;
  }
}
