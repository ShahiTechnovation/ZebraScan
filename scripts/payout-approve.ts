/**
 * Operator CLI for payout commands — the approval path of the TESTNET_LIVE_PAYOUT_DEMO (and the pilot rail).
 *
 *   pnpm exec tsx scripts/payout-approve.ts --overlay var/secrets/testnet.env --overlay var/secrets/testnet-worker.env
 *       (no action flag) list pending payout commands with their full terms
 *   ... --approve <payoutId> --hash <commandHash> --operator <name>
 *       approve exactly that command; refused unless <commandHash> matches the immutable terms
 *   ... --advance <payoutId>
 *       one advance pass of the strict state machine. After approval this is what starts the REAL
 *       TinyFish execute run (app.p2p.lol SELL). The running worker does the same automatically; both use
 *       the same per-payout job lease, so they can never advance one payout concurrently.
 *   ... --hold <payoutId> --operator <name> [--reason <text>]
 *       emergency stop (safe direction): the command is held and nothing else runs for it
 *
 * Env loading mirrors scripts/dev.mjs (./.env, then each --overlay; later wins) so the CLI sees exactly
 * what the running API/worker see; config/context/rail are then built like scripts/ops-p2p-preflight.ts
 * (loadConfig → buildContext → buildTfDeps).
 *
 * Testnet live demo framing: INR is paid from Zeb Scan's own pre-funded P2P.lol USDC; the testnet
 * payment only authorizes it. TAZ has no value.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  advancePayoutAsOperator,
  approvePayoutAsOperator,
  buildContext,
  buildTfDeps,
  describePayoutCommand,
  holdPayoutAsOperator,
  listPendingPayoutCommands,
  loadConfig,
  payoutPolicyView,
  TESTNET_DEMO_FUNDING_NOTE,
  workerId,
  type PayoutTermsView,
} from "@zeb/core";
import { ENVIRONMENT_DISPLAY } from "@zeb/domain";

const argv = process.argv.slice(2);
const overlays: string[] = [];
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
}
function fail(msg: string, code = 2): never {
  console.error(`refused: ${msg}`);
  process.exit(code);
}

/** Same parser as scripts/dev.mjs. */
function loadEnvFile(file: string, into: Record<string, string | undefined>) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) into[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
}

const env: Record<string, string | undefined> = { ...process.env };
if (existsSync(".env")) loadEnvFile(".env", env);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--overlay") continue;
  const f = argv[++i];
  if (!f || !existsSync(f)) fail(`overlay env file not found: ${f}`);
  overlays.push(f);
  loadEnvFile(f, env);
}
const cli = `pnpm exec tsx scripts/payout-approve.ts${overlays.map((o) => ` --overlay ${o}`).join("")}`;

function show(v: PayoutTermsView, n?: number) {
  const head = `${n !== undefined ? `[${n}] ` : ""}${v.id}  state=${v.state}${v.held ? "  HELD" : ""}${v.approvable ? "  (awaiting your approval)" : ""}`;
  const lines = [
    head,
    `    flow          ${v.flow}${v.sellUsdc ? " — executed as an app.p2p.lol SELL" : ""}`,
    `    UPI           ${v.recipientVpa}   (masked ${v.recipientVpaMasked})`,
    `    INR           ${v.inr}   (minimum provider-shown INR payout accepted: ${v.minInr})`,
    v.sellUsdc ? `    USDC          sell exactly ${v.sellUsdc} USDC   (authorized max debit ${v.maxUsdc})` : `    USDC          max debit ${v.maxUsdc}`,
    `    environment   ${v.environment} · mode ${v.mode} · checkout ${v.checkoutId ?? "-"}${v.withdrawalId ? ` · withdrawal ${v.withdrawalId}` : ""}`,
    `    commandHash   ${v.commandHash}   (recomputed from stored terms: ${v.hashVerified ? "OK" : "MISMATCH — do not approve"})`,
    `    reason        ${v.stateReason ?? "-"}${v.holdReason ? ` · hold: ${v.holdReason}` : ""}`,
    `    approval      ${v.approvedBy ? `${v.approvedBy} until ${v.approvalExpiresAt}` : "none"}`,
    `    created       ${v.createdAt}`,
  ];
  if (v.attempts.length) lines.push(`    attempts      ${v.attempts.map((a) => `${a.kind}:${a.status}/${a.outcome ?? "-"}${a.runId ? ` run=${a.runId}` : ""}`).join("  ")}`);
  if (v.providerOrder) lines.push(`    provider      order ${v.providerOrder.id} · ${v.providerOrder.status}`);
  if (v.approvable) lines.push(`    approve with  ${cli} --approve ${v.id} --hash ${v.commandHash} --operator <your-name>`);
  console.log(lines.join("\n"));
}

const cfg = loadConfig(env);
const ctx = buildContext(cfg);
try {
  const policy = await payoutPolicyView(ctx);
  console.log(`Zeb Scan payout commands · ${ENVIRONMENT_DISPLAY[cfg.environment]} (${cfg.environment}) · testnet live demo gate: ${policy.liveDemo ? "ON" : "OFF"}`);
  if (cfg.environment === "testnet") console.log(policy.liveDemo ? `  ${TESTNET_DEMO_FUNDING_NOTE} TAZ has no value.` : "  HACKATHON_TESTNET never executes INR payouts while TESTNET_LIVE_PAYOUT_DEMO is off.");
  console.log(`  caps: per-order INR ${policy.perOrderCapInr} · daily ${policy.dailyCapUsdc} USDC (committed in last 24h: ${policy.usedLast24hUsdc}) · LIVE_PAYOUTS_ENABLED=${policy.livePayoutsEnabled} · approval TTL ${policy.approvalTtlSec}s · legal ref ${policy.legalApprovalRef ? "set" : "MISSING"} · provider ref ${policy.providerApprovalRef ? "set" : "MISSING"}`);
  console.log("");

  const approve = flag("--approve");
  const advance = flag("--advance");
  const hold = flag("--hold");
  if ([approve, advance, hold].filter(Boolean).length > 1) fail("use only one of --approve, --advance, --hold");

  if (approve) {
    const hash = flag("--hash") ?? fail("--approve needs --hash <commandHash> (copy it from the listing)");
    const operator = flag("--operator") ?? fail("--approve needs --operator <name>");
    const v = await approvePayoutAsOperator(ctx, approve, hash, operator).catch((e: Error) => fail(e.message));
    show(v);
    console.log(`\nAPPROVED by cli:${operator}; valid until ${v.approvalExpiresAt}. The worker (or: ${cli} --advance ${v.id}) now queues the ONE execute run.`);
  } else if (advance) {
    const deps = await buildTfDeps(ctx);
    const before = await describePayoutCommand(ctx, advance);
    if (!before) fail(`payout ${advance} not found in ${cfg.environment}`);
    console.log(`before: ${before.state}${before.approvedBy ? ` (approved by ${before.approvedBy})` : ""}`);
    const r = await advancePayoutAsOperator(ctx, deps, advance, `cli-${workerId()}`).catch((e: Error) => fail(e.message, 1));
    for (const s of r.steps) console.log(`  → ${s.state}${s.rerunInMs === null ? " (waits for an operator / terminal)" : s.rerunInMs === 0 ? "" : ` (next check in ${Math.round(s.rerunInMs / 1000)}s by the worker or another --advance)`}`);
    if (r.error) console.log(`  ! ${r.error}`);
    const after = (await describePayoutCommand(ctx, advance))!;
    console.log("");
    show(after);
    if (r.error && !r.claimed) process.exitCode = 3;
  } else if (hold) {
    const operator = flag("--operator") ?? fail("--hold needs --operator <name>");
    await holdPayoutAsOperator(ctx, hold, operator, flag("--reason") ?? "");
    const v = await describePayoutCommand(ctx, hold);
    if (!v) fail(`payout ${hold} not found in ${cfg.environment}`);
    show(v);
    console.log(`\nHELD by cli:${operator}. Nothing further runs for this payout.`);
  } else {
    const items = await listPendingPayoutCommands(ctx);
    if (!items.length) console.log("No pending payout commands.");
    items.forEach((v, i) => {
      show(v, i + 1);
      console.log("");
    });
  }
} finally {
  await ctx.db.end();
}
