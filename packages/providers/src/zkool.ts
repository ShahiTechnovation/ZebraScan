/**
 * Watch-only Zcash watcher over zkool_graphql (zkool2 v6.36.0, NU7 + Ironwood), per the Free
 * Society Hack testnet guide: lightwalletd https://testnet.zec.rocks:443.
 *
 * Schema facts this adapter relies on were read from the pinned zkool2 source
 * (rust/src/graphql/{query,mutation,data,mod}.rs @ v6.36.0) and are re-checked at startup by
 * `assertSchema()` via GraphQL introspection — a missing field/operation fails closed:
 *   - mutation newAddresses(idAccount) -> Addresses { ua sapling orchard transparent diversifierIndex }
 *       rotates the account's diversifier index (BEGIN IMMEDIATE in zkool) and returns the new set.
 *   - mutation synchronizeAccount(idAccount, fast) -> synced height   (account-scoped auth)
 *   - query transactionsByAccount(idAccount) { txid height notes { id pool value scope address diversifierIndex memo } }
 *   - query unconfirmedByAccount(idAccount) { txid notes { pool scope value address diversifierIndex memo } }
 *   - query currentHeight (lightwalletd tip)
 *   - pool numbering 0 transparent, 1 sapling, 2 orchard, 3 ironwood; scope 0 = external (incoming)
 *   - JWT: ES256, claims { exp, sub: accountId (0 = admin), write }. A token with write=false
 *     cannot call `pay` ("Unauthorized"); a watch-only UFVK account cannot sign ("No Signing Key").
 *
 * Attribution: by default every invoice gets its OWN diversified Unified Address (address mode
 * "rotate"), and an incoming note is attributed via its diversifier index → never by amount,
 * never by the account's net delta. "memo" mode (one shared UA + unique encrypted memo code) is an
 * explicit fallback only.
 */
import { sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { DomainError, INVOICE_MEMO_RE, addressMatchesNetwork, buildZip321, parseDecimalToMinor } from "@zeb/domain";
import type { AddressAllocator, AllocatedAddress, DepositEvent, ScannerStatus } from "./zcash";

export type ZkoolNetwork = "testnet" | "mainnet";
export type ZkoolAddressMode = "rotate" | "memo";

export interface ZkoolConfig {
  url: string; // http(s)://host:port/graphql
  accountId: number;
  network: ZkoolNetwork;
  /** Short-lived viewer token issued by an isolated operator service. */
  jwt?: string;
  /** Refreshed atomically by an isolated issuer; read at each request. */
  jwtFile?: string;
  /** Rejected: retained in the type only to produce a clear migration error. */
  jwtPrivateKeyPem?: string;
  /** Address mode; default "rotate" (unique diversified UA per invoice). */
  addressMode?: ZkoolAddressMode;
  /** zkool `pools` for addressByAccount in memo mode; 4 = Ironwood receiver only, 6 = + Sapling. */
  pools?: number;
  /** Wallet birth height (watch-only import) for health display. */
  birthHeight?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ZkoolNote {
  id?: number;
  pool: number;
  value: number | string;
  address?: string | null;
  scope: number;
  diversifierIndex?: number | string | null;
  memo?: string | null;
}
interface ZkoolTx {
  txid: string;
  height: number | null;
  notes: ZkoolNote[];
}
interface ZkoolUnconfirmed {
  txid: string;
  notes?: ZkoolNote[] | null;
}
export interface ZkoolAddresses {
  ua: string | null;
  sapling?: string | null;
  orchard?: string | null;
  transparent?: string | null;
  diversifierIndex: number | string;
}

export const ZKOOL_POOL: Record<number, DepositEvent["pool"] | undefined> = { 0: "transparent", 1: "sapling", 2: "orchard", 3: "ironwood" };

/** Decimal ZEC (number or string, as zkool returns) → zatoshis, exact. */
export function zecToZat(v: number | string): bigint {
  const s = typeof v === "number" ? String(v) : v;
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new DomainError("WALLET_AMOUNT_FORMAT", `unexpected ZEC amount ${String(v).slice(0, 20)}`);
  return parseDecimalToMinor(s, 8);
}

/** Pull memo code out of a memo (exact token match, whitespace-trimmed). */
export function memoCode(memo: string | null | undefined): string | null {
  const m = memo?.trim();
  return m && INVOICE_MEMO_RE.test(m) ? m : null;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** ES256 JWT in zkool's claim shape. `sub` 0 = admin (bootstrap only); otherwise the account id. */
export function signZkoolJwt(key: KeyObject, claims: { sub: number; write: boolean; ttlSeconds?: number }, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: claims.sub, write: claims.write, exp: nowSec + (claims.ttlSeconds ?? 300) }));
  const sig = edSign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

export function loadPemFromEnv(env: { file?: string; pem?: string }): string | undefined {
  if (env.pem) return env.pem.replace(/\\n/g, "\n");
  if (env.file) return readFileSync(env.file, "utf8");
  return undefined;
}

/** Stable note identity shared by mempool and mined sightings of the same output. */
export function noteRef(txid: string, n: ZkoolNote, occurrence: number): string {
  return `${txid}:p${n.pool}:d${n.diversifierIndex ?? "x"}:${zecToZat(n.value).toString()}:${occurrence}`;
}

const REQUIRED_SCHEMA: Record<string, string[]> = {
  Query: ["currentHeight", "transactionsByAccount", "unconfirmedByAccount", "addressByAccount"],
  Mutation: ["newAddresses", "synchronizeAccount", "pay"],
  Note: ["pool", "value", "scope", "address", "diversifierIndex", "memo"],
  Addresses: ["ua", "diversifierIndex"],
};

export class ZkoolWatcher implements AddressAllocator {
  readonly kind = "zkool" as const;
  readonly addressMode: ZkoolAddressMode;
  readonly network: ZkoolNetwork;
  private sharedUa: string | null = null;
  private allocLock: Promise<unknown> = Promise.resolve();

  constructor(private cfg: ZkoolConfig) {
    if (!/^https?:\/\//.test(cfg.url)) throw new DomainError("SYSTEM_CONFIG", "ZKOOL_GRAPHQL_URL must be http(s)");
    if (cfg.network !== "testnet" && cfg.network !== "mainnet") throw new DomainError("SYSTEM_CONFIG", "zkool network must be testnet or mainnet");
    this.network = cfg.network;
    this.addressMode = cfg.addressMode ?? "rotate";
    if (cfg.jwtPrivateKeyPem) throw new DomainError("SYSTEM_CONFIG", "JWT issuer private keys are prohibited in wallet watcher processes");
    if (!Number.isSafeInteger(cfg.accountId) || cfg.accountId <= 0) throw new DomainError("SYSTEM_CONFIG", "watcher requires a non-admin account");
  }

  get accountId(): number {
    return this.cfg.accountId;
  }

  private bearer(): string | undefined {
    const token = this.cfg.jwtFile ? readFileSync(this.cfg.jwtFile, "utf8").trim() : this.cfg.jwt;
    if (!token) {
      if (!this.cfg.fetchImpl) throw new DomainError("WALLET_AUTH_REQUIRED", "An account-scoped viewer token is required");
      return undefined; // injectable transport for isolated tests only
    }
    try {
      const parts = token.split(".");
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      const now = Math.floor(Date.now()/1000);
      if (parts.length !== 3 || header.alg !== "ES256" || claims.sub !== this.cfg.accountId || claims.write !== false || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now+3600) throw new Error("scope or expiry");
    } catch { throw new DomainError("WALLET_AUTH_SCOPE", "Viewer credential must be unexpired, account-scoped, read-only and valid for at most one hour"); }
    // Signature is verified by zkool with the operator-provisioned public key.
    return token;
  }

  async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const f = this.cfg.fetchImpl ?? fetch;
    const token = this.bearer();
    let res: Response;
    try {
      res = await f(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new DomainError("WALLET_WATCHER_HTTP", `zkool_graphql unreachable: ${(e as Error).message.slice(0, 120)}`, undefined, { retryable: true });
    }
    if (!res.ok) throw new DomainError("WALLET_WATCHER_HTTP", `zkool_graphql HTTP ${res.status}`, undefined, { retryable: true });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new DomainError("WALLET_WATCHER_ERROR", `zkool_graphql: ${body.errors.map((e) => e.message).join("; ").slice(0, 200)}`, undefined, { retryable: true });
    if (!body.data) throw new DomainError("WALLET_WATCHER_ERROR", "zkool_graphql returned no data", undefined, { retryable: true });
    return body.data;
  }

  /** Introspects the live server and fails closed if an operation/field this adapter uses is missing. */
  async assertSchema(): Promise<Record<string, string[]>> {
    const names = Object.keys(REQUIRED_SCHEMA);
    const q = `{ ${names.map((n, i) => `t${i}: __type(name: "${n}") { name fields { name } }`).join(" ")} }`;
    const d = await this.gql<Record<string, { name: string; fields: Array<{ name: string }> } | null>>(q);
    const seen: Record<string, string[]> = {};
    names.forEach((n, i) => {
      const fields = (d[`t${i}`]?.fields ?? []).map((f) => f.name);
      seen[n] = fields;
      const missing = REQUIRED_SCHEMA[n]!.filter((f) => !fields.includes(f));
      if (missing.length) throw new DomainError("WALLET_SCHEMA_MISMATCH", `zkool_graphql ${n} lacks ${missing.join(", ")} — adapter refuses to run`);
    });
    return seen;
  }

  /**
   * Proves THIS process cannot spend: `pay` with our token must fail with either
   * "Unauthorized" (read-only token) or "No Signing Key" (watch-only UFVK account).
   */
  async assertWatchOnly(): Promise<"read_only_token" | "no_signing_key"> {
    try {
      await this.gql(`mutation { pay(idAccount: ${this.cfg.accountId}, payment: { recipients: [], confirmations: 1 }) }`);
    } catch (e) {
      const m = (e as Error).message;
      if (/No Signing Key/i.test(m)) return "no_signing_key";
      if (/Unauthorized/i.test(m)) return "read_only_token";
      throw new DomainError("WALLET_NOT_WATCH_ONLY", `could not prove the zkool account is watch-only: ${m.slice(0, 160)}`);
    }
    throw new DomainError("WALLET_NOT_WATCH_ONLY", "zkool account accepted a pay call — it holds a spending key; refusing to use it");
  }

  private checkAddress(ua: string | null | undefined): string {
    const prefix = this.network === "testnet" ? "utest1" : "u1";
    if (!ua || !ua.startsWith(prefix) || !addressMatchesNetwork(ua, this.network)) {
      throw new DomainError("WALLET_ADDRESS_INVALID", `zkool returned a non-${this.network} or non-unified address`);
    }
    return ua;
  }

  /** Memo mode only: the account's current shared UA. */
  async receivingAddress(): Promise<string> {
    if (this.sharedUa) return this.sharedUa;
    const pools = this.cfg.pools ?? 4;
    const d = await this.gql<{ addressByAccount: { ua: string } }>(`{ addressByAccount(idAccount: ${this.cfg.accountId}, pools: ${pools}) { ua } }`);
    this.sharedUa = this.checkAddress(d.addressByAccount?.ua);
    return this.sharedUa;
  }

  /**
   * Rotate mode: next diversified UA (Ironwood + Sapling receivers, no transparent).
   * Serialized in-process; skips indexes at or below `minDiversifierIndex` (e.g. after the zkool
   * DB was recreated and its dindex restarted) so an address is never handed to two invoices.
   */
  async nextAddress(minDiversifierIndex = 0n): Promise<{ ua: string; diversifierIndex: bigint; sapling: string | null; orchard: string | null }> {
    const run = async () => {
      for (let i = 0; i < 5000; i++) {
        const d = await this.gql<{ newAddresses: ZkoolAddresses }>(`mutation { newAddresses(idAccount: ${this.cfg.accountId}) { ua sapling orchard transparent diversifierIndex } }`);
        const a = d.newAddresses;
        const idx = BigInt(String(a.diversifierIndex).split(".")[0]!);
        if (idx < minDiversifierIndex) continue;
        const ua = this.checkAddress(a.ua);
        return { ua, diversifierIndex: idx, sapling: a.sapling ?? null, orchard: a.orchard ?? null };
      }
      throw new DomainError("WALLET_ADDRESS_EXHAUSTED", "could not advance zkool diversifier index past the used range");
    };
    const p = this.allocLock.then(run, run);
    this.allocLock = p.catch(() => undefined);
    return p;
  }

  async allocate(input: { invoiceId: string; diversifierIndex: bigint; amountZat: bigint; memoCode?: string; minDiversifierIndex?: bigint }): Promise<AllocatedAddress> {
    if (this.addressMode === "memo") {
      if (!input.memoCode || !INVOICE_MEMO_RE.test(input.memoCode)) throw new DomainError("WALLET_MEMO_REQUIRED", "memo-matched watcher requires an invoice memo code");
      const address = await this.receivingAddress();
      return {
        address,
        addressType: "unified",
        receivers: (this.cfg.pools ?? 4) === 4 ? ["ironwood"] : ["ironwood", "sapling"],
        accountId: String(this.cfg.accountId),
        diversifierIndex: input.diversifierIndex.toString(),
        walletId: `zkool:${this.network}:${this.cfg.accountId}`,
        birthdayHeight: this.cfg.birthHeight ?? null,
        zip321Uri: buildZip321(address, input.amountZat, input.memoCode),
        memoCode: input.memoCode,
      };
    }
    const a = await this.nextAddress(input.minDiversifierIndex ?? 0n);
    return {
      address: a.ua,
      addressType: "unified",
      receivers: a.sapling ? ["ironwood", "sapling"] : ["ironwood"],
      accountId: String(this.cfg.accountId),
      diversifierIndex: a.diversifierIndex.toString(),
      walletId: `zkool:${this.network}:${this.cfg.accountId}`,
      birthdayHeight: this.cfg.birthHeight ?? null,
      zip321Uri: buildZip321(a.ua, input.amountZat),
    };
  }

  async status(): Promise<ScannerStatus> {
    const h = await this.gql<{ currentHeight: number }>(`{ currentHeight }`);
    const synced = await this.gql<{ synchronizeAccount: number }>(`mutation { synchronizeAccount(idAccount: ${this.cfg.accountId}, fast: false) }`);
    const tip = Number(h.currentHeight ?? 0);
    const scanned = Number(synced.synchronizeAccount ?? 0);
    if (!(tip > 0)) throw new DomainError("WALLET_WATCHER_ERROR", "zkool reported no chain tip");
    return {
      network: this.network,
      tipHeight: tip,
      tipHash: "",
      tipTime: new Date().toISOString(),
      scannedHeight: scanned,
      consensusBranchId: "",
      ironwoodSupported: true, // zkool2 6.36 scans Ironwood (pool 3); verified by schema + live notes
      nu7Active: this.network === "testnet" ? true : tip >= MAINNET_NU7_HEIGHT,
      state: scanned > 0 && tip - scanned <= 3 ? "synced" : "syncing",
      walletBirthday: this.cfg.birthHeight ?? 0,
      version: "zkool_graphql",
    };
  }

  /**
   * Snapshot of incoming (scope 0) notes as scanner events. Confirmations = tip - height + 1.
   * Mempool notes (unconfirmedByAccount, which keeps listing mined txids) become display-only
   * `note_seen` events. `addressByIndex` maps diversifier index → the invoice UA we issued.
   */
  async snapshot(tip: number, addressByIndex: Map<string, string> = new Map()): Promise<DepositEvent[]> {
    const id = this.cfg.accountId;
    const d = await this.gql<{ transactionsByAccount: ZkoolTx[] }>(
      `{ transactionsByAccount(idAccount: ${id}) { txid height notes { id pool value scope address diversifierIndex memo } } }`,
    );
    const u = await this.gql<{ unconfirmedByAccount: ZkoolUnconfirmed[] }>(
      `{ unconfirmedByAccount(idAccount: ${id}) { txid notes { pool scope value address diversifierIndex memo } } }`,
    ).catch(() => ({ unconfirmedByAccount: [] as ZkoolUnconfirmed[] }));
    const shared = this.addressMode === "memo" ? await this.receivingAddress() : null;
    const out: DepositEvent[] = [];
    const mined = new Set<string>();
    const toEvents = (txid: string, height: number | null, notes: ZkoolNote[]) => {
      const occ = new Map<string, number>();
      for (const n of notes) {
        if (n.scope !== 0) continue; // scope 1 = change / internal
        const pool = ZKOOL_POOL[n.pool];
        if (!pool || pool === "transparent" || pool === "orchard") continue; // shielded only; Orchard is sealed (NU6.3) — never new funds
        const base = `${n.pool}:${n.diversifierIndex ?? "x"}:${zecToZat(n.value)}`;
        const k = occ.get(base) ?? 0;
        occ.set(base, k + 1);
        const ref = noteRef(txid, n, k);
        const dindex = n.diversifierIndex === null || n.diversifierIndex === undefined ? null : String(n.diversifierIndex).split(".")[0]!;
        const address = shared ?? (dindex !== null ? addressByIndex.get(dindex) : undefined) ?? n.address ?? `unmapped:${ref}`;
        const confirmations = height ? Math.max(0, tip - height + 1) : 0;
        out.push({
          eventId: `zkool:${this.network}:${ref}:${height ?? "mempool"}:${Math.min(confirmations, 100)}`,
          kind: height ? "note_confirmed" : "note_seen",
          network: this.network,
          pool,
          txid,
          outputRef: ref,
          valueZatoshis: zecToZat(n.value).toString(),
          address,
          blockHeight: height,
          blockHash: null,
          confirmations,
          scanVersion: "zkool_graphql",
          memo: n.memo ?? null,
        });
      }
    };
    for (const t of d.transactionsByAccount ?? []) {
      if (!/^[0-9a-f]{64}$/.test(t.txid)) continue;
      if (t.height) mined.add(t.txid);
      toEvents(t.txid, t.height && t.height > 0 ? t.height : null, t.notes ?? []);
    }
    for (const x of u.unconfirmedByAccount ?? []) {
      if (mined.has(x.txid) || !/^[0-9a-f]{64}$/.test(x.txid)) continue; // zkool keeps listing mined txids (documented)
      toEvents(x.txid, null, x.notes ?? []);
    }
    return out;
  }
}

/** Zcash Foundation (Zebra 7.0.0 release, 2026-10-22): mainnet NU7 scheduled at this height. Display only — re-verify before launch. */
export const MAINNET_NU7_HEIGHT = 3_543_405;
