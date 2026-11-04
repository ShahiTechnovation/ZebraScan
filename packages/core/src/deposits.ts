/**
 * Deposit ingestion from the watch-only scanner (spec §8.3) and the accept command.
 *
 * - Matching uses ONLY the wallet's address->invoice mapping (unique diversified address per intent).
 *   Never the amount.
 * - Dedupe key: (environment, network, pool, txid, outputRef). One tx may carry multiple outputs.
 * - mempool sightings are display-only; acceptance requires canonical mined confirmations.
 * - Reorgs revoke non-final observations; reorg after acceptance freezes downstream and raises an
 *   urgent exception — journal history is never deleted.
 * - Late deposits (any time, any status) are recorded and routed to refund review.
 */
import { createHash } from "node:crypto";
import { many, maybeOne, one, tx, type Tx } from "@zeb/db";
import { classifyPayment, DomainError, INVOICE_MEMO_RE, newId, payoutMachine, type IntentStatus } from "@zeb/domain";
import { postJournal, reverseJournal, treasury } from "@zeb/ledger";
import { usesTreasury, type CoreContext } from "./context";
import { audit, emitResource, enqueueJob, raiseException } from "./events";
import { holdPolicy, lockIntent, transitionIntent, type IntentRow } from "./intents";
import { assertQuoteIntegrity, type QuoteRow } from "./quotes";
import { issuePaymentReceipt } from "./receipts";
import { createPayoutCommand, queueTestnetDemoPayout, testnetLiveDemo } from "./tfpayouts";

export interface ScannerEvent {
  walletId?: string;
  eventId: string;
  kind: "note_seen" | "note_confirmed" | "note_reorged";
  network: string;
  pool: "orchard" | "sapling" | "transparent" | "ironwood" | "demo";
  txid: string;
  outputRef: string;
  valueZatoshis: string;
  address: string;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  scanVersion: string;
  /** Decrypted memo from memo-matched watchers. Used for matching only; never logged or stored. */
  memo?: string | null;
}

const OPEN: IntentStatus[] = ["awaiting_zec", "deposit_seen", "confirming"];
const LATE_TARGETS: IntentStatus[] = ["expired_without_funds", "cancelled"];

interface Observation {
  id: string; first_seen_at: Date; accepted: boolean; canonical: boolean;
  intent_id: string | null; zcash_address_id: string | null; value_zatoshis: string;
  custody_booked: boolean; custody_revision: number;
  wallet_id: string | null;
}

async function custody(t: Tx, ctx: CoreContext, obs: Observation, ev: ScannerEvent) {
  const event = `custody:${obs.id}:${obs.custody_revision}`;
  if (ev.kind === "note_reorged" && obs.custody_booked) {
    await reverseJournal(t, ctx.env, event, `${event}:reorg`, "Noncanonical refundable output; hold for canonical rescan");
    await t.query(`UPDATE deposit_observations SET custody_booked=false, custody_revision=custody_revision+1 WHERE id=$1`, [obs.id]);
  } else if (!obs.custody_booked && ev.kind !== "note_reorged" && ev.blockHeight !== null && ev.confirmations >= ctx.cfg.policy.requiredConfirmations) {
    await postJournal(t, ctx.env, { eventId: event, kind: "refund_liability", memo: `Confirmed custody output ${obs.id}; requires refund review`, lines: [
      { account: "zcash_asset", debit: BigInt(obs.value_zatoshis) },
      { account: "customer_refunds_due", credit: BigInt(obs.value_zatoshis) },
    ] });
    await t.query(`UPDATE deposit_observations SET custody_booked=true WHERE id=$1`, [obs.id]);
  }
}

export async function ingestScannerEvent(ctx: CoreContext, ev: ScannerEvent, source = "zcash-gateway"): Promise<{ accepted: boolean; duplicate: boolean }> {
  if (ctx.env !== "demo" && ev.network !== ctx.cfg.zcashNetwork) throw new DomainError("WALLET_NETWORK_MISMATCH", "event network does not match environment", undefined, { status: 400 });
  return tx(ctx.db, async (t) => {
    // Serialize all versions of an output, including formerly unattributed outputs.
    await t.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([ctx.env, ev.network, ev.pool, ev.txid, ev.outputRef])]);
    const payloadHash = createHash("sha256").update(JSON.stringify(ev)).digest("hex");
    const ins = await t.query(`INSERT INTO inbound_event_receipts(source, event_id, environment, payload_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [source, ev.eventId, ctx.env, payloadHash]);
    if (ins.rowCount === 0) return { accepted: false, duplicate: true };

    // Matching: memo code (memo-matched watcher) or unique address — never by amount.
    const code = ev.memo?.trim() && INVOICE_MEMO_RE.test(ev.memo.trim()) ? ev.memo.trim() : null;
    const persisted = await maybeOne<Observation>(t, `SELECT * FROM deposit_observations WHERE environment=$1 AND network=$2 AND pool=$3 AND txid=$4 AND output_ref=$5 FOR UPDATE`, [ctx.env, ev.network, ev.pool, ev.txid, ev.outputRef]);
    if (persisted && BigInt(persisted.value_zatoshis) !== BigInt(ev.valueZatoshis)) throw new DomainError("WALLET_OUTPUT_CONFLICT", "wallet output value changed");
    if (persisted?.wallet_id && ev.walletId && persisted.wallet_id!==ev.walletId) throw new DomainError("WALLET_OUTPUT_CONFLICT", "wallet output owner changed");
    const addr = persisted?.intent_id ? { id: persisted.zcash_address_id!, intent_id: persisted.intent_id } : code
      ? await maybeOne<{ id: string; intent_id: string }>(t, `SELECT id, intent_id FROM zcash_addresses WHERE environment=$1 AND network=$2 AND address=$3 AND memo_code=$4`, [ctx.env, ev.network, ev.address, code])
      : await maybeOne<{ id: string; intent_id: string }>(t, `SELECT id, intent_id FROM zcash_addresses WHERE environment=$1 AND network=$2 AND address=$3 AND memo_code IS NULL`, [ctx.env, ev.network, ev.address]);
    const intent = addr ? await lockIntent(t, ctx, addr.intent_id) : null;
    const mined = ev.blockHeight !== null && ev.kind !== "note_reorged";

    const obs = await one<Observation>(
      t,
      `INSERT INTO deposit_observations(id, environment, network, pool, txid, output_ref, value_zatoshis, zcash_address_id, intent_id, block_height, block_hash, mined, confirmations, canonical, scan_version, observed_address, wallet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (environment, network, pool, txid, output_ref) DO UPDATE SET
         wallet_id=coalesce(deposit_observations.wallet_id, EXCLUDED.wallet_id),
         intent_id=coalesce(deposit_observations.intent_id, EXCLUDED.intent_id), zcash_address_id=coalesce(deposit_observations.zcash_address_id, EXCLUDED.zcash_address_id),
         block_height = EXCLUDED.block_height, block_hash = EXCLUDED.block_hash, mined = EXCLUDED.mined,
         confirmations = EXCLUDED.confirmations, canonical = EXCLUDED.canonical, scan_version = EXCLUDED.scan_version,
         reorged_at = CASE WHEN EXCLUDED.canonical THEN deposit_observations.reorged_at ELSE now() END, updated_at = now()
       RETURNING *`,
      [newId("deposit"), ctx.env, ev.network, ev.pool, ev.txid, ev.outputRef, ev.valueZatoshis, addr?.id ?? null, intent?.id ?? null, ev.blockHeight, ev.blockHash, mined, ev.kind === "note_reorged" ? 0 : ev.confirmations, ev.kind !== "note_reorged", ev.scanVersion, ev.address, ev.walletId ?? persisted?.wallet_id ?? null],
    );

    if (!intent) {
      await custody(t, ctx, obs, ev);
      await raiseException(t, ctx.env, { kind: "unattributed_deposit", severity: "urgent", depositId: obs.id, details: { txid: ev.txid, outputRef: ev.outputRef, value: ev.valueZatoshis, memoPresent: !!ev.memo } });
      return { accepted: false, duplicate: false };
    }

    if (ev.kind === "note_reorged") {
      await custody(t, ctx, obs, ev);
      await handleReorg(t, ctx, intent, obs.id, obs.accepted);
      return { accepted: true, duplicate: false };
    }

    if (persisted && !persisted.intent_id && obs.custody_booked) {
      // Late attribution must not turn an already booked refund into a second asset/credit.
      await raiseException(t, ctx.env, { kind: "custody_attribution_review", severity: "urgent", intentId: intent.id, depositId: obs.id });
      return { accepted: false, duplicate: false };
    }

    // Late: the note appeared after the submission deadline, or the intent was already closed.
    const lateBySeen = new Date(obs.first_seen_at) > new Date(intent.deposit_submission_deadline);
    if (LATE_TARGETS.includes(intent.status) || (OPEN.includes(intent.status) && lateBySeen && intent.status === "awaiting_zec")) {
      await markLate(t, ctx, intent, ev);
      await custody(t, ctx, obs, ev);
      return { accepted: true, duplicate: false };
    }
    if (!OPEN.includes(intent.status)) {
      // The SAME note we already accepted, seen again with more confirmations: bookkeeping only
      // (confirmations were updated above). Not an additional deposit.
      if (obs.accepted) {
        // Recover only a nonredeemable TESTNET receipt once every accepted output
        // is canonical again. Never re-enter acceptance, issue credit or settle INR.
        if (ctx.env==='testnet' && intent.status==='chain_reorg_review') {
          const missing=await t.query(`SELECT 1 FROM deposit_observations WHERE intent_id=$1 AND accepted AND (NOT canonical OR NOT mined OR confirmations<$2)`,[intent.id,ctx.cfg.policy.requiredConfirmations]);
          if(!missing.rowCount && mined && ev.confirmations>=ctx.cfg.policy.requiredConfirmations) {
            await transitionIntent(t,ctx,intent,'deposit_accepted',{label:'Testnet payment reverified',detail:'The receiving wallet confirms the original output. Original receipt and journals retained; no INR payout.',set:{exception_reason:null}});
            await t.query(`UPDATE payment_intents SET payout_status='not_started' WHERE id=$1 AND payout_status='manual_review'`,[intent.id]);
            await audit(t,ctx.env,{actorType:'system',action:'deposit.testnet_reverified',target:intent.id,details:{depositId:obs.id,walletId:obs.wallet_id}});
          }
        }
        return { accepted: true, duplicate: true };
      }
      // Additional output on an already-decided intent (e.g. second payment): refund review, never silently absorbed.
      await custody(t, ctx, obs, ev);
      if (!obs.accepted) await raiseException(t, ctx.env, { kind: "extra_deposit", severity: "warning", intentId: intent.id, depositId: obs.id, details: { txid: ev.txid, status: intent.status } });
      if (!persisted) await emitResource(t, ctx.env, `checkout:${intent.id}`, "deposit.extra", { label: "Additional ZEC detected", detail: "Refund review requires canonical confirmations." });
      return { accepted: true, duplicate: false };
    }

    let cur = intent;
    if (!mined) {
      if (cur.status === "awaiting_zec") cur = await transitionIntent(t, ctx, cur, "deposit_seen", { label: "ZEC detected", detail: "Seen in the mempool — not yet mined. Display only." });
      return { accepted: true, duplicate: false };
    }
    if (cur.status === "awaiting_zec" || cur.status === "deposit_seen") cur = await transitionIntent(t, ctx, cur, "confirming", { label: "Confirming", detail: `Mined at height ${ev.blockHeight}` });
    else await emitResource(t, ctx.env, `checkout:${cur.id}`, "deposit.confirming", { label: `${ev.confirmations} of ${ctx.cfg.policy.requiredConfirmations} confirmations` });
    await evaluateAcceptance(t, ctx, cur);
    return { accepted: true, duplicate: false };
  });
}

async function markLate(t: Tx, ctx: CoreContext, intent: IntentRow, ev: ScannerEvent) {
  let cur = intent;
  if (cur.status === "awaiting_zec") cur = await transitionIntent(t, ctx, cur, "expired_without_funds", { label: "Invoice expired", detail: "ZEC arrived after the funding deadline." });
  if (cur.status === "expired_without_funds" || cur.status === "cancelled") {
    await transitionIntent(t, ctx, cur, "late_deposit", { label: "Late deposit received", detail: "ZEC arrived after this invoice closed. It will be reviewed for refund.", set: { exception_reason: "late_deposit" } });
    await treasury.setState(t, ctx.env, cur.id, "released");
  }
  await raiseException(t, ctx.env, { kind: "late_deposit", severity: "warning", intentId: intent.id, details: { value: ev.valueZatoshis } });
}

/** ZEC that must be returned: Dr zcash_asset / Cr customer_refunds_due (ZEC only, no INR). */
async function recordRefundLiability(t: Tx, ctx: CoreContext, intentId: string, eventKey: string, zat: bigint) {
  if (zat <= 0n) return;
  await postJournal(t, ctx.env, {
    eventId: `refund_due:${intentId}:${eventKey}`,
    kind: "refund_liability",
    memo: `ZEC refundable for ${intentId}`,
    lines: [
      { account: "zcash_asset", debit: zat },
      { account: "customer_refunds_due", credit: zat },
    ],
  });
}

async function evaluateAcceptance(t: Tx, ctx: CoreContext, intent: IntentRow) {
  const required = ctx.cfg.policy.requiredConfirmations;
  const deps = await many<Observation & { confirmations: number; block_height: number }>(t, `SELECT * FROM deposit_observations WHERE intent_id=$1 AND canonical AND mined`, [intent.id]);
  const total = deps.reduce((s, d) => s + BigInt(d.value_zatoshis), 0n);
  await t.query(`UPDATE payment_intents SET received_zatoshis=$2 WHERE id=$1`, [intent.id, total.toString()]);
  if (deps.length === 0 || deps.some((d) => d.confirmations < required)) return;
  if (deps.some((d) => d.custody_booked || d.custody_revision > 0)) {
    await raiseException(t, ctx.env, { kind: "custody_attribution_review", severity: "urgent", intentId: intent.id });
    return;
  }

  const quote = await one<QuoteRow>(t, `SELECT * FROM quotes WHERE id=$1`, [intent.quote_id]);
  assertQuoteIntegrity(quote);
  const due = BigInt(quote.zec_zatoshis);
  const cls = classifyPayment(total, due, ctx.cfg.policy.paymentToleranceZat);
  let cur = await lockIntent(t, ctx, intent.id);
  if (cls === "underpaid") {
    await transitionIntent(t, ctx, cur, "underpaid", { label: "Underpaid", detail: `Received less ZEC than quoted. The payment was not accepted and will be reviewed for refund.`, set: { exception_reason: "underpaid" } });
    for (const d of deps) await custody(t, ctx, d, { kind: "note_confirmed", blockHeight: d.block_height, confirmations: d.confirmations } as ScannerEvent);
    await treasury.setState(t, ctx.env, intent.id, "released");
    await raiseException(t, ctx.env, { kind: "underpaid", severity: "warning", intentId: intent.id, details: { received: total.toString(), due: due.toString() } });
    return;
  }
  if (cls === "overpaid") {
    cur = await transitionIntent(t, ctx, cur, "overpaid", { label: "Overpaid", detail: "Received more ZEC than quoted. The invoice is honoured; the excess is held for refund.", set: { exception_reason: "overpaid_excess_refundable" } });
    await raiseException(t, ctx.env, { kind: "overpaid_excess", severity: "info", intentId: intent.id, details: { excess: (total - due).toString() } });
  }
  await acceptDeposit(t, ctx, cur, quote, total, deps.map((d) => d.id));
}

/** acceptZecDeposit domain command. Idempotent: the journal event ids and unique credit index make replays no-ops. */
export async function acceptDeposit(t: Tx, ctx: CoreContext, intent: IntentRow, quote: QuoteRow, receivedZat: bigint, depositIds: string[]) {
  const due = BigInt(quote.zec_zatoshis);
  const inr = BigInt(quote.inr_paise);
  const fee = BigInt(quote.platform_fee_inr_paise);
  const excess = receivedZat > due ? receivedZat - due : 0n;
  const now = ctx.now();

  // Re-verify the treasury still backs this obligation (hold survives restarts).
  const hold = usesTreasury(ctx) ? await treasury.activeAllocation(t, ctx.env, intent.id) : null;
  if (usesTreasury(ctx) && !hold) {
    await transitionIntent(t, ctx, intent, "manual_review", { label: "Under review", detail: "Treasury backing for this payment was not found; held for operator review.", set: { exception_reason: "missing_treasury_hold" } });
    await raiseException(t, ctx.env, { kind: "missing_treasury_hold", severity: "urgent", intentId: intent.id });
    return;
  }

  const cur = await transitionIntent(t, ctx, intent, "deposit_accepted", { label: "ZEC received", detail: `${ctx.cfg.policy.requiredConfirmations}+ confirmations on the canonical chain.`, set: { accepted_at: now } });
  await t.query(`UPDATE deposit_observations SET accepted=true, updated_at=now() WHERE id = ANY($1)`, [depositIds]);

  // ZEC leg (zatoshis only).
  await postJournal(t, ctx.env, {
    eventId: `deposit_accepted:${intent.id}:zec`,
    kind: "deposit_accepted",
    memo: `ZEC received for ${intent.id}`,
    lines: [
      { account: "zcash_asset", debit: due },
      { account: "zec_inventory_clearing", credit: due },
    ],
  });
  if (excess > 0n) await recordRefundLiability(t, ctx, intent.id, "overpaid_excess", excess);

    // Link usage: exhausted-before-acceptance routes to refund review and issues NO credit.
    if (intent.link_id) {
      const link = await one<{ use_limit: number | null; reusable: boolean; successful_uses: number }>(t, `SELECT use_limit, reusable, successful_uses FROM payment_links WHERE id=$1 FOR UPDATE`, [intent.link_id]);
      const limit = link.reusable ? link.use_limit : 1;
      if (limit !== null && link.successful_uses >= limit) {
        await postJournal(t, ctx.env, {
          eventId: `refund_due:${intent.id}:link_exhausted`,
          kind: "refund_liability",
          memo: `Link exhausted before acceptance (${intent.id})`,
          lines: [
            { account: "zec_inventory_clearing", debit: due },
            { account: "customer_refunds_due", credit: due },
          ],
        });
        await transitionIntent(t, ctx, cur, "refund_queued", { label: "Refund queued", detail: "This payment link reached its use limit before your payment confirmed. Your ZEC is held for refund review; no refund has been sent.", set: { exception_reason: "link_exhausted" } });
        await treasury.setState(t, ctx.env, intent.id, "released");
        await raiseException(t, ctx.env, { kind: "link_exhausted_refund", severity: "warning", intentId: intent.id });
        return;
      }
      await t.query(`UPDATE payment_links SET successful_uses = successful_uses + 1, updated_at=now() WHERE id=$1`, [intent.link_id]);
    }

  if (ctx.env === "testnet") {
    // TAZ proves receiving only; INR is display/reference metadata, never an asset or entitlement. Sole exception: the strict TESTNET_LIVE_PAYOUT_DEMO opt-in (Scan & Pay only), where the TAZ payment only AUTHORIZES an operator-approved payout paid from Zeb Scan's own pre-funded P2P.lol USDC.
    if (intent.mode === "scan_pay" && testnetLiveDemo(ctx)) await queueTestnetDemoPayout(t, ctx, cur, quote); else await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.disabled", { label: "ZEC confirmed on testnet", detail: "Nonredeemable test receipt. INR payouts and withdrawals are disabled on testnet." });
    if (intent.merchant_id) await emitResource(t, ctx.env, `merchant:${intent.merchant_id}`, "payment.testnet_received", { intentId: intent.id });
    await issuePaymentReceipt(t, ctx, intent.id);
    await audit(t, ctx.env, { actorType: "system", action: "deposit.accept", target: intent.id, details: { received: receivedZat.toString(), due: due.toString(), nonredeemable: true } });
    return;
  }

  if (intent.mode === "scan_pay") {
    await postJournal(t, ctx.env, {
      eventId: `deposit_accepted:${intent.id}:inr`,
      kind: "deposit_accepted",
      memo: `Scan & Pay obligation for ${intent.id}`,
      lines: [
        { account: "crypto_inventory_valuation", debit: inr + fee },
        { account: "payout_pending_to_recipient", credit: inr },
        ...(fee > 0n ? [{ account: "fee_revenue" as const, credit: fee }] : []),
      ],
    });
    if (!ctx.caps.canSubmitTransactions && ctx.env !== "demo") {
      // HACKATHON_TESTNET / read-only: real ZEC was verified, but no INR payout is ever executed here.
      await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.disabled", { label: "INR payout disabled in this environment", detail: "Testnet TAZ is worthless and never funds a real UPI payout. The deposit itself is real and verified." });
      await issuePaymentReceipt(t, ctx, intent.id);
      return;
    }
    await treasury.convert(t, ctx.env, intent.id, { purpose: "direct_payout", obligationId: intent.id, amountMicros: BigInt(quote.required_usdc_micros) }, holdPolicy(ctx));
    payoutMachine.assert(cur.payout_status as "not_started", "payout_queued");
    await t.query(`UPDATE payment_intents SET payout_status='payout_queued', updated_at=now() WHERE id=$1`, [intent.id]);
    if (ctx.cfg.payoutRail === "P2P_TINYFISH_WEB") {
      // Live rail: immutable payout command → policy → liquidity → read-only preflight → operator approval → TinyFish.
      const auth = await one<{ id: string }>(t, `SELECT id FROM payout_authorizations WHERE intent_id=$1 ORDER BY created_at LIMIT 1`, [intent.id]);
      const vpa = await ctx.envelope.open(intent.recipient_vpa_ct!, `payment_intents:${intent.id}:recipient_vpa`);
      const alloc = await treasury.activeAllocation(t, ctx.env, intent.id, false);
      await createPayoutCommand(t, ctx, { flow: "SCAN_PAY", intentId: intent.id, vpa, inrPaise: inr, maxUsdcMicros: BigInt(quote.required_usdc_micros), quoteId: quote.id, authorizationId: auth.id, reservedTreasuryId: alloc?.id ?? null });
      await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.payout_queued", { label: "ZEC confirmed — preparing INR payout", detail: "The payout provider is checked read-only first; during the pilot an operator approves every payout." });
    } else {
      await emitResource(t, ctx.env, `checkout:${intent.id}`, "payout.payout_queued", { label: "INR payout queued", detail: "DEMO: a simulated provider processes this payout." });
      await enqueueJob(t, ctx.env, "payout.advance", `scan_pay:${intent.id}`, { kind: "scan_pay", id: intent.id });
    }
  } else {
    const creditId = newId("credit");
    const unlocksAt = new Date(now.getTime() + ctx.cfg.policy.creditCooldownSec * 1000);
    const backing = usesTreasury(ctx)
      ? await treasury.convert(t, ctx.env, intent.id, { purpose: "merchant_credit_backing", obligationId: creditId, amountMicros: BigInt(quote.required_usdc_micros) }, holdPolicy(ctx))
      : { id: null };
    await t.query(
      `INSERT INTO merchant_credits(id, environment, merchant_id, intent_id, deposit_id, amount_inr_paise, backing_allocation_id, status, policy_version, locked_at, unlocks_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'credit_locked',$8,$9,$10)`,
      [creditId, ctx.env, intent.merchant_id, intent.id, depositIds[0], inr.toString(), backing.id, ctx.cfg.policy.creditPolicyVersion, now, unlocksAt],
    );
    await postJournal(t, ctx.env, {
      eventId: `deposit_accepted:${intent.id}:inr`,
      kind: "credit_locked",
      memo: `Merchant credit ${creditId} (locked until ${unlocksAt.toISOString()})`,
      lines: [
        { account: "crypto_inventory_valuation", debit: inr + fee },
        { account: "merchant_credits_locked", merchantId: intent.merchant_id, credit: inr },
        ...(fee > 0n ? [{ account: "fee_revenue" as const, credit: fee }] : []),
      ],
    });
    await emitResource(t, ctx.env, `checkout:${intent.id}`, "credit.locked", { label: "Merchant credited (locked)", detail: `INR credit is locked until ${unlocksAt.toISOString().slice(0, 10)} under the settlement policy.` });
    await emitResource(t, ctx.env, `merchant:${intent.merchant_id}`, "credit.locked", { creditId, intentId: intent.id });
    await enqueueJob(t, ctx.env, "credit.unlock", creditId, { creditId }, unlocksAt);
  }
  await issuePaymentReceipt(t, ctx, intent.id);
  await audit(t, ctx.env, { actorType: "system", action: "deposit.accept", target: intent.id, details: { received: receivedZat.toString(), due: due.toString() } });
}

async function handleReorg(t: Tx, ctx: CoreContext, intent: IntentRow, depositId: string, wasAccepted: boolean) {
  await t.query(`UPDATE payout_commands SET held=true, hold_reason='source deposit reorged', updated_at=now() WHERE environment=$1 AND (source_intent_id=$2 OR withdrawal_id IN (SELECT withdrawal_id FROM merchant_credits WHERE intent_id=$2 AND withdrawal_id IS NOT NULL)) AND state NOT IN ('RECONCILED','REFUNDED')`, [ctx.env, intent.id]);
  await emitResource(t, ctx.env, `checkout:${intent.id}`, "deposit.reorged", { label: "Chain reorganisation", detail: "A previously seen transaction was removed from the canonical chain." });
  if (OPEN.includes(intent.status) && intent.status !== "awaiting_zec") {
    await transitionIntent(t, ctx, intent, "chain_reorg_review", { label: "Re-checking after chain reorganisation", set: { exception_reason: "reorg_before_finality" } });
    await raiseException(t, ctx.env, { kind: "reorg_before_finality", severity: "warning", intentId: intent.id, details: { depositId } });
    return;
  }
  if (wasAccepted || intent.status === "deposit_accepted") {
    // Post-finality reorg: freeze everything downstream; never delete history.
    if (intent.status === "deposit_accepted") await transitionIntent(t, ctx, intent, "chain_reorg_review", { label: "Under review", detail: "An accepted deposit was affected by a chain reorganisation.", set: { exception_reason: "reorg_after_acceptance" } });
    await t.query(`UPDATE merchant_credits SET frozen_from_status=status, status='frozen', updated_at=now(), version=version+1 WHERE intent_id=$1 AND status IN ('credit_prepared','credit_locked','credit_available','withdrawal_reserved')`, [intent.id]);
    const committed = !["not_started", "payout_queued"].includes(intent.payout_status);
    if (intent.mode === "scan_pay" && !committed) await t.query(`UPDATE payment_intents SET payout_status='manual_review' WHERE id=$1`, [intent.id]);
    await raiseException(t, ctx.env, { kind: "reorg_after_acceptance", severity: "urgent", intentId: intent.id, details: { depositId, payoutCommitted: committed } });
  }
}

/** DEMO ONLY: synthesize scanner events for a non-payable demo checkout. */
export async function demoSimulate(ctx: CoreContext, intentId: string, kind: "exact" | "underpaid" | "overpaid" | "advance", confirmations = 0) {
  if (ctx.env !== "demo") throw new DomainError("FEATURE_DEMO_ONLY", "Simulation is only available in the demo environment", undefined, { status: 403 });
  const i = await one<IntentRow & { address: string }>(ctx.db, `SELECT pi.*, za.address FROM payment_intents pi JOIN zcash_addresses za ON za.id=pi.zcash_address_id WHERE pi.id=$1`, [intentId]);
  const q = await one<QuoteRow>(ctx.db, `SELECT * FROM quotes WHERE id=$1`, [i.quote_id]);
  const existing = await maybeOne<{ txid: string; output_ref: string; value_zatoshis: string; confirmations: number }>(ctx.db, `SELECT txid, output_ref, value_zatoshis, confirmations FROM deposit_observations WHERE intent_id=$1 ORDER BY first_seen_at LIMIT 1`, [intentId]);
  let txid: string;
  let value: bigint;
  let conf: number;
  if (kind === "advance") {
    if (!existing) throw new DomainError("STATE_NO_DEPOSIT", "No simulated deposit to confirm", undefined, { status: 409 });
    txid = existing.txid;
    value = BigInt(existing.value_zatoshis);
    conf = existing.confirmations + 1;
  } else {
    if (existing) throw new DomainError("STATE_DEPOSIT_EXISTS", "A simulated deposit already exists", undefined, { status: 409 });
    const due = BigInt(q.zec_zatoshis);
    value = kind === "exact" ? due : kind === "underpaid" ? (due * 9n) / 10n : (due * 11n) / 10n;
    txid = createHash("sha256").update(`demo:${intentId}`).digest("hex");
    conf = confirmations;
  }
  return ingestScannerEvent(
    ctx,
    {
      eventId: `demo:${txid}:${conf}`,
      kind: conf > 0 ? "note_confirmed" : "note_seen",
      network: "demo",
      pool: "demo",
      txid,
      outputRef: `${txid}:0`,
      valueZatoshis: value.toString(),
      address: i.address,
      blockHeight: conf > 0 ? 1_000_000 + conf : null,
      blockHash: conf > 0 ? createHash("sha256").update(`blk:${conf}`).digest("hex") : null,
      confirmations: conf,
      scanVersion: "demo-simulator",
    },
    "demo-simulator",
  );
}
