/**
 * Client for services/zcash-gateway (Rust, watch-only, mTLS). The gateway owns the incoming
 * viewing key; the API only ever receives public receiving addresses and deposit observations.
 *
 * In `demo` the DemoAddressAllocator issues clearly NON-PAYABLE placeholders; it is refused in
 * every other environment.
 */
import { Agent } from "undici";
import { readFileSync } from "node:fs";
import { DomainError, assertZip321Matches, buildZip321, type Environment, type ZcashNetwork, randomToken } from "@zeb/domain";
import { fetchJson } from "./http";

export interface AllocatedAddress {
  address: string;
  addressType: "unified" | "sapling" | "transparent" | "demo";
  receivers: string[];
  accountId: string;
  diversifierIndex: string;
  walletId: string;
  birthdayHeight: number | null;
  /** Gateway-built ZIP-321 URI (pinned zip321 crate). Re-validated by the API. */
  zip321Uri: string;
  /** Memo-matched watchers: the invoice memo code embedded in the URI. */
  memoCode?: string;
}

export interface ScannerStatus {
  network: ZcashNetwork;
  tipHeight: number;
  tipHash: string;
  tipTime: string;
  scannedHeight: number;
  consensusBranchId: string;
  ironwoodSupported: boolean;
  nu7Active: boolean;
  state: "synced" | "syncing" | "rescanning" | "stalled" | "error";
  walletBirthday: number;
  version: string;
}

export interface DepositEvent {
  eventId: string;
  kind: "note_seen" | "note_confirmed" | "note_reorged";
  network: ZcashNetwork;
  pool: "orchard" | "sapling" | "transparent" | "ironwood";
  txid: string;
  outputRef: string;
  valueZatoshis: string;
  address: string;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  scanVersion: string;
  /** Decrypted memo (memo-matched watchers only). Never logged. */
  memo?: string | null;
}

export interface AddressAllocator {
  readonly kind: "gateway" | "demo" | "zkool";
  allocate(input: { invoiceId: string; network: ZcashNetwork | "demo"; privacyMode: "shielded" | "transparent"; diversifierIndex: bigint; amountZat: bigint; memoCode?: string }): Promise<AllocatedAddress>;
}

export interface GatewayConfig {
  url: string;
  network: ZcashNetwork;
  tls?: { certPath: string; keyPath: string; caPath: string };
}

export class ZcashGatewayClient implements AddressAllocator {
  readonly kind = "gateway" as const;
  private dispatcher: Agent | undefined;
  constructor(private cfg: GatewayConfig) {
    if (cfg.tls) {
      this.dispatcher = new Agent({
        connect: { cert: readFileSync(cfg.tls.certPath), key: readFileSync(cfg.tls.keyPath), ca: readFileSync(cfg.tls.caPath), rejectUnauthorized: true },
      });
    }
  }

  private fetchImpl: typeof fetch = (input, init) =>
    fetch(input, { ...(init ?? {}), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) } as RequestInit);

  async status(): Promise<ScannerStatus> {
    return fetchJson<ScannerStatus>(`${this.cfg.url}/internal/scanner/status`, { fetchImpl: this.fetchImpl, timeoutMs: 5_000, retries: 1 });
  }

  async allocate(input: { invoiceId: string; network: ZcashNetwork | "demo"; privacyMode: "shielded" | "transparent"; diversifierIndex: bigint; amountZat: bigint }): Promise<AllocatedAddress> {
    if (input.network !== this.cfg.network) throw new DomainError("WALLET_NETWORK_MISMATCH", "allocation network does not match gateway network");
    const out = await fetchJson<AllocatedAddress>(`${this.cfg.url}/internal/addresses/allocate`, {
      method: "POST",
      fetchImpl: this.fetchImpl,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invoiceId: input.invoiceId,
        network: input.network,
        privacyMode: input.privacyMode,
        diversifierIndex: input.diversifierIndex.toString(),
        amountZatoshis: input.amountZat.toString(),
      }),
      retries: 0, // allocation is keyed by diversifierIndex; the caller retries with the same index
      timeoutMs: 10_000,
    });
    if (out.diversifierIndex !== input.diversifierIndex.toString()) throw new DomainError("WALLET_ALLOCATION_MISMATCH", "gateway returned a different diversifier index");
    if (input.privacyMode === "shielded" && !out.receivers.some((r) => r === "orchard" || r === "sapling" || r === "ironwood")) {
      throw new DomainError("WALLET_NO_SHIELDED_RECEIVER", "allocated address has no shielded receiver");
    }
    assertZip321Matches(out.zip321Uri, { address: out.address, zat: input.amountZat, network: this.cfg.network });
    return out;
  }

  async deposits(sinceCursor: string | null, limit = 200): Promise<{ events: DepositEvent[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ limit: String(limit), ...(sinceCursor ? { sinceCursor } : {}) });
    return fetchJson(`${this.cfg.url}/internal/deposits?${q}`, { fetchImpl: this.fetchImpl, timeoutMs: 10_000 });
  }
}

/** Demo only: non-payable placeholder that can never be mistaken for a Zcash address. */
export class DemoAddressAllocator implements AddressAllocator {
  readonly kind = "demo" as const;
  constructor(env: Environment) {
    if (env !== "demo") throw new DomainError("SYSTEM_CONFIG", "DemoAddressAllocator is only permitted in the demo environment");
  }
  async allocate(input: { invoiceId: string; diversifierIndex: bigint; amountZat: bigint }): Promise<AllocatedAddress> {
    const address = `zebscan-demo-address-${input.invoiceId}-not-payable`;
    return {
      address,
      addressType: "demo",
      receivers: ["demo"],
      accountId: "demo",
      diversifierIndex: input.diversifierIndex.toString(),
      walletId: "demo",
      birthdayHeight: null,
      zip321Uri: `zebscan-demo://checkout/${input.invoiceId}?payable=false&ref=${randomToken(4)}`,
    };
  }
}

export { buildZip321 };
