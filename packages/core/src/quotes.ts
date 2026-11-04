/**
 * Quote creation (spec §7). A quote is an immutable DB row; its canonical inputs are hashed and
 * re-verified before any financial transition that relies on it.
 */
import { createHash } from "node:crypto";
import { one, tx, type Queryable } from "@zeb/db";
import { computeQuote, DomainError, newId, QUOTE_FORMULA_VERSION, type QuoteBreakdown } from "@zeb/domain";
import { treasury } from "@zeb/ledger";
import { canonicalJson } from "@zeb/security";
import { usesTreasury, type CoreContext } from "./context";
import { featureFor, readiness } from "./gates";
import { persistSnapshot, readP2P, readZecUsd } from "./rates";

export type QuoteMode = "scan_pay" | "terminal" | "counter_qr" | "payment_link";

export interface QuoteRow {
  id: string;
  environment: string;
  payment_mode: QuoteMode;
  privacy_mode: "shielded" | "transparent";
  inr_paise: string;
  zec_zatoshis: string;
  required_usdc_micros: string;
  platform_fee_inr_paise: string;
  p2p_fee_usdc_micros: string;
  p2p_fee_inr_paise: string;
  zec_usd_rate: string;
  inr_per_usdc_rate6: string;
  price_source: string;
  p2p_source: string;
  formula_version: string;
  policy: Record<string, unknown>;
  breakdown: Record<string, string>;
  inputs_hash: string;
  observed_at: Date;
  created_at: Date;
  expires_at: Date;
  funding_deadline: Date;
  finality_deadline: Date;
  payment_eligible: boolean;
  disabled_reason: string | null;
  execution_not_guaranteed: boolean;
  consumed_by: string | null;
}

function inputsCanonical(i: { env: string; mode: string; privacy: string; inrPaise: bigint; zecUsd: string; sellPrice6: bigint; fee: object; policy: object; formula: string; expiresAt: string }) {
  return canonicalJson({ ...i, inrPaise: i.inrPaise.toString(), sellPrice6: i.sellPrice6.toString() });
}

export function quoteInputsHash(row: QuoteRow): string {
  const fee = (row.policy as { p2pFee?: object }).p2pFee ?? {};
  return createHash("sha256")
    .update(
      inputsCanonical({
        env: row.environment,
        mode: row.payment_mode,
        privacy: row.privacy_mode,
        inrPaise: BigInt(row.inr_paise),
        zecUsd: row.zec_usd_rate,
        sellPrice6: BigInt(row.inr_per_usdc_rate6),
        fee,
        policy: (row.policy as { quotePolicy?: object }).quotePolicy ?? {},
        formula: row.formula_version,
        expiresAt: new Date(row.expires_at).toISOString(),
      }),
    )
    .digest("hex");
}

/** Throws if a stored quote's inputs were tampered with. Called at every financial transition. */
export function assertQuoteIntegrity(row: QuoteRow): void {
  if (quoteInputsHash(row) !== row.inputs_hash) throw new DomainError("QUOTE_INTEGRITY", "quote inputs hash mismatch; refusing to act on it", { quoteId: row.id }, { status: 500 });
}

export async function createQuote(
  ctx: CoreContext,
  input: { mode: QuoteMode; inrPaise: bigint; privacy: "shielded" | "transparent"; allowTransparent: boolean },
): Promise<QuoteRow> {
  const p = ctx.cfg.policy;
  if (input.inrPaise < p.minInrPaise) throw new DomainError("QUOTE_AMOUNT_TOO_LOW", `Minimum is ${p.minInrPaise} paise`, { minInrPaise: p.minInrPaise.toString() });
  if (input.inrPaise > p.maxInrPaise) throw new DomainError("QUOTE_AMOUNT_TOO_HIGH", `Maximum is ${p.maxInrPaise} paise per payment (policy)`, { maxInrPaise: p.maxInrPaise.toString() });
  if (input.privacy === "transparent" && !input.allowTransparent) throw new DomainError("QUOTE_PRIVACY_NOT_ALLOWED", "Transparent ZEC is not enabled for this payment");

  // Rates must be live; without them we return an error, never a fallback number.
  const [zec, p2p] = await Promise.all([readZecUsd(ctx), readP2P(ctx)]);
  const fee = input.mode === "scan_pay" ? p2p.fee.smallOrderFixedFeePay : p2p.fee.smallOrderFixedFeeSell;
  const quotePolicy = { platformFeeBps: p.platformFeeBps, p2pSpreadReserveBps: p.p2pSpreadReserveBps, zecVolatilityPremiumBps: p.zecVolatilityPremiumBps };
  const b: QuoteBreakdown = computeQuote({
    inrPaise: input.inrPaise,
    p2pSellPrice6: p2p.sellPrice6,
    p2pFee: { smallOrderThreshold: p2p.fee.smallOrderThreshold, smallOrderFixedFee: fee },
    zecUsd: zec.rate,
    policy: quotePolicy,
  });

  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + p.quoteLifetimeSec * 1000);
  const fundingDeadline = new Date(expiresAt.getTime() + p.fundingGraceSec * 1000);
  const finalityDeadline = new Date(fundingDeadline.getTime() + p.finalityWindowSec * 1000);

  const ready = await readiness(ctx);
  let eligible = ready.features[featureFor(input.mode)];
  if (eligible.available && usesTreasury(ctx)) {
    const cap = await treasury.treasuryCapacity(ctx.db, ctx.env, { inventoryMaxAgeMs: p.treasuryInventoryMaxAgeSec * 1000, bufferMicros: p.treasuryBufferMicros }, now);
    if (cap.stale) eligible = { available: false, reason: "USDC treasury balance is stale" };
    else if (cap.freeMicros < b.requiredUsdcMicros) eligible = { available: false, reason: "Treasury liquidity is temporarily insufficient for this amount" };
  }

  const p2pFeeCfg = { smallOrderThreshold: p2p.fee.smallOrderThreshold.toString(), smallOrderFixedFee: fee.toString() };
  const inputsHash = createHash("sha256")
    .update(
      inputsCanonical({
        env: ctx.env,
        mode: input.mode,
        privacy: input.privacy,
        inrPaise: input.inrPaise,
        zecUsd: zec.rateText,
        sellPrice6: p2p.sellPrice6,
        fee: p2pFeeCfg,
        policy: quotePolicy,
        formula: QUOTE_FORMULA_VERSION,
        expiresAt: expiresAt.toISOString(),
      }),
    )
    .digest("hex");

  return tx(ctx.db, async (t) => {
    const s1 = await persistSnapshot(t, ctx, "zec_usd", zec.source, zec.rateText, { sources: zec.sources }, zec.observedAt);
    const s2 = await persistSnapshot(t, ctx, "p2p_price", p2p.source, p2p.sellPrice6.toString(), { sellPrice6: p2p.sellPrice6.toString() }, p2p.observedAt);
    const s3 = await persistSnapshot(t, ctx, "p2p_fee", p2p.source, fee.toString(), p2pFeeCfg, p2p.observedAt);
    const breakdown = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    return one<QuoteRow>(
      t,
      `INSERT INTO quotes(id, environment, payment_mode, privacy_mode, inr_paise, zec_zatoshis, required_usdc_micros, platform_fee_inr_paise,
         p2p_fee_usdc_micros, p2p_fee_inr_paise, zec_usd_rate, inr_per_usdc_rate6, price_source, p2p_source, formula_version, policy, breakdown,
         inputs_hash, rate_snapshot_ids, observed_at, expires_at, funding_deadline, finality_deadline, payment_eligible, disabled_reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [
        newId("quote"),
        ctx.env,
        input.mode,
        input.privacy,
        input.inrPaise.toString(),
        b.zecZatoshis.toString(),
        b.requiredUsdcMicros.toString(),
        b.platformFeeInrPaise.toString(),
        b.estimatedP2PFeeUsdcMicros.toString(),
        b.p2pFeeInrPaise.toString(),
        zec.rateText,
        p2p.sellPrice6.toString(),
        zec.source,
        p2p.source,
        QUOTE_FORMULA_VERSION,
        JSON.stringify({ quotePolicy, p2pFee: p2pFeeCfg, confirmations: ctx.cfg.policy.requiredConfirmations }),
        JSON.stringify(breakdown),
        inputsHash,
        [s1, s2, s3],
        new Date(Math.min(zec.observedAt.getTime(), p2p.observedAt.getTime())),
        expiresAt,
        fundingDeadline,
        finalityDeadline,
        eligible.available,
        eligible.reason,
        now,
      ],
    );
  });
}

export async function getQuote(q: Queryable, env: string, id: string): Promise<QuoteRow | null> {
  const r = await q.query(`SELECT * FROM quotes WHERE id=$1 AND environment=$2`, [id, env]);
  return (r.rows[0] as QuoteRow) ?? null;
}

export function quoteDto(r: QuoteRow) {
  const sell = BigInt(r.inr_per_usdc_rate6);
  return {
    id: r.id,
    environment: r.environment as "demo",
    paymentMode: r.payment_mode,
    inrPaise: r.inr_paise,
    zecZatoshis: r.zec_zatoshis,
    requiredUsdcMicros: r.required_usdc_micros,
    platformFeeInrPaise: r.platform_fee_inr_paise,
    estimatedP2PFeeUsdcMicros: r.p2p_fee_usdc_micros,
    estimatedP2PFeeInrPaise: r.p2p_fee_inr_paise,
    networkFeePolicy: "Payer pays Zcash network fees in addition to the quoted amount.",
    totalZecZatoshis: r.zec_zatoshis,
    zecUsdRate: r.zec_usd_rate,
    inrPerUsdcRate: `${sell / 1_000_000n}.${(sell % 1_000_000n).toString().padStart(6, "0")}`,
    priceSource: r.price_source,
    p2pSource: r.p2p_source,
    observedAt: new Date(r.observed_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    fundingDeadline: new Date(r.funding_deadline).toISOString(),
    finalityDeadline: new Date(r.finality_deadline).toISOString(),
    fiatGuaranteePolicyId: "merchant-net-fixed-at-confirmation/treasury-absorbs-fx/v1",
    privacyMode: r.privacy_mode,
    maxSlippageBps: Number((r.policy as { quotePolicy?: { zecVolatilityPremiumBps?: number } }).quotePolicy?.zecVolatilityPremiumBps ?? 0),
    paymentEligible: r.payment_eligible,
    ...(r.disabled_reason ? { disabledReason: r.disabled_reason } : {}),
    executionNotGuaranteed: r.execution_not_guaranteed,
    formulaVersion: r.formula_version,
  };
}
