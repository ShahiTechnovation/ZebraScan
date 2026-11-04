/**
 * Connected-mode browser E2E: reset the *_test database, build the web app in connected mode
 * (separate dist dir), then run Playwright which boots the real API + worker + web.
 *   E2E_DATABASE_URL=postgres://…/zebscan_e2e_test pnpm test:e2e:connected
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const env = {
  ...process.env,
  E2E_KEK: process.env.E2E_KEK ?? randomBytes(32).toString("base64"),
  E2E_TOKEN_SECRET: process.env.E2E_TOKEN_SECRET ?? randomBytes(32).toString("hex"),
};
const run = (cmd: string, extra: Record<string, string> = {}) => execSync(cmd, { stdio: "inherit", env: { ...env, ...extra } });
run("pnpm exec tsx scripts/e2e-connected-prepare.ts");
run("pnpm --filter @zeb/web build", { NEXT_DIST_DIR: ".next-connected", NEXT_PUBLIC_ZEB_MODE: "connected", NEXT_PUBLIC_API_BASE_URL: "http://localhost:4100" });
run("pnpm --filter @zeb/web exec playwright test -c playwright.connected.config.ts");
