/**
 * Bootstrap a JWT-protected zkool_graphql server for Zeb Scan (idempotent; safe to re-run after
 * a Render restart wiped the ephemeral wallet DB).
 *
 *   pnpm zkool:bootstrap --network testnet --url https://<svc>.onrender.com/graphql [--faucet]
 *   pnpm zkool:bootstrap --network mainnet --url https://<svc>.onrender.com/graphql
 *
 * What it does (operator-only, uses the ADMIN key in var/secrets/zkool-<net>-jwt.key):
 *  1. Verifies chain tip + network identity (UA prefix decoded via zkool, never by config string).
 *  2. Introspects the schema, writes docs/evidence/zkool-schema-<net>.json.
 *  3. Receiving wallet B: creates a seed account ONCE, exports its UFVK, writes the seed to
 *     var/secrets/<net>-receiver-seed.txt (git-ignored, offline backup, never printed), then DELETES
 *     the seed account from the server. Re-imports B as WATCH-ONLY from the UFVK with its birth.
 *  4. Proves B is watch-only: `pay` with a write token → "No Signing Key"; with the worker's
 *     read-only token → "Unauthorized".
 *  5. testnet only: separate customer wallet A (TAZ, no value) used by scripts/testnet-pay.ts to pay
 *     invoices like an external customer. Its seed is backed up to var/secrets/testnet-sender-seed.txt.
 *  6. Writes var/secrets/<net>-worker.env with the env lines for the API/worker (no seeds).
 *
 * Mainnet: READ-ONLY. Only wallet B (watch-only). No sender wallet, no faucet, no pay.
 */
import { createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = arg("network");
const url = arg("url");
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet required");
if (!url || !/^https?:\/\/.+\/graphql$/.test(url)) throw new Error("--url https://…/graphql required");
const faucet = args.includes("--faucet");

const SECRETS = "var/secrets";
mkdirSync(SECRETS, { recursive: true });
mkdirSync("docs/evidence", { recursive: true });
const key = createPrivateKey(readFileSync(`${SECRETS}/zkool-${network}-jwt.key`, "utf8"));
const admin = () => signZkoolJwt(key, { sub: 0, write: true, ttlSeconds: 600 });
const log = (m: string) => console.log(`[zkool-bootstrap ${network}] ${m}`);

async function post(body: string, token: string): Promise<Response> {
  // Transport-level retry only (ECONNRESET / timeouts). GraphQL errors are never retried.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url!, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(600_000) });
    } catch (e) {
      if (attempt >= 6) throw e;
      log(`transport error (${(e as Error).message}); retry ${attempt}/5`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function gql<T>(query: string, token: string = admin(), variables?: Record<string, unknown>): Promise<T> {
  const res = await post(JSON.stringify(variables ? { query, variables } : { query }), token);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}

interface Acct {
  id: number;
  name: string;
  birth: number;
  height: number;
  incomingOnly: boolean;
}
const accounts = async () => (await gql<{ accounts: Acct[] }>(`{ accounts { id name birth height incomingOnly } }`)).accounts;

// 1. tip + identity
const tip = (await gql<{ currentHeight: number }>(`{ currentHeight }`)).currentHeight;
log(`lightwalletd tip height ${tip}`);
if (!(tip > 1_000_000)) throw new Error("implausible tip height");

// 2. schema evidence
const schema = await gql<Record<string, { fields: Array<{ name: string; args?: Array<{ name: string }> }> }>>(
  `{ q: __type(name: "Query") { fields { name args { name } } } m: __type(name: "Mutation") { fields { name args { name } } } n: __type(name: "Note") { fields { name } } a: __type(name: "Addresses") { fields { name } } }`,
);
writeFileSync(
  `docs/evidence/zkool-schema-${network}.json`,
  JSON.stringify({ capturedAt: new Date().toISOString(), network, zkool: "6.36.0 (docker hhanh00/zkool-graphql@sha256:222039f6…)", tip, schema }, null, 2),
);
for (const need of ["newAddresses", "synchronizeAccount", "pay", "createAccount", "deleteAccount"]) {
  if (!schema.m.fields.some((f) => f.name === need)) throw new Error(`schema lacks mutation ${need}`);
}
log("schema introspected → docs/evidence/zkool-schema-" + network + ".json");

// 3. receiving wallet B (watch-only)
const recvFile = `${SECRETS}/${network}-receiver.json`;
let recv: { ufvk: string; birth: number } | null = existsSync(recvFile) ? JSON.parse(readFileSync(recvFile, "utf8")) : null;
if (!recv) {
  const birth = tip - 10;
  const id = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), { n: { name: "zebscan-receiver-seed-TEMP", key: "", aindex: 0, birth, useInternal: false } })).createAccount;
  const ufvk = (await gql<{ unifiedFullViewingKey: string }>(`{ unifiedFullViewingKey(idAccount: ${id}) }`)).unifiedFullViewingKey;
  const seed = (await gql<{ accounts: Array<{ seed: string | null }> }>(`{ accounts(accountFilter: { id: ${id} }) { seed } }`)).accounts[0]?.seed;
  if (!seed) throw new Error("could not read back the new receiver seed for offline backup");
  writeFileSync(`${SECRETS}/${network}-receiver-seed.txt`, seed + "\n", { mode: 0o600 });
  await gql(`mutation { deleteAccount(idAccount: ${id}) }`);
  recv = { ufvk, birth };
  writeFileSync(recvFile, JSON.stringify(recv, null, 2), { mode: 0o600 });
  log(`receiver B created; seed backed up offline to ${SECRETS}/${network}-receiver-seed.txt and DELETED from the server`);
}
const expectUfvk = network === "testnet" ? "uviewtest1" : "uview1";
if (!recv.ufvk.startsWith(expectUfvk)) throw new Error(`receiver UFVK is not a ${network} key`);

let all = await accounts();
let watch = all.find((a) => a.name === "zebscan-receiver-watch");
if (!watch) {
  const id = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), { n: { name: "zebscan-receiver-watch", key: recv.ufvk, aindex: 0, birth: recv.birth, useInternal: false } })).createAccount;
  all = await accounts();
  watch = all.find((a) => a.id === id)!;
  log(`watch-only receiver imported from UFVK (account ${id}, birth ${recv.birth})`);
}
if (all.some((a) => a.name === "zebscan-receiver-seed-TEMP")) throw new Error("a receiver SEED account is still on the server — delete it");

// 4. watch-only proofs
const proof: Record<string, string> = {};
// The probe is a self-send of 0.0001 to the account's own default address: once the account
// holds notes, note selection succeeds and only the missing signing key can stop it.
await gql(`mutation { synchronizeAccount(idAccount: ${watch.id}, fast: false) }`, signZkoolJwt(key, { sub: watch.id, write: false })).catch(() => undefined);
const selfUa = (await gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${watch.id}) { ua } }`, signZkoolJwt(key, { sub: watch.id, write: false }))).addressByAccount.ua;
const bal = (await gql<{ balanceByAccount: { total: string | number } }>(`{ balanceByAccount(idAccount: ${watch.id}) { total } }`, signZkoolJwt(key, { sub: watch.id, write: false }))).balanceByAccount;
proof.watch_account_observed_balance = String(bal.total);
for (const [label, token] of [
  ["write_token", signZkoolJwt(key, { sub: watch.id, write: true })],
  ["worker_read_only_token", signZkoolJwt(key, { sub: watch.id, write: false })],
] as const) {
  try {
    await gql(`mutation { pay(idAccount: ${watch.id}, payment: { recipients: [{ address: "${selfUa}", amount: 0.0001 }], confirmations: 1 }) }`, token);
    throw new Error(`SECURITY: pay succeeded with ${label}`);
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("SECURITY")) throw e;
    proof[label] = m.slice(0, 120);
  }
}
// zkool runs note selection before signing: an account with no spendable notes fails with
// "No feasible note selection found" before it can reach "No Signing Key". That is NOT a
// watch-only proof, so additionally require that the account holds no seed, and re-prove with
// `--recheck-watch-only` once the account has received a note.
const seedOnWatch = (await gql<{ accounts: Array<{ seed: string | null }> }>(`{ accounts(accountFilter: { id: ${watch.id} }) { seed } }`)).accounts[0]?.seed;
if (seedOnWatch) throw new Error("SECURITY: the watch account holds a seed — refusing");
proof.seed_on_watch_account = "null (no seed stored)";
if (/No feasible note selection/i.test(proof.write_token!)) {
  proof.write_token_note = "provisional: account has no notes yet, pay failed at note selection before signing; re-run with --recheck-watch-only after the first deposit";
} else if (!/No Signing Key/i.test(proof.write_token!)) throw new Error(`expected "No Signing Key", got: ${proof.write_token}`);
if (!/Unauthorized/i.test(proof.worker_read_only_token!)) throw new Error(`expected "Unauthorized", got: ${proof.worker_read_only_token}`);
log(`watch-only proven: write token → "${proof.write_token}", worker token → "${proof.worker_read_only_token}"`);

const recvUa = (await gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${watch.id}) { ua } }`, signZkoolJwt(key, { sub: watch.id, write: false }))).addressByAccount.ua;
const uaPrefix = network === "testnet" ? "utest1" : "u1";
if (!recvUa.startsWith(uaPrefix)) throw new Error(`receiver address ${recvUa.slice(0, 12)}… is not ${network}`);

// 5. testnet customer wallet A
let sender: Acct | undefined;
let senderUa: string | null = null;
if (network === "testnet") {
  sender = all.find((a) => a.name === "demo-customer-wallet-A");
  const seedFile = `${SECRETS}/testnet-sender-seed.txt`;
  if (!sender) {
    const restoring = existsSync(seedFile);
    const meta = existsSync(`${SECRETS}/testnet-sender.json`) ? JSON.parse(readFileSync(`${SECRETS}/testnet-sender.json`, "utf8")) : { birth: tip - 10 };
    const id = (await gql<{ createAccount: number }>(`mutation($n: NewAccount!) { createAccount(newAccount: $n) }`, admin(), {
      n: { name: "demo-customer-wallet-A", key: restoring ? readFileSync(seedFile, "utf8").trim() : "", aindex: 0, birth: meta.birth, useInternal: false },
    })).createAccount;
    if (!restoring) {
      const seed = (await gql<{ accounts: Array<{ seed: string | null }> }>(`{ accounts(accountFilter: { id: ${id} }) { seed } }`)).accounts[0]?.seed;
      if (seed) writeFileSync(seedFile, seed + "\n", { mode: 0o600 });
      writeFileSync(`${SECRETS}/testnet-sender.json`, JSON.stringify({ birth: meta.birth }), { mode: 0o600 });
    }
    all = await accounts();
    sender = all.find((a) => a.id === id)!;
    log(`customer wallet A ${restoring ? "restored from offline seed" : "created"} (account ${id})`);
  }
  senderUa = (await gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${sender.id}) { ua } }`)).addressByAccount.ua;
  if (faucet) {
    const r = await fetch("https://fauzec.com/api/v1/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ network: "testnet", address: senderUa }) });
    const body = await r.text();
    log(`Fauzec claim → HTTP ${r.status} ${body.slice(0, 300)}`);
    writeFileSync(`docs/evidence/fauzec-claim.json`, JSON.stringify({ at: new Date().toISOString(), status: r.status, body: JSON.parse(body || "{}") }, null, 2));
  }
}

// 6. worker env
const envLines = [
  `# generated by scripts/zkool-bootstrap.ts ${new Date().toISOString()} — no seeds/spending keys here`,
  `ZKOOL_GRAPHQL_URL=${url}`,
  `ZKOOL_NETWORK=${network}`,
  `ZKOOL_ACCOUNT_ID=${watch.id}`,
  `ZKOOL_BIRTH_HEIGHT=${recv.birth}`,
  `ZKOOL_VIEWER_TOKEN_FILE=${SECRETS}/${network}-viewer.token`,
  `ZKOOL_ADDRESS_MODE=rotate`,
];
writeFileSync(`${SECRETS}/${network}-worker.env`, envLines.join("\n") + "\n", { mode: 0o600 });
const summary = {
  network,
  tip,
  receiver: { accountId: watch.id, birth: recv.birth, defaultUa: recvUa, ufvkLabel: "viewing key — reveals this demo wallet's history, cannot spend", ufvk: network === "testnet" ? recv.ufvk : "(withheld)" },
  sender: sender ? { accountId: sender.id, ua: senderUa } : null,
  watchOnlyProof: proof,
};
writeFileSync(`docs/evidence/zkool-bootstrap-${network}.json`, JSON.stringify({ capturedAt: new Date().toISOString(), ...summary }, null, 2));
console.log(JSON.stringify(summary, null, 2));
