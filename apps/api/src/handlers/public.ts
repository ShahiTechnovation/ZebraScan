import { maybeOne } from "@zeb/db";
import { DomainError, ENVIRONMENT_DISPLAY, maskVpa, notFound, parseUpiPayload } from "@zeb/domain";
import { createQuote, getQuote, quoteDto, readiness, readP2P, readZecUsd } from "@zeb/core";
import type { Handler, Req } from "../http";

const DISCLAIMERS = [
  "Zeb Scan is custodial: ZEC you send is received by Zeb Scan's wallet.",
  "Shielded ZEC protects on-chain payment details. The INR payout provider and banks still see banking information.",
  "INR is delivered off-chain by independent P2P liquidity providers. Timing is not guaranteed.",
  "Merchant balances are INR-denominated platform credits, not money in a bank account.",
  "Rates shown are reference prices, not a promise of execution.",
];

export const getPublicConfig: Handler = async ({ ctx }) => {
  const r = await readiness(ctx);
  return {
    environment: ctx.env,
    label: ctx.caps.label,
    apiVersion: "v1",
    minClientVersion: "0.2.0",
    zcashNetwork: ctx.cfg.zcashNetwork,
    privacyModes: ["shielded", "transparent"],
    products: {
      scanPay: r.features.scanPay.available,
      terminal: r.features.terminal.available,
      counterQr: r.features.terminal.available,
      paymentLinks: r.features.paymentLinks.available,
      withdrawals: r.features.withdrawals.available,
    },
    limits: { minInrPaise: ctx.cfg.policy.minInrPaise.toString(), maxInrPaise: ctx.cfg.policy.maxInrPaise.toString() },
    quoteLifetimeSeconds: ctx.cfg.policy.quoteLifetimeSec,
    requiredConfirmations: ctx.cfg.policy.requiredConfirmations,
    fees: { platformFeeBps: ctx.cfg.policy.platformFeeBps, withdrawalFeeBps: ctx.cfg.policy.withdrawalFeeBps },
    disclaimers: ctx.env === "testnet" ? ["HACKATHON_TESTNET: real shielded TAZ (worthless test coins). No INR is ever paid out and balances are not redeemable.", ...DISCLAIMERS] : ctx.env === "demo" ? ["DEMO: simulated payments only. Nothing here moves real money.", ...DISCLAIMERS] : DISCLAIMERS,
    auth: { emailPassword: true, emailOtp: true, passkey: false, noirWallet: true, google: false, emailDelivery: ctx.cfg.email.mode==='smtp' || (ctx.env==='demo' && !!ctx.email) },
    wallet: { noirNetwork: ctx.env === "mainnet-readonly" || ctx.env === "mainnet-enabled" ? "zcash-mainnet" : "zcash-testnet", payWithNoir: ctx.caps.realChainAddresses },
    payoutRail: ctx.cfg.payoutRail,
    modeName: ENVIRONMENT_DISPLAY[ctx.env] as "DEMO",
    capabilities: { realChainAddresses: ctx.caps.realChainAddresses, creditsRedeemable: ctx.caps.creditsRedeemable, canSubmitTransactions: ctx.caps.canSubmitTransactions },
  };
};

export const getPublicHealth: Handler = async ({ ctx }) => {
  const r = await readiness(ctx);
  return {
    environment: ctx.env,
    maintenance: !!r.paused.all,
    products: { scanPay: r.features.scanPay, terminal: r.features.terminal, paymentLinks: r.features.paymentLinks, withdrawals: r.features.withdrawals },
    checkedAt: r.checkedAt.toISOString(),
  };
};

export const getZecUsdRate: Handler = async ({ ctx }) => {
  try {
    const z = await readZecUsd(ctx);
    return {
      pair: "ZEC/USD",
      rate: z.rateText,
      sources: z.sources,
      observedAt: z.observedAt.toISOString(),
      stale: false,
      confidence: z.confidence,
      disclaimer: ctx.env === "demo" ? "Fictional demo constant — not market data." : "Reference market rate (median of independent sources). Not an executable price.",
    };
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError("RATE_UNAVAILABLE", "Live ZEC/USD rate unavailable", undefined, { retryable: true });
  }
};

export const getInrUsdcRate: Handler = async ({ ctx }) => {
  try {
    const p = await readP2P(ctx);
    const s = p.sellPrice6;
    return {
      pair: "INR/USDC",
      sellPrice: `${s / 1_000_000n}.${(s % 1_000_000n).toString().padStart(6, "0")}`,
      source: p.source,
      observedAt: p.observedAt.toISOString(),
      available: true,
      reason: null,
      disclaimer: ctx.env === "demo" ? "Fictional demo constant." : "P2P protocol configured price. A matching liquidity provider is not guaranteed.",
    };
  } catch (e) {
    return { pair: "INR/USDC", sellPrice: null, source: "p2p", observedAt: null, available: false, reason: (e as Error).message, disclaimer: "P2P price unavailable." };
  }
};

export const parseUpi: Handler = async ({ body }: Req<object, object, { payload: string }>) => {
  const p = parseUpiPayload(body.payload);
  return { vpa: p.vpa, vpaMasked: maskVpa(p.vpa), payeeName: p.payeeName, amountInrPaise: p.amountInrPaise?.toString() ?? null, note: p.note, support: p.support, notices: p.notices };
};

export const createQuoteH: Handler = async ({ ctx, body }: Req<object, object, { mode: "scan_pay"; inrPaise: string; privacyPreference: "shielded" | "transparent"; merchantHandle?: string; linkSlug?: string }>) => {
  let allowTransparent = body.mode === "scan_pay";
  if (body.mode !== "scan_pay") {
    // Merchant modes: the merchant's preference decides whether transparent ZEC is offered.
    const m = body.linkSlug
      ? await maybeOne<{ preferences: { allowTransparent?: boolean } }>(ctx.db, `SELECT m.preferences FROM payment_links l JOIN merchants m ON m.id=l.merchant_id WHERE l.slug=$1 AND l.environment=$2`, [body.linkSlug, ctx.env])
      : body.merchantHandle
        ? await maybeOne<{ preferences: { allowTransparent?: boolean } }>(ctx.db, `SELECT preferences FROM merchants WHERE (handle=$1 OR counter_slug=$1) AND environment=$2`, [body.merchantHandle, ctx.env])
        : null;
    if (!m && (body.linkSlug || body.merchantHandle)) throw notFound("merchant");
    allowTransparent = !!m?.preferences?.allowTransparent;
  }
  const q = await createQuote(ctx, { mode: body.mode, inrPaise: BigInt(body.inrPaise), privacy: body.privacyPreference, allowTransparent });
  return quoteDto(q);
};

export const getQuoteH: Handler = async ({ ctx, params }: Req<{ id: string }>) => {
  const q = await getQuote(ctx.db, ctx.env, params.id);
  if (!q) throw notFound("quote", params.id);
  return quoteDto(q);
};
