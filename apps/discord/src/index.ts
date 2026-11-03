/**
 * @app/discord — the Discord relay bot. Subscribes to the event bus and posts live game
 * activity (kills, admin actions, match state, …) to Discord channels. This is the outbound
 * half of Discord integration; it reads the same `evt.*` stream everything else does.
 *
 * It needs REDIS_URL to receive the always-on worker's events (a separate process), and a bot
 * token, set in the panel (Discord → Setup & status). Until there is one it waits for it, so the
 * container stays up without crash-looping and starts relaying the moment one is saved.
 */
import { createEventBus } from "@app/bus";
import { background, createLogger, installCrashHandlers } from "@app/shared";
import { applyInstallEnv, createRepository, safeTimezone, type DiscordRelayConfigRow, type DiscordAlertsConfig } from "@app/db";
import { loadDiscordConfig } from "./config.js";
import { Relay, type ServerRelay } from "./relay.js";
import type { Category, RelayEvent } from "./format.js";
import { communityAutomationConfig, matchAdminPing, matchWatchlist, matchAutomation, matchServerDark } from "./alerts.js";
import { DiscordRestSink } from "./sink.js";

const log = createLogger("discord");

const RELAY_REFRESH_MS = Number(process.env.DISCORD_RELAY_REFRESH_MS ?? 20_000);
const WATCH_COOLDOWN_MS = Number(process.env.DISCORD_WATCH_COOLDOWN_MS ?? 300_000); // don't re-alert on rapid reconnects

/** A stored per-server config → the relay's routing shape. A disabled server relays nothing; an
 *  enabled one relays exactly the categories it opted into that also have a channel. */
function toServerRelay(row: DiscordRelayConfigRow): ServerRelay {
  if (!row.enabled) return { enabled: new Set<Category>(), channels: {} as Record<Category, string | null> };
  return {
    enabled: new Set(row.categories as Category[]),
    channels: row.channels as Record<Category, string | null>,
    options: row.categoryOptions as ServerRelay["options"],
  };
}

/** The settings saved in the panel (the bot token among them), in this process's environment. */
const readInstallEnv = (repo: Awaited<ReturnType<typeof createRepository>>): Promise<string[]> =>
  applyInstallEnv(repo).catch((err: unknown): string[] => { log.warn("could not read the install's settings", { err: (err as Error).message }); return []; });

async function main(): Promise<void> {
  // Per-server routing comes from the DB (panel-configured); the env config stays as the default for
  // servers with no row yet. Without DATABASE_URL the repo is in-memory (empty) → everything uses the
  // env default, exactly as before this feature.
  const repo = await createRepository();
  await readInstallEnv(repo);
  if (!process.env.DISCORD_TOKEN) {
    log.warn("no Discord bot token yet — set one under Discord → Setup & status; the bot starts once it is saved");
    while (!process.env.DISCORD_TOKEN) {
      await new Promise((r) => setTimeout(r, RELAY_REFRESH_MS));
      await readInstallEnv(repo);
    }
    log.info("Discord bot token set — starting");
  }
  const config = loadDiscordConfig();
  // A channel can come from env OR per-server DB config now, so we no longer idle on a missing env
  // channel — the relay simply no-ops for events with no route. Just note it.
  if (!config.hasTarget) log.warn("no env channel configured — relying on per-server config from the panel");
  if (!process.env.REDIS_URL) log.warn("REDIS_URL not set — the bot will not receive the worker's events");
  let perServer = new Map<string, ServerRelay>();
  const alertConfigs = new Map<string, DiscordAlertsConfig>();
  const serverNames = new Map<string, string>();
  // The community clock every relayed line is stamped in. Loaded on the same timer as the rest of
  // the config, so a timezone change in the panel reaches the feed within one refresh — before
  // this the relay wrote UTC forever and a community in New York read every kill five hours off.
  let communityTz = "UTC";
  const refresh = async () => {
    // A token changed in the panel is picked up here; the sink reads it at each post.
    if ((await readInstallEnv(repo)).includes("DISCORD_TOKEN")) log.info(process.env.DISCORD_TOKEN ? "the bot token changed in the panel — posting with the new one" : "the bot token was removed in the panel — posting nothing");
    try {
      const cfgs = await repo.discordRelay.listConfigs();
      perServer = new Map(cfgs.map((r) => [r.serverId, toServerRelay(r)]));
      alertConfigs.clear();
      for (const r of cfgs) alertConfigs.set(r.serverId, r.alerts);
      serverNames.clear();
      for (const s of await repo.servers.list()) serverNames.set(s.id, s.name);
      communityTz = safeTimezone((await repo.appConfig.get()).timezone);
    } catch (err) { log.warn("could not refresh Discord relay configs", { err: (err as Error).message }); }
  };
  await refresh();
  const refreshTimer = setInterval(() => void refresh(), RELAY_REFRESH_MS);

  // Role re-sync deliberately does NOT run here. The WORKER owns it (discord-role-sync.ts, every
  // five minutes, one member-list read for the whole staff). This process used to run its own
  // copy as well — the older shape, one Discord request per linked user — and for as long as this
  // container had no database it was a silent no-op, so nothing noticed the duplication. The
  // moment this service got the real DATABASE_URL (see infra/docker-compose.yml), keeping it
  // would have meant two processes re-deciding the same role assignments on interleaved timers,
  // with the slower, per-person one spending the token's rate limit the shared roster exists to
  // conserve. One owner; this bot relays and alerts.

  const sink = new DiscordRestSink(() => process.env.DISCORD_TOKEN ?? "", log);
  const relay = new Relay(sink, { ...config.relay, resolve: (serverId) => (serverId ? perServer.get(serverId) ?? null : null), timezone: () => communityTz }, log);
  relay.start();

  // Immediate ping alerts (admin requests, watchlist joins) — sent individually, not batched.
  //
  // The cooldown map is keyed by server+player and only ever grew: one entry for every watched
  // player who has ever connected, kept for the life of the process. Since an entry older than the
  // cooldown can never suppress anything, they are swept on write.
  const watchCooldown = new Map<string, number>();
  const sweepWatchCooldown = (now: number) => {
    for (const [k, at] of watchCooldown) if (at + WATCH_COOLDOWN_MS < now) watchCooldown.delete(k);
  };
  const handleAlerts = async (evt: RelayEvent) => {
    if (!evt.serverId) {
      // A community-wide scheduled rule's report: no server of its own (see communityAutomationConfig).
      if (evt.kind !== "app.enforcement" || !(evt.data as { communityWide?: unknown } | undefined)?.communityWide) return;
      const auto = matchAutomation(evt, communityAutomationConfig(alertConfigs.values()));
      if (auto) { try { await sink.sendAlert(auto.channelId, auto.text, auto.mentionRoleId); } catch (err) { log.warn("automation alert failed", { err: (err as Error).message }); } }
      return;
    }
    const alerts = alertConfigs.get(evt.serverId);
    if (!alerts) return;
    const name = serverNames.get(evt.serverId);
    const ping = matchAdminPing(evt, alerts, name);
    if (ping) { try { await sink.sendAlert(ping.channelId, ping.text, ping.mentionRoleId); } catch (err) { log.warn("admin-ping alert failed", { err: (err as Error).message }); } }
    // Auto-mod firings (the API's enforcer publishes these): report what automation just did.
    const auto = matchAutomation(evt, alerts, name);
    if (auto) { try { await sink.sendAlert(auto.channelId, auto.text, auto.mentionRoleId); } catch (err) { log.warn("automation alert failed", { err: (err as Error).message }); } }
    // The worker's dark/recovered verdicts — one post each way, latched worker-side.
    const dark = matchServerDark(evt, alerts, name);
    if (dark) { try { await sink.sendAlert(dark.channelId, dark.text, dark.mentionRoleId); } catch (err) { log.warn("server-dark alert failed", { err: (err as Error).message }); } }
    if (evt.kind === "evt.player.connected" && alerts.watchlist?.enabled && alerts.watchlist.channelId && evt.actorPlayerId) {
      const key = `${evt.serverId}|${evt.actorPlayerId}`;
      const now = Date.now();
      if ((watchCooldown.get(key) ?? 0) + WATCH_COOLDOWN_MS < now) {
        let watch: { watched: boolean; reason?: string | null; by?: string | null } = { watched: false };
        try {
          const f = await repo.playerFlags.get(evt.actorPlayerId);
          watch = { watched: f?.watchlist ?? false, reason: f?.watchReason, by: f?.watchBy };
        } catch { /* best-effort */ }
        const wl = matchWatchlist(evt, alerts, watch, name);
        if (wl) { sweepWatchCooldown(now); watchCooldown.set(key, now); try { await sink.sendAlert(wl.channelId, wl.text, wl.mentionRoleId); } catch (err) { log.warn("watchlist alert failed", { err: (err as Error).message }); } }
      }
    }
  };

  const bus = createEventBus({ component: "discord-bus" });
  // `relay.handle` is synchronous, so the bus's own guard covers it. `handleAlerts` is not: the
  // promise it returns is invisible to that guard, and its matchers run before the first await —
  // so one alert config missing a field would reject, exit the bot, and exit it again on the next
  // event after the restart.
  bus.on("*", (evt) => { const e = evt as RelayEvent; relay.handle(e); background(log, "discord alerts", () => handleAlerts(e)); });

  log.info("discord relay running", {
    defaultCategories: [...config.relay.enabled],
    flushMs: config.relay.flushMs,
    perServerConfigs: perServer.size,
  });

  const shutdown = () => {
    log.info("shutting down");
    void (async () => {
      clearInterval(refreshTimer);
      await relay.stop();
      await bus.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The relay batches events and flushes on a timer. A crash between batches silently drops
  // whatever is buffered, so stop the relay (which flushes) before the process goes away.
  installCrashHandlers(log, {
    beforeExit: async () => {
      clearInterval(refreshTimer);
      await relay.stop().catch(() => {});
      await bus.close().catch(() => {});
    },
  });
}

main().catch((err) => {
  log.error("fatal", { err });
  process.exit(1);
});
