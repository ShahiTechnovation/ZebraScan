/**
 * Import an operator-owned receiving wallet as WATCH-ONLY on a zkool_graphql server.
 *   pnpm exec tsx scripts/zkool-import-receiver.ts --network testnet --url https://<svc>/graphql \
 *        --seed-file var/secrets/testnet-user-receiver-seed.txt [--birth 4582600] [--name zebscan-receiver-user]
 *
 * The seed is entered into the server ONCE to derive its UFVK, the seed account is then DELETED, and the
 * wallet is re-imported from the UFVK (no signing key). Mainnet is refused: for mainnet supply a UFVK
 * exported from your own wallet (the seed must never reach a server).
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = arg("network");
const url = arg("url");
const seedFile = arg("seed-file");
const name = arg("name") ?? "zebscan-receiver-user";
if (network !== "testnet") throw new Error("only --network testnet may use a seed file; for mainnet import a UFVK");
if (!url || !seedFile) throw new Error("--url and --seed-file required");
const seed = readFileSync(seedFile, "utf8").trim();
if (seed.split(/\s+/).length < 12) throw new Error("seed file does not look like a mnemonic");

const key = createPrivateKey(readFileSync(`var/secrets/zkool-${network}-jwt.key`, "utf8"));
const admin = () => signZkoolJwt(key, { sub: 0, write: true, ttlSeconds: 600 });
async function gql<T>(query: string, token = admin(), variables?: Record<string, unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url!, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(variables ? { query, variables } : { query }), signal: AbortSignal.timeout(600_000) });
      const body = JSON.parse(await res.text()) as { data?: T; errors?: Array<{ message: string }> };
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
      return body.data as T;
    } catch (e) {
      if (!(e instanceof TypeError) || attempt >= 6) throw e; // transport errors only
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
const log = (m: string) => console.log(`[import-receiver ${network}] ${m}`);

const tip = (await gql<{ currentHeight: number }>(`{ currentHeight }`)).currentHeight;
const birth = Number(arg("birth") ?? tip - 10);
const existing = (await gql<{ accounts: Array<{ id: number; name: string }> }>(`{ accounts { id name } }`)).accounts;
let watch = existing.find((a) => a.name === name);
let ufvk: string;
if (!watch) {
  const id = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), { n: { name: `${name}-seed-TEMP`, key: seed, aindex: 0, birth, useInternal: false } })).createAccount;
  ufvk = (await gql<{ unifiedFullViewingKey: string }>(`{ unifiedFullViewingKey(idAccount: ${id}) }`)).unifiedFullViewingKey;
  await gql(`mutation { deleteAccount(idAccount: ${id}) }`);
  log("seed account used to derive the UFVK and DELETED from the server");
  if (!ufvk.startsWith("uviewtest1")) throw new Error("derived key is not a testnet UFVK");
  const wid = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), { n: { name, key: ufvk, aindex: 0, birth, useInternal: false } })).createAccount;
  watch = { id: wid, name };
  mkdirSync("var/secrets", { recursive: true });
  writeFileSync("var/secrets/testnet-user-receiver.json", JSON.stringify({ ufvk, birth, accountId: wid }, null, 2), { mode: 0o600 });
} else {
  ufvk = JSON.parse(readFileSync("var/secrets/testnet-user-receiver.json", "utf8")).ufvk;
}
const left = (await gql<{ accounts: Array<{ name: string; seed: string | null }> }>(`{ accounts { name seed } }`)).accounts;
if (left.some((a) => a.seed && a.name.startsWith(name))) throw new Error("SECURITY: a seed for this receiver is still on the server");
const ro = signZkoolJwt(key, { sub: watch.id, write: false });
await gql(`mutation { synchronizeAccount(idAccount: ${watch.id}, fast: false) }`, ro);
const ua = (await gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${watch.id}) { ua } }`, ro)).addressByAccount.ua;
const bal = (await gql<{ balanceByAccount: { total: string | number } }>(`{ balanceByAccount(idAccount: ${watch.id}) { total } }`, ro)).balanceByAccount.total;
let proof = "";
try {
  await gql(`mutation { pay(idAccount: ${watch.id}, payment: { recipients: [{ address: "${ua}", amount: 0.0001 }], confirmations: 1 }) }`, signZkoolJwt(key, { sub: watch.id, write: true }));
  throw new Error("SECURITY: pay succeeded on the watch-only account");
} catch (e) {
  if ((e as Error).message.startsWith("SECURITY")) throw e;
  proof = (e as Error).message.slice(0, 100);
}
log(`watch account ${watch.id}, birth ${birth}, observed balance ${bal} TAZ, default UA ${ua.slice(0, 18)}…, pay → "${proof}"`);
const env = readFileSync("var/secrets/testnet-worker.env", "utf8").replace(/^ZKOOL_ACCOUNT_ID=.*$/m, `ZKOOL_ACCOUNT_ID=${watch.id}`).replace(/^ZKOOL_BIRTH_HEIGHT=.*$/m, `ZKOOL_BIRTH_HEIGHT=${birth}`);
writeFileSync("var/secrets/testnet-worker.env", env, { mode: 0o600 });
log("worker env now points at the new receiver (restart the worker)");
console.log(JSON.stringify({ accountId: watch.id, birth, observedBalanceTaz: String(bal), defaultUa: ua, watchOnlyProbe: proof, ufvk }, null, 1));
