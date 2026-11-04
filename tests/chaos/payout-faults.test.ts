/**
 * Fault injection for the payout executor: a scripted fake P2P executor drives the REAL payout
 * state machine, ledger, allocations and DB. Asserts the safety properties from spec §3/§10:
 *  - an ambiguous broadcast is never blindly resubmitted and never unlocks reserved credits
 *  - LP cancellation before escrow leads to a clean retry
 *  - cancellation after escrow posts a compensating escrow-return journal
 *  - an open dispute freezes the payout as `disputed`
 *  - a crashed worker's lease expires and another worker resumes the job
 */
import { afterEach, describe, expect, it } from "vitest";
import { claim, reconcile, SubmissionError, type OnchainOrder, type P2PExecutor, type SubmitHooks } from "@zeb/core";
import { Client, key, makeHarness, type Harness } from "../integration/harness";

type Script = {
  placeFails?: "ambiguous" | "definite";
  onGet?: (o: OnchainOrder, calls: number) => void;
};

class FakeExecutor implements P2PExecutor {
  readonly kind = "sdk" as const;
  readonly treasuryAddress = "0xfake";
  nonce = 0;
  confirmed = 0;
  orders = new Map<bigint, OnchainOrder>();
  gets = 0;
  nextId = 5000n;
  allowanceV = 0n;
  constructor(private script: Script) {}
  async placeOrder(a: { usdcAmount: bigint; fiatAmount6: bigint }, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    if (this.script.placeFails === "ambiguous") {
      this.confirmed = n + 1; // the chain consumed the nonce, but we never learned the hash
      throw new SubmissionError("receipt timeout", true, "RECEIPT_TIMEOUT");
    }
    if (this.script.placeFails === "definite") throw new SubmissionError("validation", false, "VALIDATION_ERROR");
    const id = this.nextId++;
    this.orders.set(id, {
      orderId: id,
      status: "placed",
      disputeStatus: "none",
      usdcAmount: a.usdcAmount,
      fiatAmount: a.fiatAmount6,
      actualUsdcAmount: a.usdcAmount + 50_000n,
      actualFiatAmount: 0n,
      fixedFeePaid: 50_000n,
      acceptedMerchant: "0xlp",
      pubkey: "",
      placedAt: BigInt(Math.floor(Date.now() / 1000)),
      acceptedAt: 0n,
      paidAt: 0n,
      completedAt: 0n,
      circleId: 1n,
    });
    const hash = `0x${id.toString(16).padStart(64, "0")}`;
    await hooks.onSubmitted(hash, n);
    this.confirmed = n + 1;
    return { hash, orderId: id };
  }
  async getOrder(id: bigint) {
    const o = this.orders.get(id)!;
    this.gets++;
    this.script.onGet?.(o, this.gets);
    return { ...o };
  }
  async approve(amount: bigint, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    this.allowanceV = amount;
    await hooks.onSubmitted(`0xapprove${n}`, n);
    this.confirmed = n + 1;
    return `0xapprove${n}`;
  }
  async allowance() {
    return this.allowanceV;
  }
  async setUpi(a: { orderId: bigint }, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    const o = this.orders.get(a.orderId)!;
    o.status = "paid";
    o.paidAt = BigInt(Math.floor(Date.now() / 1000));
    await hooks.onSubmitted(`0xupi${n}`, n);
    this.confirmed = n + 1;
    return `0xupi${n}`;
  }
  async cancel(id: bigint, hooks: SubmitHooks) {
    const n = this.nonce++;
    await hooks.beforeSend(n);
    this.orders.get(id)!.status = "cancelled";
    await hooks.onSubmitted(`0xcancel${n}`, n);
    return `0xcancel${n}`;
  }
  async receiptStatus() {
    return "success" as const;
  }
  async confirmedNonce() {
    return this.confirmed;
  }
  async findOrderByPlaceTx() {
    return null;
  }
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function paidScanPay(hh: Harness) {
  const c = new Client(hh.app);
  const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "40000", privacyPreference: "shielded" }, key: key() });
  const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "fault.test@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
  const s = await c.req("POST", `/api/v1/demo/checkout/${r.json.checkout.id}/simulate-deposit`, { body: { kind: "exact", confirmations: 3 }, key: key(), bearer: r.json.accessToken });
  expect(s.json.status).toBe("deposit_accepted");
  return { c, id: r.json.checkout.id as string, token: r.json.accessToken as string };
}

async function payoutStatus(hh: Harness, id: string) {
  return (await hh.db.query(`SELECT payout_status FROM payment_intents WHERE id=$1`, [id])).rows[0].payout_status as string;
}

describe("payout fault injection", () => {
  it("ambiguous placement broadcast → manual_review, never resubmitted", async () => {
    const fake = new FakeExecutor({ placeFails: "ambiguous" });
    h = await makeHarness({}, () => fake);
    const { id } = await paidScanPay(h);
    await h.runJobs(5);
    expect(await payoutStatus(h, id)).toBe("manual_review");
    expect(fake.nonce).toBe(1); // exactly one send attempt
    const exc = await h.db.query(`SELECT kind, severity FROM exceptions WHERE intent_id=$1`, [id]);
    expect(exc.rows).toContainEqual({ kind: "ambiguous_submission", severity: "urgent" });
    // USDC allocation still held: nothing released while state is ambiguous
    const alloc = await h.db.query(`SELECT state FROM treasury_allocations WHERE obligation_id=$1 AND state IN ('held','in_flight')`, [id]);
    expect(alloc.rowCount).toBe(1);
  });

  it("LP cancels before escrow → new attempt → completes", async () => {
    const fake = new FakeExecutor({
      onGet: (o, calls) => {
        if (o.orderId === 5000n && o.status === "placed") o.status = "cancelled";
        else if (o.orderId === 5001n && o.status === "placed") Object.assign(o, { status: "accepted", pubkey: "a".repeat(128) });
        else if (o.status === "paid" && calls > 0) Object.assign(o, { status: "completed", completedAt: BigInt(Math.floor(Date.now() / 1000)), actualFiatAmount: o.fiatAmount });
      },
    });
    h = await makeHarness({}, () => fake);
    const { id } = await paidScanPay(h);
    await h.runJobs(40);
    expect(await payoutStatus(h, id)).toBe("completed");
    const orders = await h.db.query(`SELECT attempt, status FROM p2p_orders WHERE intent_id=$1 ORDER BY attempt`, [id]);
    expect(orders.rows).toEqual([
      { attempt: 1, status: "cancelled_final" },
      { attempt: 2, status: "completed" },
    ]);
    const rec = await reconcile(h.ctx, "chaos");
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("cancellation after escrow posts an escrow-return journal and keeps the ledger balanced", async () => {
    // Order 5000: accepted → paid (observed once) → cancelled after escrow. Order 5001 completes.
    const paidReads = new Map<bigint, number>();
    const fake = new FakeExecutor({
      onGet: (o) => {
        if (o.status === "placed") Object.assign(o, { status: "accepted", pubkey: "b".repeat(128) });
        else if (o.status === "paid") {
          const n = (paidReads.get(o.orderId) ?? 0) + 1;
          paidReads.set(o.orderId, n);
          if (n < 2) return; // first read reports "paid" so escrow is recorded
          if (o.orderId === 5000n) o.status = "cancelled";
          else Object.assign(o, { status: "completed", completedAt: BigInt(Math.floor(Date.now() / 1000)), actualFiatAmount: o.fiatAmount });
        }
      },
    });
    h = await makeHarness({}, () => fake);
    const { id } = await paidScanPay(h);
    // run step by step so the "paid" state is observed before the cancellation
    for (let i = 0; i < 40; i++) await h.runJobs(1);
    const j = await h.db.query(`SELECT event_id FROM ledger_journals WHERE event_id LIKE 'escrow%' ORDER BY created_at`);
    const ids = j.rows.map((r) => r.event_id as string);
    expect(ids.some((e) => e.startsWith("escrow:"))).toBe(true);
    expect(ids.some((e) => e.startsWith("escrow_return:"))).toBe(true);
    expect(await payoutStatus(h, id)).toBe("completed");
    const rec = await reconcile(h.ctx, "chaos");
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("open dispute → disputed + urgent exception", async () => {
    const fake = new FakeExecutor({
      onGet: (o) => {
        if (o.status === "placed") Object.assign(o, { status: "accepted", pubkey: "c".repeat(128) });
        else if (o.status === "paid") o.disputeStatus = "open";
      },
    });
    h = await makeHarness({}, () => fake);
    const { id } = await paidScanPay(h);
    await h.runJobs(20);
    expect(await payoutStatus(h, id)).toBe("disputed");
    const exc = await h.db.query(`SELECT severity FROM exceptions WHERE intent_id=$1 AND kind='order_disputed'`, [id]);
    expect(exc.rows[0]?.severity).toBe("urgent");
  });

  it("a crashed worker's lease expires and another worker resumes", async () => {
    h = await makeHarness();
    const { id } = await paidScanPay(h);
    const jobs = await claim(h.ctx, "crashed-worker", 10);
    const payoutJob = jobs.find((j) => j.kind === "payout.advance");
    expect(payoutJob).toBeTruthy();
    // crashed: never finishes; lease expires
    await h.db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [payoutJob!.id]);
    await h.runJobs(30);
    expect(await payoutStatus(h, id)).toBe("completed");
  });

  it("definite (pre-broadcast) placement failure retries, then exhausts to refund_queued", async () => {
    const fake = new FakeExecutor({ placeFails: "definite" });
    h = await makeHarness({ MAX_PAYOUT_ATTEMPTS: "2" }, () => fake);
    const { id } = await paidScanPay(h);
    await h.runJobs(30);
    expect(await payoutStatus(h, id)).toBe("refund_queued");
    const exc = await h.db.query(`SELECT kind FROM exceptions WHERE intent_id=$1`, [id]);
    expect(exc.rows.map((r) => r.kind)).toContain("payout_attempts_exhausted");
  });
});
