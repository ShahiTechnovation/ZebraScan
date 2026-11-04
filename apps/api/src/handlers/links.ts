import { many, maybeOne, one } from "@zeb/db";
import { deriveLinkStatus, DomainError, newId, newSlug, notFound } from "@zeb/domain";
import { audit, type CoreContext } from "@zeb/core";
import type { Handler, Req, AnyReq } from "../http";
import { decodeCursor, encodeCursor } from "./paging";

interface LinkRow {
  id: string;
  merchant_id: string;
  slug: string;
  title: string;
  description: string;
  reference: string;
  amount_mode: "fixed" | "variable";
  fixed_inr_paise: string | null;
  min_inr_paise: string | null;
  max_inr_paise: string | null;
  reusable: boolean;
  use_limit: number | null;
  successful_uses: number;
  expires_at: Date | null;
  allow_note: boolean;
  revoked_at: Date | null;
  duplicated_from: string | null;
  views: string;
  created_at: Date;
  version: number;
}

const status = (l: LinkRow, now: Date) => deriveLinkStatus({ revokedAt: l.revoked_at, expiresAt: l.expires_at, useLimit: l.reusable ? l.use_limit : 1, successfulUses: l.successful_uses }, now);

export function linkDto(ctx: CoreContext, l: LinkRow) {
  return {
    id: l.id,
    merchantId: l.merchant_id,
    slug: l.slug,
    url: `${ctx.cfg.appBaseUrl}/pay/${l.slug}`,
    title: l.title,
    description: l.description,
    reference: l.reference,
    amountMode: l.amount_mode,
    fixedInrPaise: l.fixed_inr_paise,
    minInrPaise: l.min_inr_paise,
    maxInrPaise: l.max_inr_paise,
    reusable: l.reusable,
    useLimit: l.use_limit,
    successfulUses: l.successful_uses,
    expiresAt: l.expires_at ? new Date(l.expires_at).toISOString() : null,
    allowNote: l.allow_note,
    status: status(l, ctx.now()),
    revokedAt: l.revoked_at ? new Date(l.revoked_at).toISOString() : null,
    duplicatedFrom: l.duplicated_from,
    views: Number(l.views),
    createdAt: new Date(l.created_at).toISOString(),
    version: l.version,
  };
}

async function mine(req: AnyReq, id: string): Promise<LinkRow> {
  const l = await maybeOne<LinkRow>(req.ctx.db, `SELECT * FROM payment_links WHERE id=$1 AND merchant_id=$2 AND environment=$3`, [id, req.principal!.merchant!.id, req.ctx.env]);
  if (!l) throw notFound("payment link", id);
  return l;
}

interface LinkInput {
  title: string;
  description: string;
  reference: string;
  amountMode: "fixed" | "variable";
  fixedInrPaise?: string;
  minInrPaise?: string;
  maxInrPaise?: string;
  reusable: boolean;
  useLimit: number | null;
  expiresAt: string | null;
  allowNote: boolean;
}

function validateLink(ctx: CoreContext, b: LinkInput) {
  const p = ctx.cfg.policy;
  const inRange = (v: bigint) => v >= p.minInrPaise && v <= p.maxInrPaise;
  if (b.amountMode === "fixed") {
    if (!b.fixedInrPaise) throw new DomainError("VALIDATION_LINK_AMOUNT", "Fixed links need an amount");
    if (!inRange(BigInt(b.fixedInrPaise))) throw new DomainError("VALIDATION_LINK_AMOUNT", "Amount is outside the allowed payment range");
    if (b.minInrPaise || b.maxInrPaise) throw new DomainError("VALIDATION_LINK_AMOUNT", "Fixed links cannot have min/max");
  } else {
    if (b.fixedInrPaise) throw new DomainError("VALIDATION_LINK_AMOUNT", "Variable links cannot have a fixed amount");
    const min = b.minInrPaise ? BigInt(b.minInrPaise) : p.minInrPaise;
    const max = b.maxInrPaise ? BigInt(b.maxInrPaise) : p.maxInrPaise;
    if (!inRange(min) || !inRange(max) || min > max) throw new DomainError("VALIDATION_LINK_AMOUNT", "Min/max must be within the allowed range and min ≤ max");
  }
  if (b.expiresAt && new Date(b.expiresAt) <= ctx.now()) throw new DomainError("VALIDATION_LINK_EXPIRY", "Expiry must be in the future");
}

export const createLink: Handler = async (req: Req<object, object, LinkInput>) => {
  const { ctx, body: b } = req;
  validateLink(ctx, b);
  const l = await one<LinkRow>(
    ctx.db,
    `INSERT INTO payment_links(id, environment, merchant_id, slug, title, description, reference, amount_mode, fixed_inr_paise, min_inr_paise, max_inr_paise, reusable, use_limit, expires_at, allow_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [newId("link"), ctx.env, req.principal!.merchant!.id, newSlug(10), b.title.trim(), b.description.trim(), b.reference.trim(), b.amountMode, b.fixedInrPaise ?? null, b.minInrPaise ?? null, b.maxInrPaise ?? null, b.reusable, b.reusable ? b.useLimit : 1, b.expiresAt, b.allowNote],
  );
  await audit(ctx.db, ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "link.create", target: l.id, requestId: req.requestId });
  return linkDto(ctx, l);
};

export const listLinks: Handler = async (req: Req<object, { cursor?: string; limit: number }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<LinkRow>(
    req.ctx.db,
    `SELECT * FROM payment_links WHERE merchant_id=$1 AND environment=$2 AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4)) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [req.principal!.merchant!.id, req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  return { items: page.map((l) => linkDto(req.ctx, l)), nextCursor: rows.length > req.query.limit ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null };
};

export const getLink: Handler = async (req: Req<{ id: string }>) => linkDto(req.ctx, await mine(req, req.params.id));

export const updateLink: Handler = async (req: Req<{ id: string }, object, { expectedVersion: number; title?: string; description?: string; reference?: string; allowNote?: boolean }>) => {
  await mine(req, req.params.id);
  const sets = ["version=version+1", "updated_at=now()"];
  const vals: unknown[] = [req.params.id, req.body.expectedVersion];
  for (const [k, col] of [["title", "title"], ["description", "description"], ["reference", "reference"], ["allowNote", "allow_note"]] as const) {
    const v = req.body[k];
    if (v !== undefined) {
      vals.push(typeof v === "string" ? v.trim() : v);
      sets.push(`${col}=$${vals.length}`);
    }
  }
  const r = await req.ctx.db.query<LinkRow>(`UPDATE payment_links SET ${sets.join(", ")} WHERE id=$1 AND version=$2 RETURNING *`, vals);
  if (r.rowCount !== 1) throw new DomainError("STATE_VERSION_CONFLICT", "Link changed elsewhere; reload and retry", undefined, { status: 409 });
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "link.update", target: req.params.id, requestId: req.requestId });
  return linkDto(req.ctx, r.rows[0]!);
};

export const revokeLink: Handler = async (req: Req<{ id: string }>) => {
  const l = await mine(req, req.params.id);
  // Revocation blocks NEW checkouts only; existing/in-flight checkouts and deposits are untouched.
  const r = l.revoked_at ? l : await one<LinkRow>(req.ctx.db, `UPDATE payment_links SET revoked_at=now(), version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [l.id]);
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "link.revoke", target: l.id, requestId: req.requestId });
  return linkDto(req.ctx, r);
};

export const duplicateLink: Handler = async (req: Req<{ id: string }>) => {
  const l = await mine(req, req.params.id);
  const d = await one<LinkRow>(
    req.ctx.db,
    `INSERT INTO payment_links(id, environment, merchant_id, slug, title, description, reference, amount_mode, fixed_inr_paise, min_inr_paise, max_inr_paise, reusable, use_limit, expires_at, allow_note, duplicated_from)
     SELECT $2, environment, merchant_id, $3, title || ' (copy)', description, reference, amount_mode, fixed_inr_paise, min_inr_paise, max_inr_paise, reusable, use_limit,
            CASE WHEN expires_at IS NOT NULL AND expires_at <= now() THEN NULL ELSE expires_at END, allow_note, id
       FROM payment_links WHERE id=$1 RETURNING *`,
    [l.id, newId("link"), newSlug(10)],
  );
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "link.duplicate", target: d.id, details: { from: l.id }, requestId: req.requestId });
  return linkDto(req.ctx, d);
};

export const getPublicLink: Handler = async (req: Req<{ slug: string }>) => {
  const { ctx } = req;
  const l = await maybeOne<LinkRow & { m_display: string; m_handle: string; m_status: string; m_logo: string | null }>(
    ctx.db,
    `SELECT l.*, m.display_name AS m_display, m.handle AS m_handle, m.status AS m_status, m.logo_url AS m_logo FROM payment_links l JOIN merchants m ON m.id=l.merchant_id WHERE l.slug=$1 AND l.environment=$2`,
    [req.params.slug, ctx.env],
  );
  if (!l) throw notFound("payment link");
  // Opening the link is a view, not a use.
  void ctx.db.query(`UPDATE payment_links SET views=views+1 WHERE id=$1`, [l.id]).catch(() => undefined);
  return {
    slug: l.slug,
    title: l.title,
    description: l.description,
    amountMode: l.amount_mode,
    fixedInrPaise: l.fixed_inr_paise,
    minInrPaise: l.min_inr_paise ?? ctx.cfg.policy.minInrPaise.toString(),
    maxInrPaise: l.max_inr_paise ?? ctx.cfg.policy.maxInrPaise.toString(),
    allowNote: l.allow_note,
    status: status(l, ctx.now()),
    expiresAt: l.expires_at ? new Date(l.expires_at).toISOString() : null,
    merchant: { displayName: l.m_display, handle: l.m_handle, verified: l.m_status === "verified", logoUrl: l.m_logo },
    label: ctx.caps.label,
  };
};
