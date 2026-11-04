/**
 * Append-only double-entry journal posting. Must be called inside the same DB transaction as the
 * state change it records (and the outbox event). Idempotent on (environment, eventId): replaying
 * the same economic event returns the original journal and verifies the lines are identical.
 *
 * Invariants enforced twice: here (fast, typed errors) and in PostgreSQL (deferred constraint
 * trigger: balanced per currency per journal; append-only triggers; currency matches account).
 */
import { createHash } from "node:crypto";
import type { Queryable } from "@zeb/db";
import { maybeOne, many } from "@zeb/db";
import { DomainError, newId, type Environment } from "@zeb/domain";
import { CHART, type AccountCode } from "./accounts";

export interface JournalLine {
  account: AccountCode;
  merchantId?: string | null;
  debit?: bigint;
  credit?: bigint;
}

export interface JournalInput {
  eventId: string;
  kind: string;
  memo?: string;
  effectiveAt?: Date;
  reversalOf?: string | null;
  operatorApprovalId?: string | null;
  lines: JournalLine[];
}

function linesHash(lines: JournalLine[]): string {
  const norm = lines
    .map((l) => `${l.account}|${l.merchantId ?? ""}|${(l.debit ?? 0n).toString()}|${(l.credit ?? 0n).toString()}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(norm).digest("hex");
}

export function validateLines(lines: JournalLine[]): void {
  if (lines.length < 2) throw new DomainError("LEDGER_TOO_FEW_LINES", "a journal needs at least two postings");
  const totals = new Map<string, { d: bigint; c: bigint }>();
  for (const l of lines) {
    const def = CHART[l.account];
    if (!def) throw new DomainError("LEDGER_UNKNOWN_ACCOUNT", `unknown account ${l.account}`);
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (d < 0n || c < 0n) throw new DomainError("LEDGER_NEGATIVE", "postings must be non-negative");
    if ((d === 0n) === (c === 0n)) throw new DomainError("LEDGER_ONE_SIDED", "each posting is exactly one of debit or credit");
    if (def.perMerchant && !l.merchantId) throw new DomainError("LEDGER_MERCHANT_REQUIRED", `${l.account} requires merchantId`);
    if (!def.perMerchant && l.merchantId) throw new DomainError("LEDGER_MERCHANT_FORBIDDEN", `${l.account} is not merchant-scoped`);
    const t = totals.get(def.currency) ?? { d: 0n, c: 0n };
    t.d += d;
    t.c += c;
    totals.set(def.currency, t);
  }
  for (const [cur, t] of totals) {
    if (t.d !== t.c) throw new DomainError("LEDGER_UNBALANCED", `journal unbalanced in ${cur}: debit ${t.d} credit ${t.c}`);
  }
}

async function accountId(q: Queryable, env: Environment, code: AccountCode, merchantId: string | null): Promise<string> {
  const def = CHART[code];
  const existing = await maybeOne<{ id: string }>(
    q,
    `SELECT id FROM ledger_accounts WHERE environment=$1 AND code=$2 AND currency=$3 AND coalesce(merchant_id,'')=coalesce($4,'')`,
    [env, code, def.currency, merchantId],
  );
  if (existing) return existing.id;
  const id = `acct_${env}_${code}${merchantId ? `_${merchantId}` : ""}`;
  await q.query(
    `INSERT INTO ledger_accounts(id, environment, code, currency, merchant_id, normal_side) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [id, env, code, def.currency, merchantId, def.normal],
  );
  return id;
}

export interface PostedJournal {
  journalId: string;
  replayed: boolean;
}

export async function postJournal(q: Queryable, env: Environment, j: JournalInput): Promise<PostedJournal> {
  validateLines(j.lines);
  const hash = linesHash(j.lines);
  const existing = await maybeOne<{ id: string; memo: string }>(q, `SELECT id, memo FROM ledger_journals WHERE environment=$1 AND event_id=$2`, [env, j.eventId]);
  if (existing) {
    const prev = await many<{ code: string; merchant_id: string | null; debit_minor: string; credit_minor: string }>(
      q,
      `SELECT a.code, p.merchant_id, p.debit_minor, p.credit_minor FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.journal_id=$1`,
      [existing.id],
    );
    const prevHash = linesHash(
      prev.map((p) => ({ account: p.code as AccountCode, merchantId: p.merchant_id, debit: BigInt(p.debit_minor), credit: BigInt(p.credit_minor) })),
    );
    if (prevHash !== hash) throw new DomainError("LEDGER_EVENT_CONFLICT", `event ${j.eventId} was already posted with different lines`, undefined, { status: 409 });
    return { journalId: existing.id, replayed: true };
  }
  const journalId = newId("journal");
  await q.query(
    `INSERT INTO ledger_journals(id, environment, event_id, kind, memo, effective_at, reversal_of, operator_approval_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [journalId, env, j.eventId, j.kind, j.memo ?? "", j.effectiveAt ?? new Date(), j.reversalOf ?? null, j.operatorApprovalId ?? null],
  );
  for (const l of j.lines) {
    const acct = await accountId(q, env, l.account, l.merchantId ?? null);
    await q.query(
      `INSERT INTO ledger_postings(id, journal_id, account_id, currency, debit_minor, credit_minor, merchant_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId("posting"), journalId, acct, CHART[l.account].currency, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString(), l.merchantId ?? null],
    );
  }
  return { journalId, replayed: false };
}

/** Compensating journal: swaps debit/credit of the original, linked via reversal_of. */
export async function reverseJournal(q: Queryable, env: Environment, originalEventId: string, eventId: string, memo: string, approvalId?: string): Promise<PostedJournal> {
  const orig = await maybeOne<{ id: string }>(q, `SELECT id FROM ledger_journals WHERE environment=$1 AND event_id=$2`, [env, originalEventId]);
  if (!orig) throw new DomainError("LEDGER_NOT_FOUND", `journal for ${originalEventId} not found`, undefined, { status: 404 });
  const rows = await many<{ code: string; merchant_id: string | null; debit_minor: string; credit_minor: string }>(
    q,
    `SELECT a.code, p.merchant_id, p.debit_minor, p.credit_minor FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.journal_id=$1`,
    [orig.id],
  );
  return postJournal(q, env, {
    eventId,
    kind: "reversal",
    memo,
    reversalOf: orig.id,
    operatorApprovalId: approvalId ?? null,
    lines: rows.map((r) => ({
      account: r.code as AccountCode,
      merchantId: r.merchant_id,
      debit: BigInt(r.credit_minor) || undefined,
      credit: BigInt(r.debit_minor) || undefined,
    })),
  });
}

/** Signed balance in the account's normal direction. */
export async function accountBalance(q: Queryable, env: Environment, code: AccountCode, merchantId: string | null = null): Promise<bigint> {
  const def = CHART[code];
  const r = await maybeOne<{ d: string | null; c: string | null }>(
    q,
    `SELECT sum(p.debit_minor) AS d, sum(p.credit_minor) AS c FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id
      WHERE a.environment=$1 AND a.code=$2 AND coalesce(a.merchant_id,'')=coalesce($3,'')`,
    [env, code, merchantId],
  );
  const d = BigInt(r?.d ?? "0");
  const c = BigInt(r?.c ?? "0");
  return def.normal === "debit" ? d - c : c - d;
}

export interface MerchantBalances {
  lockedInrPaise: bigint;
  availableInrPaise: bigint;
  reservedInrPaise: bigint;
  withdrawnInrPaise: bigint;
}

export async function merchantBalances(q: Queryable, env: Environment, merchantId: string): Promise<MerchantBalances> {
  const rows = await many<{ code: string; d: string; c: string }>(
    q,
    `SELECT a.code, coalesce(sum(p.debit_minor),0) AS d, coalesce(sum(p.credit_minor),0) AS c
       FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_id=a.id
      WHERE a.environment=$1 AND a.merchant_id=$2 GROUP BY a.code`,
    [env, merchantId],
  );
  const bal = (code: string) => {
    const r = rows.find((x) => x.code === code);
    return r ? BigInt(r.c) - BigInt(r.d) : 0n;
  };
  const withdrawn = await maybeOne<{ total: string | null }>(
    q,
    `SELECT sum(p.debit_minor) AS total FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id JOIN ledger_journals j ON j.id=p.journal_id
      WHERE a.environment=$1 AND a.merchant_id=$2 AND a.code='merchant_credits_withdrawal_reserved' AND j.kind='withdrawal_completed'`,
    [env, merchantId],
  );
  return {
    lockedInrPaise: bal("merchant_credits_locked"),
    availableInrPaise: bal("merchant_credits_available"),
    reservedInrPaise: bal("merchant_credits_withdrawal_reserved"),
    withdrawnInrPaise: BigInt(withdrawn?.total ?? "0"),
  };
}

/** Global invariant check used by reconciliation: every journal balanced per currency. */
export async function findUnbalancedJournals(q: Queryable, env: Environment): Promise<string[]> {
  const rows = await many<{ journal_id: string }>(
    q,
    `SELECT p.journal_id FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.environment=$1
      GROUP BY p.journal_id, p.currency HAVING sum(p.debit_minor) <> sum(p.credit_minor)`,
    [env],
  );
  return rows.map((r) => r.journal_id);
}
