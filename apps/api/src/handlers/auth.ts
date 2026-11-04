import { many, maybeOne, one, tx } from "@zeb/db";
import { DomainError, newId } from "@zeb/domain";
import { audit, queueEmail, type CoreContext } from "@zeb/core";
import { burnVerifyTime, hashPassword, needsRehash, newSecret, passwordProblem, sha256Hex, verifyPassword, verifyTotp } from "@zeb/security";
import { csrfFor, SESSION_COOKIE, type Handler, type Req, type AnyReq } from "../http";

const normEmail = (e: string) => e.trim().toLowerCase();

export async function startSessionFor(req: AnyReq, userId: string, realm: "merchant" | "operator", opts: { mfa?: boolean } = {}) {
  const token = newSecret(32);
  const ttl = realm === "operator" ? Math.min(req.ctx.cfg.policy.sessionTtlSec, 8 * 3600) : req.ctx.cfg.policy.sessionTtlSec;
  const expires = new Date(req.ctx.now().getTime() + ttl * 1000);
  const sessionId = newId("session");
  const csrf = csrfFor(req.ctx, sessionId);
  await req.ctx.db.query(
    `INSERT INTO sessions(id, environment, user_id, token_hash, csrf_hash, realm, expires_at, ip_hash, user_agent, mfa_at, step_up_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sessionId, req.ctx.env, userId, sha256Hex(token), sha256Hex(csrf), realm, expires, req.ipHash, req.userAgent?.slice(0, 200) ?? null, opts.mfa ? req.ctx.now() : null, req.ctx.now()],
  );
  req.reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: req.ctx.cfg.cookieSecure, sameSite: realm === "operator" ? "strict" : "lax", path: "/", expires });
  return csrf;
}

async function issueToken(ctx: CoreContext, userId: string, purpose: "verify_email" | "reset_password", ttlMs: number): Promise<string> {
  const token = newSecret(32);
  await ctx.db.query(`INSERT INTO auth_tokens(id, environment, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newId("token"), ctx.env, userId, purpose, sha256Hex(token), new Date(ctx.now().getTime() + ttlMs)]);
  return token;
}

export const register: Handler = async (req: Req<object, object, { email: string; password: string }>) => {
  const { ctx } = req;
  const email = normEmail(req.body.email);
  const problem = passwordProblem(req.body.password, email);
  if (problem) throw new DomainError("VALIDATION_PASSWORD", problem);
  const existing = await maybeOne(ctx.db, `SELECT 1 FROM users WHERE environment=$1 AND realm='merchant' AND email_normalized=$2`, [ctx.env, email]);
  if (existing) throw new DomainError("AUTH_REGISTRATION_FAILED", "Could not register with these details. If you already have an account, sign in or reset your password.", undefined, { status: 409 });
  const id = newId("user");
  await ctx.db.query(`INSERT INTO users(id, environment, email, email_normalized, password_hash, realm) VALUES ($1,$2,$3,$4,$5,'merchant')`, [id, ctx.env, req.body.email.trim(), email, await hashPassword(req.body.password)]);
  const token = await issueToken(ctx, id, "verify_email", 24 * 3600_000);
  await queueEmail(ctx.db, ctx, email, "verify_email", { link: `${ctx.cfg.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}` });
  await audit(ctx.db, ctx.env, { actorType: "user", actorId: id, action: "auth.register", requestId: req.requestId, ipHash: req.ipHash });
  const csrfToken = await startSessionFor(req, id, "merchant");
  return { userId: id, emailVerified: false, csrfToken };
};

async function passwordLogin(req: AnyReq, realm: "merchant" | "operator") {
  const { ctx } = req;
  const email = normEmail(req.body.email);
  const u = await maybeOne<{ id: string; password_hash: string; email_verified_at: Date | null; failed_logins: number; locked_until: Date | null; disabled_at: Date | null; totp_secret_ct: string | null }>(
    ctx.db,
    `SELECT id, password_hash, email_verified_at, failed_logins, locked_until, disabled_at, totp_secret_ct FROM users WHERE environment=$1 AND realm=$2 AND email_normalized=$3`,
    [ctx.env, realm, email],
  );
  const generic = new DomainError("AUTH_INVALID_CREDENTIALS", "Email or password is incorrect", undefined, { status: 401 });
  if (!u) {
    await burnVerifyTime(req.body.password);
    throw generic;
  }
  if (u.disabled_at) throw generic;
  if (u.locked_until && new Date(u.locked_until) > ctx.now()) throw new DomainError("AUTH_LOCKED", "Too many failed attempts. Try again later or reset your password.", undefined, { status: 429 });
  const ok = u.password_hash ? await verifyPassword(u.password_hash, req.body.password) : (await burnVerifyTime(req.body.password), false);
  if (!ok) {
    await ctx.db.query(`UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id=$1`, [u.id]);
    await audit(ctx.db, ctx.env, { actorType: realm === "operator" ? "operator" : "user", actorId: u.id, action: "auth.login_failed", requestId: req.requestId, ipHash: req.ipHash });
    throw generic;
  }
  await ctx.db.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [u.id]);
  if (u.password_hash && needsRehash(u.password_hash)) await ctx.db.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [u.id, await hashPassword(req.body.password)]);
  return u;
}

export const login: Handler = async (req: Req<object, object, { email: string; password: string }>) => {
  const u = await passwordLogin(req, "merchant");
  const csrfToken = await startSessionFor(req, u.id, "merchant");
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: u.id, action: "auth.login", requestId: req.requestId, ipHash: req.ipHash });
  return { userId: u.id, emailVerified: !!u.email_verified_at, csrfToken };
};

export const opsLogin: Handler = async (req: Req<object, object, { email: string; password: string; totp: string }>) => {
  const u = await passwordLogin(req, "operator");
  if (!u.totp_secret_ct) throw new DomainError("AUTH_MFA_NOT_ENROLLED", "Operator MFA is not enrolled", undefined, { status: 401 });
  const secret = await req.ctx.envelope.open(u.totp_secret_ct, `users:${u.id}:totp`);
  if (!verifyTotp(secret, req.body.totp, req.ctx.now().getTime())) {
    await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: u.id, action: "auth.mfa_failed", requestId: req.requestId, ipHash: req.ipHash });
    throw new DomainError("AUTH_INVALID_CREDENTIALS", "Email, password or code is incorrect", undefined, { status: 401 });
  }
  const csrfToken = await startSessionFor(req, u.id, "operator", { mfa: true });
  await audit(req.ctx.db, req.ctx.env, { actorType: "operator", actorId: u.id, action: "auth.ops_login", requestId: req.requestId, ipHash: req.ipHash });
  return { userId: u.id, emailVerified: true, csrfToken };
};

export const logout: Handler = async (req) => {
  await req.ctx.db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [req.principal!.sessionId]);
  req.reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
};

export const verifyEmail: Handler = async (req: Req<object, object, { token: string }>) => {
  const { ctx } = req;
  await tx(ctx.db, async (t) => {
    const tok = await maybeOne<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(t, `SELECT id, user_id, expires_at, used_at FROM auth_tokens WHERE token_hash=$1 AND purpose='verify_email' AND environment=$2 FOR UPDATE`, [sha256Hex(req.body.token), ctx.env]);
    if (!tok || tok.used_at || new Date(tok.expires_at) < ctx.now()) throw new DomainError("AUTH_TOKEN_INVALID", "This verification link is invalid or expired", undefined, { status: 400 });
    await t.query(`UPDATE auth_tokens SET used_at=now() WHERE id=$1`, [tok.id]);
    await t.query(`UPDATE users SET email_verified_at=coalesce(email_verified_at, now()), updated_at=now() WHERE id=$1`, [tok.user_id]);
    await audit(t, ctx.env, { actorType: "user", actorId: tok.user_id, action: "auth.email_verified", requestId: req.requestId });
  });
  return { ok: true };
};

export const resendVerification: Handler = async (req) => {
  const { ctx, principal } = req;
  if (principal!.emailVerified) return { ok: true };
  if (!principal!.email) throw new DomainError("AUTH_NO_EMAIL", "Add an email address first", undefined, { status: 400 });
  const recent = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM auth_tokens WHERE user_id=$1 AND purpose='verify_email' AND created_at > now() - interval '1 hour'`, [principal!.userId]);
  if (Number(recent.n) >= 5) throw new DomainError("RATE_LIMITED", "Too many verification emails requested; try later", undefined, { status: 429 });
  const token = await issueToken(ctx, principal!.userId, "verify_email", 24 * 3600_000);
  await queueEmail(ctx.db, ctx, principal!.email, "verify_email", { link: `${ctx.cfg.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}` });
  return { ok: true };
};

export const forgotPassword: Handler = async (req: Req<object, object, { email: string }>) => {
  const { ctx } = req;
  const u = await maybeOne<{ id: string; email: string }>(ctx.db, `SELECT id, email FROM users WHERE environment=$1 AND realm='merchant' AND email_normalized=$2 AND disabled_at IS NULL`, [ctx.env, normEmail(req.body.email)]);
  if (u) {
    const recent = await one<{ n: string }>(ctx.db, `SELECT count(*) AS n FROM auth_tokens WHERE user_id=$1 AND purpose='reset_password' AND created_at > now() - interval '1 hour'`, [u.id]);
    if (Number(recent.n) < 3) {
      const token = await issueToken(ctx, u.id, "reset_password", 30 * 60_000);
      await queueEmail(ctx.db, ctx, u.email, "reset_password", { link: `${ctx.cfg.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}` });
    }
  }
  // Same response whether or not the account exists.
  return { ok: true };
};

export const resetPassword: Handler = async (req: Req<object, object, { token: string; password: string }>) => {
  const { ctx } = req;
  await tx(ctx.db, async (t) => {
    const tok = await maybeOne<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(t, `SELECT id, user_id, expires_at, used_at FROM auth_tokens WHERE token_hash=$1 AND purpose='reset_password' AND environment=$2 FOR UPDATE`, [sha256Hex(req.body.token), ctx.env]);
    if (!tok || tok.used_at || new Date(tok.expires_at) < ctx.now()) throw new DomainError("AUTH_TOKEN_INVALID", "This reset link is invalid or expired", undefined, { status: 400 });
    const u = await one<{ email: string }>(t, `SELECT email FROM users WHERE id=$1`, [tok.user_id]);
    const problem = passwordProblem(req.body.password, u.email);
    if (problem) throw new DomainError("VALIDATION_PASSWORD", problem);
    await t.query(`UPDATE auth_tokens SET used_at=now() WHERE id=$1`, [tok.id]);
    await t.query(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [tok.user_id, await hashPassword(req.body.password)]);
    await t.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [tok.user_id]);
    await queueEmail(t, ctx, u.email, "security_notice", { what: "Your password was reset and all sessions were signed out." });
    await audit(t, ctx.env, { actorType: "user", actorId: tok.user_id, action: "auth.password_reset", requestId: req.requestId, ipHash: req.ipHash });
  });
  return { ok: true };
};

export const listSessions: Handler = async (req) => {
  const rows = await many<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string | null }>(
    req.ctx.db,
    `SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50`,
    [req.principal!.userId],
  );
  return { items: rows.map((s) => ({ id: s.id, createdAt: new Date(s.created_at).toISOString(), lastSeenAt: new Date(s.last_seen_at).toISOString(), userAgent: s.user_agent, current: s.id === req.principal!.sessionId })) };
};

export const revokeSession: Handler = async (req: Req<{ id: string }>) => {
  const r = await req.ctx.db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [req.params.id, req.principal!.userId]);
  if (r.rowCount === 0) throw new DomainError("NOT_FOUND", "session not found", undefined, { status: 404 });
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "auth.session_revoked", target: req.params.id, requestId: req.requestId });
  return { ok: true };
};

export const stepUp: Handler = async (req: Req<object, object, { password: string }>) => {
  const u = await one<{ password_hash: string | null }>(req.ctx.db, `SELECT password_hash FROM users WHERE id=$1`, [req.principal!.userId]);
  if (!u.password_hash) throw new DomainError("AUTH_STEP_UP_REAUTH", "This account has no password. Sign in again (wallet or email code) to confirm it is you.", undefined, { status: 401 });
  if (!(await verifyPassword(u.password_hash, req.body.password))) {
    await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "auth.step_up_failed", requestId: req.requestId, ipHash: req.ipHash });
    throw new DomainError("AUTH_INVALID_CREDENTIALS", "Password is incorrect", undefined, { status: 401 });
  }
  const now = req.ctx.now();
  await req.ctx.db.query(`UPDATE sessions SET step_up_at=$2 WHERE id=$1`, [req.principal!.sessionId, now]);
  return { validUntil: new Date(now.getTime() + req.ctx.cfg.policy.stepUpValiditySec * 1000).toISOString() };
};
