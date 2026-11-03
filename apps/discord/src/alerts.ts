/**
 * Ping alerts — immediate, individually-sent Discord messages (with an optional role mention) that
 * fire on specific events, separate from the batched category relay:
 *   - admin request: a player types the trigger (default "!admin") in chat
 *   - watchlist join: a watchlisted player connects
 * The matchers here are PURE (no network, no DB): they take an event + the server's alert config (and,
 * for the watchlist, whether the player is watched) and return what to post, or null. The index wires
 * the async watch lookup + the send.
 *
 * Every one of them reads its own section defensively. The config is a jsonb column: a row written
 * before a section existed, or edited by hand, is missing it, and `alerts.adminPing.enabled` on
 * such a row is a TypeError on EVERY event the server produces — which is not a degraded alert,
 * it is the bot down. "That alert is off" is the only sane reading of a section that isn't there.
 */
import type { DiscordAlertsConfig } from "@app/db";
import { discordLiteral } from "@app/shared";
import type { RelayEvent } from "./format.js";

export interface Alert {
  channelId: string;
  mentionRoleId: string | null;
  /** message body WITHOUT the mention prefix (the sink adds it from mentionRoleId). */
  text: string;
}

const clean = (s: unknown) => String(s ?? "").trim();

/** Admin-request alert from a chat event whose message starts with the trigger. Null if the alert is
 *  off, has no channel, the event isn't chat, or the trigger doesn't match. */
export function matchAdminPing(evt: RelayEvent, alerts: DiscordAlertsConfig, serverName?: string): Alert | null {
  const rule = alerts?.adminPing;
  if (!rule?.enabled || !rule.channelId) return null;
  if (evt.kind !== "evt.chat.team" && evt.kind !== "evt.chat.squad") return null;
  const message = clean((evt.data ?? {}).message);
  const trigger = (rule.trigger || "!admin").toLowerCase();
  if (!message.toLowerCase().startsWith(trigger)) return null;
  // The player's name and words, as written: either could otherwise dress up a link.
  const player = discordLiteral(clean(evt.actorName)) || "a player";
  const where = serverName ? ` on **${serverName}**` : "";
  const rest = message.slice(trigger.length).trim();
  return { channelId: rule.channelId, mentionRoleId: rule.mentionRoleId, text: `🔔 **Admin request**${where} — **${player}**: ${discordLiteral(rest || message)}` };
}

/**
 * Rule report: a player rule from Auto settings → RULES fired (the API's enforcer publishes
 * `app.enforcement` on the bus). Reports the rule name, action, player, and reason — dry-runs and
 * failures are labeled so staff can tell "did it" from "would have" from "tried and couldn't".
 *
 * This covers the Rules tab ONLY. Server-settings profiles and the seeding automation do not
 * publish here and never have, which the wording used to obscure by calling itself "Auto settings"
 * — the name of the whole hub, three tabs wide.
 *
 * Two switches have to agree: the server's alert (channel + on) and the individual rule's own
 * `alertEnabled`. An absent flag counts as ON — an event from before the field existed, or from
 * any other publisher, should not go silently unreported.
 *
 * A rule can also carry its OWN channel (`alertChannelId`), and that one stands alone: an explicit
 * "ping HERE" written on the rule must not go quiet because the server-wide default alert is off.
 * Without one, the shared alert is both the switch and the destination, exactly as before.
 *
 * A firing on one player links that player's profile (`profileUrl`, built by the enforcer). A
 * report about many players — a group schedule, the safety breaker — carries none.
 */
export function matchAutomation(evt: RelayEvent, alerts: DiscordAlertsConfig, serverName?: string): Alert | null {
  if (evt.kind !== "app.enforcement") return null;
  const rule = alerts?.automation;
  const d = (evt.data ?? {}) as { ruleName?: string; action?: string; reason?: string | null; hours?: number | null; dryRun?: boolean; error?: string | null; alertEnabled?: boolean; alertChannelId?: string | null; profileUrl?: string | null };
  if (d.alertEnabled === false) return null;
  const own = clean(d.alertChannelId);
  const channelId = own || (rule?.enabled && rule.channelId ? rule.channelId : "");
  if (!channelId) return null;
  const player = discordLiteral(clean(evt.actorName)) || "a player";
  const where = serverName ? ` on **${serverName}**` : "";
  // "blacklist" is the stored name from the era when the action filed a record; today it places
  // a REAL ban — temp with the rule's hours, permanent without — and the alert says which
  // instead of leaking the legacy key to a channel full of staff.
  const action = d.action === "blacklist" ? (d.hours ? "ban" : "permanent ban") : clean(d.action) || "acted on";
  const hours = (d.action === "tempban" || d.action === "blacklist") && d.hours ? ` ${d.hours}h` : "";
  const status = d.error ? " — ⚠️ FAILED" : d.dryRun ? " — dry-run (observe mode)" : "";
  return {
    channelId,
    mentionRoleId: rule?.mentionRoleId ?? null,
    text: `🤖 **Rule fired**${where} — **${action}${hours}** → **${player}**${profileLink(d.profileUrl)} · rule “${discordLiteral(clean(d.ruleName)) || "?"}”${d.reason ? ` (${discordLiteral(clean(d.reason))})` : ""}${status}`,
  };
}

/**
 * " ([profile](<url>))", or "" without an http(s) link. The words are fixed rather than the
 * player's name, so no name can break the link's markdown, and the angle brackets keep Discord
 * from unfurling a preview of the sign-in page under every alert.
 */
function profileLink(url: unknown): string {
  const u = clean(url);
  return /^https?:\/\/[^\s<>()]+$/i.test(u) ? ` ([profile](<${u}>))` : "";
}

/**
 * Where a COMMUNITY-WIDE rule report goes. A scheduled rule set to all servers belongs to no one
 * server, so it carries no server id, and the alert configs are per server: the rule's own channel
 * still stands alone (matchAutomation), and without one the report goes to the first server whose
 * automation alert is switched on with a channel — most communities have exactly one. Null when no
 * server reports automation; matchAutomation then posts only to a rule's own channel.
 */
export function communityAutomationConfig(configs: Iterable<DiscordAlertsConfig>): DiscordAlertsConfig {
  for (const c of configs) if (c?.automation?.enabled && c.automation.channelId) return c;
  return {} as DiscordAlertsConfig;
}

/** Watchlist-join alert when a watched player connects. The watch status (and, when known, the
 *  reason/author — the ping is useless without WHY they're watched) is resolved by the caller.
 *  Null if the alert is off, has no channel, the event isn't a connect, or the player isn't watched. */
export function matchWatchlist(
  evt: RelayEvent,
  alerts: DiscordAlertsConfig,
  watch: boolean | { watched: boolean; reason?: string | null; by?: string | null },
  serverName?: string,
): Alert | null {
  const rule = alerts?.watchlist;
  if (!rule?.enabled || !rule.channelId) return null;
  if (evt.kind !== "evt.player.connected") return null;
  const w = typeof watch === "boolean" ? { watched: watch } : watch;
  if (!w.watched) return null;
  const player = discordLiteral(clean(evt.actorName)) || "A watched player";
  const where = serverName ? ` on **${serverName}**` : "";
  // Staff words, quoted as they wrote them.
  const why = clean(w.reason) ? ` · “${discordLiteral(clean(w.reason))}”` : "";
  const who = clean(w.by) ? ` (watched by ${discordLiteral(clean(w.by))})` : "";
  return { channelId: rule.channelId, mentionRoleId: rule.mentionRoleId, text: `👁 **Watchlisted player joined**${where} — **${player}**${why}${who}` };
}

/**
 * Server dark / server back — the worker's own verdict, not a game event. The worker polls every
 * server continuously and publishes `app.server.dark` when RCON has gone unanswered past its
 * threshold, and `app.server.recovered` on the first answer after an alert. One post each way:
 * the latch lives worker-side, so this matcher is a pure translation.
 */
export function matchServerDark(evt: RelayEvent, alerts: DiscordAlertsConfig, serverName?: string): Alert | null {
  const rule = alerts?.serverDark;
  if (!rule?.enabled || !rule.channelId) return null;
  if (evt.kind !== "app.server.dark" && evt.kind !== "app.server.recovered") return null;
  const minutes = Math.max(1, Math.round(Number(((evt.data ?? {}) as { minutes?: unknown }).minutes) || 1));
  const name = serverName ? `**${serverName}**` : "a server";
  return {
    channelId: rule.channelId,
    mentionRoleId: rule.mentionRoleId,
    text: evt.kind === "app.server.dark"
      ? `🔌 **Server unreachable** — ${name} has not answered RCON for ${minutes} minute(s). Kicks, bans, votes and automation are blind until it returns.`
      : `✅ **Server back** — ${name} is answering again (down ~${minutes} minute(s)).`,
  };
}
