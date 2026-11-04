/**
 * USDC treasury reservations (spec §9.2). Guarantees, under a per-environment transaction-scoped
 * advisory lock:
 *     sum(active held + in_flight) + policy buffer <= latest chain-confirmed USDC inventory
 * and at most one active allocation per economic obligation (unique partial index).
 * Allocations are converted (quote_hold -> deposit_hold -> direct_payout / merchant_credit_backing
 * -> withdrawal) by closing the old row and opening the new one in the same transaction, so an
 * obligation is never reserved twice and never left unreserved mid-flight.
 */
import type { Queryable } from "@zeb/db";
import { maybeOne, one } from "@zeb/db";
import { DomainError, newId, type Environment } from "@zeb/domain";

export type AllocationPurpose = "quote_hold" | "deposit_hold" | "merchant_credit_backing" | "direct_payout" | "withdrawal" | "refund" | "risk_buffer";
export type AllocationState = "held" | "in_flight" | "consumed" | "released";

export interface Allocation {
  id: string;
  purpose: AllocationPurpose;
  obligation_id: string;
  amount_micros: string;
  state: AllocationState;
  expires_at: Date | null;
}

export interface CapacityPolicy {
  /** Max age of the inventory observation before it is considered stale. */
  inventoryMaxAgeMs: number;
  /** Fixed buffer kept unallocated (micros). */
  bufferMicros: bigint;
}

export interface Capacity {
  inventoryMicros: bigint;
  inventoryObservedAt: Date | null;
  activeMicros: bigint;
  bufferMicros: bigint;
  freeMicros: bigint;
  stale: boolean;
}

async function lockTreasury(q: Queryable, env: Environment) {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`zeb-treasury:${env}`]);
}

export async function treasuryCapacity(q: Queryable, env: Environment, policy: CapacityPolicy, now = new Date()): Promise<Capacity> {
  const inv = await maybeOne<{ amount_minor: string; observed_at: Date }>(
    q,
    `SELECT amount_minor, observed_at FROM treasury_inventory WHERE environment=$1 AND asset='USDC_BASE' ORDER BY observed_at DESC LIMIT 1`,
    [env],
  );
  const act = await one<{ total: string | null }>(
    q,
    `SELECT sum(amount_micros) AS total FROM treasury_allocations WHERE environment=$1 AND state IN ('held','in_flight')`,
    [env],
  );
  const inventoryMicros = BigInt(inv?.amount_minor ?? "0");
  const activeMicros = BigInt(act.total ?? "0");
  const stale = !inv || now.getTime() - new Date(inv.observed_at).getTime() > policy.inventoryMaxAgeMs;
  const free = inventoryMicros - activeMicros - policy.bufferMicros;
  return { inventoryMicros, inventoryObservedAt: inv?.observed_at ?? null, activeMicros, bufferMicros: policy.bufferMicros, freeMicros: free, stale };
}

export async function hold(
  q: Queryable,
  env: Environment,
  a: { purpose: AllocationPurpose; obligationId: string; amountMicros: bigint; expiresAt?: Date | null },
  policy: CapacityPolicy,
): Promise<Allocation> {
  if (a.amountMicros <= 0n) throw new DomainError("LIQUIDITY_AMOUNT", "allocation must be positive");
  await lockTreasury(q, env);
  const cap = await treasuryCapacity(q, env, policy);
  if (cap.stale) throw new DomainError("LIQUIDITY_INVENTORY_STALE", "USDC treasury balance has not been verified recently; new holds are paused", undefined, { retryable: true });
  if (cap.freeMicros < a.amountMicros) {
    throw new DomainError("LIQUIDITY_INSUFFICIENT", "Treasury cannot back this payment right now", { freeMicros: cap.freeMicros.toString() }, { retryable: true });
  }
  try {
    return await one<Allocation>(
      q,
      `INSERT INTO treasury_allocations(id, environment, purpose, obligation_id, amount_micros, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,'held',$6) RETURNING id, purpose, obligation_id, amount_micros, state, expires_at`,
      [newId("allocation"), env, a.purpose, a.obligationId, a.amountMicros.toString(), a.expiresAt ?? null],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw new DomainError("LIQUIDITY_DUPLICATE_HOLD", "obligation already has an active allocation", { obligationId: a.obligationId }, { status: 409 });
    }
    throw e;
  }
}

export async function activeAllocation(q: Queryable, env: Environment, obligationId: string, forUpdate = true): Promise<Allocation | null> {
  return maybeOne<Allocation>(
    q,
    `SELECT id, purpose, obligation_id, amount_micros, state, expires_at FROM treasury_allocations
      WHERE environment=$1 AND obligation_id=$2 AND state IN ('held','in_flight') ${forUpdate ? "FOR UPDATE" : ""}`,
    [env, obligationId],
  );
}

/**
 * Convert the active allocation of `fromObligation` into a new purpose/obligation (possibly with a
 * new amount). Amount increases go through the capacity check; decreases release the difference.
 */
export async function convert(
  q: Queryable,
  env: Environment,
  fromObligation: string,
  to: { purpose: AllocationPurpose; obligationId: string; amountMicros: bigint; expiresAt?: Date | null; state?: "held" | "in_flight" },
  policy: CapacityPolicy,
): Promise<Allocation> {
  await lockTreasury(q, env);
  const cur = await activeAllocation(q, env, fromObligation);
  if (!cur) throw new DomainError("LIQUIDITY_NO_HOLD", "no active treasury allocation to convert", { obligationId: fromObligation }, { status: 409 });
  const delta = to.amountMicros - BigInt(cur.amount_micros);
  if (delta > 0n) {
    const cap = await treasuryCapacity(q, env, policy);
    if (cap.freeMicros < delta) throw new DomainError("LIQUIDITY_INSUFFICIENT", "Treasury cannot extend this hold", undefined, { retryable: true });
  }
  const next = await one<Allocation>(
    q,
    `INSERT INTO treasury_allocations(id, environment, purpose, obligation_id, amount_micros, state, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, purpose, obligation_id, amount_micros, state, expires_at`,
    // insert first under a temporary obligation suffix is unnecessary: close old row first when same obligation
    [newId("allocation"), env, to.purpose, to.obligationId === fromObligation ? `${to.obligationId}#pending` : to.obligationId, to.amountMicros.toString(), to.state ?? "held", to.expiresAt ?? null],
  );
  await q.query(`UPDATE treasury_allocations SET state='consumed', converted_to=$2, updated_at=now(), version=version+1 WHERE id=$1`, [cur.id, next.id]);
  if (to.obligationId === fromObligation) {
    await q.query(`UPDATE treasury_allocations SET obligation_id=$2 WHERE id=$1`, [next.id, to.obligationId]);
    next.obligation_id = to.obligationId;
  }
  return next;
}

export async function setState(q: Queryable, env: Environment, obligationId: string, state: "in_flight" | "consumed" | "released"): Promise<Allocation | null> {
  const cur = await activeAllocation(q, env, obligationId);
  if (!cur) return null;
  await q.query(`UPDATE treasury_allocations SET state=$2, updated_at=now(), version=version+1 WHERE id=$1`, [cur.id, state]);
  return { ...cur, state };
}

export async function recordInventory(q: Queryable, env: Environment, asset: "USDC_BASE" | "ZEC" | "ETH_BASE_GAS", amount: bigint, source: string, blockRef?: string) {
  await q.query(`INSERT INTO treasury_inventory(environment, asset, amount_minor, source, block_ref) VALUES ($1,$2,$3,$4,$5)`, [env, asset, amount.toString(), source, blockRef ?? null]);
}
