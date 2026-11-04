import { buildContext, buildTfDeps, loadConfig } from "@zeb/core";
import { buildServer } from "./server";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const app = await buildServer(ctx, { logger: true, tf: await buildTfDeps(ctx) });

const shutdown = async (sig: string) => {
  app.log.info({ sig }, "shutting down");
  await app.close();
  await ctx.db.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: cfg.apiPort, host: cfg.apiHost });
app.log.info({ environment: cfg.environment, zcashNetwork: cfg.zcashNetwork, p2p: ctx.p2p ? "configured" : ctx.p2pConfigError, gateway: ctx.gateway ? "configured" : "not configured" }, "zeb-scan api ready");
