/** Read-only audit: never boot a worker, sync a wallet, bootstrap accounts, or submit payments. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createPool } from "@zeb/db";
import { loadConfig } from "@zeb/core";
import { signZkoolJwt } from "@zeb/providers";

const dir = "docs/evidence/audit-2026-11-04";
const env = { ...process.env };
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
for (const file of [".env", "var/secrets/testnet.env", "var/secrets/testnet-worker.env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
}
report.configuration = Object.fromEntries(["ZEB_TOKEN_SECRET", "ZEB_LOCAL_KEKS", "ZEB_ACTIVE_KEK", "DATABASE_URL", "ZKOOL_GRAPHQL_URL", "ZKOOL_JWT_PRIVATE_KEY_FILE", "TINYFISH_API_KEY", "P2P_ALLOWED_START_URL", "TINYFISH_PROFILE_ID", "SMTP_URL", "LEGAL_APPROVAL_REF", "PROVIDER_APPROVAL_REF"].map(k => [k, Boolean(env[k])]));
report.uiMode = { configured: env.NEXT_PUBLIC_ZEB_MODE, resolved: env.NEXT_PUBLIC_ZEB_MODE === "connected" ? "connected" : "demo" };
try { const cfg = loadConfig(env); report.configLoad = { status: "PASS", environment: cfg.environment }; }
catch (e) { report.configLoad = { status: "FAIL", code: (e as { code?: string }).code, message: (e as Error).message.replace(/https?:\/\/\S+/g, "[URL]") }; }

if (env.DATABASE_URL) {
  const db = createPool(env.DATABASE_URL, { max: 1 });
  try {
    await db.query("BEGIN READ ONLY");
    report.database = { connected: true, migrations: (await db.query("SELECT name FROM schema_migrations ORDER BY name")).rows };
    for (const table of ["payment_intents", "deposit_observations", "merchant_credits", "payout_commands", "jobs"]) {
      try { report[table] = (await db.query(`SELECT environment, count(*)::text AS count FROM ${table} GROUP BY environment`)).rows; }
      catch (e) { report[table] = { code: (e as { code?: string }).code }; break; }
    }
    report.scanner = (await db.query("SELECT environment, network, status, tip_height, scanned_height, updated_at FROM scanner_state")).rows;
    report.jobStates = (await db.query("SELECT environment,kind,state,count(*)::text AS count FROM jobs GROUP BY environment,kind,state")).rows;
    report.acceptedReceipts = (await db.query("SELECT pi.id, pi.environment, pi.mode, pi.status, pi.payout_status, pi.received_zatoshis, q.zec_zatoshis AS quoted_zatoshis, d.network, d.pool, d.txid, d.output_ref, d.value_zatoshis, d.block_height, d.confirmations, d.canonical, d.accepted, (SELECT count(*)::int FROM ledger_journals j WHERE j.environment=pi.environment AND j.event_id='deposit_accepted:' || pi.id || ':zec') AS zec_journals, (SELECT count(*)::int FROM ledger_journals j WHERE j.environment=pi.environment AND j.event_id='deposit_accepted:' || pi.id || ':inr') AS inr_journals FROM payment_intents pi JOIN quotes q ON q.id=pi.quote_id JOIN deposit_observations d ON d.intent_id=pi.id WHERE pi.environment='testnet' AND d.accepted")).rows;
    await db.query("ROLLBACK");
    report.testDatabases = (await db.query("SELECT datname FROM pg_database WHERE datname LIKE '%\\_test' ESCAPE '\\'")).rows;
  } catch (e) { report.database = { connected: false, code: (e as { code?: string }).code ?? "CONNECTION_FAILED" }; }
  finally { await db.end(); }
}

if (env.ZKOOL_GRAPHQL_URL && env.ZKOOL_JWT_PRIVATE_KEY_FILE) {
  const url = env.ZKOOL_GRAPHQL_URL;
  const key = createPrivateKey(readFileSync(env.ZKOOL_JWT_PRIVATE_KEY_FILE, "utf8"));
  const account = Number(env.ZKOOL_ACCOUNT_ID ?? 1);
  const token = signZkoolJwt(key, { sub: account, write: false });
  for (const [name, query] of [
    ["walletTip", "{ currentHeight }"],
    ["receiverNotes", `{ transactionsByAccount(idAccount: ${account}) { txid height notes { pool scope value diversifierIndex } } }`],
    ["walletSchema", '{ __type(name: "Query") { fields { name } } }'],
  ]) {
    try {
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
      const body = await r.json() as Record<string, unknown>;
      report[name!] = { url: new URL(url).origin, status: r.status, data: body.data ?? null, errorCount: Array.isArray(body.errors) ? body.errors.length : 0 };
    } catch { report[name!] = { status: "BLOCKED", reason: "HTTP/JSON request failed within 20 seconds" }; }
  }
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ accounts { id } }" }), signal: AbortSignal.timeout(20_000) });
    report.unauthenticatedWallet = { status: r.status, bodyWithheld: true };
  } catch { report.unauthenticatedWallet = { status: "BLOCKED" }; }
}

const urls = new Set(["http://127.0.0.1:3000/", "http://127.0.0.1:4000/healthz", "http://127.0.0.1:4000/readyz", "http://127.0.0.1:4000/api/v1/config"]);
if (env.NEXT_PUBLIC_API_BASE_URL) urls.add(new URL("/healthz", env.NEXT_PUBLIC_API_BASE_URL).toString());
if (existsSync(".vercel/.env.production.local")) {
  const body = readFileSync(".vercel/.env.production.local", "utf8");
  for (const name of ["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"]) {
    const m = new RegExp(`^${name}="?([^"\\r\\n]+)`, "m").exec(body);
    if (m && /^[a-zA-Z0-9.-]+$/.test(m[1]!)) urls.add(`https://${m[1]}/`);
  }
}
report.http = await Promise.all([...urls].map(async url => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); const body = await r.text(); return { url, status: r.status, demoText: /Demo mode|simulated transactions|Preview QR|Explore demo/i.test(body), contentType: r.headers.get("content-type"), ...(url.endsWith("/readyz") ? { readiness: JSON.parse(body) as unknown } : {}) }; }
  catch { return { url, status: "BLOCKED", reason: "connection failed within 10 seconds" }; }
}));
const outputName = process.argv[2] ?? "runtime.json";
if (!/^[a-z0-9-]+\.json$/.test(outputName)) throw new Error("Use a simple JSON output filename");
writeFileSync(`${dir}/${outputName}`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
