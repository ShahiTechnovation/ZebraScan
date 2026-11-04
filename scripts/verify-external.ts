/**
 * Read-only verification of external dependencies. Never signs or sends anything.
 * Writes docs/evidence/external-verification-<UTC date>.json and prints a summary.
 *
 *   pnpm verify:external
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createPublicClient, http, keccak256, type Address, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CIRCLE_USDC, CoinGeckoSource, KrakenSource, ZecUsdOracle } from "@zeb/providers";

type Status = "verified" | "unknown" | "blocked" | "failed";
interface Check {
  dependency: string;
  status: Status;
  evidence: Record<string, unknown>;
  source: string;
  checkedAt: string;
}

const checks: Check[] = [];
const now = () => new Date().toISOString();
async function check(dependency: string, source: string, fn: () => Promise<{ status?: Status; evidence: Record<string, unknown> }>) {
  try {
    const r = await fn();
    checks.push({ dependency, status: r.status ?? "verified", evidence: r.evidence, source, checkedAt: now() });
  } catch (e) {
    checks.push({ dependency, status: "failed", evidence: { error: (e as Error).message.slice(0, 300) }, source, checkedAt: now() });
  }
}

const ERC20 = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

async function token(client: PublicClient, address: Address) {
  const code = await client.getCode({ address });
  const [symbol, decimals] = await Promise.all([client.readContract({ address, abi: ERC20, functionName: "symbol" }), client.readContract({ address, abi: ERC20, functionName: "decimals" })]);
  return { address, hasCode: !!code && code !== "0x", codeHash: code ? keccak256(code) : null, symbol, decimals: Number(decimals) };
}

await check("ZEC/USD — CoinGecko simple price", "https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true", async () => {
  const o = await new CoinGeckoSource().fetch();
  return { evidence: { rate: o.rateText, observedAt: o.observedAt.toISOString() } };
});
await check("ZEC/USD — Kraken ticker (pair resolved via AssetPairs)", "https://api.kraken.com/0/public/AssetPairs?pair=ZECUSD", async () => {
  const o = await new KrakenSource().fetch();
  return { evidence: { mid: o.rateText, bid: o.bid, ask: o.ask, raw: o.raw } };
});
await check("ZEC/USD — oracle policy (2 sources, 150 bps max deviation, 120 s max age)", "packages/providers/src/prices.ts", async () => {
  const r = await new ZecUsdOracle([new CoinGeckoSource(), new KrakenSource()], { minSources: 2, maxAgeMs: 120_000, maxDeviationBps: 150, maxBidAskSpreadBps: 200 }).read();
  return { evidence: { median: r.rateText, sources: r.observations.map((o) => [o.source, o.rateText]), failures: r.failures } };
});

const mainnet = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL_MAINNET ?? "https://mainnet.base.org") }) as PublicClient;
const sepolia = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_RPC_URL_SEPOLIA ?? "https://sepolia.base.org") }) as PublicClient;

await check("Base mainnet RPC + Circle native USDC", "https://developers.circle.com/stablecoins/usdc-contract-addresses", async () => {
  const chainId = await mainnet.getChainId();
  const usdc = await token(mainnet, CIRCLE_USDC[8453]!);
  const usdbc = await token(mainnet, "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA").catch((e) => ({ error: (e as Error).message }));
  const ok = chainId === 8453 && usdc.hasCode && usdc.symbol === "USDC" && usdc.decimals === 6;
  return { status: ok ? "verified" : "failed", evidence: { chainId, usdc, usdbcForContrast: usdbc, block: (await mainnet.getBlockNumber()).toString() } };
});
await check("Base Sepolia RPC + Circle USDC (testnet)", "https://developers.circle.com/stablecoins/usdc-contract-addresses", async () => {
  const chainId = await sepolia.getChainId();
  const usdc = await token(sepolia, CIRCLE_USDC[84532]!);
  const ok = chainId === 84532 && usdc.hasCode && usdc.decimals === 6;
  return { status: ok ? "verified" : "failed", evidence: { chainId, usdc, block: (await sepolia.getBlockNumber()).toString() } };
});

await check("@p2pdotme/sdk pinned version", "https://www.npmjs.com/package/@p2pdotme/sdk", async () => {
  // The package restricts subpath exports; read its manifest from the installed directory instead.
  const req = createRequire(path.resolve("packages/providers/package.json"));
  const entry = req.resolve("@p2pdotme/sdk/orders");
  const pkgPath = path.join(entry.slice(0, entry.lastIndexOf("dist")), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; dependencies: Record<string, string> };
  const reg = (await (await fetch("https://registry.npmjs.org/@p2pdotme/sdk")).json()) as { "dist-tags": { latest: string } };
  return { evidence: { installed: pkg.version, latestOnNpm: reg["dist-tags"].latest, deps: pkg.dependencies } };
});
await check("P2P.me Diamond / subgraph / integrator permission", "https://github.com/p2pdotme/p2pdotme-sdk (example uses zero-address placeholders)", async () => ({
  status: "blocked",
  evidence: {
    reason: "No provider-verified Diamond address, subgraph URL, ABI/code hash, integrator whitelist or liquidity-circle access has been supplied. The official examples intentionally use 0x000… placeholders. P2P execution stays gated closed.",
    diamondConfigured: !!process.env.P2P_DIAMOND_ADDRESS,
  },
}));

await check("librustzcash crates (Zcash gateway pins)", "https://crates.io", async () => {
  const names = ["zcash_client_backend", "zcash_client_sqlite", "zcash_keys", "zcash_address", "zip321", "zcash_protocol"];
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const r = (await (await fetch(`https://crates.io/api/v1/crates/${n}`, { headers: { "user-agent": "zeb-scan verify-external (contact: operator)" } })).json()) as { crate: { max_stable_version: string; updated_at: string } };
    out[n] = { max_stable_version: r.crate.max_stable_version, updated_at: r.crate.updated_at };
  }
  return { evidence: out };
});
await check("Zebra / Zaino releases", "https://github.com/ZcashFoundation/zebra/releases, https://github.com/zingolabs/zaino/releases", async () => {
  const z = (await (await fetch("https://api.github.com/repos/ZcashFoundation/zebra/releases/latest")).json()) as { tag_name: string; published_at: string };
  const za = (await (await fetch("https://api.github.com/repos/zingolabs/zaino/releases/latest")).json()) as { tag_name: string; published_at: string };
  return { evidence: { zebra: [z.tag_name, z.published_at], zaino: [za.tag_name, za.published_at] } };
});
await check("Zcash gateway (compiled + Ironwood scanning proven on testnet)", "services/zcash-gateway", async () => ({
  status: "blocked",
  evidence: { reason: "No Rust toolchain on the build host; gateway not compiled or run. No testnet node/indexer endpoint or wallet birthday supplied. Invoice creation stays closed in testnet/mainnet." },
}));
for (const [dep, reason] of [
  ["Legal / regulatory approval (RBI PA, PPI, FIU-IND VDA, FEMA)", "Requires qualified counsel. LEGAL_APPROVAL_REF unset → mainnet-enabled gate closed."],
  ["Merchant KYB provider", "No provider selected; manual review queue implemented. Mandatory fields to be decided by counsel."],
  ["Email delivery (SMTP)", "No SMTP credentials supplied; dev-file provider used for demo/testnet only."],
  ["Secret manager / KMS", "Only LocalKeyProvider implemented (demo/testnet). Cloud KMS adapter required for mainnet."],
  ["Funded Base treasury signer", "No signer, funding or remote signing service supplied."],
  ["ZEC→USDC rebalance venue", "No approved venue; rebalancing is manual/out of scope until one is approved."],
] as const) checks.push({ dependency: dep, status: "blocked", evidence: { reason }, source: "operator", checkedAt: now() });

const outDir = path.resolve("docs/evidence");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `external-verification-${now().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ generatedAt: now(), checks }, null, 2));
for (const c of checks) console.log(`${c.status.padEnd(9)} ${c.dependency}`);
console.log(`\nevidence written to ${path.relative(process.cwd(), file)}`);
process.exitCode = checks.some((c) => c.status === "failed") ? 1 : 0;
