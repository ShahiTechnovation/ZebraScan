/**
 * Merchant credit cooldown (spec §9.3). The unlock worker is idempotent and re-checks, per credit:
 * no open exception/dispute on the payment, deposit still canonical, merchant eligible, backing held.
 */
import { maybeOne, tx } from "@zeb/db";
import { creditMachine, type CreditStatus } from "@zeb/domain";
import { postJournal, treasury } from "@zeb/ledger";
import { usesTreasury, type CoreContext } from "./context";
import { emitResource, enqueueJob } from "./events";

export async function unlockCredit(ctx: CoreContext, creditId: string): Promise<"unlocked" | "not_due" | "blocked" | "noop"> {
  return tx(ctx.db, async (t) => {
    const c = await maybeOne<{ id: string; merchant_id: string; intent_id: string | null; status: CreditStatus; unlocks_at: Date; amount_inr_paise: string; version: number }>(
      t,
      `SELECT id, merchant_id, intent_id, status, unlocks_at, amount_inr_paise, version FROM merchant_credits WHERE id=$1 AND environment=$2 FOR UPDATE`,
      [creditId, ctx.env],
    );
    if (!c || c.status !== "credit_locked") return "noop";
    const now = ctx.now();
    if (new Date(c.unlocks_at) > now) {
      await enqueueJob(t, ctx.env, "credit.unlock", creditId, { creditId }, new Date(c.unlocks_at));
      return "not_due";
    }
    const blockers: string[] = [];
    if (c.intent_id) {
      const exc = await maybeOne(t, `SELECT 1 FROM exceptions WHERE intent_id=$1 AND status='open' AND severity <> 'info'`, [c.intent_id]);
      if (exc) blockers.push("open exception");
      const reorged = await maybeOne(t, `SELECT 1 FROM deposit_observations WHERE intent_id=$1 AND accepted AND NOT canonical`, [c.intent_id]);
      if (reorged) blockers.push("deposit no longer canonical");
    }
    const m = await maybeOne<{ status: string }>(t, `SELECT status FROM merchants WHERE id=$1`, [c.merchant_id]);
    if (!m || ["suspended", "closed"].includes(m.status)) blockers.push(`merchant ${m?.status ?? "missing"}`);
    if (usesTreasury(ctx)) {
      const backing = await treasury.activeAllocation(t, ctx.env, c.id, false);
      if (!backing) blockers.push("no treasury backing");
    }
    if (blockers.length) {
      await enqueueJob(t, ctx.env, "credit.unlock", creditId, { creditId, blockers }, new Date(now.getTime() + 3_600_000));
      return "blocked";
    }
    creditMachine.assert("credit_locked", "credit_available");
    await t.query(`UPDATE merchant_credits SET status='credit_available', available_at=$2, updated_at=now(), version=version+1 WHERE id=$1`, [c.id, now]);
    await postJournal(t, ctx.env, {
      eventId: `credit_unlock:${c.id}`,
      kind: "credit_available",
      memo: `Cooldown ended for ${c.id}`,
      lines: [
        { account: "merchant_credits_locked", merchantId: c.merchant_id, debit: BigInt(c.amount_inr_paise) },
        { account: "merchant_credits_available", merchantId: c.merchant_id, credit: BigInt(c.amount_inr_paise) },
      ],
    });
    await emitResource(t, ctx.env, `merchant:${c.merchant_id}`, "credit.available", { creditId: c.id });
    return "unlocked";
  });
}
