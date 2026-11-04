/** Stable keyset cursors: base64url("<iso timestamp>|<id>"). */
import { DomainError } from "@zeb/domain";

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${new Date(at).toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const raw = Buffer.from(c, "base64url").toString("utf8");
  const [at, id] = raw.split("|");
  if (!at || !id || Number.isNaN(Date.parse(at)) || id.length > 64) throw new DomainError("VALIDATION_CURSOR", "Invalid cursor");
  return { at, id };
}
