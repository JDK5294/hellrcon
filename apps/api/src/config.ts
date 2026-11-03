import { randomBytes } from "node:crypto";
import { normalizeHost } from "./public-host.js";

/**
 * The values the shipped templates once carried for SESSION_SECRET. Every copy of the project has
 * them, so a login signed with one is a login anybody can sign: they read as "not set", and the
 * install keeps a key of its own instead (session-secret.ts).
 */
export const PLACEHOLDER_SESSION_SECRETS: ReadonlySet<string> = new Set([
  "change-me-to-a-long-random-string",
  "please-change-me-in-infra-.env",
]);

export interface ApiConfig {
  port: number;
  sessionSecret: string;
  /** SESSION_SECRET held a real value of its own. Otherwise sessionSecret starts as a throwaway,
   *  and boot replaces it with the install's stored key (resolveSessionSecret). */
  sessionSecretFromEnv?: boolean;
  webRoot: string | null;
  /**
   * The dedicated hostname for the public stats site (e.g. "stats.example.com"). When set,
   * requests arriving on this hostname get ONLY the public surface — the page, its assets and
   * the public API — and everything else answers 404, so a link shared with players never
   * reveals the admin panel's address. Unset = the site rides the panel host at /stats only.
   */
  publicStatsHost?: string | null;
  /** The origin shown to staff as the shareable base URL (defaults to https://<publicStatsHost>). */
  publicStatsOrigin?: string | null;
  /**
   * What the public stats site calls itself in its own header, e.g. "Example Community".
   *
   * The page is handed to PLAYERS, and the software's name means nothing to them — this is the
   * community's name. Null falls back to the app name, which is impersonal but never wrong.
   */
  publicStatsName?: string | null;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const given = (env.SESSION_SECRET ?? "").trim();
  const sessionSecretFromEnv = given !== "" && !PLACEHOLDER_SESSION_SECRETS.has(given);
  return {
    port: Number(env.API_PORT ?? env.PORT ?? 8080),
    sessionSecret: sessionSecretFromEnv ? given : randomBytes(32).toString("hex"),
    sessionSecretFromEnv,
    webRoot: env.WEB_ROOT ?? null,
    ...publicStatsConfig(env),
  };
}

/**
 * The public stats site's part of the config. Set in the panel (Administration → Online access)
 * and read from the environment like the rest (install-env.ts), so it is read again after a save.
 * A blank shareable address is the default one, not an empty one.
 */
export function publicStatsConfig(env: NodeJS.ProcessEnv = process.env): Pick<ApiConfig, "publicStatsHost" | "publicStatsOrigin" | "publicStatsName"> {
  const publicStatsHost = normalizeHost(env.PUBLIC_STATS_HOST);
  return {
    publicStatsHost,
    publicStatsOrigin: (env.PUBLIC_STATS_ORIGIN ?? "").trim().replace(/\/+$/, "") || (publicStatsHost ? `https://${publicStatsHost}` : null),
    publicStatsName: env.PUBLIC_STATS_NAME?.trim() || null,
  };
}
