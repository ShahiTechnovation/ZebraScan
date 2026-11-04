import { many, maybeOne } from "@zeb/db";
import { notFound } from "@zeb/domain";
import { cancelWithdrawal, createWithdrawal, quoteWithdrawal, withdrawalDto, type WithdrawalRow } from "@zeb/core";
import type { Handler, Req } from "../http";
import { decodeCursor, encodeCursor } from "./paging";

export const quoteWithdrawalH: Handler = async (req: Req<object, object, { inrPaise: string }>) => quoteWithdrawal(req.ctx, req.principal!.merchant!.id, BigInt(req.body.inrPaise));

export const createWithdrawalH: Handler = async (req: Req<object, object, { inrPaise: string; payoutDestinationId: string }>) => {
  const p = req.principal!;
  const w = await createWithdrawal(req.ctx, { merchantId: p.merchant!.id, userId: p.userId, inrPaise: BigInt(req.body.inrPaise), destinationId: req.body.payoutDestinationId, stepUpAt: new Date(p.stepUpAt!), requestId: req.requestId });
  return withdrawalDto(req.ctx.db, req.ctx, w);
};

export const listWithdrawals: Handler = async (req: Req<object, { cursor?: string; limit: number }>) => {
  const c = decodeCursor(req.query.cursor);
  const rows = await many<WithdrawalRow>(
    req.ctx.db,
    `SELECT * FROM withdrawals WHERE merchant_id=$1 AND environment=$2 AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4)) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [req.principal!.merchant!.id, req.ctx.env, c?.at ?? null, c?.id ?? "", req.query.limit + 1],
  );
  const page = rows.slice(0, req.query.limit);
  return { items: await Promise.all(page.map((w) => withdrawalDto(req.ctx.db, req.ctx, w))), nextCursor: rows.length > req.query.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null };
};

export const getWithdrawal: Handler = async (req: Req<{ id: string }>) => {
  const w = await maybeOne<WithdrawalRow>(req.ctx.db, `SELECT * FROM withdrawals WHERE id=$1 AND merchant_id=$2 AND environment=$3`, [req.params.id, req.principal!.merchant!.id, req.ctx.env]);
  if (!w) throw notFound("withdrawal", req.params.id);
  return withdrawalDto(req.ctx.db, req.ctx, w);
};

export const cancelWithdrawalH: Handler = async (req: Req<{ id: string }>) => {
  const w = await cancelWithdrawal(req.ctx, req.params.id, req.principal!.merchant!.id, req.principal!.userId);
  return withdrawalDto(req.ctx.db, req.ctx, w);
};
