/**
 * Transactional side effects written in the SAME transaction as a state change:
 *  - resource_events: the SSE stream (monotonic id; Last-Event-ID replay)
 *  - outbox_events:   durable integration events for the worker
 *  - jobs:            durable, leased work items (Postgres is the authority, not a queue)
 *  - audit_log / exceptions
 */
import type { Queryable } from "@zeb/db";
import { maybeOne } from "@zeb/db";
import { newId, type Environment } from "@zeb/domain";
import { redact } from "@zeb/security";

export async function emitResource(q: Queryable, env: Environment, resource: string, type: string, data: Record<string, unknown>): Promise<void> {
  await q.query(`INSERT INTO resource_events(environment, resource, event_type, data) VALUES ($1,$2,$3,$4)`, [env, resource, type, JSON.stringify(data)]);
  await q.query(`SELECT pg_notify('zeb_events', $1)`, [resource]);
}

export async function outbox(q: Queryable, env: Environment, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await q.query(`INSERT INTO outbox_events(environment, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)`, [
    env,
    aggregateType,
    aggregateId,
    eventType,
    JSON.stringify(payload),
  ]);
}

/** Enqueue (or keep) a job. Dedupe on (env, kind, key) among active jobs. */
export async function enqueueJob(q: Queryable, env: Environment, kind: string, dedupeKey: string, payload: Record<string, unknown> = {}, runAt?: Date): Promise<void> {
  await q.query(
    `INSERT INTO jobs(id, environment, kind, dedupe_key, payload, run_at) VALUES ($1,$2,$3,$4,$5,coalesce($6, now()))
     ON CONFLICT (environment, kind, dedupe_key) WHERE state IN ('queued','running','failed','paused')
     DO UPDATE SET run_at = LEAST(jobs.run_at, EXCLUDED.run_at), updated_at = now()`,
    [newId("job"), env, kind, dedupeKey, JSON.stringify(payload), runAt ?? null],
  );
}

export async function audit(
  q: Queryable,
  env: Environment,
  a: { actorType: "user" | "operator" | "system" | "payer" | "service"; actorId?: string | null; action: string; target?: string | null; details?: Record<string, unknown>; requestId?: string | null; ipHash?: string | null },
): Promise<void> {
  await q.query(`INSERT INTO audit_log(environment, actor_type, actor_id, action, target, details, request_id, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    env,
    a.actorType,
    a.actorId ?? null,
    a.action,
    a.target ?? null,
    JSON.stringify(redact(a.details ?? {})),
    a.requestId ?? null,
    a.ipHash ?? null,
  ]);
}

export async function raiseException(
  q: Queryable,
  env: Environment,
  e: { kind: string; severity: "info" | "warning" | "urgent"; intentId?: string | null; withdrawalId?: string | null; orderId?: string | null; depositId?: string | null; details?: Record<string, unknown> },
): Promise<string> {
  const existing = await maybeOne<{ id: string }>(
    q,
    `SELECT id FROM exceptions WHERE environment=$1 AND kind=$2 AND coalesce(intent_id,'')=coalesce($3,'') AND coalesce(withdrawal_id,'')=coalesce($4,'') AND coalesce(order_id,'')=coalesce($5,'') AND coalesce(deposit_id,'')=coalesce($6,'') AND status='open'`,
    [env, e.kind, e.intentId ?? null, e.withdrawalId ?? null, e.orderId ?? null, e.depositId ?? null],
  );
  if (existing) return existing.id;
  const id = newId("event").replace(/^evt_/, "exc_");
  await q.query(
    `INSERT INTO exceptions(id, environment, kind, severity, intent_id, withdrawal_id, order_id, deposit_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, env, e.kind, e.severity, e.intentId ?? null, e.withdrawalId ?? null, e.orderId ?? null, e.depositId ?? null, JSON.stringify(redact(e.details ?? {}))],
  );
  await outbox(q, env, "exception", id, `alert.${e.severity}.${e.kind}`, {});
  return id;
}
