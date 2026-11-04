/**
 * Payout state machine driver (worker job "payout.advance"). Re-entrant and idempotent: every run
 * re-reads authoritative state (DB row + on-chain getOrder) and moves at most a few steps.
 *
 * Invariants:
 *  - The p2p_orders row is committed BEFORE any broadcast; the intended nonce is persisted before
 *    sending and the hash right after. A crash mid-send is resolved from chain nonce state; a
 *    possibly-broadcast transaction is NEVER blindly resubmitted (-> manual_review).
 *  - Approve exactly order.actualUsdcAmount (incl. small-order fee), never less than the order
 *    amount, never more than the treasury allocation.
 *  - Reserved merchant credits are restored only after the chain shows the order cancelled with no
 *    escrow outstanding.
 *  - On-chain "completed" is LP-asserted; we additionally wait out the dispute window and check
 *    fiat/USDC amounts before marking completed. It is never described as a bank credit.
 */
import { maybeOne, one, tx, type Tx } from "@zeb/db";
import { DomainError, newId, PAISE_TO_P2P_FIAT, payoutMachine, usdcForInr, withdrawalMachine, type PayoutStatus, type WithdrawalStatus } from "@zeb/domain";
import { postJournal, reverseJournal, treasury } from "@zeb/ledger";
import type { CoreContext } from "./context";
import { emitResource, raiseException } from "./events";
import { SubmissionError, type OnchainOrder, type P2PExecutor } from "./executor";
import { readP2P } from "./rates";
import { finalizeWithdrawal, restoreWithdrawal, transitionWithdrawal, type WithdrawalRow } from "./withdrawals";

export type PayoutKind = "scan_pay" | "withdrawal";
type Next = { rerunInMs: number | null };

interface OrderRow {
  id: string;
  attempt: number;
  status: string;
  onchain_order_id: string | null;
  place_tx_hash: string | null;
  approve_tx_hash: string | null;
  set_upi_tx_hash: string | null;
  submit_nonce: string | null;
  fiat_amount6: string;
  usdc_amount_micros: string;
  actual_usdc_micros: string | null;
  recipient_vpa_ct: string;
  created_at: Date;
  updated_at: Date;
  last_onchain: unknown;
  provider_proof: unknown;
}

/* ------------------------------------------------------------------ subject abstraction */

interface Subject {
  kind: PayoutKind;
  id: string;
  status: string;
  inrPaise: bigint; // fiat to deliver
  allocationMicros: bigint;
  vpaCiphertext: string;
  vpaAad: string;
  resource: string;
}

const PATH = ["order_placing", "placed", "merchant_accepted", "usdc_escrowed", "inr_processing", "provider_completed"] as const;

async function loadSubject(t: Tx, ctx: CoreContext, kind: PayoutKind, id: string): Promise<Subject> {
  if (kind === "scan_pay") {
    const i = await one<{ id: string; payout_status: string; quote_id: string; recipient_vpa_ct: string }>(t, `SELECT id, payout_status, quote_id, recipient_vpa_ct FROM payment_intents WHERE id=$1 AND environment=$2 FOR UPDATE`, [id, ctx.env]);
    const q = await one<{ inr_paise: string }>(t, `SELECT inr_paise FROM quotes WHERE id=$1`, [i.quote_id]);
    const alloc = await treasury.activeAllocation(t, ctx.env, id);
    return { kind, id, status: i.payout_status, inrPaise: BigInt(q.inr_paise), allocationMicros: BigInt(alloc?.amount_micros ?? "0"), vpaCiphertext: i.recipient_vpa_ct, vpaAad: `payment_intents:${id}:recipient_vpa`, resource: `checkout:${id}` };
  }
  const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 AND environment=$2 FOR UPDATE`, [id, ctx.env]);
  const d = await one<{ id: string; vpa_ct: string }>(t, `SELECT id, vpa_ct FROM payout_destinations WHERE id=$1`, [w.payout_destination_id]);
  const alloc = await treasury.activeAllocation(t, ctx.env, id);
  return { kind, id, status: w.status, inrPaise: BigInt(w.payout_inr_paise), allocationMicros: BigInt(alloc?.amount_micros ?? "0"), vpaCiphertext: d.vpa_ct, vpaAad: `payout_destinations:${d.id}:vpa`, resource: `withdrawal:${id}` };
}

async function setSubject(t: Tx, ctx: CoreContext, s: Subject, to: string, label: string, detail?: string, set: Record<string, unknown> = {}) {
  if (s.status === to) return;
  if (s.kind === "scan_pay") {
    payoutMachine.assert(s.status as PayoutStatus, to as PayoutStatus, { intentId: s.id });
    await t.query(`UPDATE payment_intents SET payout_status=$2, updated_at=now(), status_version=status_version+1 WHERE id=$1`, [s.id, to]);
    await emitResource(t, ctx.env, s.resource, `payout.${to}`, { label, ...(detail ? { detail } : {}), simulated: ctx.env === "demo" });
  } else {
    const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1`, [s.id]);
    await transitionWithdrawal(t, ctx, w, to as WithdrawalStatus, label, detail, set);
  }
  s.status = to;
}

/** Walk the canonical path one legal step at a time (we may observe several on-chain steps at once). */
async function walkTo(t: Tx, ctx: CoreContext, s: Subject, target: (typeof PATH)[number], label: string, detail?: string) {
  const machine = s.kind === "scan_pay" ? payoutMachine : withdrawalMachine;
  const from = PATH.indexOf(s.status as (typeof PATH)[number]);
  const to = PATH.indexOf(target);
  if (from === -1) {
    // Off the happy path (e.g. cancel_requested, provider_timeout): jump only if the machine allows it.
    if ((machine.can as (a: string, b: string) => boolean)(s.status, target)) await setSubject(t, ctx, s, target, label, detail);
    return;
  }
  for (let k = from + 1; k <= to; k++) await setSubject(t, ctx, s, PATH[k]!, k === to ? label : `Order ${PATH[k]!.replace(/_/g, " ")}`, k === to ? detail : undefined);
}

/* ------------------------------------------------------------------ entry */

export async function advancePayout(ctx: CoreContext, exec: P2PExecutor | null, kind: PayoutKind, id: string): Promise<Next> {
  const pre = await tx(ctx.db, async (t) => {
    const s = await loadSubject(t, ctx, kind, id);
    const order = await maybeOne<OrderRow>(t, `SELECT * FROM p2p_orders WHERE ${kind === "scan_pay" ? "intent_id" : "withdrawal_id"}=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`, [id]);
    return { s, order };
  });
  const terminal = kind === "scan_pay" ? ["completed", "refund_queued", "manual_review", "disputed", "not_started"] : ["completed", "cancelled", "manual_review", "disputed", "failed_recoverable", "requested", "funds_reserved"];
  if (terminal.includes(pre.s.status)) return { rerunInMs: null };
  if (!exec) {
    await tx(ctx.db, (t) => raiseException(t, ctx.env, { kind: "payout_executor_unavailable", severity: "warning", ...(kind === "scan_pay" ? { intentId: id } : { withdrawalId: id }), details: { reason: ctx.p2pConfigError ?? "no signer" } }));
    return { rerunInMs: 300_000 };
  }

  const order = pre.order;
  // Withdrawal cancellation requested before any order: restore immediately.
  if (kind === "withdrawal" && pre.s.status === "cancel_requested" && (!order || (!order.place_tx_hash && !order.submit_nonce))) {
    await tx(ctx.db, async (t) => {
      const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [id]);
      await restoreWithdrawal(t, ctx, w, "cancelled before order placement");
    });
    return { rerunInMs: null };
  }

  if (!order || order.status === "cancelled_final" || order.status === "failed_final") return startAttempt(ctx, exec, pre.s, (order?.attempt ?? 0) + 1);
  if (!order.onchain_order_id) return resolvePlacement(ctx, exec, pre.s, order);
  return trackOrder(ctx, exec, pre.s, order);
}

/* ------------------------------------------------------------------ placement */

async function startAttempt(ctx: CoreContext, exec: P2PExecutor, s: Subject, attempt: number): Promise<Next> {
  if (attempt > ctx.cfg.policy.maxPayoutAttempts) {
    await tx(ctx.db, async (t) => {
      const cur = await loadSubject(t, ctx, s.kind, s.id);
      if (s.kind === "scan_pay") await setSubject(t, ctx, cur, "refund_queued", "Payout failed — refund queued", "No liquidity provider completed the INR payout. Your ZEC will be refunded after review.");
      else await setSubject(t, ctx, cur, "failed_recoverable", "Payout attempts exhausted", "Reserved credits stay reserved until an operator confirms no funds are in flight.", { failure_reason: "attempts_exhausted" });
      await raiseException(t, ctx.env, { kind: "payout_attempts_exhausted", severity: "urgent", ...(s.kind === "scan_pay" ? { intentId: s.id } : { withdrawalId: s.id }) });
    });
    return { rerunInMs: null };
  }
  const p2p = await readP2P(ctx);
  const usdc = usdcForInr(s.inrPaise, p2p.sellPrice6);
  const fiat6 = s.inrPaise * PAISE_TO_P2P_FIAT;
  if (usdc > s.allocationMicros) {
    await tx(ctx.db, async (t) => {
      const cur = await loadSubject(t, ctx, s.kind, s.id);
      await setSubject(t, ctx, cur, s.kind === "scan_pay" ? "not_liquid" : "failed_recoverable", "Price moved beyond the reserved buffer", "Held for treasury review.");
      await raiseException(t, ctx.env, { kind: "payout_price_exceeds_allocation", severity: "warning", ...(s.kind === "scan_pay" ? { intentId: s.id } : { withdrawalId: s.id }), details: { need: usdc.toString(), allocated: s.allocationMicros.toString() } });
    });
    return { rerunInMs: null };
  }
  const rowId = newId("order");
  const cfg = ctx.p2p?.cfg;
  await tx(ctx.db, async (t) => {
    const cur = await loadSubject(t, ctx, s.kind, s.id);
    if (cur.kind === "scan_pay" && cur.status !== "payout_queued") await setSubject(t, ctx, cur, "payout_queued", "Retrying payout");
    if (cur.kind === "withdrawal" && cur.status === "failed_recoverable") await setSubject(t, ctx, cur, "awaiting_provider", "Retrying payout");
    await t.query(
      `INSERT INTO p2p_orders(id, environment, purpose, intent_id, withdrawal_id, attempt, order_type_code, chain_id, diamond_address, usdc_address, status, fiat_amount6, usdc_amount_micros, recipient_vpa_ct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'order_placing',$11,$12,$13)`,
      [rowId, ctx.env, s.kind, s.kind === "scan_pay" ? s.id : null, s.kind === "withdrawal" ? s.id : null, attempt, s.kind === "scan_pay" ? 2 : 1, cfg?.chainId ?? 0, cfg?.diamondAddress ?? "demo", cfg?.usdcAddress ?? "demo", fiat6.toString(), usdc.toString(), s.vpaCiphertext],
    );
    await setSubject(t, ctx, cur, "order_placing", "Placing P2P order", `${s.kind === "scan_pay" ? "PAY" : "SELL"} order, attempt ${attempt}`);
  });
  const row = await one<OrderRow>(ctx.db, `SELECT * FROM p2p_orders WHERE id=$1`, [rowId]);
  return submitPlacement(ctx, exec, s, row);
}

function hooksFor(ctx: CoreContext, rowId: string, field: "place_tx_hash" | "approve_tx_hash" | "set_upi_tx_hash" | "cancel") {
  return {
    beforeSend: async (nonce: number) => {
      await ctx.db.query(`UPDATE p2p_orders SET submit_nonce=$2, updated_at=now() WHERE id=$1`, [rowId, nonce]);
    },
    onSubmitted: async (hash: string) => {
      if (field === "cancel") await ctx.db.query(`UPDATE p2p_orders SET provider_proof = coalesce(provider_proof,'{}'::jsonb) || jsonb_build_object('cancel_tx', $2::text), updated_at=now() WHERE id=$1`, [rowId, hash]);
      else await ctx.db.query(`UPDATE p2p_orders SET ${field}=$2, submit_nonce=NULL, updated_at=now() WHERE id=$1`, [rowId, hash]);
    },
  };
}

async function submitPlacement(ctx: CoreContext, exec: P2PExecutor, s: Subject, row: OrderRow): Promise<Next> {
  try {
    const r = await exec.placeOrder({ rowId: row.id, orderType: s.kind === "scan_pay" ? 2 : 1, usdcAmount: BigInt(row.usdc_amount_micros), fiatAmount6: BigInt(row.fiat_amount6) }, hooksFor(ctx, row.id, "place_tx_hash"));
    if (r.orderId !== null) await ctx.db.query(`UPDATE p2p_orders SET onchain_order_id=$2, status='placed', updated_at=now() WHERE id=$1`, [row.id, r.orderId.toString()]);
    return { rerunInMs: 1_000 };
  } catch (e) {
    const ambiguous = e instanceof SubmissionError ? e.ambiguous : true;
    if (!ambiguous) {
      await tx(ctx.db, async (t) => {
        await t.query(`UPDATE p2p_orders SET status='failed_final', failure_reason=$2, submit_nonce=NULL, updated_at=now() WHERE id=$1`, [row.id, (e as Error).message.slice(0, 300)]);
        const cur = await loadSubject(t, ctx, s.kind, s.id);
        await setSubject(t, ctx, cur, s.kind === "scan_pay" ? "provider_failed" : "failed_recoverable", "Order placement failed", "Nothing was broadcast; will retry.");
      });
      return { rerunInMs: 30_000 };
    }
    // Possibly broadcast: resolve from chain on the next run.
    await ctx.db.query(`UPDATE p2p_orders SET failure_reason=$2, updated_at=now() WHERE id=$1`, [row.id, `ambiguous: ${(e as Error).message.slice(0, 280)}`]);
    return { rerunInMs: 15_000 };
  }
}

async function toManualReview(ctx: CoreContext, s: Subject, row: OrderRow, kind: string, detail: string) {
  await tx(ctx.db, async (t) => {
    const cur = await loadSubject(t, ctx, s.kind, s.id);
    if (cur.status !== "manual_review") await setSubject(t, ctx, cur, "manual_review", "Under manual review", detail);
    await raiseException(t, ctx.env, { kind, severity: "urgent", orderId: row.id, ...(s.kind === "scan_pay" ? { intentId: s.id } : { withdrawalId: s.id }), details: { detail } });
  });
  return { rerunInMs: null };
}

async function resolvePlacement(ctx: CoreContext, exec: P2PExecutor, s: Subject, row: OrderRow): Promise<Next> {
  if (!row.place_tx_hash) {
    if (row.submit_nonce === null) return submitPlacement(ctx, exec, s, row);
    // A send was started. If the chain has consumed that nonce, a tx we cannot identify was mined.
    const confirmed = await exec.confirmedNonce();
    if (confirmed > Number(row.submit_nonce)) return toManualReview(ctx, s, row, "ambiguous_submission", "A placement transaction may have been broadcast without a recorded hash.");
    if (Date.now() - new Date(row.updated_at).getTime() < 120_000) return { rerunInMs: 20_000 }; // may still be in the mempool
    await ctx.db.query(`UPDATE p2p_orders SET submit_nonce=NULL WHERE id=$1`, [row.id]);
    return submitPlacement(ctx, exec, s, { ...row, submit_nonce: null });
  }
  const st = await exec.receiptStatus(row.place_tx_hash);
  if (st === "pending") {
    if (Date.now() - new Date(row.updated_at).getTime() > 15 * 60_000) return toManualReview(ctx, s, row, "placement_tx_stuck", "Placement transaction not mined after 15 minutes.");
    return { rerunInMs: 10_000 };
  }
  if (st === "reverted") {
    // placeOrder pulls no USDC: a revert moved no funds.
    await tx(ctx.db, async (t) => {
      await t.query(`UPDATE p2p_orders SET status='failed_final', failure_reason='place reverted', updated_at=now() WHERE id=$1`, [row.id]);
      const cur = await loadSubject(t, ctx, s.kind, s.id);
      await setSubject(t, ctx, cur, s.kind === "scan_pay" ? "provider_failed" : "failed_recoverable", "Order placement reverted", "No funds moved; will retry.");
    });
    return { rerunInMs: 30_000 };
  }
  const orderId = await exec.findOrderByPlaceTx(row.place_tx_hash, { fiatAmount6: BigInt(row.fiat_amount6) });
  if (orderId === null) {
    if (Date.now() - new Date(row.updated_at).getTime() < 10 * 60_000) return { rerunInMs: 30_000 }; // subgraph lag
    return toManualReview(ctx, s, row, "order_id_unresolved", "Order was placed on chain but its id could not be determined unambiguously.");
  }
  await ctx.db.query(`UPDATE p2p_orders SET onchain_order_id=$2, status='placed', updated_at=now() WHERE id=$1`, [row.id, orderId.toString()]);
  return { rerunInMs: 1_000 };
}

/* ------------------------------------------------------------------ tracking */

function snapshot(o: OnchainOrder) {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function trackOrder(ctx: CoreContext, exec: P2PExecutor, s: Subject, row: OrderRow): Promise<Next> {
  const orderId = BigInt(row.onchain_order_id!);
  const o = await exec.getOrder(orderId);
  if (ctx.env !== "demo") await ctx.db.query(`UPDATE p2p_orders SET last_onchain=$2, last_read_at=now() WHERE id=$1`, [row.id, JSON.stringify(snapshot(o))]);
  else await ctx.db.query(`UPDATE p2p_orders SET last_read_at=now() WHERE id=$1`, [row.id]);
  const scope = s.kind === "scan_pay" ? { intentId: s.id } : { withdrawalId: s.id };

  if (o.fiatAmount !== BigInt(row.fiat_amount6)) return toManualReview(ctx, s, row, "order_fiat_mismatch", "On-chain fiat amount differs from the requested amount.");
  if (o.disputeStatus === "open") {
    await tx(ctx.db, async (t) => {
      // A dispute implies USDC was escrowed; record it first so the trail and transitions stay legal.
      const cur = o.status === "paid" || o.status === "completed" ? await recordEscrow(t, ctx, s, row, o) : await loadSubject(t, ctx, s.kind, s.id);
      if (cur.status !== "disputed") await setSubject(t, ctx, cur, "disputed", "Disputed", "The order is in dispute with the P2P protocol.");
      await raiseException(t, ctx.env, { kind: "order_disputed", severity: "urgent", orderId: row.id, ...scope });
    });
    return { rerunInMs: 300_000 };
  }

  switch (o.status) {
    case "placed": {
      await tx(ctx.db, async (t) => walkTo(t, ctx, await loadSubject(t, ctx, s.kind, s.id), "placed", "Order placed", "Waiting for a liquidity provider to accept."));
      // Approve exactly what the Diamond will pull (amount + small-order fee) — as soon as placement is mined.
      const blocked = await ensureApproval(ctx, exec, s, row, o);
      if (blocked) return blocked;
      const cancelRequested = s.kind === "withdrawal" && s.status === "cancel_requested";
      const timedOut = Date.now() - Number(o.placedAt) * 1000 > ctx.cfg.policy.payoutAcceptTimeoutSec * 1000;
      if (cancelRequested || timedOut) {
        try {
          await exec.cancel(orderId, hooksFor(ctx, row.id, "cancel"));
        } catch (e) {
          ctx.log.warn({ orderRow: row.id, err: (e as Error).message }, "cancelOrder failed; will re-read chain");
        }
        if (timedOut && s.kind === "scan_pay") await tx(ctx.db, async (t) => setSubject(t, ctx, await loadSubject(t, ctx, s.kind, s.id), "provider_timeout", "No provider accepted in time"));
      }
      return { rerunInMs: 5_000 };
    }
    case "accepted": {
      await tx(ctx.db, async (t) => walkTo(t, ctx, await loadSubject(t, ctx, s.kind, s.id), "merchant_accepted", "Liquidity provider accepted"));
      if (s.kind === "withdrawal" && s.status === "cancel_requested") {
        await exec.cancel(orderId, hooksFor(ctx, row.id, "cancel")).catch(() => undefined);
        return { rerunInMs: 5_000 };
      }
      if (!row.set_upi_tx_hash) {
        if (!/^[0-9a-fA-F]{128}$/.test(o.pubkey)) return toManualReview(ctx, s, row, "merchant_pubkey_invalid", "Accepted order has no valid merchant public key.");
        // A fast LP may accept before we observed "placed": approval must still happen before the pull.
        const blocked = await ensureApproval(ctx, exec, s, row, o);
        if (blocked) return blocked;
        if ((await exec.allowance()) < o.actualUsdcAmount) return { rerunInMs: 5_000 }; // approval still settling
        const vpa = await ctx.envelope.open(s.vpaCiphertext, s.vpaAad);
        try {
          await exec.setUpi({ orderId, paymentAddress: vpa, merchantPublicKey: o.pubkey }, hooksFor(ctx, row.id, "set_upi_tx_hash"));
        } catch (e) {
          if (e instanceof SubmissionError && !e.ambiguous) return { rerunInMs: 15_000 };
          return { rerunInMs: 15_000 }; // re-read: getOrder decides whether escrow happened
        }
      }
      return { rerunInMs: 3_000 };
    }
    case "paid": {
      await tx(ctx.db, (t) => recordEscrow(t, ctx, s, row, o));
      if (Date.now() - Number(o.paidAt) * 1000 > ctx.cfg.policy.payoutCompletionTimeoutSec * 1000) {
        await tx(ctx.db, (t) => raiseException(t, ctx.env, { kind: "payout_completion_overdue", severity: "warning", orderId: row.id, ...scope }));
      }
      return { rerunInMs: 15_000 };
    }
    case "completed": {
      const sinceComplete = Date.now() - Number(o.completedAt) * 1000;
      await tx(ctx.db, async (t) => {
        // Observed completed (possibly without seeing paid): make sure escrow is recorded first.
        const cur = await recordEscrow(t, ctx, s, row, o);
        await walkTo(t, ctx, cur, "provider_completed", "Provider marked the order complete", "LP-asserted on chain; waiting out the dispute window and reconciling.");
        await t.query(`UPDATE p2p_orders SET status='completed', provider_proof = coalesce(provider_proof,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE id=$1`, [
          row.id,
          JSON.stringify({ proof: "lp_asserted_onchain_completion", completedAt: o.completedAt.toString(), actualFiatAmount: o.actualFiatAmount.toString(), acceptedMerchant: o.acceptedMerchant }),
        ]);
      });
      if (sinceComplete < ctx.cfg.policy.payoutDisputeWindowSec * 1000) return { rerunInMs: Math.min(60_000, ctx.cfg.policy.payoutDisputeWindowSec * 1000 - sinceComplete + 1_000) };
      return reconcileCompleted(ctx, s, row, o);
    }
    case "cancelled": {
      await tx(ctx.db, async (t) => {
        const escrowed = await maybeOne(t, `SELECT 1 FROM ledger_journals WHERE environment=$1 AND event_id=$2`, [ctx.env, `escrow:${row.id}`]);
        if (escrowed) await reverseJournal(t, ctx.env, `escrow:${row.id}`, `escrow_return:${row.id}`, `P2P order ${orderId} cancelled; escrow returned`);
        await t.query(`UPDATE p2p_orders SET status='cancelled_final', updated_at=now() WHERE id=$1`, [row.id]);
        const cur = await loadSubject(t, ctx, s.kind, s.id);
        if (cur.kind === "withdrawal" && cur.status === "cancel_requested") {
          const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [s.id]);
          await restoreWithdrawal(t, ctx, w, "on-chain order cancelled at merchant request");
          return;
        }
        if (escrowed) await treasury.setState(t, ctx.env, s.id, "released").then(() => treasury.hold(t, ctx.env, { purpose: s.kind === "scan_pay" ? "direct_payout" : "withdrawal", obligationId: s.id, amountMicros: s.allocationMicros }, { inventoryMaxAgeMs: ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000, bufferMicros: 0n }));
        if (cur.kind === "scan_pay") {
          if (cur.status === "order_placing") await walkTo(t, ctx, cur, "placed", "Order placed");
          if (cur.status !== "cancelled" && cur.status !== "provider_timeout") await setSubject(t, ctx, cur, "cancelled", "Order cancelled", "Will retry with a new order.");
        } else await setSubject(t, ctx, cur, "failed_recoverable", "Order cancelled", "Will retry with a new order.");
      });
      return { rerunInMs: 10_000 };
    }
  }
}

/** Record USDC escrow exactly once (journal keyed by order row) and walk the subject to inr_processing. */
async function recordEscrow(t: Tx, ctx: CoreContext, s: Subject, row: OrderRow, o: OnchainOrder) {
  const cur = await loadSubject(t, ctx, s.kind, s.id);
  await walkTo(t, ctx, cur, "usdc_escrowed", "USDC escrowed", "USDC was pulled into P2P escrow.");
  await postJournal(t, ctx.env, {
    eventId: `escrow:${row.id}`,
    kind: "usdc_escrowed",
    memo: `P2P order ${o.orderId} escrow`,
    lines: [
      { account: "usdc_in_p2p_escrow", debit: o.actualUsdcAmount },
      { account: "base_usdc_asset", credit: o.actualUsdcAmount },
    ],
  });
  await treasury.setState(t, ctx.env, s.id, "in_flight");
  await walkTo(t, ctx, cur, "inr_processing", "INR transfer in progress", "The liquidity provider transfers INR off-chain. Zeb Scan cannot see the bank transfer directly.");
  return cur;
}

/** Approve exactly order.actualUsdcAmount once per order. Returns a Next when the caller must stop. */
async function ensureApproval(ctx: CoreContext, exec: P2PExecutor, s: Subject, row: OrderRow, o: OnchainOrder): Promise<Next | null> {
  if (row.approve_tx_hash) return null;
  if (o.actualUsdcAmount < o.usdcAmount) return toManualReview(ctx, s, row, "order_pull_below_amount", "actualUsdcAmount below order amount; refusing to approve short.");
  if (o.actualUsdcAmount > s.allocationMicros) return toManualReview(ctx, s, row, "order_pull_exceeds_allocation", "Required USDC pull exceeds the reserved allocation.");
  if ((await exec.allowance()) < o.actualUsdcAmount) {
    try {
      await exec.approve(o.actualUsdcAmount, hooksFor(ctx, row.id, "approve_tx_hash"));
    } catch (e) {
      if (e instanceof SubmissionError && !e.ambiguous) return { rerunInMs: 30_000 };
      return toManualReview(ctx, s, row, "approve_ambiguous", `USDC approval outcome unknown: ${(e as Error).message.slice(0, 120)}`);
    }
  } else await ctx.db.query(`UPDATE p2p_orders SET approve_tx_hash='preexisting-allowance', updated_at=now() WHERE id=$1`, [row.id]);
  await ctx.db.query(`UPDATE p2p_orders SET actual_usdc_micros=$2, approved_micros=$2 WHERE id=$1`, [row.id, o.actualUsdcAmount.toString()]);
  row.approve_tx_hash = row.approve_tx_hash ?? "set";
  return null;
}

async function reconcileCompleted(ctx: CoreContext, s: Subject, row: OrderRow, o: OnchainOrder): Promise<Next> {
  if (o.actualFiatAmount !== 0n && o.actualFiatAmount !== BigInt(row.fiat_amount6)) return toManualReview(ctx, s, row, "completed_fiat_mismatch", "Completed fiat amount differs from the requested amount.");
  await tx(ctx.db, async (t) => {
    const fee = o.fixedFeePaid > 0n ? o.fixedFeePaid : o.actualUsdcAmount - o.usdcAmount;
    await postJournal(t, ctx.env, {
      eventId: `settle:${row.id}`,
      kind: "usdc_settled",
      memo: `P2P order ${o.orderId} settled to LP`,
      lines: [
        { account: "usdc_settlement_outflow", debit: o.actualUsdcAmount - fee },
        ...(fee > 0n ? [{ account: "p2p_fee_expense_usdc" as const, debit: fee }] : []),
        { account: "usdc_in_p2p_escrow", credit: o.actualUsdcAmount },
      ],
    });
    await treasury.setState(t, ctx.env, s.id, "consumed");
    const cur = await loadSubject(t, ctx, s.kind, s.id);
    if (s.kind === "scan_pay") {
      await postJournal(t, ctx.env, {
        eventId: `payout_complete:${s.id}`,
        kind: "payout_completed",
        memo: `Scan & Pay ${s.id} delivered by provider`,
        lines: [
          { account: "payout_pending_to_recipient", debit: s.inrPaise },
          { account: "crypto_inventory_valuation", credit: s.inrPaise },
        ],
      });
      await setSubject(t, ctx, cur, "payout_reconciled", "Reconciled", "On-chain order amounts match the payout.");
      await setSubject(t, ctx, cur, "completed", "Payout completed", "The liquidity provider reported the INR transfer as complete. This is not a bank statement.");
    } else {
      const w = await one<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [s.id]);
      await finalizeWithdrawal(t, ctx, w);
    }
  });
  return { rerunInMs: null };
}

export function payoutError(e: unknown): DomainError {
  return e instanceof DomainError ? e : new DomainError("P2P_UNEXPECTED", (e as Error).message);
}
