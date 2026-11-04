/**
 * Integration harness: real PostgreSQL (TEST_DATABASE_URL, database name MUST end in "_test"),
 * real migrations, the real Fastify server via app.inject(), and the real worker job handlers.
 * External systems (chain, P2P) are exercised only through the demo-environment implementations,
 * which are labelled DEMO and are refused by the code in any other environment.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createPool, migrate, type Db } from "@zeb/db";
import { buildContext, buildHandlers, claim, DemoP2PExecutor, loadConfig, resetRateCaches, resetReadinessCache, runJob, runCapabilityPreflight, type CoreContext, type P2PExecutor, type TfDeps } from "@zeb/core";
import { buildServer } from "../../apps/api/src/server";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "";

export function requireTestDb(): string {
  if (!TEST_DB) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const name = new URL(TEST_DB).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`refusing to run against database "${name}" (must end with _test)`);
  return TEST_DB;
}

export async function resetDb(): Promise<Db> {
  const db = createPool(requireTestDb(), { max: 10, applicationName: "zeb-it" });
  await db.query("DROP SCHEMA IF EXISTS public CASCADE");
  await db.query("CREATE SCHEMA public");
  await db.query("DROP TABLE IF EXISTS schema_migrations");
  await migrate(db);
  return db;
}

export interface Harness {
  ctx: CoreContext;
  app: FastifyInstance;
  db: Db;
  runJobs(maxRounds?: number): Promise<number>;
  close(): Promise<void>;
}

export async function makeHarness(overrides: Record<string, string> = {}, execFactory?: (db: Db) => P2PExecutor, tfFactory?: (ctx: CoreContext) => TfDeps): Promise<Harness> {
  const db = await resetDb();
  const kek = randomBytes(32).toString("base64");
  const cfg = loadConfig({
    ZEB_ENVIRONMENT: "demo",
    DATABASE_URL: requireTestDb(),
    ZEB_TOKEN_SECRET: randomBytes(32).toString("hex"),
    ZEB_LOCAL_KEKS: `k1:${kek}`,
    ZEB_ACTIVE_KEK: "k1",
    WEB_ORIGINS: "http://localhost:3000",
    CREDIT_COOLDOWN_SECONDS: "0",
    PAYOUT_DEST_COOLING_SECONDS: "0",
    INTERNAL_HMAC_SECRET: "x".repeat(40),
    ...overrides,
  });
  resetRateCaches();
  resetReadinessCache();
  const ctx = buildContext(cfg, { db, log: { info() {}, warn() {}, error() {} } });
  const app = await buildServer(ctx, { rateLimitScale: 100, tf: tfFactory ? tfFactory(ctx) : undefined });
  const exec = execFactory ? execFactory(db) : new DemoP2PExecutor(db, "demo", 50_000n, { acceptAfterMs: 0, completeAfterMs: 0 });
  const tf = tfFactory ? tfFactory(ctx) : { port: null, web: null };
  const handlers = buildHandlers(exec, tf);
  handlers["p2p.preflight"] = async (c) => {
    await runCapabilityPreflight(c, tf);
  };
  // Seed the simulated demo treasury inventory.
  await handlers["treasury.inventory"]!(ctx, { id: "seed", kind: "treasury.inventory", dedupe_key: "seed", payload: {}, attempts: 1, max_attempts: 1 });
  return {
    ctx,
    app,
    db,
    async runJobs(maxRounds = 30) {
      let total = 0;
      for (let i = 0; i < maxRounds; i++) {
        // make every queued job due now (tests do not wait for back-off timers)
        await db.query(`UPDATE jobs SET run_at=now() WHERE state IN ('queued','failed') AND kind NOT IN ('treasury.inventory','reconcile','scanner.poll','email.deliver','outbox.dispatch','intents.expire')`);
        const jobs = (await claim(ctx, "it-worker", 20)).filter((j) => !["treasury.inventory", "reconcile", "scanner.poll", "email.deliver", "outbox.dispatch", "intents.expire"].includes(j.kind));
        if (!jobs.length) break;
        for (const j of jobs) await runJob(ctx, handlers, j, "it-worker");
        total += jobs.length;
      }
      return total;
    },
    async close() {
      await app.close();
      await db.end();
    },
  };
}

/** Tiny cookie jar + helpers around app.inject. */
export class Client {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  constructor(private app: FastifyInstance) {}
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(method: string, url: string, opts: { body?: unknown; key?: string; bearer?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { origin: "http://localhost:3000", ...opts.headers };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.key) headers["idempotency-key"] = opts.key;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (this.csrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    const res = await this.app.inject({ method: method as "GET", url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    for (const c of ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? [])) {
      const [kv] = c.split(";");
      const [k, ...v] = kv!.split("=");
      this.cookies.set(k!.trim(), v.join("="));
    }
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* not json */
    }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.statusCode, json, headers: res.headers };
  }
}

let n = 0;
export const key = () => `it-key-${Date.now()}-${++n}`;
