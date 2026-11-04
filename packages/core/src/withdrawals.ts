/**
 * Merchant withdrawals (SELL, orderType 1). Reserve available credits atomically with the ledger
 * and a USDC allocation; restore ONLY through an explicit compensating journal after the chain
 * proves nothing is in flight; finalize only after the order completes and reconciles.
 */
import { many, maybeOne, one, tx, type Queryable, type Tx } from "@zeb/db";
import { bpsCeil, creditMachine, DomainError, maskVpa, newId, notFound, p2pFixedFee, usdcForInr, withdrawalMachine, type WithdrawalStatus } from "@zeb/domain";
import { merchantBalances, postJournal, treasury } from "@zeb/ledger";
import type { CoreContext } from "./context";
import { audit, emitResource, enqueueJob } from "./events";
import { readiness } from "./gates";
import { holdPolicy } from "./intents";
import { createPayoutCommand, recordAuthorization } from "./tfpayouts";
import { readP2P } from "./rates";

export interface WithdrawalRow {
  id: string;
  merchant_id: string;
  payout_destination_id: string;
  inr_paise: string;
  fee_inr_paise: string;
  payout_inr_paise: string;
  required_usdc_micros: string;
  status: WithdrawalStatus;
  failure_reason: string | null;
  recovered_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  quote_snapshot: Record<string, string>;
}

export async function quoteWithdrawal(ctx: CoreContext, merchantId: string, inrPaise: bigint) {
  const p = ctx.cfg.policy;
  const blockers: string[] = [];
  const ready = await readiness(ctx);
  if (!ready.features.withdrawals.available) blockers.push(ready.features.withdrawals.reason ?? "Withdrawals unavailable");
  if (inrPaise < p.minWithdrawalInrPaise) blockers.push(`Minimum withdrawal is ${p.minWithdrawalInrPaise} paise`);
  const bal = await merchantBalances(ctx.db, ctx.env, merchantId);
  if (bal.availableInrPaise < inrPaise) blockers.push("Amount exceeds available balance");
  const dest = await maybeOne<{ status: string; usable_after: Date | null }>(ctx.db, `SELECT status, usable_after FROM payout_destinations WHERE merchant_id=$1 AND status IN ('pending_verification','cooling_off','verified')`, [merchantId]);
  if (!dest) blockers.push("Add a payout UPI ID first");
  else if (dest.status !== "verified") blockers.push("Payout UPI ID is not verified yet");
  else if (dest.usable_after && new Date(dest.usable_after) > ctx.now()) blockers.push("Payout UPI ID is in its security cooling-off period");
  const fee = bpsCeil(inrPaise, p.withdrawalFeeBps);
  const payout = inrPaise - fee;
  let sell = "0";
  let required = 0n;
  let p2pFee = 0n;
  try {
    const r = await readP2P(ctx);
    sell = r.sellPrice6.toString();
    const usdc = usdcForInr(payout, r.sellPrice6);
    p2pFee = p2pFixedFee(usdc, { smallOrderThreshold: r.fee.smallOrderThreshold, smallOrderFixedFee: r.fee.smallOrderFixedFeeSell });
    required = usdc + p2pFee + bpsCeil(usdc, p.p2pSpreadReserveBps);
  } catch (e) {
    blockers.push((e as Error).message);
  }
  return {
    inrPaise: inrPaise.toString(),
    feeInrPaise: fee.toString(),
    payoutInrPaise: payout.toString(),
    requiredUsdcMicros: required.toString(),
    estimatedP2PFeeUsdcMicros: p2pFee.toString(),
    sellPrice: sell,
    executable: blockers.length === 0,
    blockers,
    observedAt: ctx.now().toISOString(),
    disclaimer: "Estimate only. The INR transfer is executed off-chain by a P2P liquidity provider; timing and completion are not guaranteed.",
  };
}

async function transition(t: Tx, ctx: CoreContext, w: WithdrawalRow, to: WithdrawalStatus, label: string, detail?: string, set: Record<string, unknown> = {}): Promise<WithdrawalRow> {
  withdrawalMachine.assert(w.status, to, { withdrawalId: w.id });
  const cols = ["status=$3", "version=version+1", "updated_at=now()"];
  const vals: unknown[] = [w.id, w.version, to];
  for (const [k, v] of Object.entries(set)) {
    vals.push(v);
    cols.push(`${k}=$${vals.length}`);
  }
  const r = await t.query(`UPDATE withdrawals SET ${cols.join(", ")} WHERE id=$1 AND version=$2 RETURNING *`, vals);
  if (r.rowCount !== 1) throw new DomainError("STATE_CONCURRENT_MODIFICATION", "withdrawal changed concurrently", undefined, { status: 409, retryable: true });
  await emitResource(t, ctx.env, `withdrawal:${w.id}`, `withdrawal.${to}`, { status: to, label, ...(detail ? { detail } : {}) });
  await emitResource(t, ctx.env, `merchant:${w.merchant_id}`, "withdrawal.updated", { withdrawalId: w.id, status: to });
  return r.rows[0] as WithdrawalRow;
}
export { transition as transitionWithdrawal };

export async function createWithdrawal(ctx: CoreContext, a: { merchantId: string; userId: string; inrPaise: bigint; destinationId: string; stepUpAt: Date; requestId?: string }): Promise<WithdrawalRow> {
  const q = await quoteWithdrawal(ctx, a.merchantId, a.inrPaise);
  if (!q.executable) throw new DomainError("WITHDRAWAL_NOT_EXECUTABLE", q.blockers[0] ?? "Withdrawal not possible right now", { blockers: q.blockers });
  return tx(ctx.db, async (t) => {
    const m = await one<{ status: string }>(t, `SELECT status FROM merchants WHERE id=$1 AND environment=$2 FOR UPDATE`, [a.merchantId, ctx.env]);
    if (ctx.env === "mainnet-enabled" && m.status !== "verified") throw new DomainError("COMPLIANCE_KYB_REQUIRED", "Merchant verification (KYB) is required before withdrawals");
    if (["restricted", "suspended", "closed"].includes(m.status)) throw new DomainError("COMPLIANCE_MERCHANT_RESTRICTED", "Withdrawals are disabled for this merchant");
    const dest = await maybeOne<{ id: string; status: string; usable_after: Date | null }>(t, `SELECT id, status, usable_after FROM payout_destinations WHERE id=$1 AND merchant_id=$2 FOR SHARE`, [a.destinationId, a.merchantId]);
    if (!dest || dest.status !== "verified" || (dest.usable_after && new Date(dest.usable_after) > ctx.now())) throw new DomainError("WITHDRAWAL_DESTINATION_NOT_READY", "Payout destination is not verified or still cooling off");
    const active = await maybeOne(t, `SELECT 1 FROM withdrawals WHERE merchant_id=$1 AND status NOT IN ('completed','cancelled')`, [a.merchantId]);
    if (active) throw new DomainError("WITHDRAWAL_ALREADY_ACTIVE", "Another withdrawal is in progress", undefined, { status: 409 });
    const bal = await merchantBalances(t, ctx.env, a.merchantId);
    if (bal.availableInrPaise < a.inrPaise) throw new DomainError("WITHDRAWAL_INSUFFICIENT", "Amount exceeds available balance", { availableInrPaise: bal.availableInrPaise.toString() });

    const wid = newId("withdrawal");
    let w = await one<WithdrawalRow>(
      t,
      `INSERT INTO withdrawals(id, environment, merchant_id, payout_destination_id, inr_paise, fee_inr_paise, payout_inr_paise, required_usdc_micros, quote_snapshot, status, requested_by, step_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10,$11) RETURNING *`,
      [wid, ctx.env, a.merchantId, a.destinationId, q.inrPaise, q.feeInrPaise, q.payoutInrPaise, q.requiredUsdcMicros, JSON.stringify(q), a.userId, a.stepUpAt],
    );

    // Reserve credits FIFO, splitting the last one if needed.
    let remaining = a.inrPaise;
    const credits = await many<{ id: string; amount_inr_paise: string; backing_allocation_id: string | null; intent_id: string | null }>(
      t,
      `SELECT id, amount_inr_paise, backing_allocation_id, intent_id FROM merchant_credits WHERE merchant_id=$1 AND environment=$2 AND status='credit_available' ORDER BY available_at, created_at FOR UPDATE`,
      [a.merchantId, ctx.env],
    );
    for (const c of credits) {
      if (remaining === 0n) break;
      const amt = BigInt(c.amount_inr_paise);
      const backing = await treasury.activeAllocation(t, ctx.env, c.id);
      if (amt <= remaining) {
        creditMachine.assert("credit_available", "withdrawal_reserved");
        await t.query(`UPDATE merchant_credits SET status='withdrawal_reserved', withdrawal_id=$2, updated_at=now(), version=version+1 WHERE id=$1`, [c.id, wid]);
        if (backing) await treasury.setState(t, ctx.env, c.id, "released");
        remaining -= amt;
      } else {
        creditMachine.assert("credit_available", "split");
        const reservedId = newId("credit");
        const restId = newId("credit");
        await t.query(`UPDATE merchant_credits SET status='split', updated_at=now(), version=version+1 WHERE id=$1`, [c.id]);
        await t.query(
          `INSERT INTO merchant_credits(id, environment, merchant_id, intent_id, amount_inr_paise, status, policy_version, available_at, withdrawal_id, parent_credit_id)
           SELECT $2, environment, merchant_id, NULL, $3, 'withdrawal_reserved', policy_version, available_at, $4, id FROM merchant_credits WHERE id=$1`,
          [c.id, reservedId, remaining.toString(), wid],
        );
        await t.query(
          `INSERT INTO merchant_credits(id, environment, merchant_id, intent_id, amount_inr_paise, status, policy_version, available_at, parent_credit_id)
           SELECT $2, environment, merchant_id, NULL, $3, 'credit_available', policy_version, available_at, id FROM merchant_credits WHERE id=$1`,
          [c.id, restId, (amt - remaining).toString()],
        );
        if (backing) {
          const restBacking = (BigInt(backing.amount_micros) * (amt - remaining) + amt - 1n) / amt;
          await treasury.convert(t, ctx.env, c.id, { purpose: "merchant_credit_backing", obligationId: restId, amountMicros: restBacking }, holdPolicy(ctx));
          await t.query(`UPDATE merchant_credits SET backing_allocation_id=(SELECT id FROM treasury_allocations WHERE obligation_id=$1 AND state='held') WHERE id=$1`, [restId]);
        }
        remaining = 0n;
      }
    }
    if (remaining !== 0n) throw new DomainError("LEDGER_CREDIT_MISMATCH", "available credits do not cover the ledger balance; refusing", undefined, { status: 500 });

    await postJournal(t, ctx.env, {
      eventId: `withdrawal_reserve:${wid}`,
      kind: "withdrawal_reserved",
      memo: `Reserved for withdrawal ${wid}`,
      lines: [
        { account: "merchant_credits_available", merchantId: a.merchantId, debit: a.inrPaise },
        { account: "merchant_credits_withdrawal_reserved", merchantId: a.merchantId, credit: a.inrPaise },
      ],
    });
    await treasury.hold(t, ctx.env, { purpose: "withdrawal", obligationId: wid, amountMicros: BigInt(q.requiredUsdcMicros) }, holdPolicy(ctx));
    w = await transition(t, ctx, w, "funds_reserved", "Funds reserved", "Credits moved from available to reserved.");
    w = await transition(t, ctx, w, "awaiting_provider", "Waiting for a payout provider");
    if (ctx.cfg.payoutRail === "P2P_TINYFISH_WEB") {
      const d = await one<{ vpa_ct: string }>(t, `SELECT vpa_ct FROM payout_destinations WHERE id=$1`, [a.destinationId]);
      const vpa = await ctx.envelope.open(d.vpa_ct, `payout_destinations:${a.destinationId}:vpa`);
      const authId = await recordAuthorization(t, ctx, {
        withdrawalId: wid,
        actor: a.userId,
        terms: { version: "withdrawal-terms-v1", recipientVpaMasked: maskVpa(vpa), inrPaise: q.inrPaise, feeInrPaise: q.feeInrPaise, payoutInrPaise: q.payoutInrPaise, maxUsdcDebitMicros: q.requiredUsdcMicros, stepUpAt: a.stepUpAt.toISOString() },
      });
      const alloc = await treasury.activeAllocation(t, ctx.env, wid, false);
      await createPayoutCommand(t, ctx, { flow: "MERCHANT_WITHDRAWAL", withdrawalId: wid, vpa, inrPaise: BigInt(q.payoutInrPaise), maxUsdcMicros: BigInt(q.requiredUsdcMicros), quoteId: null, authorizationId: authId, reservedTreasuryId: alloc?.id ?? null });
    } else {
      await enqueueJob(t, ctx.env, "payout.advance", `withdrawal:${wid}`, { kind: "withdrawal", id: wid });
    }
    await audit(t, ctx.env, { actorType: "user", actorId: a.userId, action: "withdrawal.request", target: wid, details: { inrPaise: a.inrPaise.toString() }, requestId: a.requestId });
    return w;
  });
}

/** Compensating restore. Caller MUST have proven that no USDC left the treasury for this withdrawal. */
export async function restoreWithdrawal(t: Tx, ctx: CoreContext, w: WithdrawalRow, reason: string): Promise<WithdrawalRow> {
  const credits = await many<{ id: string; amount_inr_paise: string }>(t, `SELECT id, amount_inr_paise FROM merchant_credits WHERE withdrawal_id=$1 AND status='withdrawal_reserved' FOR UPDATE`, [w.id]);
  await treasury.setState(t, ctx.env, w.id, "released");
  for (const c of credits) {
    creditMachine.assert("withdrawal_reserved", "credit_available");
    await t.query(`UPDATE merchant_credits SET status='credit_available', withdrawal_id=NULL, updated_at=now(), version=version+1 WHERE id=$1`, [c.id]);
    // Re-back the restored credit at the current conservative requirement (pro-rata of the withdrawal hold).
    const share = (BigInt(w.required_usdc_micros) * BigInt(c.amount_inr_paise) + BigInt(w.inr_paise) - 1n) / BigInt(w.inr_paise);
    await treasury.hold(t, ctx.env, { purpose: "merchant_credit_backing", obligationId: c.id, amountMicros: share > 0n ? share : 1n }, holdPolicy(ctx));
  }
  await postJournal(t, ctx.env, {
    eventId: `withdrawal_restore:${w.id}`,
    kind: "withdrawal_released",
    memo: `Withdrawal ${w.id} restored: ${reason}`,
    lines: [
      { account: "merchant_credits_withdrawal_reserved", merchantId: w.merchant_id, debit: BigInt(w.inr_paise) },
      { account: "merchant_credits_available", merchantId: w.merchant_id, credit: BigInt(w.inr_paise) },
    ],
  });
  return transition(t, ctx, w, "cancelled", "Withdrawal cancelled", `Reserved credits restored (${reason}).`, { recovered_at: ctx.now(), failure_reason: reason });
}

export async function cancelWithdrawal(ctx: CoreContext, id: string, merchantId: string, userId: string): Promise<WithdrawalRow> {
  return tx(ctx.db, async (t) => {
    const w = await maybeOne<WithdrawalRow>(t, `SELECT * FROM withdrawals WHERE id=$1 AND merchant_id=$2 AND environment=$3 FOR UPDATE`, [id, merchantId, ctx.env]);
    if (!w) throw notFound("withdrawal", id);
    const order = await maybeOne<{ place_tx_hash: string | null; status: string }>(t, `SELECT place_tx_hash, status FROM p2p_orders WHERE withdrawal_id=$1 ORDER BY attempt DESC LIMIT 1`, [id]);
    if (["requested", "funds_reserved", "awaiting_provider"].includes(w.status) && !order?.place_tx_hash) {
      const restored = await restoreWithdrawal(t, ctx, w.status === "requested" ? w : await transition(t, ctx, w, "cancel_requested", "Cancellation requested"), "cancelled by merchant before provider commitment");
      await audit(t, ctx.env, { actorType: "user", actorId: userId, action: "withdrawal.cancel", target: id });
      return restored;
    }
    if (["placed", "merchant_accepted"].includes(w.status)) {
      // An on-chain order exists but no USDC is escrowed yet: ask the worker to cancel ON CHAIN first.
      const next = await transition(t, ctx, w, "cancel_requested", "Cancellation requested", "Cancelling the on-chain order; credits are restored only after the chain confirms the cancellation.");
      await enqueueJob(t, ctx.env, "payout.advance", `withdrawal:${id}`, { kind: "withdrawal", id });
      await audit(t, ctx.env, { actorType: "user", actorId: userId, action: "withdrawal.cancel_requested", target: id });
      return next;
    }
    throw new DomainError("STATE_CANCEL_NOT_SAFE", "This withdrawal is already committed with the payout provider and cannot be cancelled. Open a support case if it is stuck.", undefined, { status: 409, currentStatus: w.status });
  });
}

/** Extinguish the liability after the SELL order completed AND reconciled. */
export async function finalizeWithdrawal(t: Tx, ctx: CoreContext, w: WithdrawalRow): Promise<WithdrawalRow> {
  const payout = BigInt(w.payout_inr_paise);
  const fee = BigInt(w.fee_inr_paise);
  await postJournal(t, ctx.env, {
    eventId: `withdrawal_complete:${w.id}`,
    kind: "withdrawal_completed",
    memo: `Withdrawal ${w.id} completed by P2P provider`,
    lines: [
      { account: "merchant_credits_withdrawal_reserved", merchantId: w.merchant_id, debit: payout + fee },
      { account: "crypto_inventory_valuation", credit: payout },
      ...(fee > 0n ? [{ account: "fee_revenue" as const, credit: fee }] : []),
    ],
  });
  await t.query(`UPDATE merchant_credits SET status='extinguished', updated_at=now(), version=version+1 WHERE withdrawal_id=$1 AND status='withdrawal_reserved'`, [w.id]);
  const rec = await transition(t, ctx, w, "reconciled", "Reconciled");
  return transition(t, ctx, rec, "completed", "Completed", "The provider reported the INR transfer complete. This is not a bank statement.");
}

export async function withdrawalDto(q: Queryable, ctx: CoreContext, w: WithdrawalRow) {
  const dest = await maybeOne<{ vpa_masked: string }>(q, `SELECT vpa_masked FROM payout_destinations WHERE id=$1`, [w.payout_destination_id]);
  const order = await maybeOne<{ onchain_order_id: string | null }>(q, `SELECT onchain_order_id FROM p2p_orders WHERE withdrawal_id=$1 ORDER BY attempt DESC LIMIT 1`, [w.id]);
  const ev = await many<{ id: string; created_at: Date; event_type: string; data: { label?: string; detail?: string } }>(q, `SELECT id, created_at, event_type, data FROM resource_events WHERE resource=$1 ORDER BY id`, [`withdrawal:${w.id}`]);
  return {
    id: w.id,
    merchantId: w.merchant_id,
    inrPaise: w.inr_paise,
    feeInrPaise: w.fee_inr_paise,
    payoutInrPaise: w.payout_inr_paise,
    requiredUsdcMicros: w.required_usdc_micros,
    payoutVpaMasked: dest?.vpa_masked ?? maskVpa("unknown@unknown"),
    status: w.status,
    orderReference: order?.onchain_order_id ?? null,
    failureReason: w.failure_reason,
    recoveredAt: w.recovered_at ? new Date(w.recovered_at).toISOString() : null,
    timeline: ev.map((e) => ({ id: String(e.id), at: new Date(e.created_at).toISOString(), type: e.event_type, label: e.data.label ?? e.event_type, ...(e.data.detail ? { detail: e.data.detail } : {}) })),
    createdAt: new Date(w.created_at).toISOString(),
    updatedAt: new Date(w.updated_at).toISOString(),
    label: ctx.caps.label,
  };
}
