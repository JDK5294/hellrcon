/**
 * At-rest sealing for stored secrets (RCON passwords, CRCON API keys). AES-256-GCM with a key
 * derived from the ENCRYPTION_KEY env string; the stored form is self-describing
 * (`enc:v1:<iv>:<tag>:<ciphertext>` base64) so plaintext legacy values pass through `openSecret`
 * untouched and get upgraded opportunistically. GCM authenticates, so tampering fails loudly.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

const keyOf = (secret: string): Buffer => createHash("sha256").update(secret).digest();

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function sealSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}

/** Decrypt a sealed value; legacy plaintext passes through unchanged. A sealed value without
 *  the key is a hard error — the operator must restore ENCRYPTION_KEY, not silently lose
 *  server credentials. */
export function openSecret(stored: string, secret: string | undefined | null): string {
  if (!isSealed(stored)) return stored;
  if (!secret) throw new Error("stored secret is encrypted but ENCRYPTION_KEY is not set — restore it in infra/.env");
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed sealed secret");
  const [iv, tag, ct] = parts.map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString("utf8");
}
