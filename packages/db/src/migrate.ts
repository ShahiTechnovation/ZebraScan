/**
 * Forward-only SQL migrations with SHA-256 checksums. An applied migration whose file changed
 * aborts the run (never silently re-interpret schema). Runs under an advisory lock so two
 * deployers cannot migrate concurrently.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LOCK_KEY = 0x5a_45_42_53; // "ZEBS"

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function load(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

async function ensureTable(c: pg.PoolClient) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrate(pool: pg.Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureTable(c);
    const done = new Map((await c.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
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
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    c.release();
  }
  return applied;
}

export async function migrationStatus(pool: pg.Pool): Promise<Array<{ name: string; applied: boolean; checksumOk: boolean | null }>> {
  const c = await pool.connect();
  try {
    await ensureTable(c);
    const done = new Map((await c.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    return load().map((m) => ({ name: m.name, applied: done.has(m.name), checksumOk: done.has(m.name) ? done.get(m.name) === m.checksum : null }));
  } finally {
    c.release();
  }
}
