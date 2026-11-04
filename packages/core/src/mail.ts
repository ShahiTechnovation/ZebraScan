/**
 * Email outbox. Addresses and params (which may contain one-time links) are envelope-encrypted at
 * rest, with AAD bound to the row's address hash + template. Delivery happens in the worker. With
 * no provider configured, rows become 'undeliverable' and the UI states that email is not
 * configured — it never claims a message was sent.
 */
import { many, type Queryable } from "@zeb/db";
import { TEMPLATES, type TemplateName } from "@zeb/providers";
import { sha256Hex } from "@zeb/security";
import type { CoreContext } from "./context";

const aadFor = (toHash: string, template: string) => `email_outbox:${toHash}:${template}`;

export async function queueEmail(q: Queryable, ctx: CoreContext, to: string, template: TemplateName, params: Record<string, string>): Promise<void> {
  const toHash = sha256Hex(to.trim().toLowerCase());
  const aad = aadFor(toHash, template);
  await q.query(`INSERT INTO email_outbox(environment, to_hash, to_ct, template, params_ct) VALUES ($1,$2,$3,$4,$5)`, [
    ctx.env,
    toHash,
    await ctx.envelope.seal(to.trim(), aad),
    template,
    await ctx.envelope.seal(JSON.stringify(params), aad),
  ]);
}

export async function deliverEmails(ctx: CoreContext): Promise<number> {
  const rows = await many<{ id: string; to_ct: string; params_ct: string; template: TemplateName; to_hash: string }>(
    ctx.db,
    `SELECT id, to_ct, params_ct, template, to_hash FROM email_outbox WHERE environment=$1 AND state='queued' ORDER BY id LIMIT 20`,
    [ctx.env],
  );
  for (const r of rows) {
    if (!ctx.email) {
      await ctx.db.query(`UPDATE email_outbox SET state='undeliverable', last_error='no email provider configured' WHERE id=$1`, [r.id]);
      continue;
    }
    try {
      const aad = aadFor(r.to_hash, r.template);
      const to = await ctx.envelope.open(r.to_ct, aad);
      const params = JSON.parse(await ctx.envelope.open(r.params_ct, aad)) as Record<string, string>;
      const t = (TEMPLATES[r.template] as (p: Record<string, string>) => { subject: string; text: string })(params);
      await ctx.email.send({ to, subject: t.subject, text: t.text });
      await ctx.db.query(`UPDATE email_outbox SET state='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [r.id]);
    } catch (e) {
      await ctx.db.query(`UPDATE email_outbox SET attempts=attempts+1, last_error=$2, state=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END WHERE id=$1`, [r.id, (e as Error).message.slice(0, 200)]);
    }
  }
  return rows.length;
}
