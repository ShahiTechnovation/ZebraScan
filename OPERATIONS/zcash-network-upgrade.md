# Zcash network upgrades (NU7)

* **Testnet:** NU7 + Ironwood already active (event guide, 2026-11). Orchard is sealed (NU6.3): new shielded funds go to Ironwood. The watcher ignores Orchard-pool notes as new funds and issues UAs with an Ironwood-capable receiver plus Sapling.
* **Mainnet:** NU7 is *scheduled* for 2026-11-05 at height **3,543,405** (Zcash Foundation, Zebra 7.0.0 release notes, 2026-10-22). `ZkoolWatcher.status()` reports `nu7Active = tip >= 3_543_405` for display only. Nothing assumes the upgrade has happened, and nothing hardcodes block times.

## Checklist around an activation
1. Pin a zkool release that states support for the upgrade, re-run `pnpm zkool:bootstrap` (schema introspection evidence is rewritten), and run the unit suite (`tests/unit/zkool-tinyfish.test.ts`).
2. Confirm the lightwalletd endpoint serves the new branch: compare `currentHeight` with an independent explorer, and check the zkool sync passes the activation height without errors.
3. Watch `scanner_state.last_error` and lag across the activation height. If sync stalls more than 10 minutes below the height, close receiving (`feature_gates`), and don't fall back to another network.
4. Mainnet stays `MAINNET_READONLY` throughout: no payouts, no sweeps, no refunds.
