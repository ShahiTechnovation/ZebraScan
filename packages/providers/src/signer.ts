/**
 * Base treasury signer boundary. The API process never constructs a signer; only the worker's
 * payout executor does, and only when the environment allows submissions.
 *
 *  - Testnet (Base Sepolia 84532): a local key read from a secret FILE mount (never from Git or a
 *    NEXT_PUBLIC env). Refused for any other chain.
 *  - Mainnet (Base 8453): a remote isolated signing service (KMS/HSM-backed) reached over mTLS.
 *    The service must itself enforce chain/contract allowlists and limits. A raw private key is
 *    refused on mainnet.
 */
import { readFileSync, statSync } from "node:fs";
import { createWalletClient, http, serializeTransaction, type Address, type Hex, type TransactionSerializable, type WalletClient } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { DomainError } from "@zeb/domain";
import { CHAINS } from "./p2p";

export function loadTestnetFileSigner(path: string, chainId: number, rpcUrl: string): WalletClient {
  if (chainId !== 84532) throw new DomainError("P2P_SIGNER_POLICY", "file-based signer keys are permitted on Base Sepolia only");
  const st = statSync(path);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new DomainError("P2P_SIGNER_POLICY", "signer key file must not be group/world readable");
  const pk = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk) || /^0x0{64}$/.test(pk)) throw new DomainError("P2P_SIGNER_POLICY", "signer key file is malformed");
  const account = privateKeyToAccount(pk as Hex);
  return createWalletClient({ account, chain: CHAINS[chainId], transport: http(rpcUrl) });
}

export interface RemoteSignerConfig {
  url: string;
  address: Address;
  /** mTLS material is provided by the platform (undici dispatcher); see infra/deploy/README.md. */
  fetchImpl?: typeof fetch;
  authHeader?: string;
}

/** viem Account backed by a remote isolated signer. Only signTransaction is supported. */
export function remoteSignerClient(cfg: RemoteSignerConfig, chainId: number, rpcUrl: string): WalletClient {
  const f = cfg.fetchImpl ?? fetch;
  const account = toAccount({
    address: cfg.address,
    async signMessage() {
      throw new DomainError("P2P_SIGNER_POLICY", "message signing is not permitted for the treasury signer");
    },
    async signTypedData() {
      throw new DomainError("P2P_SIGNER_POLICY", "typed-data signing is not permitted for the treasury signer");
    },
    async signTransaction(tx: TransactionSerializable) {
      const res = await f(`${cfg.url.replace(/\/$/, "")}/v1/sign-transaction`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.authHeader ? { authorization: cfg.authHeader } : {}) },
        body: JSON.stringify({ chainId, unsigned: serializeTransaction(tx) }),
      });
      if (!res.ok) throw new DomainError("P2P_SIGNER_REJECTED", `remote signer refused (${res.status})`, undefined, { retryable: res.status >= 500 });
      const body = (await res.json()) as { signed?: string };
      if (!body.signed || !/^0x[0-9a-fA-F]+$/.test(body.signed)) throw new DomainError("P2P_SIGNER_REJECTED", "remote signer returned malformed payload");
      return body.signed as Hex;
    },
  });
  return createWalletClient({ account, chain: CHAINS[chainId], transport: http(rpcUrl) });
}
