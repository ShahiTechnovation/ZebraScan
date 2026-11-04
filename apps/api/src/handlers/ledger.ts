import { many, maybeOne, one } from "@zeb/db";
import { notFound } from "@zeb/domain";
import { checkoutPublic, quoteDto, type QuoteRow } from "@zeb/core";
import { merchantBalances } from "@zeb/ledger";
import type { Handler, Req, AnyReq } from "../http";
import { decodeCursor, encodeCursor } from "./paging";

interface TxRow {
  id: string;
  mode: "terminal";
  status: string;
  inr_paise: string;
  platform_fee_inr_paise: string;
  zec_zatoshis: string;
  received_zatoshis: string;
  privacy_mode: "shielded";
  link_id: string | null;
  credit_id: string | null;
  credit_status: string | null;
  receipt_id: string | null;
  created_at: Date;
  accepted_at: Date | null;
}

const TX_SQL = `SELECT pi.id, pi.mode, pi.status, q.inr_paise, q.platform_fee_inr_paise, q.zec_zatoshis, pi.received_zatoshis, pi.privacy_mode, pi.link_id,
    c.id AS credit_id, c.status AS credit_status, pi.receipt_id, pi.created_at, pi.accepted_at
  FROM payment_intents pi JOIN quotes q ON q.id = pi.quote_id
  LEFT JOIN merchant_credits c ON c.intent_id = pi.id AND c.parent_credit_id IS NULL`;

function txDto(req: AnyReq, r: TxRow) {
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    inrPaise: r.inr_paise,
    platformFeeInrPaise: r.platform_fee_inr_paise,
    zecZatoshis: r.zec_zatoshis,
    receivedZatoshis: r.received_zatoshis,
    privacyMode: r.privacy_mode,
    linkId: r.link_id,
    creditId: r.credit_id,
    creditStatus: r.credit_status,
    receiptId: r.receipt_id,
    createdAt: new Date(r.created_at).toISOString(),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
    label: req.ctx.caps.label,
  };
}

export const listTransactions: Handler = async (req: Req<object, { cursor?: string; limit: number; mode?: string; status?: string }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<TxRow>(
    req.ctx.db,
    `${TX_SQL} WHERE pi.merchant_id=$1 AND pi.environment=$2 AND ($3::text IS NULL OR pi.mode=$3) AND ($4::text IS NULL OR pi.status=$4)
       AND ($5::timestamptz IS NULL OR (pi.created_at, pi.id) < ($5, $6)) ORDER BY pi.created_at DESC, pi.id DESC LIMIT $7`,
    [req.principal!.merchant!.id, req.ctx.env, req.query.mode ?? null, req.query.status ?? null, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  return { items: page.map((r) => txDto(req, r)), nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null };
};

export const getTransaction: Handler = async (req: Req<{ id: string }>) => {
  const r = await maybeOne<TxRow>(req.ctx.db, `${TX_SQL} WHERE pi.id=$1 AND pi.merchant_id=$2 AND pi.environment=$3`, [req.params.id, req.principal!.merchant!.id, req.ctx.env]);
  if (!r) throw notFound("transaction", req.params.id);
  const c = await checkoutPublic(req.ctx.db, req.ctx, r.id);
  const lastRecon = await maybeOne<{ finished_at: Date; ok: boolean }>(req.ctx.db, `SELECT finished_at, ok FROM reconciliation_runs WHERE environment=$1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`, [req.ctx.env]);
  const recState: "pending" | "reconciled" | "discrepancy" = !lastRecon || !r.accepted_at || new Date(lastRecon.finished_at) < new Date(r.accepted_at) ? "pending" : lastRecon.ok ? "reconciled" : "discrepancy";
  return {
    ...txDto(req, r),
    timeline: c.timeline,
    deposits: c.deposits,
    finality: { requiredConfirmations: c.zcash.requiredConfirmations, currentConfirmations: c.zcash.currentConfirmations, canonical: c.deposits.every((d) => d.canonical) },
    reconciliation: { state: recState, lastCheckedAt: lastRecon ? new Date(lastRecon.finished_at).toISOString() : null },
  };
};

export const getBalance: Handler = async (req) => {
  const id = req.principal!.merchant!.id;
  const b = await merchantBalances(req.ctx.db, req.ctx.env, id);
  const pending = await one<{ total: string | null }>(
    req.ctx.db,
    `SELECT sum(q.inr_paise) AS total FROM payment_intents pi JOIN quotes q ON q.id=pi.quote_id WHERE pi.merchant_id=$1 AND pi.status IN ('deposit_seen','confirming')`,
    [id],
  );
  const lastRecon = await maybeOne<{ finished_at: Date }>(req.ctx.db, `SELECT finished_at FROM reconciliation_runs WHERE environment=$1 AND ok IS TRUE ORDER BY finished_at DESC LIMIT 1`, [req.ctx.env]);
  const liability = b.lockedInrPaise + b.availableInrPaise + b.reservedInrPaise;
  return {
    merchantId: id,
    currency: "INR",
    pendingInrPaise: pending.total ?? "0",
    lockedInrPaise: b.lockedInrPaise.toString(),
    availableInrPaise: b.availableInrPaise.toString(),
    reservedInrPaise: b.reservedInrPaise.toString(),
    withdrawnInrPaise: b.withdrawnInrPaise.toString(),
    liabilityInrPaise: liability.toString(),
    redeemable: req.ctx.caps.creditsRedeemable,
    lastReconciledAt: lastRecon ? new Date(lastRecon.finished_at).toISOString() : null,
    disclaimer: req.ctx.caps.creditsRedeemable
      ? "INR-denominated platform balance. Not yet in your bank account."
      : `INR-denominated ${req.ctx.caps.label ?? ""} platform balance. Not redeemable for real money in this environment.`.replace("  ", " "),
  };
};

export const listBalanceEntries: Handler = async (req: Req<object, { cursor?: string; limit: number }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<{ id: string; journal_id: string; created_at: Date; kind: string; code: string; debit_minor: string; credit_minor: string; memo: string; event_id: string }>(
    req.ctx.db,
    `SELECT p.id, p.journal_id, p.created_at, j.kind, a.code, p.debit_minor, p.credit_minor, j.memo, j.event_id
       FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id JOIN ledger_accounts a ON a.id=p.account_id
      WHERE p.merchant_id=$1 AND j.environment=$2 AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3, $4))
      ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
    [req.principal!.merchant!.id, req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      journalId: r.journal_id,
      at: new Date(r.created_at).toISOString(),
      kind: r.kind,
      account: r.code,
      direction: BigInt(r.credit_minor) > 0n ? ("credit" as const) : ("debit" as const),
      amountInrPaise: BigInt(r.credit_minor) > 0n ? r.credit_minor : r.debit_minor,
      memo: r.memo,
      refId: r.event_id.split(":")[1] ?? null,
    })),
    nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
  };
};

export const listSettlements: Handler = async (req: Req<object, { cursor?: string; limit: number }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<{ id: string; intent_id: string | null; amount_inr_paise: string; status: string; locked_at: Date | null; unlocks_at: Date | null; available_at: Date | null; withdrawal_id: string | null; policy_version: string; created_at: Date }>(
    req.ctx.db,
    `SELECT id, intent_id, amount_inr_paise, status, locked_at, unlocks_at, available_at, withdrawal_id, policy_version, created_at FROM merchant_credits
      WHERE merchant_id=$1 AND environment=$2 AND status <> 'split' AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4)) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [req.principal!.merchant!.id, req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    items: page.map((r) => ({ creditId: r.id, intentId: r.intent_id, amountInrPaise: r.amount_inr_paise, status: r.status, lockedAt: iso(r.locked_at), unlocksAt: iso(r.unlocks_at), availableAt: iso(r.available_at), withdrawalId: r.withdrawal_id, policyVersion: r.policy_version })),
    nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
  };
};

export { quoteDto, type QuoteRow };
