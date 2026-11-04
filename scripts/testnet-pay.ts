/**
 * TESTNET ONLY — pay a Zeb Scan invoice from the separate demo customer wallet A (TAZ, no value),
 * exactly like an external customer wallet would: parse the ZIP-321 URI the server issued, sync A,
 * broadcast one shielded payment. The Zeb Scan watcher must then detect it on its own — this
 * script never tells the backend the txid.
 *
 *   pnpm testnet:pay --url https://<svc>.onrender.com/graphql --uri "zcash:utest1…?amount=0.01"
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = arg("url");
const uri = arg("uri");
if (!url || !uri) throw new Error("--url and --uri are required");
const m = /^zcash:(utest1[0-9a-z]+)\?(.*)$/.exec(uri);
if (!m) throw new Error("only a testnet (utest1…) ZIP-321 URI is accepted");
const address = m[1]!;
const params = new URLSearchParams(m[2]);
const amount = params.get("amount");
if (!amount || !/^\d+(\.\d{1,8})?$/.test(amount)) throw new Error("URI amount missing/invalid");
const memoB64 = params.get("memo");
const memo = memoB64 ? Buffer.from(memoB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : null;

const key = createPrivateKey(readFileSync("var/secrets/zkool-testnet-jwt.key", "utf8"));
async function gql<T>(query: string): Promise<T> {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signZkoolJwt(key, { sub: 0, write: true })}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(600_000),
  });
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}
const accts = (await gql<{ accounts: Array<{ id: number; name: string }> }>(`{ accounts { id name } }`)).accounts;
const a = accts.find((x) => x.name === "demo-customer-wallet-A");
if (!a) throw new Error("customer wallet A not found — run pnpm zkool:bootstrap --network testnet first");
await gql(`mutation { synchronizeAccount(idAccount: ${a.id}, fast: false) }`);
const bal = (await gql<{ balanceByAccount: Record<string, string | number> }>(`{ balanceByAccount(idAccount: ${a.id}) { height sapling orchard ironwood total } }`)).balanceByAccount;
console.log(`[testnet-pay] wallet A balance (TAZ): ${JSON.stringify(bal)}`);
const memoArg = memo ? `, memo: ${JSON.stringify(memo)}` : "";
const t0 = Date.now();
const txid = (await gql<{ pay: string }>(`mutation { pay(idAccount: ${a.id}, payment: { recipients: [{ address: "${address}", amount: ${amount}${memoArg} }], confirmations: 1 }) }`)).pay;
console.log(`[testnet-pay] broadcast in ${Date.now() - t0} ms → txid ${txid}`);
console.log(`[testnet-pay] explorer: https://zexplorer.app/testnet/tx/${txid}`);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(`docs/evidence/testnet-payment-${txid.slice(0, 12)}.json`, JSON.stringify({ at: new Date().toISOString(), txid, to: address, amountTaz: amount, memoPresent: !!memo, explorer: `https://zexplorer.app/testnet/tx/${txid}` }, null, 2));
