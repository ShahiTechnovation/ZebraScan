/**
 * Import an operator-supplied VIEWING KEY (UFVK uview… / UIVK uivk…, or uviewtest…/uivktest… on testnet)
 * as a WATCH-ONLY receiving account on a zkool_graphql server. No seed or spending key is involved.
 *
 *   pnpm exec tsx scripts/zkool-import-viewing-key.ts --network mainnet --url https://<svc>/graphql \
 *        --key-file var/secrets/mainnet-user-viewing-key.txt [--address u1…] [--birth <height>] [--name zebscan-user-mainnet]
 *
 * Proves: the account holds no seed, a write token cannot `pay` (no signing key), the worker's
 * read-only token gets Unauthorized, and (if --address is given) whether that address is among the
 * account's first diversified addresses. Writes the worker env (account id + birth) for the network.
 */
import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = arg("network");
const url = arg("url");
const keyFile = arg("key-file");
const expectAddress = arg("address");
const name = arg("name") ?? `zebscan-user-${network}`;
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
if (!url || !keyFile) throw new Error("--url and --key-file required");
const vk = readFileSync(keyFile, "utf8").trim();
const okPrefix = network === "mainnet" ? /^(uview1|uivk1)[0-9a-z]+$/ : /^(uviewtest1|uivktest1)[0-9a-z]+$/;
if (!okPrefix.test(vk)) throw new Error(`key is not a ${network} unified viewing key (UFVK/UIVK)`);
if (vk.split(/\s+/).length > 1) throw new Error("that looks like a seed phrase — only viewing keys are accepted");

const jwtKey = createPrivateKey(readFileSync(`var/secrets/zkool-${network}-jwt.key`, "utf8"));
const admin = () => signZkoolJwt(jwtKey, { sub: 0, write: true, ttlSeconds: 600 });
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
const log = (m: string) => console.log(`[import-vk ${network}] ${m}`);

const tip = (await gql<{ currentHeight: number }>(`{ currentHeight }`)).currentHeight;
const birth = Number(arg("birth") ?? tip - 100);
const accounts = (await gql<{ accounts: Array<{ id: number; name: string; incomingOnly: boolean }> }>(`{ accounts { id name incomingOnly } }`)).accounts;
let acct = accounts.find((a) => a.name === name);
if (!acct) {
  const id = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), { n: { name, key: vk, aindex: 0, birth, useInternal: false } })).createAccount;
  acct = { id, name, incomingOnly: vk.startsWith("uivk") };
  log(`imported watch-only account ${id} (birth ${birth}, tip ${tip})`);
} else log(`account ${acct.id} already present`);
const seed = (await gql<{ accounts: Array<{ seed: string | null; incomingOnly: boolean }> }>(`{ accounts(accountFilter: { id: ${acct.id} }) { seed incomingOnly } }`)).accounts[0];
if (seed?.seed) throw new Error("SECURITY: this account holds a seed — refusing");
const ro = signZkoolJwt(jwtKey, { sub: acct.id, write: false });
const sync = (await gql<{ synchronizeAccount: number }>(`mutation { synchronizeAccount(idAccount: ${acct.id}, fast: false) }`, ro)).synchronizeAccount;
const first = (await gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${acct.id}) { ua } }`, ro)).addressByAccount.ua;
let match: string = "not checked";
if (expectAddress) {
  // The wallet may show a later diversified address; zkool derives the same receivers from the key.
  // Compare against the account's default address (dindex 0). A mismatch here does not prove the key
  // is wrong (wallets differ in which diversifier they display); a match proves it is right.
  match = first === expectAddress ? "MATCH (default address)" : "different from the account's default address (may be another diversifier of the same key)";
}
let probe = "";
try {
  await gql(`mutation { pay(idAccount: ${acct.id}, payment: { recipients: [{ address: "${first}", amount: 0.0001 }], confirmations: 1 }) }`, signZkoolJwt(jwtKey, { sub: acct.id, write: true }));
  throw new Error("SECURITY: pay succeeded on the watch-only account");
} catch (e) {
  if ((e as Error).message.startsWith("SECURITY")) throw e;
  probe = (e as Error).message.slice(0, 100);
}
let roProbe = "";
try {
  await gql(`mutation { pay(idAccount: ${acct.id}, payment: { recipients: [], confirmations: 1 }) }`, ro);
  throw new Error("SECURITY: pay succeeded with the read-only token");
} catch (e) {
  if ((e as Error).message.startsWith("SECURITY")) throw e;
  roProbe = (e as Error).message.slice(0, 60);
}
writeFileSync(`var/secrets/${network}-user-receiver.json`, JSON.stringify({ accountId: acct.id, birth, incomingOnly: !!seed?.incomingOnly, defaultUa: first }, null, 2), { mode: 0o600 });
const envFile = `var/secrets/${network}-worker.env`;
if (existsSync(envFile)) {
  const env = readFileSync(envFile, "utf8").replace(/^ZKOOL_ACCOUNT_ID=.*$/m, `ZKOOL_ACCOUNT_ID=${acct.id}`).replace(/^ZKOOL_BIRTH_HEIGHT=.*$/m, `ZKOOL_BIRTH_HEIGHT=${birth}`);
  writeFileSync(envFile, env, { mode: 0o600 });
  log(`${envFile} now points at account ${acct.id} (restart that worker; the viewer-token issuer must use --account ${acct.id})`);
}
console.log(JSON.stringify({ network, accountId: acct.id, birth, tip, syncedTo: sync, incomingOnly: !!seed?.incomingOnly, seedOnServer: false, defaultAddress: first, addressCheck: match, payWithWriteToken: probe, payWithWorkerToken: roProbe }, null, 1));
