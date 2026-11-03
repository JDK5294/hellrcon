/**
 * The Rules tab's live-roster triggers, aimed at ONE player from Player triggers.
 *
 * A rule watches everyone on a server; a player trigger watches one person. The roster conditions a
 * rule can fire on (a role, a level, a name, a clan tag, VIP, playtime, a Discord link, the kill
 * rate, a ratio of kills, deaths and team kills, the allowed area, the squad checks) are the same
 * detectors here, with the same knobs and the same judgement, so "Bob plays Tank Commander" means
 * exactly what the restricted-role rule means by it.
 *
 * What differs is WHEN. A rule re-fires every re-check interval while a condition lasts, climbing
 * its ladder; a trigger is an instruction about something happening, so it fires when the
 * condition STARTS. "Every time" is every time it starts again, once it has been gone for
 * ROSTER_TRIGGER_CLEAR_MS: they left the role (or the server) and came back later.
 *
 * The worker detects (it reads every roster already) and puts PLAYER_TRIGGER_ROSTER_KIND on the
 * bus carrying the trigger's id; the API's trigger runner fires that one trigger.
 */
import { getStateTrigger, parseTriggerParams, resolveTriggerParams, stateTriggerAppliesTo } from "./state-triggers.js";

/** The bus kind a player trigger's roster detection travels as. Not a log event: the live feed and
 *  the Discord relay show only evt.* kinds, as with the rules' own app.state.* detections. */
export const PLAYER_TRIGGER_ROSTER_KIND = "app.playertrigger.roster";

/** How long a condition must have been gone before an every-time trigger can fire on it again —
 *  a few roster checks, so one odd read (a player between roles on the deploy screen) is not a
 *  second occurrence. */
export const ROSTER_TRIGGER_CLEAR_MS = 120_000;

/** Player-trigger event → the Rules tab's roster trigger that judges it. */
export const PLAYER_ROSTER_EVENT_KIND = {
  role: "app.state.bad_role",
  lowlevel: "app.state.low_level",
  rolelevel: "app.state.role_level",
  badname: "app.state.bad_name",
  outofzone: "app.state.out_of_zone",
  novip: "app.state.no_vip",
  playtime: "app.state.playtime",
  nodiscord: "app.state.no_discord",
  killrate: "app.state.kill_rate",
  ratio: "app.state.ratio",
  clantag: "app.state.clan_tag",
  noleader: "app.state.no_leader",
  solotank: "app.state.solo_tank",
  soloheli: "app.state.solo_heli",
} as const;
export type PlayerRosterEvent = keyof typeof PLAYER_ROSTER_EVENT_KIND;
export const PLAYER_ROSTER_EVENTS = Object.keys(PLAYER_ROSTER_EVENT_KIND) as PlayerRosterEvent[];

export function isPlayerRosterEvent(event: unknown): event is PlayerRosterEvent {
  return typeof event === "string" && Object.hasOwn(PLAYER_ROSTER_EVENT_KIND, event);
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);

/**
 * What a roster trigger's detector reads, from what the trigger stores. "Plays a role" stores only
 * its roles: it is the restricted-role detector with those roles disallowed and no allowlist.
 */
export function rosterDetectParams(event: PlayerRosterEvent, stored: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const kind = PLAYER_ROSTER_EVENT_KIND[event];
  if (event === "role") return resolveTriggerParams(kind, { disallowedRoles: nums(stored?.roles), allowedRoles: [] });
  return resolveTriggerParams(kind, stored);
}

/**
 * A roster trigger's settings, checked at save. The Rules tab's own checks (parseTriggerParams)
 * against the PLAYER's game: its roles, and whether the condition exists there at all (no
 * helicopters in WW2).
 */
export function parseRosterParams(
  event: PlayerRosterEvent,
  raw: unknown,
  game: { id: string | null; roles: Set<number> },
): { params: Record<string, unknown> } | { error: string } {
  const kind = PLAYER_ROSTER_EVENT_KIND[event];
  if (!stateTriggerAppliesTo(kind, game.id)) {
    return { error: `“${getStateTrigger(kind)?.label ?? event}” isn't something this player's game has` };
  }
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (event === "role") {
    const roles = [...new Set(nums(body.roles).map(Math.round))];
    if (!roles.length) return { error: "pick at least one role" };
    const stray = game.roles.size > 0 ? roles.find((r) => !game.roles.has(r)) : undefined;
    if (stray !== undefined) return { error: `role ${stray} is not a role this player's game has — pick from the list` };
    return { params: { roles } };
  }
  const parsed = parseTriggerParams(kind, body, game.roles);
  // The Rules tab's sentences speak of "this rule"; here it is a trigger.
  if ("error" in parsed) return { error: parsed.error.replace(/\bthis rule\b/g, "this trigger") };
  return { params: parsed.params ?? {} };
}
