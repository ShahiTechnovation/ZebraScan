# ADR-0002 — No custom smart contracts
Status: accepted

INR delivery uses P2P.me PAY (orderType 2) and SELL (orderType 1) orders through `@p2pdotme/sdk@1.3.10`, following the official examples exactly (approve `actualUsdcAmount`, `updatedFiatAmount = 0n`). We do not deploy contracts or bridges and there is no Zcash-side contract. The SDK is given a *guarded* wallet client that only sends zero-value transactions to the configured Diamond or Circle USDC, with explicit nonce and gas caps, persisting the nonce before and the hash after broadcast.
