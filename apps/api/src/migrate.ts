/** Production migration entry (bundled): `node dist/migrate.js`. Uses MIGRATIONS_DIR if set. */
import { createPool, migrate } from "@zeb/db";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const pool = createPool(url, { max: 1, applicationName: "zeb-migrate" });
try {
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
