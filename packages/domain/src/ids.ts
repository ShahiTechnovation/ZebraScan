/** Opaque, unguessable identifiers: <prefix>_<26 base32 chars> (128 bits of CSPRNG entropy). */
import { randomBytes } from "node:crypto";

const B32 = "0123456789abcdefghjkmnpqrstvwxyz"; // no i/l/o/u

export function randomToken(bytes = 16): string {
  const buf = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const ID_PREFIXES = {
  user: "usr",
  session: "ses",
  merchant: "mer",
  member: "mem",
  payoutDestination: "pd",
  link: "lnk",
  quote: "qt",
  rateSnapshot: "rs",
  intent: "pi",
  address: "za",
  deposit: "dep",
  order: "ord",
  withdrawal: "wd",
  credit: "cr",
  journal: "jnl",
  posting: "pst",
  allocation: "alc",
  receipt: "rcp",
  supportCase: "case",
  event: "evt",
  job: "job",
  audit: "aud",
  approval: "apr",
  token: "tok",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomToken(16)}`;
}

/** Short human-friendly slug for public links / merchant counters (~50 bits). */
export function newSlug(len = 10): string {
  return randomToken(8).slice(0, len);
}

const ID_RE = /^[a-z]{2,5}_[0-9a-hjkmnp-tv-z]{20,32}$/;
export function isId(value: string, kind?: IdKind): boolean {
  if (!ID_RE.test(value)) return false;
  return kind ? value.startsWith(`${ID_PREFIXES[kind]}_`) : true;
}
