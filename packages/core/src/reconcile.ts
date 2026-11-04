/**
 * Treasury inventory refresh and reconciliation (spec §9.2). Discrepancies outside tolerance pause
 * new payouts/withdrawals (system gate) and raise an urgent exception; they never auto-correct.
 */
import { many, maybeOne, one, tx } from "@zeb/db";
import { newId } from "@zeb/domain";
import { accountBalance, findUnbalancedJournals, treasury } from "@zeb/ledger";
import type { Address } from "viem";
import type { CoreContext } from "./context";
import { audit, raiseException } from "./events";

export async function refreshInventory(ctx: CoreContext): Promise<{ usdc?: string; eth?: string; skipped?: string }> {
  if (ctx.env === "demo") {
    const has = await maybeOne(ctx.db, `SELECT 1 FROM treasury_inventory WHERE environment='demo' AND asset='USDC_BASE'`);
    if (!has) await treasury.recordInventory(ctx.db, "demo", "USDC_BASE", 25_000_000_000n, "demo:simulated-25000-usdc");
    return { skipped: "demo uses a simulated 25,000 USDC inventory" };
  }
  if (!ctx.p2p || !ctx.cfg.treasuryAddress) return { skipped: "P2P client or TREASURY_ADDRESS not configured" };
  const addr = ctx.cfg.treasuryAddress as Address;
  const [usdc, eth, block] = await Promise.all([ctx.p2p.usdcBalance(addr), ctx.p2p.publicClient.getBalance({ address: addr }), ctx.p2p.publicClient.getBlockNumber()]);
  await treasury.recordInventory(ctx.db, ctx.env, "USDC_BASE", usdc, `base_rpc:balanceOf:${ctx.p2p.cfg.chainId}`, block.toString());
  await treasury.recordInventory(ctx.db, ctx.env, "ETH_BASE_GAS", eth, `base_rpc:getBalance:${ctx.p2p.cfg.chainId}`, block.toString());
  return { usdc: usdc.toString(), eth: eth.toString() };
}

export interface ReconResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; status: "PASS" | "FAIL" | "BLOCKED"; detail: string }>;
}

export async function reconcile(ctx: CoreContext, kind = "periodic"): Promise<ReconResult> {
  const env = ctx.env;
  const runId = newId("audit").replace(/^aud_/, "rec_");
  await ctx.db.query(`INSERT INTO reconciliation_runs(id, environment, kind) VALUES ($1,$2,$3)`, [runId, env, kind]);
  const checks: ReconResult["checks"] = [];
  const add = (name: string, ok: boolean, detail: string, blocked = false) => checks.push({ name, ok, status: blocked ? "BLOCKED" : ok ? "PASS" : "FAIL", detail });

  const unbalanced = await findUnbalancedJournals(ctx.db, env);
  add("ledger_balanced", unbalanced.length === 0, unbalanced.length ? `unbalanced journals: ${unbalanced.slice(0, 5).join(",")}` : "all journals balanced per currency");

  const cap = await treasury.treasuryCapacity(ctx.db, env, { inventoryMaxAgeMs: ctx.cfg.policy.treasuryInventoryMaxAgeSec * 1000, bufferMicros: 0n }, ctx.now());
  // A stale/unknown inventory is not a ledger discrepancy: it already blocks new holds and closes
  // receiving via readiness. Only a fresh observation that is BELOW active allocations is.
  if (cap.stale) add("allocations_within_inventory", false, `USDC inventory not freshly observed (active ${cap.activeMicros})`, true);
  else add("allocations_within_inventory", cap.activeMicros <= cap.inventoryMicros, `active ${cap.activeMicros} vs inventory ${cap.inventoryMicros}`);

  // Merchant liability per status: ledger vs credits table.
  const led = await many<{ code: string; bal: string }>(
    ctx.db,
    `SELECT a.code, sum(p.credit_minor) - sum(p.debit_minor) AS bal FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
      WHERE a.environment=$1 AND a.code IN ('merchant_credits_locked','merchant_credits_available','merchant_credits_withdrawal_reserved') GROUP BY a.code`,
    [env],
  );
  const cr = await many<{ status: string; total: string }>(ctx.db, `SELECT status, sum(amount_inr_paise) AS total FROM merchant_credits WHERE environment=$1 GROUP BY status`, [env]);
  const ledOf = (c: string) => BigInt(led.find((r) => r.code === c)?.bal ?? "0");
  const crOf = (s: string) => BigInt(cr.find((r) => r.status === s)?.total ?? "0");
  const frozen = crOf("frozen");
  const lockedOk = ledOf("merchant_credits_locked") === crOf("credit_locked") + crOf("credit_prepared");
  const availOk = ledOf("merchant_credits_available") === crOf("credit_available");
  const resOk = ledOf("merchant_credits_withdrawal_reserved") === crOf("withdrawal_reserved");
  add(
    "merchant_liability_matches_credits",
    lockedOk && availOk && resOk,
    `locked ${ledOf("merchant_credits_locked")}/${crOf("credit_locked")}, available ${ledOf("merchant_credits_available")}/${crOf("credit_available")}, reserved ${ledOf("merchant_credits_withdrawal_reserved")}/${crOf("withdrawal_reserved")}${frozen > 0n ? `, frozen ${frozen} under review` : ""}`,
  );

  // Every accepted merchant intent has exactly one original credit (or a refund route).
  const orphan = await one<{ n: string }>(
    ctx.db,
    `SELECT count(*) AS n FROM payment_intents pi WHERE pi.environment=$1 AND pi.environment<>'testnet' AND pi.mode <> 'scan_pay' AND pi.status='deposit_accepted'
       AND NOT EXISTS (SELECT 1 FROM merchant_credits c WHERE c.intent_id=pi.id AND c.parent_credit_id IS NULL)`,
    [env],
  );
  add("accepted_deposits_have_credits", orphan.n === "0", `${orphan.n} accepted merchant payments without a credit`);

  // Escrow ledger vs orders currently paid on chain.
  const escrowLedger = await accountBalance(ctx.db, env, "usdc_in_p2p_escrow");
  const escrowOrders = await one<{ total: string | null }>(
    ctx.db,
    `SELECT sum(o.actual_usdc_micros) AS total FROM p2p_orders o WHERE o.environment=$1 AND EXISTS (SELECT 1 FROM ledger_journals j WHERE j.environment=$1 AND j.event_id='escrow:'||o.id)
       AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.environment=$1 AND (j.event_id='settle:'||o.id OR j.event_id='escrow_return:'||o.id))`,
    [env],
  );
  add("escrow_matches_orders", escrowLedger === BigInt(escrowOrders.total ?? "0"), `ledger ${escrowLedger} vs open escrowed orders ${escrowOrders.total ?? 0}`);
  const unverified = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM payout_commands c WHERE c.environment=$1 AND c.state='RECONCILED' AND NOT EXISTS (SELECT 1 FROM payout_settlement_evidence e WHERE e.payout_id=c.id AND e.outcome='delivered' AND e.command_hash=c.command_hash)`, [env]);
  add("payouts_have_independent_evidence", unverified.n === "0", `${unverified.n} finalized payouts without independent evidence`);
  const reorgs = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM deposit_observations WHERE environment=$1 AND accepted AND NOT canonical`, [env]);
  add("accepted_deposits_canonical", reorgs.n === "0", `${reorgs.n} accepted noncanonical outputs`);

  const ok = checks.every((c) => c.ok);
  await tx(ctx.db, async (t) => {
    await t.query(`UPDATE reconciliation_runs SET finished_at=now(), ok=$2, result=$3 WHERE id=$1`, [runId, ok, JSON.stringify({ checks })]);
    if (checks.some((c) => c.status === "FAIL")) {
      for (const f of ["scanPay", "withdrawals"]) {
        await t.query(
          `INSERT INTO feature_gates(environment, feature, enabled, reason, updated_by) VALUES ($1,$2,false,$3,'system:reconciliation')
           ON CONFLICT (environment, feature) DO UPDATE SET enabled=false, reason=EXCLUDED.reason, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [env, f, `Reconciliation discrepancy (${runId})`],
        );
      }
      await raiseException(t, env, { kind: "reconciliation_discrepancy", severity: "urgent", details: { runId, failed: checks.filter((c) => !c.ok).map((c) => c.name) } });
      await audit(t, env, { actorType: "system", action: "reconcile.freeze", target: runId });
    }
  });
  return { ok, checks };
}
