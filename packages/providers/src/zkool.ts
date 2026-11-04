/**
 * Watch-only Zcash testnet watcher over zkool_graphql (zkool2), per the Free Society Hack testnet
 * guide (v2026-11-02): NU7 + Ironwood, lightwalletd https://testnet.zec.rocks:443.
 *
 * The zkool account MUST be created from a UFVK (`uviewtest…`) with a `birth` height: it has no
 * spending key (`pay` returns "No Signing Key"). Never point this adapter at a seed account.
 *
 * Invoices are matched by a unique memo code (encrypted inside the shielded note), never by amount.
 * Operations used (documented): currentHeight, synchronize, addressByAccount, transactionsByAccount
 * { txid height time notes { pool value address scope memo } }, unconfirmedByAccount { txid value }.
 *
 * STATUS: contract-tested against a local fake of the documented schema only. Not yet exercised
 * against a live zkool_graphql (no Linux runtime on the build host) — see docs/READINESS_REPORT.md.
 */
import { DomainError, INVOICE_MEMO_RE, addressMatchesNetwork, buildZip321, parseDecimalToMinor } from "@zeb/domain";
import type { AddressAllocator, AllocatedAddress, DepositEvent, ScannerStatus } from "./zcash";

export interface ZkoolConfig {
  url: string; // http(s)://host:port/graphql
  accountId: number;
  network: "testnet";
  /** Optional JWT when zkool_graphql runs with -j. */
  jwt?: string;
  /** zkool `pools` argument for addressByAccount; 4 = Ironwood-only UA (documented). */
  pools?: number;
  fetchImpl?: typeof fetch;
}

interface ZkoolNote {
  pool: number;
  value: number | string;
  address?: string | null;
  scope: number;
  memo?: string | null;
}
interface ZkoolTx {
  id: number;
  txid: string;
  height: number | null;
  time?: number | string | null;
  notes: ZkoolNote[];
}

const POOL: Record<number, DepositEvent["pool"] | undefined> = { 0: "transparent", 1: "sapling", 2: "orchard", 3: "ironwood" };

/** Decimal ZEC (number or string, as zkool returns) → zatoshis, exact. */
export function zecToZat(v: number | string): bigint {
  const s = typeof v === "number" ? v.toFixed(8) : v;
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new DomainError("WALLET_AMOUNT_FORMAT", `unexpected ZEC amount ${String(v).slice(0, 20)}`);
  return parseDecimalToMinor(s, 8);
}

/** Pull memo code out of a memo (exact token match, whitespace-trimmed). */
export function memoCode(memo: string | null | undefined): string | null {
  const m = memo?.trim();
  return m && INVOICE_MEMO_RE.test(m) ? m : null;
}

export class ZkoolWatcher implements AddressAllocator {
  readonly kind = "zkool" as const;
  private ua: string | null = null;
  constructor(private cfg: ZkoolConfig) {
    if (!/^https?:\/\//.test(cfg.url)) throw new DomainError("SYSTEM_CONFIG", "ZKOOL_GRAPHQL_URL must be http(s)");
  }

  async gql<T>(query: string): Promise<T> {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.jwt ? { authorization: `Bearer ${this.cfg.jwt}` } : {}) },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new DomainError("WALLET_WATCHER_HTTP", `zkool_graphql HTTP ${res.status}`, undefined, { retryable: true });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new DomainError("WALLET_WATCHER_ERROR", `zkool_graphql: ${body.errors.map((e) => e.message).join("; ").slice(0, 200)}`, undefined, { retryable: true });
    if (!body.data) throw new DomainError("WALLET_WATCHER_ERROR", "zkool_graphql returned no data", undefined, { retryable: true });
    return body.data;
  }

  /** Proves the account is watch-only: `pay` must fail with "No Signing Key". */
  async assertWatchOnly(): Promise<void> {
    try {
      await this.gql(`mutation { pay(idAccount: ${this.cfg.accountId}, payment: { recipients: [], confirmations: 1 }) }`);
    } catch (e) {
      if (/No Signing Key/i.test((e as Error).message)) return;
      throw new DomainError("WALLET_NOT_WATCH_ONLY", `could not prove the zkool account is watch-only: ${(e as Error).message.slice(0, 160)}`);
    }
    throw new DomainError("WALLET_NOT_WATCH_ONLY", "zkool account accepted a pay call — it holds a spending key; refusing to use it");
  }

  async receivingAddress(): Promise<string> {
    if (this.ua) return this.ua;
    const pools = this.cfg.pools ?? 4;
    const d = await this.gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${this.cfg.accountId}, pools: ${pools}) { ua } }`);
    const ua = d.addressByAccount?.ua;
    if (!ua || !addressMatchesNetwork(ua, "testnet") || !ua.startsWith("utest1")) throw new DomainError("WALLET_ADDRESS_INVALID", "zkool returned a non-testnet or non-unified address");
    this.ua = ua;
    return ua;
  }

  async allocate(input: { invoiceId: string; diversifierIndex: bigint; amountZat: bigint; memoCode?: string }): Promise<AllocatedAddress> {
    if (!input.memoCode || !INVOICE_MEMO_RE.test(input.memoCode)) throw new DomainError("WALLET_MEMO_REQUIRED", "memo-matched watcher requires an invoice memo code");
    const address = await this.receivingAddress();
    return {
      address,
      addressType: "unified",
      receivers: this.cfg.pools === 4 || this.cfg.pools === undefined ? ["ironwood"] : ["ironwood", "sapling"],
      accountId: String(this.cfg.accountId),
      diversifierIndex: input.diversifierIndex.toString(),
      walletId: `zkool:${this.cfg.accountId}`,
      birthdayHeight: null,
      zip321Uri: buildZip321(address, input.amountZat, input.memoCode),
      memoCode: input.memoCode,
    };
  }

  async status(): Promise<ScannerStatus> {
    const synced = await this.gql<{ synchronize: number }>(`mutation { synchronize(idAccounts: [${this.cfg.accountId}], fast: false) }`);
    const h = await this.gql<{ currentHeight: number }>(`{ currentHeight }`);
    const scanned = Number(synced.synchronize ?? 0);
    const tip = Number(h.currentHeight ?? 0);
    return {
      network: "testnet",
      tipHeight: tip,
      tipHash: "",
      tipTime: new Date().toISOString(),
      scannedHeight: scanned || tip,
      consensusBranchId: "77190ad9", // NU7 testnet branch per event guide; zkool exposes no branch query
      ironwoodSupported: true, // zkool2 Oct-2026 releases produce/scan Ironwood (event guide)
      nu7Active: true,
      state: tip > 0 && (scanned === 0 || tip - scanned <= 3) ? "synced" : "syncing",
      walletBirthday: 0,
      version: "zkool_graphql",
    };
  }

  /**
   * Snapshot of incoming (scope 0) notes as scanner events. Confirmations = tip - height + 1.
   * Mempool sightings come from unconfirmedByAccount (display only).
   */
  async snapshot(tip: number): Promise<DepositEvent[]> {
    const d = await this.gql<{ transactionsByAccount: ZkoolTx[] }>(
      `{ transactionsByAccount(idAccount: ${this.cfg.accountId}) { id txid height time notes { pool value address scope memo } } }`,
    );
    const u = await this.gql<{ unconfirmedByAccount: Array<{ txid: string; value: number | string }> }>(`{ unconfirmedByAccount(idAccount: ${this.cfg.accountId}) { txid value } }`).catch(() => ({ unconfirmedByAccount: [] }));
    const address = await this.receivingAddress();
    const out: DepositEvent[] = [];
    const mined = new Set<string>();
    for (const t of d.transactionsByAccount ?? []) {
      if (!/^[0-9a-f]{64}$/.test(t.txid)) continue;
      t.notes.forEach((n, idx) => {
        if (n.scope !== 0) return; // scope 1 = change
        const pool = POOL[n.pool];
        if (!pool || pool === "orchard") return; // Orchard is sealed on NU6.3: never accept as new funds
        const confirmations = t.height ? Math.max(0, tip - t.height + 1) : 0;
        if (t.height) mined.add(t.txid);
        out.push({
          eventId: `zkool:${t.txid}:${idx}:${t.height ?? "mempool"}:${Math.min(confirmations, 100)}`,
          kind: t.height ? "note_confirmed" : "note_seen",
          network: "testnet",
          pool,
          txid: t.txid,
          outputRef: `${t.txid}:note${idx}`,
          valueZatoshis: zecToZat(n.value).toString(),
          address,
          blockHeight: t.height,
          blockHash: null,
          confirmations,
          scanVersion: "zkool_graphql",
          memo: n.memo ?? null,
        });
      });
    }
    for (const x of u.unconfirmedByAccount ?? []) {
      if (mined.has(x.txid)) continue; // zkool keeps listing mined txids here (documented)
      // No per-note memo for mempool rows: display-only sighting, never matched to an invoice by amount.
    }
    return out;
  }
}
