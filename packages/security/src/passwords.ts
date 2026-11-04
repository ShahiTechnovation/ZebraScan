/**
 * Argon2id password hashing (OWASP 2025 baseline: m=19 MiB, t=2, p=1; we use m=64 MiB, t=3).
 * Parameters are encoded in the PHC string so they can be raised later; `needsRehash` reports
 * hashes made with weaker parameters so login can transparently upgrade them.
 */
import { hash, verify } from "@node-rs/argon2";

// Algorithm.Argon2id === 2 in @node-rs/argon2 (const enum; inlined for isolatedModules).
const ARGON2ID = 2;

export const ARGON2_PARAMS = { algorithm: ARGON2ID, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password.normalize("NFKC"), ARGON2_PARAMS);
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password.normalize("NFKC"));
  } catch {
    return false;
  }
}

export function needsRehash(phc: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (!m) return true;
  return Number(m[1]) < ARGON2_PARAMS.memoryCost || Number(m[2]) < ARGON2_PARAMS.timeCost;
}

/** A fixed dummy hash so login timing does not reveal whether an email exists. */
let dummy: Promise<string> | null = null;
export async function burnVerifyTime(password: string): Promise<void> {
  dummy ??= hashPassword("zeb-scan-timing-equalizer");
  await verifyPassword(await dummy, password);
}

/** Password policy: length-based (NIST 800-63B), reject trivially common choices. */
const COMMON = new Set(["password", "password1", "12345678", "123456789", "qwertyuiop", "iloveyou", "zebscan123", "11111111", "letmein123"]);
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 256) return "Password is too long.";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common.";
  if (email && pw.toLowerCase().includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) {
    return "Password must not contain your email name.";
  }
  if (/^(.)\1+$/.test(pw)) return "Password must not repeat a single character.";
  return null;
}
