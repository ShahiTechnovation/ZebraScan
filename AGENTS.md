# Notes for AI coding agents working on Zeb Scan

Source of truth for Zcash facts: https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt (version 2026-11-02). Re-fetch when a new version is announced. Key overrides:

- **Testnet only** for the hackathon (TAZ, `utest1…` addresses). Mainnet funds are out of scope.
- NU7 is live on testnet (branch `77190ad9`, ~25 s blocks). v4 transactions are invalid.
- **Orchard is sealed** (NU6.3): new shielded funds go to **Ironwood**. Never write Orchard-only receiving code. The watcher ignores Orchard notes.
- The only live light-wallet server is `https://testnet.zec.rocks:443`. Old electriccoin/lightwalletd.com endpoints are dead.
- No pure JS can create Ironwood addresses: use zkool_graphql, zingo-cli, zcash-devtool, or the Noir testnet extension. WebZjs and crates.io zcli do not produce Ironwood receivers.
- Fees: let the wallet compute (ZIP 317). Memos ≤512 bytes, shielded only. Seen → mined → confirmed; a broadcast is not a payment.
- Explorer: `https://zexplorer.app/testnet/tx/<txid>`.
- Never put spending keys or seeds in code, logs, prompts or the repo. Viewing keys are fine server-side; label them.

## Project rules
- Money is integer minor units (paise / zatoshis / USDC micros) and integer strings on the wire. No floats.
- Deposits are matched by unique address or invoice memo, **never by amount**. Only the server's watcher advances deposit state.
- `HACKATHON_TESTNET` never executes INR payouts. TinyFish observations are untrusted; a TinyFish `COMPLETED` run is not payment success. No blind retries after a possible submission.
- The old on-chain P2P SDK executor is reference-only and must not be wired as a fallback.
- Frontend files in `apps/web` use CRLF line endings.
- Verify with `pnpm typecheck && pnpm lint && pnpm test && TEST_DATABASE_URL=…_test pnpm test:integration` before claiming status.
