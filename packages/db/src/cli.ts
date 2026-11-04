import { createPool, migrate, migrationStatus } from "./index";

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const pool = createPool(url, { max: 2, applicationName: "zeb-migrate" });
try {
  if (cmd === "migrate") {
    const applied = await migrate(pool, (m) => console.log(m));
    console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
  } else if (cmd === "status") {
    for (const s of await migrationStatus(pool)) console.log(`${s.applied ? (s.checksumOk ? "✔" : "✖ CHECKSUM") : "·"} ${s.name}`);
  } else {
    console.error("usage: cli.ts migrate|status");
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
