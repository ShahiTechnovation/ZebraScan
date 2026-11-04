/**
 * ZIP-321 checks (https://zips.z.cash/zip-0321). The Rust gateway builds URIs with the pinned
 * `zip321` crate; this module independently re-validates what the gateway returns before the
 * API serves it, so a gateway bug cannot put a wrong amount or address into a customer QR.
 */
import { DomainError } from "./errors";
import { formatMinor, ZAT_PER_ZEC } from "./money";
import type { ZcashNetwork } from "./environment";

export const MAX_ZATOSHIS = 21_000_000n * ZAT_PER_ZEC;

/** ZIP-321 amount: decimal ZEC, at most 8 fractional digits, no exponent, no trailing dot. */
export function zatToZip321Amount(zat: bigint): string {
  if (zat <= 0n || zat > MAX_ZATOSHIS) throw new DomainError("WALLET_AMOUNT_RANGE", "amount outside valid ZEC range");
  return formatMinor(zat, 8, { trim: true });
}

const BECH32 = "[02-9ac-hj-np-z]";
const B58 = "[1-9A-HJ-NP-Za-km-z]";

/** Prefix sanity per network. Full validation is done in the gateway with `zcash_address`. */
export function addressMatchesNetwork(address: string, network: ZcashNetwork): boolean {
  const patterns: Record<ZcashNetwork, RegExp> = {
    mainnet: new RegExp(`^(u1${BECH32}{20,}|zs1${BECH32}{20,}|t1${B58}{33}|t3${B58}{33})$`),
    testnet: new RegExp(`^(utest1${BECH32}{20,}|ztestsapling1${BECH32}{20,}|tm${B58}{33}|t2${B58}{33})$`),
    regtest: new RegExp(`^(uregtest1${BECH32}{20,}|zregtestsapling1${BECH32}{20,}|tm${B58}{33})$`),
  };
  return patterns[network].test(address);
}

export function receiverKind(address: string): "unified" | "sapling" | "transparent" | "unknown" {
  if (/^u(test|regtest)?1/.test(address)) return "unified";
  if (/^z(s|testsapling|regtestsapling)1/.test(address)) return "sapling";
  if (/^t[123m]/.test(address)) return "transparent";
  return "unknown";
}

/** ZIP-321 memo encoding: base64url of the UTF-8 memo, no padding; memos are ≤512 bytes. */
export function encodeZip321Memo(memo: string): string {
  const bytes = Buffer.from(memo, "utf8");
  if (bytes.length > 512) throw new DomainError("WALLET_MEMO_TOO_LONG", "memo exceeds 512 bytes");
  return bytes.toString("base64url");
}

/** Validate a single-payment ZIP-321 URI exactly matches the expected address, amount and (optional) memo, with no label/message PII. */
export function assertZip321Matches(uri: string, expected: { address: string; zat: bigint; network: ZcashNetwork; memo?: string }): void {
  const m = /^zcash:([^?]+)(\?(.*))?$/.exec(uri);
  if (!m) throw new DomainError("WALLET_URI_INVALID", "payment URI is not a zcash: URI");
  if (m[1] !== expected.address) throw new DomainError("WALLET_URI_MISMATCH", "payment URI address does not match allocated address");
  if (!addressMatchesNetwork(expected.address, expected.network)) {
    throw new DomainError("WALLET_NETWORK_MISMATCH", "address does not belong to the expected network");
  }
  const params = new URLSearchParams(m[3] ?? "");
  const disallowed = [...new Set(params.keys())].filter((k) => k !== "amount" && !(k === "memo" && expected.memo !== undefined));
  if (disallowed.length) throw new DomainError("WALLET_URI_PARAMS", `payment URI carries disallowed params: ${disallowed.join(",")}`);
  if (params.getAll("amount").length !== 1) throw new DomainError("WALLET_URI_AMOUNT", "payment URI must carry exactly one amount");
  if (params.get("amount") !== zatToZip321Amount(expected.zat)) throw new DomainError("WALLET_URI_AMOUNT", "payment URI amount does not match quote");
  if (expected.memo !== undefined && params.get("memo") !== encodeZip321Memo(expected.memo)) throw new DomainError("WALLET_URI_MEMO", "payment URI memo does not match invoice");
}

export function buildZip321(address: string, zat: bigint, memo?: string): string {
  // Shielded recipients only may carry memos (ZIP-321); transparent addresses never get one.
  const m = memo && !/^t/.test(address) ? `&memo=${encodeZip321Memo(memo)}` : "";
  return `zcash:${address}?amount=${zatToZip321Amount(zat)}${m}`;
}

/** Invoice memo code: high-entropy, ASCII, short enough to type. Matching key for memo-matched watchers. */
export const INVOICE_MEMO_RE = /^ZEB-[0-9A-Z]{12,20}$/;
