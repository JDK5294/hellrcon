/**
 * Links back into the panel from outside it — a Discord alert linking a player's profile.
 *
 * The panel's address is the one Discord sign-in already sends staff back to: the origin of its
 * callback (DISCORD_OAUTH_REDIRECT). There is nothing to configure; an install without sign-in
 * has no address to hand out, and nothing links.
 */
import { discordAuthConfig } from "./discord-auth.js";

/** "https://admin.example.com", or "" when sign-in is not set up. */
export function panelBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const u = new URL(discordAuthConfig(env).redirectUri);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch {
    return "";
  }
}

/** A player's profile — the same `#/players/~<id>` the panel's own "Copy profile link" holds. */
export function playerProfileUrl(playerId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = panelBaseUrl(env);
  return playerId && base ? `${base}/#/players/~${encodeURIComponent(playerId)}` : null;
}
