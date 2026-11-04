# zeb-zcash-gateway — watch-only Zcash receiving service

> **Status: BLOCKED — source only, never compiled or run.** The build host has no Rust toolchain,
> and no testnet node/indexer, viewing key or wallet birthday was supplied. Until every item in
> the checklist below is done, the API keeps invoice creation **closed** in `testnet` and
> `mainnet-*` (readiness reports "Zcash wallet gateway not configured" / "scanner … error").

## What it does (and does not do)

| Does | Does not |
| --- | --- |
| Hold a **UIVK** (incoming viewing key) only | Hold a spending key, seed, or UFVK |
| Derive one unique diversified address per invoice at an index burned in PostgreSQL | Reuse an index (bound once in its own `invoices` table; a second invoice for the same index is a 409) |
| Issue shielded invoices with Orchard (+Sapling) receivers and **no** transparent receiver | Guess deposits by amount |
| Build ZIP-321 URIs with the pinned `zip321` crate (re-validated by the API) | Put labels/messages/PII in URIs |
| Scan compact blocks sequentially via `zcash_client_backend` and emit `note_seen` / `note_confirmed` / `note_reorged` events keyed by (txid, wallet output identity) | Use explorers, mempool APIs, pasted TXIDs or screenshots |
| Refuse allocation unless synced, fresh tip, Ironwood-capable | Create, sign or broadcast transactions (refunds/rebalances use a separate isolated signer) |

Internal API (mTLS, client cert from the internal CA): `GET /internal/scanner/status`,
`POST /internal/addresses/allocate`, `GET /internal/deposits?sinceCursor=`, `POST /internal/backfill`.
Shapes match `packages/providers/src/zcash.ts`.

## Pinned crates (verified on crates.io 2026-11-04)

`zcash_client_backend =0.25.0`, `zcash_client_sqlite =0.23.0`, `zcash_keys =0.17.0`,
`zcash_address =0.14.0`, `zcash_protocol =0.11.0`, `zip321 =0.10.0`, `zip32 =0.3.0`
(evidence: `docs/evidence/external-verification-2026-11-04.json`).

## First build & verification checklist (testnet first)

1. Build in the pinned container: `docker build -f infra/docker/zcash-gateway.Dockerfile .`
   Fix API drift against the exact crate versions (the code was written against published APIs
   without a compiler). `cargo deny` / `cargo audit` must pass.
2. Confirm in the crate changelogs/source that this release train scans **NU6.3 (Ironwood)**
   outputs and recognises **NU7** (testnet activated; mainnet planned ≈ height 3,543,405,
   ≈ 2026-11-05 — do not assume it activated; read the chain).
3. Implement `Wallet::scan_once` with `zcash_client_backend::sync::run` against a
   `zcash_client_sqlite::WalletDb` whose account is imported from the UIVK with the birthday
   height; diff `get_received_notes`/mined heights into the event log; mark reorged notes.
4. Run against a Zaino or lightwalletd **testnet** endpoint; record tip height, branch id and
   scan lag in `GET /internal/scanner/status`.
5. Prove on testnet (and record txids in `docs/evidence/`):
   * two invoices for the **same amount** paid concurrently are matched to the right invoices;
   * one transaction with two outputs to two invoice addresses yields two events;
   * a payment after expiry becomes `late_deposit` in the API;
   * restart + rescan from birthday produces only duplicate (ignored) events;
   * a reorg (regtest) produces `note_reorged` and the API freezes downstream state.
6. Only then set `ZCASH_GATEWAY_URL` + mTLS paths for the API/worker in `testnet`.

## Key ceremony (mainnet, operator-owned)

Seed generation happens offline in a dedicated ceremony; only the UIVK is exported to this
service. Spending keys stay with the isolated treasury signer behind two-person approval.
Encrypted backups and a documented recovery drill are prerequisites for `mainnet-enabled`.
