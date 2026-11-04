/**
 * PostgreSQL access. Explicit SQL only. Every money-changing command runs inside `tx()`, which
 * retries on serialization failures / deadlocks; callers lock aggregates with SELECT … FOR UPDATE.
 * NUMERIC columns are parsed as strings (never JS numbers) — convert with BigInt().
 */
import pg from "pg";

// NUMERIC (1700) and INT8 (20) as strings: never let money/heights pass through a JS float.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Db {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "zeb-scan",
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
}

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected

export async function tx<T>(
  db: Db,
  fn: (t: Tx) => Promise<T>,
  opts: { isolation?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? "READ COMMITTED"}`);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.floor(Math.random() * 20)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function one<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q.query(sql, params);
  if (r.rowCount !== 1) throw new Error(`expected exactly one row, got ${r.rowCount}`);
  return r.rows[0] as T;
}

export async function maybeOne<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}

export { migrate, migrationStatus } from "./migrate";
