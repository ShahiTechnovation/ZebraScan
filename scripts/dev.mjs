// Local development: API + worker (tsx watch) and the Next.js app, sharing ./.env.
// Usage: pnpm dev   (requires .env; see .env.example and scripts/gen-dev-secrets.ts)
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} else if (!process.env.ZEB_ENVIRONMENT) {
  console.error("No .env found. Copy .env.example to .env and fill the secrets (pnpm exec tsx scripts/gen-dev-secrets.ts).");
  process.exit(1);
}
const procs = [
  ["api", ["exec", "tsx", "watch", "apps/api/src/main.ts"]],
  ["worker", ["exec", "tsx", "watch", "apps/worker/src/main.ts"]],
  ["web", ["--filter", "@zeb/web", "dev"]],
].map(([name, args]) => {
  const p = spawn("pnpm", args, { env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`.padEnd(9);
  p.stdout.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, tag)));
  p.stderr.on("data", (d) => process.stderr.write(String(d).replace(/^/gm, tag)));
  return p;
});
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
