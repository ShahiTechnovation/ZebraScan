/**
 * ISOLATED ISSUER — the only process that holds the zkool JWT signing key.
 * Writes a short-lived (15 min), account-scoped, READ-ONLY viewer token to a file that the API/worker
 * read per request (ZKOOL_VIEWER_TOKEN_FILE). The API/worker never see the key and cannot mint tokens,
 * and the token cannot call `pay` (zkool: Unauthorized).
 *
 *   pnpm exec tsx scripts/zkool-viewer-issuer.ts --network testnet --account 3 --out var/secrets/testnet-viewer.token
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = arg("network");
const account = Number(arg("account"));
const out = arg("out");
if ((network !== "testnet" && network !== "mainnet") || !Number.isInteger(account) || account < 1 || !out) throw new Error("--network testnet|mainnet --account <id> --out <file>");
const key = createPrivateKey(readFileSync(`var/secrets/zkool-${network}-jwt.key`, "utf8"));
function issue() {
  const tok = signZkoolJwt(key, { sub: account, write: false, ttlSeconds: 900 });
  writeFileSync(`${out}.tmp`, tok, { mode: 0o600 });
  renameSync(`${out}.tmp`, out!); // atomic swap so readers never see a partial token
}
issue();
console.log(`[issuer ${network}] account ${account} read-only token → ${out} (15 min TTL, refreshed every 5 min)`);
setInterval(issue, 300_000);
