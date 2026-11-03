/**
 * API tokens for launchers/bots/scripts. We store only a SHA-256 hash of the token;
 * the raw token is shown to the user once at creation and never persisted.
 */
import { randomBytes, createHash } from "node:crypto";

const PREFIX = "hrc_";

export interface GeneratedToken {
  /** the full token to hand to the user once (never stored). */
  token: string;
  /** the value to persist. */
  hash: string;
}

export function generateToken(): GeneratedToken {
  const raw = randomBytes(32).toString("base64url");
  const token = `${PREFIX}${raw}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeToken(value: string): boolean {
  return value.startsWith(PREFIX);
}
