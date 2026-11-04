/** Run a reconciliation now (also runs every 10 minutes in the worker). Exit 1 on discrepancy. */
import { buildContext, loadConfig, reconcile } from "@zeb/core";

const ctx = buildContext(loadConfig());
const r = await reconcile(ctx, "manual");
for (const c of r.checks) console.log(`${c.ok ? "OK  " : "FAIL"}  ${c.name}: ${c.detail}`);
await ctx.db.end();
process.exitCode = r.ok ? 0 : 1;
