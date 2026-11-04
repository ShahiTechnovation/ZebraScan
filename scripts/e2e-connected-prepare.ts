/**
 * Prepares the connected-mode E2E run: resets the E2E database (name MUST end in "_test"),
 * applies migrations, and clears the dev mail directory.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createPool, migrate } from "@zeb/db";

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error("E2E_DATABASE_URL is required");
const name = new URL(url).pathname.slice(1);
if (!name.endsWith("_test")) throw new Error(`refusing to reset database "${name}" (must end with _test)`);
const pool = createPool(url, { max: 1 });
await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
await pool.query("CREATE SCHEMA public");
console.log("migrations:", await migrate(pool));
await pool.end();
const mail = path.resolve(import.meta.dirname, "../var/e2e-mail");
rmSync(mail, { recursive: true, force: true });
mkdirSync(mail, { recursive: true });
console.log("e2e database reset:", name);
