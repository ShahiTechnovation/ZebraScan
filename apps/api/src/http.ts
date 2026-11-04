/**
 * HTTP plumbing: principal resolution (session cookie / scoped bearer / internal HMAC), CSRF,
 * origin checks, step-up, idempotency, Zod validation of input AND output, RFC 7807-style errors.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { maybeOne } from "@zeb/db";
import { DomainError, randomToken } from "@zeb/domain";
import { canonicalJson, merchantCan, operatorCan, safeEqual, sha256Hex, type MerchantPermission, type MerchantRole, type OperatorPermission, type OperatorRole } from "@zeb/security";
import type { CoreContext } from "@zeb/core";
import type { RouteDef } from "@zeb/contracts";

export const SESSION_COOKIE = "zeb_session";
export const ANON_COOKIE = "zeb_anon";

export interface Principal {
  userId: string;
  sessionId: string;
  realm: "merchant" | "operator";
  email: string | null;
  emailVerified: boolean;
  csrfHash: string;
  stepUpAt: Date | null;
  mfaAt: Date | null;
  merchant: { id: string; role: MerchantRole } | null;
  operatorRoles: OperatorRole[];
}

export interface Req<P = Record<string, string>, Q = Record<string, unknown>, B = unknown> {
  ctx: CoreContext;
  def: RouteDef;
  params: P;
  query: Q;
  body: B;
  principal: Principal | null;
  /** Anonymous payer correlation id (cookie) — never an identity. */
  anonId: string;
  bearer: string | null;
  requestId: string;
  ipHash: string;
  userAgent: string | null;
  raw: FastifyRequest;
  reply: FastifyReply;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReq = Req<any, any, any>;
export type Handler = (req: AnyReq) => Promise<unknown>;

/** Per-session CSRF token: HMAC(secret, sessionId). Stable across tabs; DB stores only its sha256. */
export function csrfFor(ctx: CoreContext, sessionId: string): string {
  return createHmac("sha256", ctx.cfg.tokenSecret).update(`csrf:${sessionId}`).digest("base64url");
}

export function ipHash(ctx: CoreContext, ip: string): string {
  return createHmac("sha256", ctx.cfg.tokenSecret).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

export async function resolvePrincipal(ctx: CoreContext, raw: FastifyRequest): Promise<Principal | null> {
  const token = raw.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const s = await maybeOne<{ id: string; user_id: string; realm: "merchant" | "operator"; csrf_hash: string; step_up_at: Date | null; mfa_at: Date | null; expires_at: Date; email: string | null; email_verified_at: Date | null; disabled_at: Date | null }>(
    ctx.db,
    `SELECT s.id, s.user_id, s.realm, s.csrf_hash, s.step_up_at, s.mfa_at, s.expires_at, u.email, u.email_verified_at, u.disabled_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=$1 AND s.environment=$2 AND s.revoked_at IS NULL`,
    [sha256Hex(token), ctx.env],
  );
  if (!s || new Date(s.expires_at) < ctx.now() || s.disabled_at) return null;
  // Touch at most once a minute.
  void ctx.db.query(`UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'`, [s.id]).catch(() => undefined);
  let merchant: Principal["merchant"] = null;
  let operatorRoles: OperatorRole[] = [];
  if (s.realm === "merchant") {
    const m = await maybeOne<{ merchant_id: string; role: MerchantRole }>(
      ctx.db,
      `SELECT mm.merchant_id, mm.role FROM merchant_members mm JOIN merchants m ON m.id=mm.merchant_id WHERE mm.user_id=$1 AND mm.removed_at IS NULL AND m.environment=$2 AND m.status <> 'closed' ORDER BY mm.created_at LIMIT 1`,
      [s.user_id, ctx.env],
    );
    if (m) merchant = { id: m.merchant_id, role: m.role };
  } else {
    const r = await ctx.db.query<{ role: OperatorRole }>(`SELECT role FROM operator_roles WHERE user_id=$1`, [s.user_id]);
    operatorRoles = r.rows.map((x) => x.role);
  }
  return {
    userId: s.user_id,
    sessionId: s.id,
    realm: s.realm,
    email: s.email,
    emailVerified: !!s.email_verified_at,
    csrfHash: s.csrf_hash,
    stepUpAt: s.step_up_at,
    mfaAt: s.mfa_at,
    merchant,
    operatorRoles,
  };
}

export function authorize(req: AnyReq): void {
  const { def, principal: p, ctx } = req;
  switch (def.auth) {
    case "public":
    case "scoped":
    case "internal":
      return;
    case "user":
      if (!p || p.realm !== "merchant") throw new DomainError("AUTH_REQUIRED", "Sign in required", undefined, { status: 401 });
      return;
    case "merchant":
      if (!p || p.realm !== "merchant") throw new DomainError("AUTH_REQUIRED", "Sign in required", undefined, { status: 401 });
      if (!p.merchant) throw new DomainError("AUTH_NO_MERCHANT", "Create your business profile first", undefined, { status: 403 });
      if (def.permission && !merchantCan(p.merchant.role, def.permission as MerchantPermission)) throw new DomainError("AUTH_FORBIDDEN", "Your role does not allow this action", undefined, { status: 403 });
      break;
    case "operator":
      if (!p || p.realm !== "operator") throw new DomainError("AUTH_REQUIRED", "Operator sign-in required", undefined, { status: 401 });
      if (!p.mfaAt) throw new DomainError("AUTH_MFA_REQUIRED", "Operator MFA required", undefined, { status: 401 });
      if (def.permission && !p.operatorRoles.some((r) => operatorCan(r, def.permission as OperatorPermission))) throw new DomainError("AUTH_FORBIDDEN", "Operator role does not allow this action", undefined, { status: 403 });
      break;
  }
  if (def.stepUp) {
    const ok = p?.stepUpAt && ctx.now().getTime() - new Date(p.stepUpAt).getTime() < ctx.cfg.policy.stepUpValiditySec * 1000;
    if (!ok) throw new DomainError("AUTH_STEP_UP_REQUIRED", "Confirm your password to continue", undefined, { status: 401 });
  }
}

/** CSRF for cookie-authenticated mutations + Origin allowlist for every browser mutation. */
export function checkCsrf(req: AnyReq): void {
  const m = req.raw.method;
  if (m === "GET" || m === "HEAD" || req.def.auth === "internal") return;
  const origin = req.raw.headers.origin;
  if (origin && !req.ctx.cfg.webOrigins.includes(origin)) throw new DomainError("AUTH_ORIGIN", "Origin not allowed", undefined, { status: 403 });
  if (req.principal && ["user", "merchant", "operator"].includes(req.def.auth)) {
    const t = req.raw.headers["x-csrf-token"];
    if (typeof t !== "string" || !safeEqual(sha256Hex(t), req.principal.csrfHash)) throw new DomainError("AUTH_CSRF", "Missing or invalid CSRF token", undefined, { status: 403 });
  }
}

/** Scoped access to a checkout: valid bearer token for this checkout OR a member of its merchant. */
export async function checkoutAccess(req: AnyReq, intentId: string): Promise<"payer" | "merchant"> {
  const i = await maybeOne<{ merchant_id: string | null; access_subject: string; access_generation: number }>(
    req.ctx.db,
    `SELECT merchant_id, access_subject, access_generation FROM payment_intents WHERE id=$1 AND environment=$2`,
    [intentId, req.ctx.env],
  );
  if (i && req.bearer) {
    const c = req.ctx.tokens.verify(req.bearer);
    if (c && c.scope === `checkout:${intentId}` && c.sub === i.access_subject && (c.gen ?? 1) === i.access_generation) return "payer";
  }
  if (i?.merchant_id && req.principal?.merchant?.id === i.merchant_id) return "merchant";
  // 404 instead of 403: do not reveal whether a checkout id exists.
  throw new DomainError("NOT_FOUND", "checkout not found", undefined, { status: 404 });
}

/* ------------------------------------------------------------------ idempotency */

export async function idempotencyBegin(req: AnyReq): Promise<{ replay: { status: number; body: unknown } | null; key: string | null; principal: string }> {
  const key = req.raw.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw new DomainError("VALIDATION_IDEMPOTENCY_KEY", "Idempotency-Key header (8-100 chars) is required for this command", undefined, { status: 400 });
  }
  const principal = req.principal ? `user:${req.principal.userId}` : req.bearer ? `token:${sha256Hex(req.bearer).slice(0, 32)}` : `anon:${req.anonId}`;
  const hash = sha256Hex(`${req.def.operationId}\n${canonicalJson({ params: req.params, body: req.body })}`);
  const ttlHours = ["createWithdrawal", "createScanPayIntent", "createTerminalIntent", "createLinkCheckout", "createCounterCheckout"].includes(req.def.operationId) ? 24 * 30 : 48;
  const ins = await req.ctx.db.query(
    `INSERT INTO idempotency_keys(environment, principal, endpoint, idem_key, request_hash, state, expires_at)
     VALUES ($1,$2,$3,$4,$5,'in_progress', now() + ($6 || ' hours')::interval) ON CONFLICT DO NOTHING`,
    [req.ctx.env, principal, req.def.operationId, key, hash, String(ttlHours)],
  );
  if (ins.rowCount === 1) return { replay: null, key, principal };
  const row = await maybeOne<{ request_hash: string; state: string; response_status: number | null; response_body: unknown; expires_at: Date }>(
    req.ctx.db,
    `SELECT request_hash, state, response_status, response_body, expires_at FROM idempotency_keys WHERE environment=$1 AND principal=$2 AND endpoint=$3 AND idem_key=$4`,
    [req.ctx.env, principal, req.def.operationId, key],
  );
  if (!row) throw new DomainError("IDEMPOTENCY_RACE", "Retry the request", undefined, { status: 409, retryable: true });
  if (row.request_hash !== hash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different request", undefined, { status: 409 });
  if (row.state === "in_progress") throw new DomainError("IDEMPOTENCY_IN_PROGRESS", "An identical request is still being processed", undefined, { status: 409, retryable: true });
  return { replay: { status: row.response_status ?? 200, body: row.response_body }, key, principal };
}

export async function idempotencyEnd(req: AnyReq, st: { key: string | null; principal: string }, status: number, body: unknown) {
  if (!st.key) return;
  await req.ctx.db.query(`UPDATE idempotency_keys SET state='done', response_status=$5, response_body=$6 WHERE environment=$1 AND principal=$2 AND endpoint=$3 AND idem_key=$4`, [
    req.ctx.env,
    st.principal,
    req.def.operationId,
    st.key,
    status,
    JSON.stringify(body),
  ]);
}

export async function idempotencyAbort(req: AnyReq, st: { key: string | null; principal: string }) {
  if (!st.key) return;
  await req.ctx.db.query(`DELETE FROM idempotency_keys WHERE environment=$1 AND principal=$2 AND endpoint=$3 AND idem_key=$4 AND state='in_progress'`, [req.ctx.env, st.principal, req.def.operationId, st.key]);
}

/* ------------------------------------------------------------------ errors */

export function errorBody(e: unknown, requestId: string): { status: number; body: Record<string, unknown> } {
  if (e instanceof DomainError) {
    const body: Record<string, unknown> = { code: e.code, message: e.message, requestId, retryable: e.retryable };
    if (e.details && !e.code.startsWith("SYSTEM_")) body.details = e.details;
    if (e.opts.currentStatus) body.currentStatus = e.opts.currentStatus;
    return { status: e.status, body };
  }
  if (e instanceof z.ZodError) {
    return { status: 400, body: { code: "VALIDATION_ERROR", message: "Request validation failed", requestId, retryable: false, details: { issues: e.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) } } };
  }
  const pg = e as { code?: string };
  if (pg.code === "23505") return { status: 409, body: { code: "STATE_CONFLICT", message: "Conflicting state; the resource already exists or changed", requestId, retryable: true } };
  if (pg.code === "23514" || pg.code === "23000") return { status: 409, body: { code: "LEDGER_INVARIANT", message: "A financial invariant rejected this change", requestId, retryable: false } };
  return { status: 500, body: { code: "SYSTEM_INTERNAL", message: "Internal error", requestId, retryable: true } };
}

export function newRequestId(header: unknown): string {
  return typeof header === "string" && /^[A-Za-z0-9._-]{6,100}$/.test(header) ? header : `req_${randomToken(12)}`;
}
