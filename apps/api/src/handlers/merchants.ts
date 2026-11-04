import { many, maybeOne, one, tx } from "@zeb/db";
import { DomainError, maskVpa, merchantMachine, newId, newSlug, notFound, validateVpa, type MerchantStatus } from "@zeb/domain";
import { audit, queueEmail, readiness, type CoreContext } from "@zeb/core";
import { hmacHex, merchantCan, type MerchantRole } from "@zeb/security";
import { csrfFor, type Handler, type Req, type AnyReq } from "../http";

const DEFAULT_PREFS = { defaultPrivacy: "shielded", allowTransparent: false, notifyOnCredit: true, notifyOnWithdrawal: true, showZecOnReceipts: true };

interface MerchantRow {
  id: string;
  environment: string;
  handle: string;
  display_name: string;
  legal_name: string | null;
  business_type: string | null;
  category: string;
  country: string;
  status: MerchantStatus;
  logo_url: string | null;
  counter_slug: string;
  retired_counter_slugs: string[];
  receiving_enabled: boolean;
  preferences: Record<string, unknown>;
  created_at: Date;
  version: number;
}

export function merchantDto(m: MerchantRow) {
  return {
    id: m.id,
    environment: m.environment as "demo",
    handle: m.handle,
    displayName: m.display_name,
    legalName: m.legal_name,
    businessType: m.business_type,
    category: m.category,
    country: m.country,
    status: m.status,
    logoUrl: m.logo_url,
    counterSlug: m.counter_slug,
    receivingEnabled: m.receiving_enabled,
    preferences: { ...DEFAULT_PREFS, ...m.preferences } as typeof DEFAULT_PREFS & { defaultPrivacy: "shielded" },
    createdAt: new Date(m.created_at).toISOString(),
    version: m.version,
  };
}

async function loadMine(req: AnyReq): Promise<MerchantRow> {
  const m = await maybeOne<MerchantRow>(req.ctx.db, `SELECT * FROM merchants WHERE id=$1 AND environment=$2`, [req.principal!.merchant!.id, req.ctx.env]);
  if (!m) throw notFound("merchant");
  return m;
}

function gates(ctx: CoreContext, m: MerchantRow | null, emailVerified: boolean, r: Awaited<ReturnType<typeof readiness>>) {
  const reasons: string[] = [];
  if (!m) reasons.push("Create your business profile");
  if (m && ctx.env === "mainnet-enabled" && m.status !== "verified") reasons.push("Business verification (KYB) is required before accepting live payments");
  if (m && ["restricted", "suspended", "closed"].includes(m.status)) reasons.push(`Account is ${m.status}`);
  if (!r.features.terminal.available) reasons.push(r.features.terminal.reason ?? "Receiving unavailable");
  const canReceive = !!m && reasons.length === 0;
  const wReasons = [...reasons];
  if (!emailVerified) wReasons.push("Verify your email before adding a payout destination or withdrawing");
  if (!r.features.withdrawals.available) wReasons.push(r.features.withdrawals.reason ?? "Withdrawals unavailable");
  return { canReceive, canWithdraw: !!m && wReasons.length === 0, reasons: [...new Set([...reasons, ...wReasons])] };
}

export const getMerchantSession: Handler = async (req) => {
  const { ctx, principal: p } = req;
  const r = await readiness(ctx);
  if (!p || p.realm !== "merchant") {
    return { authenticated: false, userId: null, emailVerified: false, csrfToken: null, merchant: null, role: null, scopes: [], gates: { canReceive: false, canWithdraw: false, reasons: ["Sign in"] }, stepUpValidUntil: null };
  }
  const m = p.merchant ? await maybeOne<MerchantRow>(ctx.db, `SELECT * FROM merchants WHERE id=$1`, [p.merchant.id]) : null;
  const csrf = csrfFor(ctx, p.sessionId);
  const role = p.merchant?.role ?? null;
  const allPerms = ["merchant.read", "merchant.update", "terminal.create", "links.read", "links.write", "balance.read", "withdrawal.request", "withdrawal.cancel", "payout_destination.manage", "support.read", "support.write", "members.manage"] as const;
  const stepValid = p.stepUpAt ? new Date(new Date(p.stepUpAt).getTime() + ctx.cfg.policy.stepUpValiditySec * 1000) : null;
  return {
    authenticated: true,
    userId: p.userId,
    emailVerified: p.emailVerified,
    csrfToken: csrf,
    merchant: m ? merchantDto(m) : null,
    role,
    scopes: role ? allPerms.filter((x) => merchantCan(role as MerchantRole, x)) : [],
    gates: gates(ctx, m, p.emailVerified, r),
    stepUpValidUntil: stepValid && stepValid > ctx.now() ? stepValid.toISOString() : null,
  };
};

export const createMerchant: Handler = async (req: Req<object, object, { displayName: string; handle: string; category: string; legalName?: string; businessType?: string }>) => {
  const { ctx, principal: p } = req;
  if (p!.merchant) throw new DomainError("STATE_MERCHANT_EXISTS", "You already have a business profile", undefined, { status: 409 });
  return tx(ctx.db, async (t) => {
    const taken = await maybeOne(t, `SELECT 1 FROM merchants WHERE environment=$1 AND (handle=$2 OR counter_slug=$2)`, [ctx.env, req.body.handle]);
    if (taken) throw new DomainError("VALIDATION_HANDLE_TAKEN", "That handle is taken", undefined, { status: 409 });
    const id = newId("merchant");
    const m = await one<MerchantRow>(
      t,
      `INSERT INTO merchants(id, environment, handle, display_name, legal_name, business_type, category, counter_slug, preferences, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, ctx.env, req.body.handle, req.body.displayName.trim(), req.body.legalName?.trim() ?? null, req.body.businessType ?? null, req.body.category.trim(), `${req.body.handle}-${newSlug(6)}`, JSON.stringify(DEFAULT_PREFS), p!.userId],
    );
    await t.query(`INSERT INTO merchant_members(id, merchant_id, user_id, role) VALUES ($1,$2,$3,'owner')`, [newId("member"), id, p!.userId]);
    await audit(t, ctx.env, { actorType: "user", actorId: p!.userId, action: "merchant.create", target: id, requestId: req.requestId });
    return merchantDto(m);
  });
};

export const getMyMerchant: Handler = async (req) => merchantDto(await loadMine(req));

export const updateMyMerchant: Handler = async (req: Req<object, object, { expectedVersion: number; displayName?: string; category?: string; logoUrl?: string | null }>) => {
  const { ctx } = req;
  const sets: string[] = ["version=version+1", "updated_at=now()"];
  const vals: unknown[] = [req.principal!.merchant!.id, req.body.expectedVersion];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  };
  if (req.body.displayName !== undefined) add("display_name", req.body.displayName.trim());
  if (req.body.category !== undefined) add("category", req.body.category.trim());
  if (req.body.logoUrl !== undefined) {
    if (req.body.logoUrl && !/^https:\/\//.test(req.body.logoUrl)) throw new DomainError("VALIDATION_LOGO_URL", "Logo must be an https URL");
    add("logo_url", req.body.logoUrl);
  }
  const r = await ctx.db.query<MerchantRow>(`UPDATE merchants SET ${sets.join(", ")} WHERE id=$1 AND version=$2 RETURNING *`, vals);
  if (r.rowCount !== 1) throw new DomainError("STATE_VERSION_CONFLICT", "Profile changed elsewhere; reload and retry", undefined, { status: 409 });
  await audit(ctx.db, ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "merchant.update", target: req.principal!.merchant!.id, requestId: req.requestId });
  return merchantDto(r.rows[0]!);
};

export const submitKyb: Handler = async (req) => {
  const { ctx } = req;
  return tx(ctx.db, async (t) => {
    const m = await one<MerchantRow>(t, `SELECT * FROM merchants WHERE id=$1 FOR UPDATE`, [req.principal!.merchant!.id]);
    if (!m.legal_name || !m.business_type) throw new DomainError("COMPLIANCE_KYB_INCOMPLETE", "Add your legal name and business type before submitting for review");
    if (!req.principal!.emailVerified) throw new DomainError("COMPLIANCE_EMAIL_UNVERIFIED", "Verify your email first");
    merchantMachine.assert(m.status, "pending_review");
    const u = await one<MerchantRow>(t, `UPDATE merchants SET status='pending_review', kyb_provider='manual', version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [m.id]);
    await t.query(`INSERT INTO exceptions(id, environment, kind, severity, details) VALUES ($1,$2,'kyb_review','info',$3)`, [newId("event").replace(/^evt_/, "exc_"), ctx.env, JSON.stringify({ merchantId: m.id })]);
    await audit(t, ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "merchant.kyb_submit", target: m.id, requestId: req.requestId });
    return merchantDto(u);
  });
};

/* ------------------------------------------------------------------ payout destinations */

interface DestRow {
  id: string;
  vpa_masked: string;
  beneficiary_name: string | null;
  status: string;
  usable_after: Date | null;
  created_at: Date;
}
const destDto = (d: DestRow) => ({
  id: d.id,
  kind: "upi_vpa" as const,
  vpaMasked: d.vpa_masked,
  beneficiaryName: d.beneficiary_name,
  status: d.status as "verified",
  usableAfter: d.usable_after ? new Date(d.usable_after).toISOString() : null,
  createdAt: new Date(d.created_at).toISOString(),
});

export const listPayoutDestinations: Handler = async (req) => {
  const rows = await many<DestRow>(req.ctx.db, `SELECT id, vpa_masked, beneficiary_name, status, usable_after, created_at FROM payout_destinations WHERE merchant_id=$1 AND status <> 'removed' ORDER BY created_at DESC`, [req.principal!.merchant!.id]);
  return { items: rows.map(destDto) };
};

export const createPayoutDestination: Handler = async (req: Req<object, object, { vpa: string; beneficiaryName?: string }>) => {
  const { ctx, principal: p } = req;
  if (!p!.emailVerified) throw new DomainError("COMPLIANCE_EMAIL_UNVERIFIED", "Verify your email before adding a payout destination", undefined, { status: 403 });
  const vpa = validateVpa(req.body.vpa);
  return tx(ctx.db, async (t) => {
    const merchantId = p!.merchant!.id;
    // Replacing a destination: old one removed; pending withdrawals keep their reserved destination id (immutable on the withdrawal).
    await t.query(`UPDATE payout_destinations SET status='removed', updated_at=now(), version=version+1 WHERE merchant_id=$1 AND status IN ('pending_verification','cooling_off','verified')`, [merchantId]);
    const id = newId("payoutDestination");
    const usableAfter = new Date(ctx.now().getTime() + ctx.cfg.policy.payoutDestinationCoolingSec * 1000);
    // demo: auto-verified (simulated); otherwise manual/provider verification is required.
    const status = ctx.env === "demo" ? "verified" : "pending_verification";
    const d = await one<DestRow>(
      t,
      `INSERT INTO payout_destinations(id, environment, merchant_id, vpa_ct, vpa_masked, vpa_fingerprint, beneficiary_name, status, usable_after, verified_at, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, vpa_masked, beneficiary_name, status, usable_after, created_at`,
      [id, ctx.env, merchantId, await ctx.envelope.seal(vpa, `payout_destinations:${id}:vpa`), maskVpa(vpa), hmacHex(ctx.cfg.tokenSecret, `vpa:${vpa.toLowerCase()}`), req.body.beneficiaryName?.trim() ?? null, status, usableAfter, status === "verified" ? ctx.now() : null, status === "verified" ? "demo:auto" : null],
    );
    if (status !== "verified") {
      await t.query(`INSERT INTO exceptions(id, environment, kind, severity, details) VALUES ($1,$2,'payout_destination_review','info',$3)`, [newId("event").replace(/^evt_/, "exc_"), ctx.env, JSON.stringify({ merchantId, destinationId: id })]);
    }
    if (p!.email) await queueEmail(t, ctx, p!.email, "security_notice", { what: `A payout UPI ID (${maskVpa(vpa)}) was added to your Zeb Scan business. It can be used after review and a security cooling-off period.` });
    await audit(t, ctx.env, { actorType: "user", actorId: p!.userId, action: "payout_destination.create", target: id, requestId: req.requestId });
    return destDto(d);
  });
};

export const updatePayoutDestination: Handler = async (req: Req<{ id: string }, object, { beneficiaryName: string }>) => {
  const { ctx, principal: p } = req;
  return tx(ctx.db, async (t) => {
    const d = await maybeOne<DestRow>(t, `SELECT id, vpa_masked, beneficiary_name, status, usable_after, created_at FROM payout_destinations WHERE id=$1 AND merchant_id=$2 AND status <> 'removed' FOR UPDATE`, [req.params.id, p!.merchant!.id]);
    if (!d) throw notFound("payout destination");
    const status = ctx.env === "demo" ? d.status : "pending_verification";
    const r = await one<DestRow>(
      t,
      `UPDATE payout_destinations SET beneficiary_name=$2, status=$3, usable_after=$4, updated_at=now(), version=version+1 WHERE id=$1 RETURNING id, vpa_masked, beneficiary_name, status, usable_after, created_at`,
      [d.id, req.body.beneficiaryName.trim(), status, new Date(ctx.now().getTime() + ctx.cfg.policy.payoutDestinationCoolingSec * 1000)],
    );
    if (p!.email) await queueEmail(t, ctx, p!.email, "security_notice", { what: `The beneficiary name on payout UPI ID ${d.vpa_masked} was changed. It requires re-review.` });
    await audit(t, ctx.env, { actorType: "user", actorId: p!.userId, action: "payout_destination.update", target: d.id, requestId: req.requestId });
    return destDto(r);
  });
};

export const deletePayoutDestination: Handler = async (req: Req<{ id: string }>) => {
  const { ctx, principal: p } = req;
  const active = await maybeOne(ctx.db, `SELECT 1 FROM withdrawals WHERE payout_destination_id=$1 AND status NOT IN ('completed','cancelled')`, [req.params.id]);
  if (active) throw new DomainError("STATE_DESTINATION_IN_USE", "A withdrawal to this destination is in progress", undefined, { status: 409 });
  const r = await ctx.db.query(`UPDATE payout_destinations SET status='removed', updated_at=now(), version=version+1 WHERE id=$1 AND merchant_id=$2 AND status <> 'removed'`, [req.params.id, p!.merchant!.id]);
  if (r.rowCount === 0) throw notFound("payout destination");
  if (p!.email) await queueEmail(ctx.db, ctx, p!.email, "security_notice", { what: "A payout UPI ID was removed from your Zeb Scan business." });
  await audit(ctx.db, ctx.env, { actorType: "user", actorId: p!.userId, action: "payout_destination.remove", target: req.params.id, requestId: req.requestId });
  return { ok: true };
};

/* ------------------------------------------------------------------ preferences / metrics / counter */

export const getPreferences: Handler = async (req) => merchantDto(await loadMine(req)).preferences;

export const updatePreferences: Handler = async (req: Req<object, object, Record<string, unknown>>) => {
  const m = await loadMine(req);
  const next = { ...DEFAULT_PREFS, ...m.preferences, ...req.body };
  await req.ctx.db.query(`UPDATE merchants SET preferences=$2, version=version+1, updated_at=now() WHERE id=$1`, [m.id, JSON.stringify(next)]);
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "merchant.preferences", target: m.id, details: req.body, requestId: req.requestId });
  return next;
};

export const getMetrics: Handler = async (req) => {
  const id = req.principal!.merchant!.id;
  const acc = await one<{ n: string; vol: string | null }>(
    req.ctx.db,
    `SELECT count(*) AS n, sum(c.amount_inr_paise) AS vol FROM merchant_credits c WHERE c.merchant_id=$1 AND c.parent_credit_id IS NULL AND c.intent_id IS NOT NULL`,
    [id],
  );
  const pending = await one<{ n: string }>(req.ctx.db, `SELECT count(*) AS n FROM payment_intents WHERE merchant_id=$1 AND status IN ('awaiting_zec','deposit_seen','confirming')`, [id]);
  const links = await one<{ n: string }>(req.ctx.db, `SELECT count(*) AS n FROM payment_links WHERE merchant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [id]);
  return { acceptedPayments: Number(acc.n), acceptedVolumeInrPaise: acc.vol ?? "0", pendingPayments: Number(pending.n), activeLinks: Number(links.n), asOf: req.ctx.now().toISOString(), source: "ledger" };
};

const counterDto = (ctx: CoreContext, m: MerchantRow) => ({
  slug: m.counter_slug,
  url: `${ctx.cfg.appBaseUrl}/m/${m.counter_slug}`,
  retiredSlugs: m.retired_counter_slugs,
  note: "This QR opens your hosted checkout. Each payer gets a fresh invoice and a unique ZEC address — it is never a static deposit address.",
});

export const getCounterQr: Handler = async (req) => counterDto(req.ctx, await loadMine(req));

export const regenerateCounterQr: Handler = async (req) => {
  const m = await loadMine(req);
  const r = await one<MerchantRow>(
    req.ctx.db,
    `UPDATE merchants SET retired_counter_slugs = array_append(retired_counter_slugs, counter_slug), counter_slug=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [m.id, `${m.handle}-${newSlug(6)}`],
  );
  await audit(req.ctx.db, req.ctx.env, { actorType: "user", actorId: req.principal!.userId, action: "merchant.counter_regenerate", target: m.id, requestId: req.requestId });
  return counterDto(req.ctx, r);
};

export const getPublicMerchant: Handler = async (req: Req<{ handle: string }>) => {
  const { ctx } = req;
  const m = await maybeOne<MerchantRow>(ctx.db, `SELECT * FROM merchants WHERE environment=$1 AND counter_slug=$2 AND status <> 'closed'`, [ctx.env, req.params.handle]);
  if (!m) throw notFound("merchant");
  const r = await readiness(ctx);
  const active = m.receiving_enabled && !["restricted", "suspended"].includes(m.status) && r.features.terminal.available && (ctx.env !== "mainnet-enabled" || m.status === "verified");
  return {
    handle: m.handle,
    displayName: m.display_name,
    logoUrl: m.logo_url,
    verified: m.status === "verified",
    receivingActive: active,
    limits: { minInrPaise: ctx.cfg.policy.minInrPaise.toString(), maxInrPaise: ctx.cfg.policy.maxInrPaise.toString() },
    label: ctx.caps.label,
  };
};
