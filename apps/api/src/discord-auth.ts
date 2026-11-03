/**
 * Discord OAuth2 sign-in — the pure, I/O-free half. The routes in app.ts do the HTTP (redirect,
 * token exchange, member fetch); everything here is deterministic and unit-tested: building the
 * authorize URL, signing/verifying the short-lived CSRF `state`, and resolving which panel roles
 * a member's Discord role set grants from the mapping.
 *
 * Config comes from the environment (see `discordAuthConfig`): the OAuth client id/secret, the guild
 * whose roles we read, and the redirect URL Discord returns the user to.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface DiscordAuthConfig {
  clientId: string;
  clientSecret: string;
  guildId: string;
  redirectUri: string;
}

/** Read the Discord OAuth config from the environment. Empty strings mean "not configured". */
export function discordAuthConfig(env: NodeJS.ProcessEnv = process.env): DiscordAuthConfig {
  return {
    clientId: env.DISCORD_CLIENT_ID ?? "",
    clientSecret: env.DISCORD_CLIENT_SECRET ?? "",
    guildId: env.DISCORD_GUILD_ID ?? "",
    redirectUri: env.DISCORD_OAUTH_REDIRECT ?? "",
  };
}

/** True when every piece needed for the OAuth flow is present. */
export function isDiscordAuthConfigured(cfg: DiscordAuthConfig): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.guildId && cfg.redirectUri);
}

// The scopes we need: identify (who they are) + read their member object in our guild (their roles).
export const DISCORD_OAUTH_SCOPES = "identify guilds.members.read";

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * The cookie that ties an OAuth round-trip to the browser that started it.
 *
 * A signed `state` alone does not do the job `state` exists for. It proves the value came from us
 * and has not expired — but ANYONE can get one by loading /start, so it says nothing about WHICH
 * browser is finishing the flow. The attack that leaves open is the classic one: an attacker
 * begins their own sign-in, holds the resulting `code`+`state` without spending it, and gets a
 * staff member to open that callback URL. The panel consumes `#discord_token` on load with no
 * interaction, so the victim is now silently signed in AS THE ATTACKER — reading what they type,
 * and with every action they take recorded against the attacker's account in the audit trail.
 *
 * The fix is to make the callback require something only the starting browser has. /start sets
 * this cookie to the same nonce it signs into the state; /callback demands the two match.
 *
 * `SameSite=Lax` is required and not a compromise: the callback arrives as a top-level GET
 * navigation from discord.com, which Lax permits and Strict would block. `HttpOnly` keeps it away
 * from scripts, and it is scoped to the OAuth path so it is sent nowhere else.
 */
export const OAUTH_STATE_COOKIE = "hr_oauth_state";
const OAUTH_COOKIE_PATH = "/api/auth/discord";

/**
 * The `Set-Cookie` value for a starting flow, or for clearing one (`nonce: null`).
 *
 * `Secure` follows the redirect URI's scheme rather than being hardcoded: a panel served over
 * plain http on a LAN would silently never receive a Secure cookie, and "sign-in stopped working"
 * is a worse outcome than the flag it was protecting.
 */
export function oauthStateCookie(nonce: string | null, redirectUri: string, ttlSeconds = 600): string {
  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  const base = `${OAUTH_STATE_COOKIE}=${nonce ? encodeURIComponent(nonce) : ""}; Path=${OAUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax${secure}`;
  return nonce ? `${base}; Max-Age=${ttlSeconds}` : `${base}; Max-Age=0`;
}

/** Pull our cookie out of a raw `Cookie:` header. Absent, malformed or empty all read as null. */
export function readStateCookie(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== OAUTH_STATE_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try { return decodeURIComponent(raw) || null; } catch { return null; }
  }
  return null;
}

/** Sign a short-lived state token (nonce + expiry) with the session secret — CSRF protection. */
export function signState(secret: string, nonce: string, ttlSeconds = 600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${nonce}.${exp}`;
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Verify a state token: signature valid AND not expired. Returns the nonce, or null. */
export function verifyState(secret: string, state: string, now = Date.now()): string | null {
  const parts = (state ?? "").split(".");
  if (parts.length !== 3) return null;
  const nonce = parts[0]!, expStr = parts[1]!, sig = parts[2]!;
  const expected = b64url(createHmac("sha256", secret).update(`${nonce}.${expStr}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(expStr) || Number(expStr) * 1000 < now) return null;
  return nonce;
}

// Link-mode state: the SAME signed state mechanism, but the nonce carries which logged-in user
// asked to link their Discord. The callback uses this to attach (or merge) instead of signing in.
const LINK_PREFIX = "link:";

/** Nonce for a "link my Discord to this account" flow: `link:<userId>:<random>`. */
export function linkStateNonce(userId: string, random: string): string {
  return `${LINK_PREFIX}${userId}:${random}`;
}

/** If a verified state nonce is a link request, the user id it belongs to; else null. */
export function parseLinkNonce(nonce: string): string | null {
  if (!nonce.startsWith(LINK_PREFIX)) return null;
  const rest = nonce.slice(LINK_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  return sep > 0 ? rest.slice(0, sep) : null;
}

/** Statuses that mean "Discord is busy or broken", not "Discord answered you". */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Never make somebody stare at a redirect for longer than this between attempts. */
const MAX_RETRY_WAIT_MS = 2_000;

/** Is this status Discord failing rather than Discord answering? Drives the message the user gets. */
export function isDiscordTransient(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * A GET against Discord that retries the failures which are not about the caller.
 *
 * Discord rate-limits per route, and `users/@me/guilds/:id/member` is one of the tighter ones —
 * several staff signing in at once is enough to draw a 429 — on top of Discord's own bad minutes
 * (5xx). Both arrive as a non-2xx response, and the sign-in callback used to read any non-2xx from
 * that endpoint as "you're not a member of this Discord server": the single most misleading answer
 * available, because it sends a staff member to an admin about their membership over something
 * that would have cleared itself in a second.
 *
 * Retries only idempotent GETs (never the auth-code exchange, which is single-use), honours
 * `retry-after` when Discord sends one, and caps the wait so a sign-in cannot hang. The final
 * response is returned either way — reading a genuine 401/403/404 stays the caller's job.
 */
export async function discordGet(
  url: string,
  headers: Record<string, string>,
  opts: { attempts?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A deadline per attempt. This runs while somebody is sitting on the OAuth callback waiting to
  // be let in, and it retries — so without one, three stalled sockets in a row keep the browser
  // parked with nothing to react to. A timeout throws, which the caller already treats as "Discord
  // isn't answering", the same as any other outage.
  const init = (): RequestInit => ({ headers, signal: AbortSignal.timeout(15_000) });
  let res = await doFetch(url, init());
  for (let attempt = 1; attempt < attempts && isDiscordTransient(res.status); attempt++) {
    const after = Number(res.headers.get("retry-after"));
    // Discord sends seconds; fall back to a short backoff when it says nothing.
    const waitMs = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 250 * attempt, MAX_RETRY_WAIT_MS);
    await sleep(waitMs);
    res = await doFetch(url, init());
  }
  return res;
}

/** Build the Discord authorize URL the user is sent to, carrying the signed state. */
export function buildAuthorizeUrl(cfg: DiscordAuthConfig, state: string): string {
  const qs = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES,
    state,
    prompt: "consent",
  });
  return `https://discord.com/api/oauth2/authorize?${qs.toString()}`;
}

/**
 * Resolve the set of panel role ids a member's Discord roles grant, from the mapping. Deduped.
 * A member with no mapped role resolves to an empty array — the caller uses that to refuse sign-in
 * (access gate: only members with a mapped role may sign in).
 */

/** Extract the Discord role id list from a guild member object (defensively). */
export function memberRoleIds(member: unknown): string[] {
  const roles = (member as { roles?: unknown } | null)?.roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
}
