import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import { ROUTES, type RouteDef } from "@zeb/contracts";
import { buildOpenApi } from "@zeb/contracts/openapi";
import { many, maybeOne } from "@zeb/db";
import { DomainError, randomToken } from "@zeb/domain";
import { pollScanner, readiness, type CoreContext } from "@zeb/core";
import { redact } from "@zeb/security";
import {
  ANON_COOKIE,
  authorize,
  checkCsrf,
  checkoutAccess,
  errorBody,
  idempotencyAbort,
  idempotencyBegin,
  idempotencyEnd,
  ipHash,
  newRequestId,
  resolvePrincipal,
  type Handler,
  type Req,
} from "./http";
import * as auth from "./handlers/auth";
import * as checkout from "./handlers/checkout";
import * as internal from "./handlers/internal";
import * as ledger from "./handlers/ledger";
import * as links from "./handlers/links";
import * as merchants from "./handlers/merchants";
import * as ops from "./handlers/ops";
import * as pub from "./handlers/public";
import * as receipts from "./handlers/receipts";
import * as wd from "./handlers/withdrawals";
import * as wallet from "./handlers/wallet";
import * as payouts from "./handlers/payouts";
import type { TfDeps } from "@zeb/core";

export const HANDLERS: Record<keyof typeof ROUTES, Handler> = {
  getPublicConfig: pub.getPublicConfig,
  getPublicHealth: pub.getPublicHealth,
  getZecUsdRate: pub.getZecUsdRate,
  getInrUsdcRate: pub.getInrUsdcRate,
  parseUpi: pub.parseUpi,
  createQuote: pub.createQuoteH,
  getQuote: pub.getQuoteH,
  createScanPayIntent: checkout.createScanPayIntent,
  getScanPayIntent: checkout.getScanPayIntent,
  cancelScanPayIntent: checkout.cancelScanPayIntent,
  register: auth.register,
  login: auth.login,
  logout: auth.logout,
  verifyEmail: auth.verifyEmail,
  resendVerification: auth.resendVerification,
  forgotPassword: auth.forgotPassword,
  resetPassword: auth.resetPassword,
  listSessions: auth.listSessions,
  revokeSession: auth.revokeSession,
  stepUp: auth.stepUp,
  getMerchantSession: merchants.getMerchantSession,
  createMerchant: merchants.createMerchant,
  getMyMerchant: merchants.getMyMerchant,
  updateMyMerchant: merchants.updateMyMerchant,
  submitKyb: merchants.submitKyb,
  listPayoutDestinations: merchants.listPayoutDestinations,
  createPayoutDestination: merchants.createPayoutDestination,
  updatePayoutDestination: merchants.updatePayoutDestination,
  deletePayoutDestination: merchants.deletePayoutDestination,
  getPreferences: merchants.getPreferences,
  updatePreferences: merchants.updatePreferences,
  getMetrics: merchants.getMetrics,
  createTerminalIntent: checkout.createTerminalIntent,
  getTerminalIntent: checkout.getTerminalIntent,
  getCounterQr: merchants.getCounterQr,
  regenerateCounterQr: merchants.regenerateCounterQr,
  getPublicMerchant: merchants.getPublicMerchant,
  createCounterCheckout: checkout.createCounterCheckout,
  createLink: links.createLink,
  listLinks: links.listLinks,
  getLink: links.getLink,
  updateLink: links.updateLink,
  revokeLink: links.revokeLink,
  duplicateLink: links.duplicateLink,
  getPublicLink: links.getPublicLink,
  createLinkCheckout: checkout.createLinkCheckout,
  getCheckout: checkout.getCheckout,
  refreshCheckout: checkout.refreshCheckout,
  submitRefundDetails: checkout.submitRefundDetailsH,
  listTransactions: ledger.listTransactions,
  getTransaction: ledger.getTransaction,
  getBalance: ledger.getBalance,
  listBalanceEntries: ledger.listBalanceEntries,
  listSettlements: ledger.listSettlements,
  quoteWithdrawal: wd.quoteWithdrawalH,
  createWithdrawal: wd.createWithdrawalH,
  listWithdrawals: wd.listWithdrawals,
  getWithdrawal: wd.getWithdrawal,
  cancelWithdrawal: wd.cancelWithdrawalH,
  getReceipt: receipts.getReceipt,
  downloadReceipt: receipts.downloadReceipt,
  createSupportCase: receipts.createSupportCase,
  listSupportCases: receipts.listSupportCases,
  opsLogin: auth.opsLogin,
  opsHealth: ops.opsHealth,
  opsTreasury: ops.opsTreasury,
  opsReconciliation: ops.opsReconciliation,
  opsJobs: ops.opsJobs,
  opsExceptions: ops.opsExceptions,
  opsAudit: ops.opsAudit,
  opsPause: ops.opsPause,
  opsResume: ops.opsResume,
  opsRetryJob: ops.opsRetryJob,
  opsDecideException: ops.opsDecideException,
  opsApprove: ops.opsApprove,
  internalZcashEvents: internal.internalZcashEvents,
  internalP2PEvents: internal.internalP2PEvents,
  internalWebhook: internal.internalWebhook,
  demoSimulateDeposit: checkout.demoSimulateDeposit,
  demoAdvanceConfirmations: checkout.demoAdvanceConfirmations,
  walletChallenge: wallet.walletChallenge,
  walletVerify: wallet.walletVerify,
  emailOtpRequest: wallet.emailOtpRequest,
  emailOtpVerify: wallet.emailOtpVerify,
  getAuthSession: merchants.getMerchantSession,
  getPublicConfigV2: pub.getPublicConfig,
  scanParse: pub.parseUpi,
  getP2PReadiness: payouts.getP2PReadiness,
  adminP2PPreflight: payouts.adminP2PPreflight,
  adminP2PCapabilities: payouts.adminP2PCapabilities,
  adminListPayouts: payouts.adminListPayouts,
  adminGetPayout: payouts.adminGetPayout,
  adminApprovePayout: payouts.adminApprovePayout,
  adminReconcilePayout: payouts.adminReconcilePayout,
  adminHoldPayout: payouts.adminHoldPayout,
  adminPayoutNotSubmitted: payouts.adminPayoutNotSubmitted,
};

const RATE: Record<string, { max: number; timeWindow: string }> = {
  register: { max: 5, timeWindow: "1 minute" },
  login: { max: 10, timeWindow: "1 minute" },
  opsLogin: { max: 5, timeWindow: "1 minute" },
  walletChallenge: { max: 20, timeWindow: "1 minute" },
  walletVerify: { max: 10, timeWindow: "1 minute" },
  emailOtpRequest: { max: 5, timeWindow: "1 minute" },
  emailOtpVerify: { max: 10, timeWindow: "1 minute" },
  forgotPassword: { max: 5, timeWindow: "1 minute" },
  resetPassword: { max: 10, timeWindow: "1 minute" },
  stepUp: { max: 10, timeWindow: "1 minute" },
  createQuote: { max: 60, timeWindow: "1 minute" },
  createScanPayIntent: { max: 20, timeWindow: "1 minute" },
  createLinkCheckout: { max: 20, timeWindow: "1 minute" },
  createCounterCheckout: { max: 20, timeWindow: "1 minute" },
  parseUpi: { max: 60, timeWindow: "1 minute" },
  createSupportCase: { max: 10, timeWindow: "1 minute" },
};

export async function buildServer(ctx: CoreContext, opts: { logger?: boolean; rateLimitScale?: number; tf?: TfDeps } = {}): Promise<FastifyInstance> {
  if (opts.tf) payouts.setTfDeps(opts.tf);
  const scale = Math.max(1, opts.rateLimitScale ?? Number(process.env.RATE_LIMIT_SCALE ?? 1));
  for (const k of Object.keys(ROUTES)) if (!(k in HANDLERS)) throw new Error(`route ${k} has no handler`);

  const app = Fastify({
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          redact: { paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "req.headers['x-zeb-signature']"], censor: "[redacted]" },
          serializers: { req: (r: FastifyRequest) => ({ method: r.method, url: r.url.replace(/access_token=[^&]+/, "access_token=[redacted]"), id: r.id }) },
        }
      : false,
    bodyLimit: 64 * 1024,
    trustProxy: process.env.TRUST_PROXY === "true",
    genReqId: (r) => newRequestId(r.headers["x-request-id"]),
    disableRequestLogging: !opts.logger,
  });

  // Keep the raw body (internal HMAC verification) while parsing JSON strictly.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new DomainError("VALIDATION_JSON", "Malformed JSON body", undefined, { status: 400 }), undefined);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: ctx.cfg.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || ctx.cfg.webOrigins.includes(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "idempotency-key", "x-csrf-token", "x-request-id", "authorization", "last-event-id", "if-none-match"],
    exposedHeaders: ["x-request-id", "etag"],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: true, max: 300 * scale, timeWindow: "1 minute", keyGenerator: (r) => ipHash(ctx, r.ip) });

  app.setErrorHandler((err, req, reply) => {
    const e = (err as { statusCode?: number }).statusCode === 429 ? new DomainError("RATE_LIMITED", "Too many requests", undefined, { status: 429, retryable: true }) : err;
    const { status, body } = errorBody(e, String(req.id));
    if (status >= 500 && process.env.ZEB_DEBUG_ERRORS === "1") console.error(err);
    if (status >= 500) req.log?.error?.({ err: redact({ message: (err as Error).message, stack: (err as Error).stack }) }, "request failed");
    reply.code(status).header("cache-control", "no-store").send(body);
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: "NOT_FOUND", message: "Route not found", requestId: String(req.id), retryable: false }));

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", String(req.id));
    if (!req.cookies?.[ANON_COOKIE]) {
      const v = randomToken(16);
      req.cookies[ANON_COOKIE] = v;
      reply.setCookie(ANON_COOKIE, v, { httpOnly: true, sameSite: "lax", secure: ctx.cfg.cookieSecure, path: "/", maxAge: 30 * 86_400 });
    }
  });

  /* ---------------------------------------------------------------- health */
  app.get("/healthz", async () => ({ ok: true, environment: ctx.env }));
  app.get("/readyz", async (_req, reply) => {
    const r = await readiness(ctx, { fresh: true });
    const body = {
      ready: r.db,
      environment: ctx.env,
      db: r.db,
      priceFeed: r.priceFeed,
      p2p: r.p2p,
      scanner: r.scanner,
      treasury: r.treasury,
      signer: r.signer,
      approvals: r.approvals,
      features: r.features,
      paused: Object.keys(r.paused),
      checkedAt: r.checkedAt.toISOString(),
    };
    // Not ready only when the core service cannot function; per-feature gates are reported, not fatal.
    reply.code(r.db ? 200 : 503).header("cache-control", "no-store").send(body);
  });
  app.get("/api/v1/openapi.json", async () => buildOpenApi({ includeDemo: ctx.env === "demo" }));

  /* ---------------------------------------------------------------- manual "check payment now" (payer) */
  // Same access rule as checkout reads: a bearer token scoped to this checkout (subject + generation).
  // Triggers one immediate watch-only scan (idempotent ingestion; throttled globally) and returns the
  // checkout's real state. It never moves money: payouts stay in the separate, gated settlement path.
  let lastManualScanAt = 0;
  app.post("/api/v1/checkout/:id/check-payment", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (raw, reply) => {
    const id = String((raw.params as { id?: string }).id ?? "");
    const origin = raw.headers.origin;
    if (origin && !ctx.cfg.webOrigins.includes(origin)) return reply.code(403).send({ code: "AUTH_ORIGIN", message: "Origin not allowed" });
    const bearer = typeof raw.headers.authorization === "string" && raw.headers.authorization.startsWith("Bearer ") ? raw.headers.authorization.slice(7).trim() : null;
    const row = await ctx.db.query<{ access_subject: string; access_generation: number }>(
      `SELECT access_subject, access_generation FROM payment_intents WHERE id=$1 AND environment=$2`,
      [id, ctx.env],
    );
    const i = row.rows[0];
    const c = i && bearer ? ctx.tokens.verify(bearer) : null;
    if (!i || !c || c.scope !== `checkout:${id}` || c.sub !== i.access_subject || (c.gen ?? 1) !== i.access_generation) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "checkout not found" });
    }
    let scanned = false;
    let scanError: string | null = null;
    if (ctx.env !== "demo" && Date.now() - lastManualScanAt > 3_000) {
      lastManualScanAt = Date.now();
      try {
        await pollScanner(ctx);
        scanned = true;
      } catch (e) {
        scanError = (e as Error).message.replace(/Bearer\s+\S+/g, "Bearer ***").slice(0, 160);
      }
    }
    const s = await ctx.db.query<{ status: string; received_zatoshis: string | null; confirmations: number | null; mined: boolean | null }>(
      `SELECT pi.status, pi.received_zatoshis::text AS received_zatoshis, d.confirmations, d.mined
         FROM payment_intents pi LEFT JOIN LATERAL (
           SELECT confirmations, mined FROM deposit_observations WHERE intent_id=pi.id AND canonical ORDER BY first_seen_at DESC LIMIT 1
         ) d ON true WHERE pi.id=$1`,
      [id],
    );
    const st = s.rows[0]!;
    reply.header("cache-control", "no-store").send({
      checkoutId: id,
      scanned,
      scanError,
      status: st.status,
      zecReceived: ["deposit_seen", "confirming", "deposit_accepted"].includes(st.status) || (st.received_zatoshis ?? "0") !== "0",
      zecConfirmed: st.status === "deposit_accepted",
      receivedZatoshis: st.received_zatoshis ?? "0",
      confirmations: st.confirmations ?? 0,
      confirmationsRequired: ctx.cfg.policy.requiredConfirmations,
      checkedAt: new Date().toISOString(),
    });
  });

  /* ---------------------------------------------------------------- Zcash network status (public, no secrets) */
  app.get("/api/v1/zcash/networks", async (_req, reply) => {
    const r = await readiness(ctx);
    const rows = r.db
      ? await ctx.db.query<{ network: string; status: string; tip_height: string | null; scanned_height: string | null; ironwood_supported: boolean; nu7_active: boolean; gateway_version: string | null; updated_at: Date; last_error: string | null }>(
          `SELECT network, status, tip_height, scanned_height, ironwood_supported, nu7_active, gateway_version, updated_at, last_error FROM scanner_state WHERE environment=$1`,
          [ctx.env],
        )
      : { rows: [] };
    const watcher = ctx.zkool ? { kind: "zkool_graphql", addressMode: ctx.zkool.addressMode, viewing: "watch-only UFVK (cannot spend)" } : ctx.cfg.zcashGateway ? { kind: "zcash-gateway" } : null;
    reply.header("cache-control", "no-store").send({
      environment: ctx.env,
      network: ctx.cfg.zcashNetwork ?? "demo",
      watcher,
      confirmationsRequired: ctx.cfg.policy.requiredConfirmations,
      receivingOpen: r.features.paymentLinks.available,
      receivingReason: r.features.paymentLinks.reason,
      explorerTxBase: ctx.cfg.zcashNetwork === "testnet" ? "https://zexplorer.app/testnet/tx/" : ctx.cfg.zcashNetwork === "mainnet" ? "https://zexplorer.app/tx/" : null,
      realMoney: ctx.caps.creditsRedeemable,
      networks: rows.rows.map((s) => ({
        network: s.network,
        status: s.status === "syncing" ? "WATCHER_CATCHING_UP" : s.status === "synced" ? "SYNCED" : s.status.toUpperCase(),
        chainTipHeight: s.tip_height ? Number(s.tip_height) : null,
        walletSyncedHeight: s.scanned_height ? Number(s.scanned_height) : null,
        lagBlocks: s.tip_height && s.scanned_height ? Number(s.tip_height) - Number(s.scanned_height) : null,
        ironwood: s.ironwood_supported,
        nu7Active: s.nu7_active,
        watcherVersion: s.gateway_version,
        lastUpdatedAt: new Date(s.updated_at).toISOString(),
        stale: Date.now() - new Date(s.updated_at).getTime() > 120_000,
        lastError: s.last_error ? s.last_error.replace(/Bearer\s+\S+/g, "Bearer ***").slice(0, 160) : null,
      })),
      privacy: "The light-wallet server sees the watcher's IP and sync timing. The watch-only key sees incoming amounts and memos. Explorers prove a txid exists but cannot show shielded amounts.",
    });
  });

  /* ---------------------------------------------------------------- contract routes */
  for (const def of Object.values(ROUTES) as RouteDef[]) {
    if (def.demoOnly && ctx.env !== "demo") continue;
    const handler = HANDLERS[def.operationId as keyof typeof ROUTES];
    const rate = RATE[def.operationId];
    app.route({
      method: def.method,
      url: def.path,
      config: rate ? { rateLimit: { ...rate, max: rate.max * scale } } : {},
      handler: async (raw, reply) => {
        const bearerHdr = raw.headers.authorization;
        const req: Req = {
          ctx,
          def,
          params: (raw.params ?? {}) as Record<string, string>,
          query: (raw.query ?? {}) as Record<string, unknown>,
          body: raw.body,
          principal: await resolvePrincipal(ctx, raw),
          anonId: raw.cookies?.[ANON_COOKIE] ?? `ip-${ipHash(ctx, raw.ip)}`,
          bearer: typeof bearerHdr === "string" && bearerHdr.startsWith("Bearer ") ? bearerHdr.slice(7).trim() : null,
          requestId: String(raw.id),
          ipHash: ipHash(ctx, raw.ip),
          userAgent: (raw.headers["user-agent"] as string | undefined) ?? null,
          raw,
          reply,
        };
        req.params = def.params ? (def.params.parse(req.params) as Record<string, string>) : {};
        req.query = def.query ? (def.query.parse(req.query) as Record<string, unknown>) : {};
        req.body = def.body ? def.body.parse(raw.body ?? {}) : undefined;
        authorize(req);
        checkCsrf(req);
        reply.header("cache-control", def.operationId === "getPublicConfig" ? "public, max-age=15" : "no-store");

        let idem: Awaited<ReturnType<typeof idempotencyBegin>> | null = null;
        if (def.idempotent) {
          idem = await idempotencyBegin(req);
          if (idem.replay) {
            reply.header("idempotent-replayed", "true");
            return reply.code(idem.replay.status).send(idem.replay.body);
          }
        }
        let out: unknown;
        try {
          out = await handler(req);
        } catch (e) {
          if (idem) await idempotencyAbort(req, idem);
          throw e;
        }
        const parsed = def.response.safeParse(out);
        if (!parsed.success) {
          if (idem) await idempotencyAbort(req, idem);
          raw.log?.error?.({ op: def.operationId, issues: parsed.error.issues.slice(0, 5) }, "response contract violation");
          throw new DomainError("SYSTEM_CONTRACT", "Response failed contract validation", undefined, { status: 500 });
        }
        const status = def.status ?? 200;
        if (idem) await idempotencyEnd(req, idem, status, parsed.data);
        if (def.method === "GET") {
          const etag = `W/"${createHash("sha256").update(JSON.stringify(parsed.data)).digest("base64url").slice(0, 27)}"`;
          reply.header("etag", etag);
          if (raw.headers["if-none-match"] === etag) return reply.code(304).send();
        }
        return reply.code(status).send(parsed.data);
      },
    });
  }

  /* ---------------------------------------------------------------- SSE */
  app.get("/api/v1/events", async (raw, reply) => {
    const q = raw.query as { resource?: string; access_token?: string; lastEventId?: string };
    const resource = q.resource ?? "";
    const m = /^(checkout|withdrawal|merchant):([a-z]{2,5}_[0-9a-z]{16,40}|me)$/.exec(resource);
    if (!m) throw new DomainError("VALIDATION_RESOURCE", "resource must be checkout:{id}, withdrawal:{id} or merchant:me");
    const principal = await resolvePrincipal(ctx, raw);
    const bearer = q.access_token ?? (typeof raw.headers.authorization === "string" ? raw.headers.authorization.replace(/^Bearer /, "") : null);
    const base = { ctx, def: ROUTES.getCheckout as RouteDef, params: {}, query: {}, body: undefined, principal, anonId: "", bearer, requestId: String(raw.id), ipHash: "", userAgent: null, raw, reply } as Req;
    let key = resource;
    const check = async () => {
      if (m[1] === "checkout") await checkoutAccess(base, m[2]!);
      else if (m[1] === "withdrawal") {
        const w = await maybeOne<{ merchant_id: string }>(ctx.db, `SELECT merchant_id FROM withdrawals WHERE id=$1 AND environment=$2`, [m[2], ctx.env]);
        const p = await resolvePrincipal(ctx, raw);
        if (!w || p?.merchant?.id !== w.merchant_id) throw new DomainError("NOT_FOUND", "not found", undefined, { status: 404 });
      } else {
        const p = await resolvePrincipal(ctx, raw);
        if (!p?.merchant) throw new DomainError("AUTH_REQUIRED", "Sign in required", undefined, { status: 401 });
        key = `merchant:${p.merchant.id}`;
      }
    };
    await check();
    const lastHdr = raw.headers["last-event-id"] ?? q.lastEventId;
    let last = typeof lastHdr === "string" && /^\d{1,18}$/.test(lastHdr) ? BigInt(lastHdr) : 0n;

    reply.hijack();
    const origin = raw.headers.origin;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(origin && ctx.cfg.webOrigins.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {}),
    });
    reply.raw.write(`retry: 3000\n\n`);
    let closed = false;
    const started = Date.now();
    let lastBeat = Date.now();
    let lastAuth = Date.now();
    raw.raw.on("close", () => {
      closed = true;
    });
    while (!closed && Date.now() - started < 30 * 60_000) {
      try {
        if (Date.now() - lastAuth > 30_000) {
          await check(); // access revocation: drop the stream if the session/token no longer allows it
          lastAuth = Date.now();
        }
        const rows = await many<{ id: string; event_type: string; data: unknown; created_at: Date }>(
          ctx.db,
          `SELECT id, event_type, data, created_at FROM resource_events WHERE resource=$1 AND environment=$2 AND id > $3 ORDER BY id LIMIT 100`,
          [key, ctx.env, last.toString()],
        );
        for (const r of rows) {
          reply.raw.write(`id: ${r.id}\nevent: ${r.event_type}\ndata: ${JSON.stringify({ type: r.event_type, at: new Date(r.created_at).toISOString(), data: r.data })}\n\n`);
          last = BigInt(r.id);
        }
        if (Date.now() - lastBeat > 15_000) {
          reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
          lastBeat = Date.now();
        }
      } catch {
        reply.raw.write(`event: access_revoked\ndata: {}\n\n`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    reply.raw.end();
  });

  return app;
}
