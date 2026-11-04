# Zeb Scan: pay a UPI QR or a merchant checkout in shielded ZEC

**One-line pitch:** Zeb Scan gives every checkout its own shielded Zcash address, detects the payment with a watch-only viewing key, and turns a confirmed payment into an INR obligation for a UPI payee or merchant. It is aimed at Zcash holders in India and the small merchants they pay.

Three products share one receiving and ledger core: **Scan & Pay** (pay an existing UPI QR), **Merchant QR Terminal**, and **Payment Links**.

## Real public-testnet proof (Zcash testnet, NU7 + Ironwood)

| | |
| --- | --- |
| **Testnet txid (sent by this project)** | `5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7` |
| Explorer | https://zexplorer.app/testnet/tx/5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7 |
| What it is | Separate customer wallet A paid Scan & Pay checkout `pi_kddd0fe7xccewd6x2csrhykxdr` (₹1,000 test value = **0.00836471 TAZ**, Ironwood pool) |
| Receiving address | `utest1m8mtnuwdfsxy0d3e8p270ja8g88pvu6lchc92nxlq79jpzqpak6jktk3h3vvj85gjd90wz6zm2vdznv9r5ylc95vdnvwy5s2vq7vdkl73hfu84s5fmefyjzjspt6a5xdhch3yk47ed00p0avf25uhk5g43ndw9nhsr64t0xakya2zjeg`, a diversified address issued only for this checkout (diversifier index 1) |
| Detection | Automatic, with no txid pasted anywhere: mempool `deposit_seen` at 21:32:07 IST, mined at **height 4,582,568**, accepted at 21:32:55 IST with 1 confirmation required. 30+ confirmations later there is still exactly one observation, one receipt and two ledger journals, across several worker restarts |
| Matching | By the note's diversifier index → invoice address (never by amount or by the account's net delta). Amount comes from the incoming note value (`scope: 0`) |
| Watch-only proof | `pay` on the receiver account with a write token → **`No Signing Key`**. The worker's own token is account-scoped and read-only, so `pay` → `Unauthorized` |
| Evidence files | `docs/evidence/testnet-checkout-pi_kddd0fe7.json`, `testnet-payment-5c1f713d64e7.json`, `zkool-bootstrap-testnet.json`, `zkool-auth-testnet.json`, `zkool-schema-testnet.json`, `screens/testnet-scanpay-confirmed.png` |

**Demo wallet viewing key (receiver B, testnet only).** This is a viewing key: it reveals this demo wallet's history but **cannot spend**. Birth height **4582531**.

```
uviewtest1jxnxxt4tyn590h57wx4u7dqnw2lr7vjrzk073vseepuhlm56ws6393zh8njmh2nk4jqrm6z2stlxtaqdy225vadr77lmp73tvmw3zsuh7aujmgwracsxr84d3jycrz6k99gacf57kyr3k637qt7pw70t7sfp3fp9k27kszgs5wz5gctjv8fys0dmghmgf8afp9uxnvskktzwlgrtmnsf7z43569cdvhfsaf5yzpuwzjcd4nf70grrvhn3agnmrx0578dmv0unavm6prpscsulznzaztj9k2rxf9q8d8p6rfaa77jkks34vz2qjxpczwv8nqmz6sy66fyrqffv67lvr4v7aq3nrn5xze9m4fhu5vtd0peyhqdrlflxl937dg4zw8zt3n094eq0kc62l4adgfvzf88k82c2rz2xhv79slrfet3yycth3muj0gfkn9ppve650l7d0987k9pd7n230aclrt22hlcum0ufk7w2weuw6vq7ca0f8kp
```

The explorer proves the transaction exists, plus its height and fee. It cannot show a shielded amount or recipient. You can check those only with the viewing key above.

Faucet funding of wallet A (Fauzec, not a project transaction): `b056fc3a752cc67edd6f212791846406985d387e09225cbcb3143ec8f7b0d9b2`.

## Status per subsystem (evidence-backed)

| Subsystem | Status | Evidence |
| --- | --- | --- |
| Testnet watch-only watcher (zkool_graphql 6.36.0 on Render, JWT ES256) | **READY** | 6/6 auth checks (no token, forged key, expired, scoped and cross-network tokens all refused); synced, lag 0 |
| Unique address per checkout (`newAddresses` rotation) | **READY** | live checkout got dindex 1; unit test covers 2 concurrent allocations + index skipping after a wallet-DB reset |
| Deposit detection → confirmation → acceptance → receipt | **READY (testnet)** | txid above |
| Restart / replay idempotency | **READY** | observation key `(env, network, pool, txid, txid:p<pool>:d<dindex>:<zat>:<n>)` + `inbound_event_receipts`; regression test for a bug found live (re-seen accepted note mislabelled "Additional ZEC") |
| Mainnet watcher (separate Render service, DB, key, API on its own port) | **READY as MAINNET_READONLY** | tip 3,541,759 synced, NU7 not yet active (scheduled at 3,543,405); receiving, quotes, payouts and withdrawals all closed. `docs/evidence/mainnet-readonly-status.json` |
| Mainnet watch-only proof | **PARTIAL** | no seed on server + worker token `Unauthorized`; the `No Signing Key` probe needs a funded account and we will not fund mainnet. The mainnet monitor wallet's keys were generated on the watcher host, so it is **not for customer funds** |
| INR payout via existing P2P.me account in TinyFish | **BLOCKED (by design + missing key)** | testnet never enqueues real TinyFish jobs; `TINYFISH_API_KEY` not configured; spendable USDC unverified → payouts blocked |
| Merchant QR / Payment Link on testnet | built + integration-tested on the same core | live testnet run in this submission used Scan & Pay |
| Custom pool / EVM contract / ZEC vault | **None, by design** | ZEC stays in a Zcash wallet; INR liquidity is the operator's existing P2P.me account |

## How it works
1. A checkout gets a quote in exact zatoshis (median CoinGecko/Kraken, integer math) and a **fresh diversified Unified Address** from the watch-only account (Ironwood + Sapling receivers, no transparent). The server returns a ZIP-321 URI `zcash:<utest1…>?amount=<8dp>` and a QR.
2. The worker (`apps/worker`) polls zkool_graphql with a short-lived, account-scoped, read-only JWT. It syncs the account, reads incoming notes (mined + mempool), maps each note's diversifier index to the invoice it was issued for, and ingests idempotently.
3. States: `awaiting_zec → deposit_seen (display only) → confirming → deposit_accepted`. Underpaid, overpaid, late, extra and unattributed payments, plus reorgs, each have a deterministic state and an operator action (`OPERATIONS/deposit-recovery.md`).
4. Acceptance writes the ledger journal, receipt and outbox event in one DB transaction. Scan & Pay then creates a payout command for the existing TinyFish/P2P.me rail. That rail is operator-approved, preflighted read-only, and **disabled on testnet**. Merchant products create locked INR-denominated credits instead.

## Run it
```bash
pnpm install
# 1. Deploy the watchers: Render Dashboard → New → Blueprint → this repo (render.yaml: zebscan-zcash-test + zebscan-zcash-main)
# 2. JWT keys: var/secrets/zkool-<net>-jwt.key (private, git-ignored); public halves are in infra/zkool/
pnpm exec tsx scripts/zkool-verify-auth.ts --network testnet --url https://<svc>.onrender.com/graphql
pnpm zkool:bootstrap --network testnet --url https://<svc>.onrender.com/graphql --faucet   # watch-only B + customer wallet A
cp config/zcash.testnet.example.env var/secrets/testnet.env   # fill DB URL + secrets (pnpm exec tsx scripts/gen-dev-secrets.ts)
pnpm db:migrate
node scripts/dev.mjs --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env --no-web
# web (connected mode needs a production build: its CSP blocks dev-mode eval)
NEXT_DIST_DIR=.next-testnet NEXT_PUBLIC_ZEB_MODE=connected NEXT_PUBLIC_API_BASE_URL=http://localhost:4000 pnpm --filter @zeb/web build
# pay an invoice like an external customer (testnet only):
pnpm testnet:pay --url https://<svc>.onrender.com/graphql --uri "zcash:utest1…?amount=…"
```
Public URL: https://zebrascan.vercel.app is the **DEMO-mode** frontend (simulated, labelled). The real testnet flow above ran against the local API/worker and the Render watcher.

## Design decisions
* **Watcher, not a new wallet.** zkool2 `zkool_graphql` 6.36.0, pinned by image digest. Schema introspection at startup fails closed. The `--allow-unauthenticated` flag is never used.
* **Viewing key only on the server.** The receiver seed was generated, backed up offline (git-ignored), then deleted from the watcher. The watch account was re-imported from its UFVK with a birth height. `ZCASH_SPEND_KEY_REF` must be blank or the API/worker refuses to boot.
* **One address per checkout**, recoverable and concurrency-safe: serialized `newAddresses` calls, a Postgres unique index on address and on `(account, diversifier_index)`, and skipping indexes already issued after a wallet-DB reset. A shared UA plus a unique encrypted memo exists only as an explicit fallback (`ZKOOL_ADDRESS_MODE=memo`).
* **Confirmation policy:** testnet demo = 1 block (stated, and not zero reorg risk); mainnet default = 10. Reorg detection runs every poll.
* **Hard network isolation:** separate Render services, keys, databases and API ports. The network is stored on every row, and the start script refuses a testnet/mainnet lightwalletd mismatch. A `.env` change alone cannot enable real money: `MAINNET_READONLY` closes receiving and payouts in code.
* **No liquidity pool, escrow, vault or bridge.** A confirmed ZEC deposit creates an obligation. It does not mint USDC. Payouts need verified spendable capacity in the operator's existing P2P.me account and operator approval (`OPERATIONS/provider-liquidity.md`).

## Privacy and trust note
1. **What stays private:** sender, receiver and amount are shielded on-chain (Ironwood). No memo is needed because the address itself identifies the invoice.
2. **What the app reveals, to whom:**
   - the light-wallet server (`testnet.zec.rocks` / `zec.rocks`) sees the watcher host's IP and sync timing;
   - the watcher host (Render) and anyone holding the viewing key see every incoming amount and memo of the receiving wallet;
   - our server stores quotes, invoice addresses, txids, amounts, masked UPI IDs and envelope-encrypted full UPI IDs. Emails are stored only for email sign-in;
   - CoinGecko and Kraken see our price requests. If a live payout is ever authorized, P2P.me, its liquidity provider, banks and TinyFish's hosted browser see the INR recipient and amount.
3. **Who users must trust:** Zeb Scan as custodial operator; Render as the watcher host; the light-wallet server for availability; P2P.me and TinyFish for any future INR delivery.
4. **What we'd fix next:** route watcher traffic over Nym; move the watcher to self-hosted Zebra + lightwalletd; generate mainnet keys offline; delete payout PII after reconciliation.

Not "anonymous" or "untraceable": the operator links invoices to UPI payees.

## Technologies used
Zcash testnet/mainnet (NU7, Ironwood); zkool2 `zkool_graphql` 6.36.0 (`hhanh00/zkool-graphql@sha256:222039f6…`); lightwalletd `testnet.zec.rocks:443` / `zec.rocks:443`; Render (Docker web services); Fauzec faucet API; ZIP-316 UA/UFVK, ZIP-321 URIs; Node 24, TypeScript, Fastify 5, Zod 4, PostgreSQL 18 (double-entry ledger with DB-enforced balance triggers); Next.js 15 / React 19 / Tailwind; Vitest + Playwright; @tiny-fish/sdk 0.11.0 (payout rail, not live); @noir-wallet/sdk 0.1.9 (sign-in). JWTs are ES256 via Node `crypto`.

## Tests (run on this machine)
`pnpm typecheck` ✅ · unit 52/52 ✅ · integration (real PostgreSQL) 44/44 ✅. See `docs/READINESS_REPORT.md`.

## Next 30 days
1. Run a stranger test: a judge or venue user pays a Merchant QR / Payment Link from their own Noir or Zingo wallet.
2. Move the watcher to a persistent host (self-hosted Zebra + lightwalletd) and route its traffic through Nym.
3. Generate the mainnet receiving keys offline and re-import as watch-only, then repeat `MAINNET_READONLY` verification after NU7 activates (height 3,543,405).
4. Get written P2P.me automation permission, configure `TINYFISH_API_KEY`, and run the read-only TinyFish preflight against the existing account. Only then consider a tiny operator-approved pilot.

Operator runbooks: `OPERATIONS/`. Feedback for the tool teams: `FEEDBACK.md`.
