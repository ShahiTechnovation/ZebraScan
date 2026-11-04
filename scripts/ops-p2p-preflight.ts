/**
 * READ-ONLY P2P.me capability probe through TinyFish (delta spec §4). Never moves money:
 * the agent goal forbids submitting anything and the result is only an observation.
 *
 *   ZEB_ENVIRONMENT=MAINNET_READONLY TINYFISH_API_KEY=… P2P_ALLOWED_START_URL=https://app.p2p.me/ \
 *   DATABASE_URL=… ZEB_TOKEN_SECRET=… ZEB_LOCAL_KEKS=… ZEB_ACTIVE_KEK=… pnpm ops:p2p-preflight
 *
 * Writes a p2p_capability_reports row and docs/P2P_BROWSER_CAPABILITY.md (redacted).
 */
import { writeFileSync } from "node:fs";
import { buildContext, buildTfDeps, loadConfig, runCapabilityPreflight } from "@zeb/core";

const cfg = loadConfig();
if (cfg.environment === "demo") throw new Error("Run the real probe in MAINNET_READONLY (or HACKATHON_TESTNET for a dev check); DEMO would only exercise the simulator.");
const ctx = buildContext(cfg);
const tf = await buildTfDeps(ctx);
const r = await runCapabilityPreflight(ctx, tf, { requestedBy: "cli" });
await ctx.db.end();

const lines = [
  "# P2P.me browser capability (TinyFish, read-only)",
  "",
  `- Checked: ${r.createdAt} (environment ${cfg.environment})`,
  `- Result: **${r.status}**`,
  `- TinyFish run: ${r.runId ?? "not started"}`,
  `- Final page origin: ${r.observedUrl ? new URL(r.observedUrl).origin : "n/a"}`,
  `- Operational account fingerprint: ${r.accountFingerprint ?? "n/a"} (keyed hash; the account id itself is not stored)`,
  `- Start URL: ${cfg.tinyfish.startUrl ?? "not configured"} · profile: ${cfg.tinyfish.profileId ? "explicit profile_id" : "default Browser Context Profile (use_profile: true)"}`,
  "",
  "## Blockers",
  ...(r.reasons.length ? r.reasons.map((x) => `- ${x}`) : ["- none"]),
  "",
  "## Unverified dependencies (delta spec §1 A–H) — a logged-in profile proves none of these",
  "- A. P2P.me permits automation of user-directed payments for third-party Zeb Scan customers",
  "- B. the default profile is authenticated to the correct domain/account",
  "- C. orders can be signed in a hosted browser without private keys/extension interaction",
  "- D. funded, spendable Base USDC and fees",
  "- E. limits / KYC / circle eligibility allow PAY and SELL",
  "- F. an independent way to verify a payout beyond agent prose",
  "- G. a licensed/permitted operating model",
  "- H. wallet signature serialization for server verification (Noir: see docs/READINESS_REPORT.md)",
  "",
  "`eligible_for_payout` stays false until this report is PASS, fresh, and live payouts are explicitly enabled by the operator.",
  "",
];
writeFileSync("docs/P2P_BROWSER_CAPABILITY.md", lines.join("\n"));
console.log(`${r.status}: ${r.reasons.join("; ") || "ok"}\nwritten docs/P2P_BROWSER_CAPABILITY.md`);
process.exitCode = r.status === "PASS" ? 0 : 2;
