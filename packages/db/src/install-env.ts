/**
 * The install's settings that used to be typed into infra/.env — the Discord app's credentials, the
 * public stats site and the Cloudflare tunnel's token — set in the panel instead, and kept in
 * install_settings.
 *
 * Every process still reads them from its environment, as it always has: at boot, and again on a
 * timer, each copies the stored values over its own process.env (applyInstallEnv). So the code that
 * reads process.env.DISCORD_TOKEN is unchanged, and a value saved in the panel is in force in the
 * API at once and in the worker and the bot within one refresh.
 *
 * An install that set them in infra/.env carries them over (importInstallEnv, the API's boot): a
 * key the panel has never set takes the environment's value, once. From then on the panel's value
 * is the one in force and the .env line no longer matters. Clearing a value in the panel stores it
 * empty rather than removing it, so the old .env line is not carried over again on the next boot.
 */
import type { Repository } from "./types.js";

export interface InstallEnvSetting {
  /** Its install_settings key. */
  key: string;
  /** The environment variable its readers use. */
  env: string;
  /** Sealed at rest, and never sent back to the panel. */
  secret: boolean;
}

export const INSTALL_ENV_SETTINGS: readonly InstallEnvSetting[] = [
  { key: "discord.token", env: "DISCORD_TOKEN", secret: true },
  { key: "discord.appId", env: "DISCORD_APP_ID", secret: false },
  { key: "discord.publicKey", env: "DISCORD_PUBLIC_KEY", secret: false },
  { key: "discord.clientId", env: "DISCORD_CLIENT_ID", secret: false },
  { key: "discord.clientSecret", env: "DISCORD_CLIENT_SECRET", secret: true },
  { key: "discord.guildId", env: "DISCORD_GUILD_ID", secret: false },
  { key: "discord.redirect", env: "DISCORD_OAUTH_REDIRECT", secret: false },
  { key: "stats.host", env: "PUBLIC_STATS_HOST", secret: false },
  { key: "stats.origin", env: "PUBLIC_STATS_ORIGIN", secret: false },
  { key: "stats.name", env: "PUBLIC_STATS_NAME", secret: false },
  { key: "tunnel.token", env: "CLOUDFLARE_TUNNEL_TOKEN", secret: true },
];

export const installEnvSetting = (env: string): InstallEnvSetting | undefined => INSTALL_ENV_SETTINGS.find((s) => s.env === env);

type Settings = Pick<Repository, "installSettings">;

/** Carry over what the environment sets and the panel never has. Returns the variables carried over. */
export async function importInstallEnv(repo: Settings, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const carried: string[] = [];
  for (const s of INSTALL_ENV_SETTINGS) {
    const given = (env[s.env] ?? "").trim();
    if (!given || (await repo.installSettings.get(s.key)) !== null) continue;
    await repo.installSettings.set(s.key, given, { secret: s.secret, by: "infra/.env" });
    carried.push(s.env);
  }
  return carried;
}

/** Copy the stored values over `env`: a stored value wins, an empty one unsets it, an unset key leaves
 *  the environment's own. Returns the variables that changed. */
export async function applyInstallEnv(repo: Settings, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const changed: string[] = [];
  for (const s of INSTALL_ENV_SETTINGS) {
    const stored = await repo.installSettings.get(s.key);
    if (stored === null) continue;
    const want = stored.trim();
    if ((env[s.env] ?? "") === want) continue;
    if (want) env[s.env] = want;
    else delete env[s.env];
    changed.push(s.env);
  }
  return changed;
}
