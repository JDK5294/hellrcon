/**
 * Parse the Discord bot configuration from the environment into a {@link RelayConfig} plus the
 * bot token. Pure and env-injectable so it can be unit-tested.
 *
 * Channel routing: each category posts to its own channel if set, else the default channel,
 * else it isn't posted. Categories default to a sensible, low-noise set (kills, admin, match) —
 * chat and connections are opt-in via DISCORD_RELAY_CATEGORIES for privacy/noise reasons.
 */
import { ALL_CATEGORIES, type Category } from "./format.js";
import type { RelayConfig } from "./relay.js";

export interface DiscordConfig {
  token: string | null;
  relay: RelayConfig;
  /** true if at least one enabled category has a channel to post to. */
  hasTarget: boolean;
}

const PER_CATEGORY_ENV: Record<Category, string> = {
  kills: "DISCORD_KILLS_CHANNEL_ID",
  chat: "DISCORD_CHAT_CHANNEL_ID",
  admin: "DISCORD_ADMIN_CHANNEL_ID",
  connections: "DISCORD_CONNECTIONS_CHANNEL_ID",
  match: "DISCORD_MATCH_CHANNEL_ID",
};

const DEFAULT_CATEGORIES: Category[] = ["kills", "admin", "match"];

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

export function loadDiscordConfig(env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  const defaultChannel = clean(env.DISCORD_CHANNEL_ID);

  const channels = {} as Record<Category, string | null>;
  for (const cat of ALL_CATEGORIES) channels[cat] = clean(env[PER_CATEGORY_ENV[cat]]) ?? defaultChannel;

  const requested = clean(env.DISCORD_RELAY_CATEGORIES);
  const enabledList = requested
    ? requested
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is Category => (ALL_CATEGORIES as readonly string[]).includes(s))
    : DEFAULT_CATEGORIES;
  const enabled = new Set<Category>(enabledList);

  const flushMs = Number(env.DISCORD_FLUSH_MS ?? 2000);
  const hasTarget = [...enabled].some((cat) => channels[cat]);

  return {
    token: clean(env.DISCORD_TOKEN),
    relay: { channels, enabled, flushMs: Number.isFinite(flushMs) && flushMs > 0 ? flushMs : 2000 },
    hasTarget,
  };
}
