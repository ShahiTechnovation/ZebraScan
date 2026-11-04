/**
 * Zeb Scan worker: durable jobs (payout rail, credit unlocks, expiry, scanner polling, treasury
 * inventory, reconciliation, email). PostgreSQL leases are the authority.
 *
 * Payout rails:
 *  - P2P_TINYFISH_WEB (all non-demo environments): TinyFish operates the authenticated P2P.me web UI
 *    under the payout state machine in @zeb/core/tfpayouts. The TINYFISH_API_KEY lives only here
 *    and in the API process.
 *  - DEMO_SIMULATED (demo only): simulated provider.
 * The earlier on-chain SDK executor is kept in the source as REFERENCE ONLY and is never
 * constructed here — there is no automatic fallback between rails.
 */
import { createServer } from "node:http";
import { buildContext, buildHandlers, buildTfDeps, claim, DemoP2PExecutor, ensurePeriodic, loadConfig, runCapabilityPreflight, runJob, workerId } from "@zeb/core";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const owner = workerId();

const exec = cfg.environment === "demo" ? new DemoP2PExecutor(ctx.db, "demo") : null;
const tf = await buildTfDeps(ctx);
const handlers = buildHandlers(exec, tf);
handlers["p2p.preflight"] = async (c, job) => {
  await runCapabilityPreflight(c, tf, { requestedBy: typeof job.payload.requestedBy === "string" ? job.payload.requestedBy : undefined });
};

let running = true;
process.on("SIGINT", () => (running = false));
process.on("SIGTERM", () => (running = false));

await ensurePeriodic(ctx);

// Optional liveness endpoint for orchestrators (no data, no secrets).
let lastLoopAt = Date.now();
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 0);
if (healthPort) {
  createServer((_req, res) => {
    const alive = Date.now() - lastLoopAt < 30_000;
    res.writeHead(alive ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: alive, owner, environment: cfg.environment, payoutRail: cfg.payoutRail, tinyfish: tf.port ? tf.port.kind : "not_configured" }));
  }).listen(healthPort, process.env.WORKER_HEALTH_HOST ?? "127.0.0.1");
}
ctx.log.info({ owner, environment: cfg.environment, payoutRail: cfg.payoutRail, tinyfish: tf.port?.kind ?? "not_configured", p2pWeb: tf.web ? new URL(tf.web.startUrl).host : "not_configured" }, "zeb-scan worker started");

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
while (running) {
  lastLoopAt = Date.now();
  try {
    const jobs = await claim(ctx, owner, concurrency);
    if (jobs.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await Promise.all(jobs.map((j) => runJob(ctx, handlers, j, owner)));
  } catch (e) {
    ctx.log.error({ err: (e as Error).message }, "worker loop error");
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
await ctx.db.end();
ctx.log.info({ owner }, "worker stopped");
