/**
 * Stateless signed session tokens (HMAC-SHA256) for web login — no session store, no
 * external JWT dependency. Format: `base64url(claims).base64url(hmac)`.
 *
 * (Programmatic access uses the opaque, stored API tokens in tokens.ts instead.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  /** user id. */
  sub: string;
  /** expiry, epoch seconds. */
  exp: number;
  /**
   * The account's session epoch when this token was signed.
   *
   * Nothing here can check it — this module has no database. It is carried so the caller CAN: the
   * API compares it against the user's current epoch on every request, which is what makes a
   * stateless token revocable at all. Absent means 0, which is where every account starts, so
   * tokens signed before this field existed keep working until somebody actually revokes.
   */
  ep?: number;
  /**
   * When the person last actually signed in, epoch seconds — a password typed or a Discord
   * sign-in, not a renewal. The API's renewal carries it forward unchanged, which is what puts a
   * ceiling on how long renewing alone can keep a sign-in going. Absent on tokens made before it
   * existed; read then as a week before their expiry, which is when they were made.
   */
  auth?: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = b64url(JSON.stringify(claims));
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(token: string, secret: string): SessionClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Build claims for a user with a TTL in seconds (default 7 days).
 *
 * `epoch` is the account's session epoch at sign-in. Callers that omit it mint a token pinned to
 * epoch 0 — correct only for an account that has never been revoked, so the API always passes the
 * value it just read rather than relying on the default.
 */
export function sessionClaims(userId: string, ttlSeconds = 7 * 24 * 3600, epoch = 0): SessionClaims {
  const now = Math.floor(Date.now() / 1000);
  return { sub: userId, exp: now + ttlSeconds, ep: epoch, auth: now };
}
