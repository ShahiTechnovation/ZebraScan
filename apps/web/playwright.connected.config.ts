/**
 * Connected-mode E2E: the browser drives the REAL API + worker + PostgreSQL.
 * The backend runs in the `demo` environment (no chain is touched; every record is labelled DEMO),
 * against a dedicated database whose name MUST end in "_test" (reset in global setup).
 */
import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import path from "node:path";

const WEB = 3200;
const API = 4100;
const root = path.resolve(__dirname, "../..");
export const MAIL_DIR = path.join(root, "var", "e2e-mail");
const db = process.env.E2E_DATABASE_URL ?? "";

const backendEnv = {
  ZEB_ENVIRONMENT: "demo",
  DATABASE_URL: db,
  ZEB_TOKEN_SECRET: process.env.E2E_TOKEN_SECRET ?? randomBytes(32).toString("hex"),
  ZEB_LOCAL_KEKS: `e2e:${process.env.E2E_KEK ?? randomBytes(32).toString("base64")}`,
  ZEB_ACTIVE_KEK: "e2e",
  API_PORT: String(API),
  WEB_ORIGINS: `http://localhost:${WEB}`,
  APP_BASE_URL: `http://localhost:${WEB}`,
  EMAIL_MODE: "dev-file",
  EMAIL_DEV_DIR: MAIL_DIR,
  CREDIT_COOLDOWN_SECONDS: "3",
  RATE_LIMIT_SCALE: "50",
  COOKIE_SECURE: "false",
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "tests/e2e-connected",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB}`, channel: "chrome", trace: "off" },
  projects: [{ name: "connected", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 900 } } }],
  webServer: [
    {
      command: `pnpm exec tsx apps/api/src/main.ts`,
      cwd: root,
      env: backendEnv,
      url: `http://localhost:${API}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec tsx apps/worker/src/main.ts`,
      cwd: root,
      env: { ...backendEnv, WORKER_HEALTH_PORT: "4101" },
      url: "http://127.0.0.1:4101/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start -p ${WEB}`,
      env: { NEXT_DIST_DIR: ".next-connected" },
      url: `http://localhost:${WEB}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
