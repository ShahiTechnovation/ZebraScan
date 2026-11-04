# Feedback notes (agent-observed friction, 2026-11-04). The builder writes the final FEEDBACK.md

## SDK or wallet tool: zkool2 `zkool_graphql` 6.36.0
- `pay` on a watch-only (UFVK) account with **no notes** returns `No feasible note selection found`, not `No Signing Key`, because note selection runs before signing. The event guide's "watch-only ⇒ No Signing Key" check only holds once the account has received funds. We nearly recorded a false proof.
- `newAddresses(idAccount)` (diversified address rotation) and per-note `diversifierIndex` were the key enablers for one-address-per-invoice. The event guide doesn't mention them; we found them in the source.
- A prebuilt Docker image exists (`hhanh00/zkool-graphql`) and saved a 30-minute Rust build. Only a Linux binary is attached to releases; there is no Windows build of the GraphQL server.
- An unauthenticated request with JWT enabled returns HTTP 500 `Unhandled rejection: AuthError` instead of 401.

## Node or indexer
- `testnet.zec.rocks:443` was reliable all evening. Mainnet `zec.rocks:443` reported 3,541,756–3,541,759 (pre-NU7).

## Faucet
- Fauzec API returned a txid immediately (1 TAZ), and funds were spendable within about 2 minutes.

## Hosting
- Render free web services have an ephemeral disk, so the wallet DB is lost on restart. An idempotent re-bootstrap from UFVK + birth height covers it.

## Build host
- No WSL/Docker/Rust on the Windows build machine, so all Zcash tooling had to run remotely.
