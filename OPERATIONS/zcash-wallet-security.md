# Zcash wallet security (operator runbook)

## Key roles
| Key | Where it may live | Never |
| --- | --- | --- |
| Receiver **seed / spending key** (wallet B) | Offline only: `var/secrets/<net>-receiver-seed.txt` on the operator machine right after bootstrap, then moved to an encrypted offline backup | Web server, API, worker, Render, TinyFish, CI, chat/LLM prompts, git, logs |
| Receiver **UFVK** (`uviewtest…` / `uview1…`) | zkool watch-only account on the watcher host; `var/secrets/<net>-receiver.json` | Public endpoints, frontend bundle. It is not a signing key, but it reveals the wallet's full history: treat it as sensitive. Testnet demo UFVK may be published for judges |
| zkool **admin JWT private key** (`var/secrets/zkool-<net>-jwt.key`) | Operator machine only (bootstrap) | Worker/API in production. Rotate by redeploying zkool with a new public key |
| Worker token | Minted per request from the same key, `sub=<watch account>`, `write=false`, 5 min expiry | It cannot call `pay` (zkool returns `Unauthorized`) |
| Customer wallet A seed (testnet only) | zkool testnet DB + `var/secrets/testnet-sender-seed.txt` | Mainnet. Wallet A exists only to act as an external customer on TAZ (no value) |

`ZCASH_SPEND_KEY_REF` must be blank on API/worker: `loadConfig` refuses to boot otherwise.

## Server posture (zkool_graphql)
* Image pinned by digest: `hhanh00/zkool-graphql:6.36.0@sha256:222039f6…` (`infra/zkool/Dockerfile`).
* `infra/zkool/start.sh` always passes `--jwt-public-key-file`. It never passes `--allow-unauthenticated`, which would expose `accounts { seed }` to anyone who can reach the port.
* Network is set per service (`ZKOOL_NETWORK`). The DB file name carries the network, and a testnet service pointed at a mainnet lightwalletd (or the reverse) exits at boot.
* Mainnet requires `ZKOOL_DB_PASSWORD` (encrypted wallet DB).
* Startup proofs run by the worker (`pollZkool`): GraphQL introspection (`assertSchema`) plus a `pay` probe that must fail (`assertWatchOnly`).
* Bootstrap proofs (`pnpm zkool:bootstrap`): `pay` with a write token on the watch account → `No Signing Key`; with the worker token → `Unauthorized`. Evidence goes to `docs/evidence/zkool-bootstrap-<net>.json`.

## Re-bootstrap after a restart (Render free plan has an ephemeral disk)
`pnpm zkool:bootstrap --network testnet --url https://<svc>/graphql` is idempotent. It re-imports the UFVK with its **birth height** (so every past deposit is rescanned), restores wallet A from its offline seed, and rewrites `var/secrets/testnet-worker.env`. The allocator in Postgres then skips every diversifier index already issued (`minDiversifierIndex`), so a recreated zkool DB never hands an old invoice address to a new checkout.

## Incident: suspected key exposure
1. UFVK exposed: privacy incident only (history visible), no fund risk. Rotate to a new receiving account for future invoices.
2. Seed exposed: sweep funds with the offline signer to a fresh wallet and rotate the UFVK. Mainnet: stop receiving first (`feature_gates`).
3. Admin JWT key exposed: redeploy zkool with a new public key at once. Tokens expire within 10 minutes.
