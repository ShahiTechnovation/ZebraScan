/**
 * Envelope encryption for sensitive fields (payout VPAs, relay identities, refund addresses).
 *
 * Each value gets a fresh 256-bit data key (DEK); the value is sealed with AES-256-GCM and the
 * DEK is wrapped by a key-encryption key (KEK) from a KeyProvider. The serialized envelope
 * records the KEK id so KEKs can rotate without re-encrypting everything at once.
 *
 * Associated data (AAD) binds a ciphertext to its row/column ("payout_destinations:pd_x:vpa"),
 * so a ciphertext copied into another row fails to decrypt.
 *
 * KeyProvider implementations:
 *  - LocalKeyProvider: KEKs from env (base64, 32 bytes). Acceptable for demo/testnet ONLY.
 *  - A cloud KMS provider (AWS KMS / GCP KMS / Vault Transit) must implement wrap/unwrap for
 *    mainnet; see docs/SECURITY.md. verify-prod-config refuses LocalKeyProvider on mainnet.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyProvider {
  readonly kind: "local" | "kms";
  activeKeyId(): string;
  wrap(keyId: string, dek: Buffer, aad: string): Promise<Buffer>;
  unwrap(keyId: string, wrapped: Buffer, aad: string): Promise<Buffer>;
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ct = sealed.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export class LocalKeyProvider implements KeyProvider {
  readonly kind = "local" as const;
  private keys = new Map<string, Buffer>();
  constructor(
    keys: Record<string, string>,
    private active: string,
  ) {
    for (const [id, b64] of Object.entries(keys)) {
      const k = Buffer.from(b64, "base64");
      if (k.length !== 32) throw new Error(`KEK ${id} must be 32 bytes base64`);
      this.keys.set(id, k);
    }
    if (!this.keys.has(active)) throw new Error(`active KEK ${active} not configured`);
  }
  /** Parse "id1:base64,id2:base64" */
  static fromEnv(spec: string | undefined, active: string | undefined): LocalKeyProvider {
    if (!spec || !active) throw new Error("ZEB_LOCAL_KEKS and ZEB_ACTIVE_KEK are required for LocalKeyProvider");
    const keys: Record<string, string> = {};
    for (const part of spec.split(",")) {
      const [id, b64] = part.split(":");
      if (!id || !b64) throw new Error("ZEB_LOCAL_KEKS must be id:base64[,id:base64]");
      keys[id.trim()] = b64.trim();
    }
    return new LocalKeyProvider(keys, active);
  }
  activeKeyId() {
    return this.active;
  }
  private key(id: string) {
    const k = this.keys.get(id);
    if (!k) throw new Error(`unknown KEK ${id}`);
    return k;
  }
  async wrap(keyId: string, dek: Buffer, aad: string) {
    return gcmSeal(this.key(keyId), dek, `kek:${aad}`);
  }
  async unwrap(keyId: string, wrapped: Buffer, aad: string) {
    return gcmOpen(this.key(keyId), wrapped, `kek:${aad}`);
  }
}

const VERSION = "zenv1";

export class Envelope {
  constructor(private kp: KeyProvider) {}

  async seal(plaintext: string, aad: string): Promise<string> {
    const dek = randomBytes(32);
    const keyId = this.kp.activeKeyId();
    const wrapped = await this.kp.wrap(keyId, dek, aad);
    const sealed = gcmSeal(dek, Buffer.from(plaintext, "utf8"), aad);
    dek.fill(0);
    return [VERSION, keyId, wrapped.toString("base64url"), sealed.toString("base64url")].join(".");
  }

  async open(envelope: string, aad: string): Promise<string> {
    const [v, keyId, wrappedB64, sealedB64] = envelope.split(".");
    if (v !== VERSION || !keyId || !wrappedB64 || !sealedB64) throw new Error("malformed envelope");
    const dek = await this.kp.unwrap(keyId, Buffer.from(wrappedB64, "base64url"), aad);
    try {
      return gcmOpen(dek, Buffer.from(sealedB64, "base64url"), aad).toString("utf8");
    } finally {
      dek.fill(0);
    }
  }

  keyIdOf(envelope: string): string | null {
    return envelope.split(".")[1] ?? null;
  }

  /** Re-wrap under the active KEK (rotation job). */
  async rotate(envelope: string, aad: string): Promise<string> {
    if (this.keyIdOf(envelope) === this.kp.activeKeyId()) return envelope;
    return this.seal(await this.open(envelope, aad), aad);
  }
}
