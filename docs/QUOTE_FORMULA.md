# Quote formula QF-2026-11-01

All integer/rational arithmetic (`packages/domain/src/quote.ts`); amounts that the treasury funds round **up**.

```
fiat6        = inrPaise × 10_000                          (P2P fiat is 6-decimal)
usdcForFiat  = ceil(fiat6 × 1e6 / sellPrice6)             (sellPrice6 = Diamond PriceConfig.sellPrice)
p2pFee       = usdcForFiat ≤ smallOrderThreshold ? smallOrderFixedFee{Pay|Sell} : 0
spread       = ceil(usdcForFiat × p2pSpreadReserveBps / 1e4)
requiredUsdc = usdcForFiat + p2pFee + spread               → treasury hold
platformFee  = ceil(inrPaise × platformFeeBps / 1e4)       (INR, payer-paid)
usdValue     = requiredUsdc + ceil(platformFee→USDC)
premium      = ceil(usdValue × zecVolatilityPremiumBps / 1e4)
zecZatoshis  = ceil((usdValue + premium) × 100 / zecUsd)   (zecUsd = oracle median, exact rational)
```

Assumption: 1 USDC valued at 1 USD on the ZEC leg; the premium and treasury FX policy absorb basis risk. Inputs (rate snapshot ids, fee config, policy, formula version, expiry) are hashed into `quotes.inputs_hash` and re-verified before acceptance. Worked example and invariants: `tests/unit/domain.test.ts`.
