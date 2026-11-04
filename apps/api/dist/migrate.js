// ../../packages/db/src/index.ts
import pg from "pg";

// ../../packages/db/src/migrate.ts
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
var LOCK_KEY = 1514488403;
function load(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((name) => {
    const sql = readFileSync(join(dir, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}
async function ensureTable(c) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}
async function migrate(pool2, log = () => void 0) {
  const c = await pool2.connect();
  const applied = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureTable(c);
    const done = new Map((await c.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    for (const m of load()) {
      const prev = done.get(m.name);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`migration ${m.name} was modified after being applied (checksum mismatch)`);
        continue;
      }
      log(`applying ${m.name}`);
      await c.query("BEGIN");
      try {
        await c.query(m.sql);
        await c.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await c.query("COMMIT");
        applied.push(m.name);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${e.message}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => void 0);
    c.release();
  }
  return applied;
}

// ../../packages/db/src/index.ts
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
function createPool(connectionString, opts = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "zeb-scan",
    statement_timeout: 15e3,
    idle_in_transaction_session_timeout: 3e4
  });
}

// src/migrate.ts
var url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
var pool = createPool(url, { max: 1, applicationName: "zeb-migrate" });
try {
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
//# sourceMappingURL=migrate.js.map