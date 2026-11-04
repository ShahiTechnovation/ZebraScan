/**
 * Internal service endpoints. Transport: mTLS terminated at the internal ingress (see
 * infra/deploy). Defence in depth: every request must also carry
 *   X-Zeb-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(INTERNAL_HMAC_SECRET, "<t>.<raw body>")>
 * with |now - t| <= 300s. Events are deduplicated by (source, eventId).
 */
import { createHmac } from "node:crypto";
import { maybeOne } from "@zeb/db";
import { DomainError } from "@zeb/domain";
import { enqueueJob, ingestScannerEvent, type ScannerEvent } from "@zeb/core";
import { safeEqual } from "@zeb/security";
import type { Handler, Req, AnyReq } from "../http";

export function verifyInternalSignature(req: AnyReq): void {
  const secret = req.ctx.cfg.internalHmacSecret;
  if (!secret) throw new DomainError("SYSTEM_INTERNAL_DISABLED", "Internal endpoints are disabled (INTERNAL_HMAC_SECRET not configured)", undefined, { status: 503 });
  const h = req.raw.headers["x-zeb-signature"];
  const m = typeof h === "string" ? /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(h) : null;
  if (!m) throw new DomainError("AUTH_SIGNATURE", "Missing or malformed signature", undefined, { status: 401 });
  const t = Number(m[1]);
  if (Math.abs(req.ctx.now().getTime() / 1000 - t) > 300) throw new DomainError("AUTH_SIGNATURE_STALE", "Signature timestamp outside tolerance", undefined, { status: 401 });
  const raw = (req.raw as unknown as { rawBody?: string }).rawBody ?? "";
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  if (!safeEqual(expected, m[2]!)) throw new DomainError("AUTH_SIGNATURE", "Invalid signature", undefined, { status: 401 });
}

export const internalZcashEvents: Handler = async (req: Req<object, object, ScannerEvent>) => {
  verifyInternalSignature(req);
  return ingestScannerEvent(req.ctx, req.body);
};

/** P2P events are wake-up hints only: the payout job re-reads the order on chain before acting. */
export const internalP2PEvents: Handler = async (req: Req<object, object, { eventId: string; chainId: number; orderId: string }>) => {
  verifyInternalSignature(req);
  const { ctx, body } = req;
  if (!ctx.p2p || body.chainId !== ctx.p2p.cfg.chainId) throw new DomainError("P2P_CHAIN_MISMATCH", "Event chain does not match configuration", undefined, { status: 400 });
  const ins = await ctx.db.query(`INSERT INTO inbound_event_receipts(source, event_id, environment, payload_hash) VALUES ('p2p-watcher',$1,$2,'-') ON CONFLICT DO NOTHING`, [body.eventId, ctx.env]);
  if (ins.rowCount === 0) return { accepted: false, duplicate: true };
  const o = await maybeOne<{ intent_id: string | null; withdrawal_id: string | null }>(ctx.db, `SELECT intent_id, withdrawal_id FROM p2p_orders WHERE environment=$1 AND chain_id=$2 AND onchain_order_id=$3`, [ctx.env, body.chainId, body.orderId]);
  if (!o) return { accepted: false, duplicate: false };
  const kind = o.intent_id ? "scan_pay" : "withdrawal";
  const id = (o.intent_id ?? o.withdrawal_id)!;
  await enqueueJob(ctx.db, ctx.env, "payout.advance", `${kind}:${id}`, { kind, id });
  return { accepted: true, duplicate: false };
};

export const internalWebhook: Handler = async (req: Req<{ provider: string }>) => {
  verifyInternalSignature(req);
  // No external webhook providers are configured in this build. Unknown providers are rejected
  // rather than accepted silently.
  throw new DomainError("NOT_FOUND", `No webhook handler for provider "${req.params.provider}"`, undefined, { status: 404 });
};
