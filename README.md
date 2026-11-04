# Zeb Scan: pay any UPI QR or a merchant checkout in shielded ZEC — they get INR

**Pay in ZEC. They get INR.** Three products: **Scan & Pay** (pay an existing merchant's UPI QR), **Merchant QR Terminal**, and **Payment Links**.

## Who it's for and the problem
Zcash holders in India who want to pay ordinary UPI merchants, and small merchants who want to accept shielded ZEC without running a wallet stack. *No user interviews are recorded yet — add real evidence from the venue here; do not invent any.*

## Demo
- Video: _not recorded yet_ · Public URL: _not deployed yet_
- **Testnet transaction ID: none yet.** Real Ironwood deposit detection needs a watch-only `zkool_graphql` (or the Rust gateway) running; this build machine could not run either (see Status). Once a payment lands, record `txid` + `https://zexplorer.app/testnet/tx/<txid>` here.
- Viewing key (optional): put the demo wallet's `uviewtest…` and birth height here (never a spending key).

## Status (evidence: `docs/READINESS_REPORT.md`)
| Area | State |
| --- | --- |
| Demo + connected UI against the real API/DB/worker (DEMO env) | **Tested** (unit 89, integration 43, browser E2E 23 + 2) |
| Payment-first redesign | **Done** (`docs/UI_SIMPLIFICATION_AUDIT.md`) |
| Noir wallet sign-in (challenge → `signMessage` derived → server verify) | **Tested with generated vectors**; no real-extension signature captured yet |
| Email one-time code sign-in | **Tested** |
| Passkeys | **Not implemented** (shown as unavailable) |
| HACKATHON_TESTNET deposit detection (zkool_graphql, memo-matched) | **Built + contract-tested; BLOCKED live** — needs a running zkool_graphql with a UFVK account |
| TinyFish P2P.me payout rail (state machine, approval, reconciliation) | **Built + fault-tested with a scripted port; BLOCKED live** — `TINYFISH_API_KEY` not configured; read-only preflight reports BLOCKED (`docs/P2P_BROWSER_CAPABILITY.md`) |
| Live INR payouts | **Disabled by policy** (never on testnet; pilot requires operator approval, caps, legal/provider permission) |

## Run it
```bash
pnpm install
cp .env.example .env    # fill secrets: pnpm exec tsx scripts/gen-dev-secrets.ts
pnpm db:migrate
NEXT_PUBLIC_ZEB_MODE=connected NEXT_PUBLIC_API_BASE_URL=http://localhost:4000 pnpm dev
```
For real testnet deposits (HACKATHON_TESTNET): run `zkool_graphql -d wallet.db -p 8000 -l https://testnet.zec.rocks:443 -C 1` on Linux, create a **watch-only** account from your UFVK with `birth`, then set `ZEB_ENVIRONMENT=HACKATHON_TESTNET ZKOOL_GRAPHQL_URL=http://127.0.0.1:8000/graphql ZKOOL_ACCOUNT_ID=<id>`. The worker refuses an account that can spend.

## How it works
1. Payer scans/pastes a UPI QR (or a merchant shows a QR / link); the server validates it and quotes exact zatoshis from two price feeds (no floats).
2. A checkout gets an Ironwood `utest1` address and a unique memo code `ZEB-…` in a ZIP-321 URI. Pay with any Zcash wallet (include the memo) or **Pay with Noir**.
3. The watch-only watcher sees the note, matches it by memo (never by amount), waits for confirmations, handles late/under/over payments and reorgs.
4. Merchant payments become locked INR-denominated credits (cooldown), then withdrawable. Scan & Pay (and withdrawals) create an immutable payout command for the TinyFish P2P.me rail — **operator-approved, read-only preflight first, reconciled separately; disabled on testnet**.

## Privacy and trust note
1. **What stays private:** sender, receiver and amount are shielded on-chain; the memo (invoice code only) is encrypted.
2. **What the app reveals, to whom:**
   - the light-wallet server (`testnet.zec.rocks`) sees the watcher's IP and sync timing;
   - our server stores invoice codes, txids, amounts, masked UPI IDs, encrypted full UPI IDs (envelope encryption), and a keyed fingerprint of a Noir login identity (not the address); emails only for email sign-in;
   - CoinGecko / Kraken see our price requests; P2P.me and its liquidity provider (and banks) see the INR recipient and amount for payouts; TinyFish operates our P2P.me account in a hosted browser and sees those screens;
   - no LLM receives customer data except TinyFish's agent, which sees the payout command fields it must check.
3. **Who users must trust:** Zeb Scan as custodian/operator; the P2P.me liquidity provider for INR delivery; TinyFish for browser automation; the light-wallet server for availability.
4. **What we'd fix next:** Nym for the watcher's traffic; passkeys; deleting payout PII after reconciliation; a non-browser, provider-authorized payout API.

## Technologies used
Next.js 15 / React 19 / Tailwind 3; Fastify 5; PostgreSQL 16+ (tested on 18.4); Zod 4.3.6; viem 2.47.6; @noir-wallet/sdk 0.1.9; @tiny-fish/sdk 0.11.0; @p2pdotme/sdk 1.3.10 (reference only); zkool_graphql (zkool2 v6.36.0, external); librustzcash crates pinned in `services/zcash-gateway` (not compiled); Argon2id (@node-rs/argon2); Vitest 3; Playwright.

## Next 30 days
Run the zkool watcher on a Linux host and record the first testnet txid; capture a real Noir extension signature as a test vector; get written P2P.me automation/permission and run the read-only TinyFish preflight; passkeys. *(Add links to any issue, PR or forum post you open.)*

## Feedback
See `FEEDBACK.md`. More docs: `docs/` (architecture, API, security, runbooks, readiness, dependency matrix), `AGENTS.md`.
