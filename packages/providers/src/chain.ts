/** TLS lightwalletd chain witness. Schemas vendored from zcash/lightwallet-protocol. */
import { credentials, loadPackageDefinition, type Client } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { resolve } from "node:path";
import { DomainError } from "@zeb/domain";

export interface ChainWitness { height: number; hash: string; time: string; branch: string; network: "testnet" | "mainnet" }
type Rpc = Client & Record<string, (input: unknown, options: { deadline: Date }, cb: (error: Error | null, value: Record<string, unknown>) => void) => void>;
const cache = new Map<string, { at: number; value: ChainWitness }>();
export async function readChainWitness(network: "testnet" | "mainnet"): Promise<ChainWitness> {
  const previous = cache.get(network);
  if (previous && Date.now()-previous.at<15_000) return previous.value;
  const proto = loadPackageDefinition(loadSync(resolve(process.cwd(), "packages/providers/proto/service.proto"), { longs: String, bytes: Buffer, defaults: true })) as unknown as { cash: { z: { wallet: { sdk: { rpc: { CompactTxStreamer: new (host: string, creds: ReturnType<typeof credentials.createSsl>) => Rpc } } } } } };
  const client = new proto.cash.z.wallet.sdk.rpc.CompactTxStreamer(network === "testnet" ? "testnet.zec.rocks:443" : "zec.rocks:443", credentials.createSsl());
  const call = (method: string, input = {}): Promise<Record<string, unknown>> => new Promise((resolveResult, reject) => client[method]!(input, { deadline: new Date(Date.now()+12_000) }, (e,r)=>e?reject(new DomainError("WALLET_CHAIN_UNAVAILABLE", "Chain witness unavailable; no payments accepted", undefined, {retryable:true})):resolveResult(r)));
  try {
    const [info,tip] = await Promise.all([call("getLightdInfo"),call("getLatestBlock")]);
    if (info.chainName !== (network === "testnet" ? "test" : "main")) throw new DomainError("WALLET_NETWORK_MISMATCH", "Lightwallet server reports a different network");
    const height = Number(tip.height);
    if (!Number.isSafeInteger(height) || height<=0 || Math.abs(Number(info.blockHeight)-height)>3) throw new DomainError("WALLET_CHAIN_INCONSISTENT", "Chain witness heights disagree");
    const block = await call("getBlock",{height:String(height)});
    const hash = Buffer.from(block.hash as Uint8Array);
    const time = Number(block.time)*1000;
    if (hash.length !== 32 || !hash.equals(Buffer.from(tip.hash as Uint8Array)) || Number(block.height)!==height || !Number.isFinite(time) || time<=0 || time>Date.now()+30_000) throw new DomainError("WALLET_CHAIN_INCONSISTENT", "Block identity or timestamp invalid");
    const branch=String(info.consensusBranchId).toLowerCase().replace(/^0x/,"");
    const nu7=height >= (network === "testnet" ? 4_465_026 : 3_543_405);
    if (!/^[0-9a-f]{8}$/.test(branch) || (nu7 && branch!=="77190ad9")) throw new DomainError("WALLET_UNSUPPORTED_CONSENSUS", "Consensus branch does not match the supported network upgrade");
    const value={height,hash:hash.reverse().toString("hex"),time:new Date(time).toISOString(),branch,network};
    cache.set(network,{at:Date.now(),value});
    return value;
  } finally { client.close(); }
}
