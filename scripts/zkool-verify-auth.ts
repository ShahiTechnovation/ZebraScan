/**
 * Verifies a deployed zkool_graphql enforces JWT auth and reports a real chain tip.
 *   pnpm zkool:verify --network testnet --url https://<svc>/graphql
 * Writes docs/evidence/zkool-auth-<net>.json. Never prints tokens or keys.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = arg("network");
const url = arg("url");
if ((network !== "testnet" && network !== "mainnet") || !url) throw new Error("--network testnet|mainnet --url https://…/graphql");
const key = createPrivateKey(readFileSync(`var/secrets/zkool-${network}-jwt.key`, "utf8"));
const forged = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

async function q(query: string, token?: string): Promise<{ status: number; body: string }> {
  const r = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
}
const admin = () => signZkoolJwt(key, { sub: 0, write: true });
const results: Record<string, { status: number; body: string; pass: boolean }> = {};
const check = (name: string, r: { status: number; body: string }, pass: boolean) => {
  results[name] = { ...r, pass };
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: HTTP ${r.status} ${r.body.replace(/\s+/g, " ").slice(0, 160)}`);
};

const tip = await q(`{ currentHeight }`, admin());
const h = Number(/"currentHeight":(\d+)/.exec(tip.body)?.[1] ?? 0);
check("admin token → currentHeight (real chain tip)", tip, h > 1_000_000);
const accts = await q(`{ accounts { id name birth height incomingOnly } }`, admin());
check("admin token → accounts", accts, accts.status === 200 && accts.body.includes('"accounts"'));
const none = await q(`{ accounts { id name } }`);
check("no token → accounts refused", none, !none.body.includes('"accounts":['));
const fake = await q(`{ accounts { id name } }`, signZkoolJwt(forged, { sub: 0, write: true }));
check("forged-key token → accounts refused", fake, !fake.body.includes('"accounts":['));
const expired = await q(`{ accounts { id } }`, signZkoolJwt(key, { sub: 0, write: true, ttlSeconds: -600 }));
check("expired token → refused", expired, !expired.body.includes('"accounts":['));
const scoped = await q(`{ accounts { id name } }`, signZkoolJwt(key, { sub: 999, write: false }));
check("account-scoped token → admin query refused", scoped, !scoped.body.includes('"accounts":['));

mkdirSync("docs/evidence", { recursive: true });
writeFileSync(`docs/evidence/zkool-auth-${network}.json`, JSON.stringify({ capturedAt: new Date().toISOString(), network, url: url.replace(/^(https:\/\/[^.]+).*/, "$1…"), tipHeight: h, results }, null, 2));
const failed = Object.values(results).filter((r) => !r.pass).length;
console.log(failed ? `${failed} check(s) FAILED` : `all ${Object.keys(results).length} checks passed; tip ${h}`);
process.exit(failed ? 1 : 0);
