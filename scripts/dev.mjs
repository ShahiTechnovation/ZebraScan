// Local development: API + worker (tsx watch) and the Next.js app, sharing ./.env.
// Usage: pnpm dev   (requires .env; see .env.example and scripts/gen-dev-secrets.ts)
// Overlays (later wins), e.g. HACKATHON_TESTNET:
//   node scripts/dev.mjs --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env [--no-web]
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
function load(file) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
if (existsSync(".env")) load(".env");
else if (!process.env.ZEB_ENVIRONMENT) {
  console.error("No .env found. Copy .env.example to .env and fill the secrets (pnpm exec tsx scripts/gen-dev-secrets.ts).");
  process.exit(1);
}
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--overlay") continue;
  const f = argv[++i];
  if (!f || !existsSync(f)) {
    console.error(`overlay env file not found: ${f}`);
    process.exit(1);
  }
  load(f);
}
const only = argv.includes("--no-web") ? new Set(["api", "worker"]) : null;
const procs = [
  ["api", ["exec", "tsx", "watch", "apps/api/src/main.ts"]],
  ["worker", ["exec", "tsx", "watch", "apps/worker/src/main.ts"]],
  ["web", ["--filter", "@zeb/web", "dev"]],
]
  .filter(([name]) => !only || only.has(name))
  .map(([name, args]) => {
    const p = spawn("pnpm", args, { env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    const tag = `[${name}]`.padEnd(9);
    p.stdout.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, tag)));
    p.stderr.on("data", (d) => process.stderr.write(String(d).replace(/^/gm, tag)));
    return p;
  });
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
