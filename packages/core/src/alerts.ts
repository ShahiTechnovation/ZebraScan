import { randomToken } from "@zeb/domain";
import type { CoreContext } from "./context";

/** At-least-once delivery. The receiver must dedupe Idempotency-Key; an ack is required. */
export async function deliverOutbox(ctx: CoreContext, target = process.env.ALERT_WEBHOOK_URL, bearer = process.env.ALERT_WEBHOOK_TOKEN): Promise<number> {
  if (!target) return 0; // retain pending events; never pretend an alert was delivered
  const url = new URL(target);
  if (url.protocol !== "https:" && !(ctx.env === "demo" && url.protocol === "http:" && ["127.0.0.1","localhost"].includes(url.hostname))) throw new Error("Alert delivery requires HTTPS (loopback allowed only in isolated tests)");
  const lease = randomToken(16);
  const rows = await ctx.db.query<{id:string;event_type:string;aggregate_type:string;aggregate_id:string}>(`UPDATE outbox_events SET delivery_lease=$2,lease_until=now()+interval '60 seconds',delivery_attempts=delivery_attempts+1
    WHERE id IN (SELECT id FROM outbox_events WHERE environment=$1 AND dispatched_at IS NULL AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
    RETURNING id,event_type,aggregate_type,aggregate_id`,[ctx.env,lease]);
  let delivered=0;
  for (const row of rows.rows) {
    try {
      const r = await fetch(url,{method:"POST",redirect:"error",headers:{"content-type":"application/json","idempotency-key":`zeb:${ctx.env}:${row.id}`,...(bearer?{authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify({id:row.id,environment:ctx.env,type:row.event_type,resourceType:row.aggregate_type,resourceId:row.aggregate_id}),signal:AbortSignal.timeout(5000)});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await ctx.db.query(`UPDATE outbox_events SET dispatched_at=now(),delivery_lease=NULL,lease_until=NULL,delivery_error=NULL WHERE id=$1 AND delivery_lease=$2`,[row.id,lease]);
      delivered++;
    } catch {
      await ctx.db.query(`UPDATE outbox_events SET delivery_lease=NULL,lease_until=NULL,retry_at=now()+interval '60 seconds',delivery_error='delivery failed; retry scheduled' WHERE id=$1 AND delivery_lease=$2`,[row.id,lease]);
    }
  }
  return delivered;
}
