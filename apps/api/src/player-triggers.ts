/**
 * Per-player triggers: "when THIS player <event>, <action>", once or every time.
 *
 * The sibling of the server-wide Rules engine (enforcer.ts), and deliberately not part of it. A
 * Rule watches a SERVER for anyone doing something; a trigger watches ONE named player and
 * follows them — across every server, or waits on one. The headline case is the simplest: "send
 * this player a message the next time they connect, once, then forget it". The rest of the action
 * surface (kick, punish, tempban, permaban, VIP hours, economy points) rides the same spine.
 *
 * This module is the PURE half: which bus event maps to which trigger event, whether a trigger
 * matches, and — because a one-shot must arm exactly one firing — the disarm decision. The
 * runtime half (the bus subscription, the executor, the audit) lives in player-trigger-runner.ts,
 * so everything decided here is testable without a server, a clock or a database.
 */
import type { EnforceEvent } from "./enforcer.js";
import type { PlayerTriggerRow, PlayerTriggerStep, PlayerTriggerEvent, PlayerTriggerAction } from "@app/db";
import { getGame, isSideSwap } from "@app/games";
import { PLAYER_ROSTER_EVENTS, PLAYER_TRIGGER_ROSTER_KIND, isPlayerRosterEvent, parseRosterParams, ratioPair, restrictedWeaponReason } from "@app/rules";

// "punished" is deliberately NOT buildable: the game's log has no PUNISH line (KICK and BAN are
// the only moderation lines it prints), and evt.player.punished rows exist only from CRCON
// archive imports — a "gets punished" trigger would sit armed and never fire, which is worse
// than not offering it. The subjects map below still understands the kind for imported data.
export const TRIGGER_EVENTS: PlayerTriggerEvent[] = [
  "connect", "disconnect", "kill", "teamkill", "chat",
  "death", "teamkilled", "kicked", "banned",
  // The Rules tab's player events, judged the way its rules judge them (see eventConditionHolds).
  "teamswitch", "weaponkill", "camenter", "camexit", "votestart", "votecast", "afk",
  // …and its live-roster conditions, detected by the worker for one player (@app/rules'
  // player-roster): fired when the condition starts, not for as long as it lasts.
  ...PLAYER_ROSTER_EVENTS,
];
export const TRIGGER_ACTIONS: PlayerTriggerAction[] = [
  "message", "kick", "punish", "tempban", "permaban",
  "vip", "vipremove", "points", "takepoints", "switch", "watch",
];

/** The capability (id + level) a staff member must hold to CREATE a trigger with this action.
 *  Gating at creation is the whole safety model: a trigger can never do by automation what its
 *  author could not do by hand. Read straight from the same catalogue the moderation buttons use. */
export const ACTION_CAPABILITY: Record<PlayerTriggerAction, { cap: string; level: "write" }> = {
  message: { cap: "action.message", level: "write" },
  kick: { cap: "action.kick", level: "write" },
  punish: { cap: "action.punish", level: "write" },
  tempban: { cap: "action.tempban", level: "write" },
  permaban: { cap: "action.permaban", level: "write" },
  vip: { cap: "vip.grant", level: "write" },
  vipremove: { cap: "vip.revoke", level: "write" },
  points: { cap: "economy.balances", level: "write" },
  takepoints: { cap: "economy.balances", level: "write" },
  switch: { cap: "action.switch", level: "write" },
  watch: { cap: "player.watchlist", level: "write" },
};

/** The event the trigger runner's own AFK clock raises for ONE "afk" trigger — never put on the
 *  bus; the runner hands it to itself (see PlayerTriggerRunner.runAfkSweep). */
export const PLAYER_TRIGGER_AFK_KIND = "app.playertrigger.afk";

/** How long an AFK trigger waits for a kill when it doesn't say: the Rules tab's AFK default. */
export const AFK_DEFAULT_MINUTES = 10;

/** One subject a bus event names: which trigger event it satisfies and for WHOM. Most events name
 *  the subject by record id; the game's own KICK/BAN/PUNISH log lines carry only a name, so those
 *  come through as a name for the matcher to fall back on. */
export interface TriggerSubject {
  event: PlayerTriggerEvent;
  playerId: string | null;
  playerName: string | null;
}

/**
 * Every (trigger event, subject) pair a bus event stands for. A kill names TWO people — the
 * actor's "kill" and the victim's "death" are both real trigger events, read from either end —
 * which is why this returns a list rather than one mapping.
 */
export function triggerSubjectsOf(e: EnforceEvent): TriggerSubject[] {
  const actor = (event: PlayerTriggerEvent): TriggerSubject => ({ event, playerId: e.actorPlayerId ?? null, playerName: e.actorName ?? null });
  const victim = (event: PlayerTriggerEvent): TriggerSubject => ({ event, playerId: e.victimPlayerId ?? null, playerName: e.victimName ?? null });
  switch (e.kind) {
    case "evt.player.connected": return [actor("connect")];
    case "evt.player.disconnected": return [actor("disconnect")];
    // A kill with a weapon a trigger names is the killer's too — team kills included, as the
    // Rules tab's restricted-weapon trigger counts them.
    case "evt.kill": return [actor("kill"), victim("death"), actor("weaponkill")];
    case "evt.teamkill": return [actor("teamkill"), victim("teamkilled"), actor("weaponkill")];
    case "evt.player.teamSwitched": return [actor("teamswitch")];
    case "evt.admin.camera": {
      // One event for both halves of a visit, told apart by its `entered` flag. A line whose
      // direction could not be read carries null and is neither — a gap, not a firing.
      const entered = ((e.data ?? {}) as { entered?: boolean | null }).entered;
      return entered === true ? [actor("camenter")] : entered === false ? [actor("camexit")] : [];
    }
    case "evt.chat.team":
    case "evt.chat.squad": return [actor("chat")];
    // VOTESYS lines name the player only by name: they match by the trigger's stored name.
    case "evt.vote.started": return [actor("votestart")];
    case "evt.vote.cast": return [actor("votecast")];
    case PLAYER_TRIGGER_AFK_KIND: return [actor("afk")];
    // A roster condition the worker saw on ONE trigger's player; it says which condition, and
    // which trigger it was judged for (see eventConditionHolds).
    case PLAYER_TRIGGER_ROSTER_KIND: {
      const event = ((e.data ?? {}) as { event?: unknown }).event;
      return isPlayerRosterEvent(event) ? [actor(event)] : [];
    }
    case "evt.player.kicked": return [actor("kicked")];
    case "evt.player.banned": return [actor("banned")];
    case "evt.player.punished": return [actor("punished")];
    default: return [];
  }
}

/** Does this subject mean this trigger's player? The record id is authoritative when the event
 *  carries one; the stored name is the fallback for the name-only moderation lines — and ONLY
 *  then, so a rename can never hijack an id-keyed trigger. */
export function subjectIsTriggerPlayer(t: Pick<PlayerTriggerRow, "playerId" | "playerName">, s: TriggerSubject): boolean {
  if (s.playerId) return s.playerId === t.playerId;
  if (s.playerName && t.playerName) return s.playerName.toLowerCase() === t.playerName.toLowerCase();
  return false;
}

/**
 * Does this trigger fire on this event? Pure predicate — no side effects, no clock.
 *
 * A trigger matches when (a) one of the event's subjects is this trigger's event about this
 * trigger's player, and (b) the trigger's server scope allows it (null = any server; otherwise
 * the exact server the event came from). A disarmed one-shot never matches — its `enabled` is
 * still true but `disarmedAt` is set, so the armed set the runner keeps in memory has already
 * dropped it; this guard makes the predicate correct even handed a stale row.
 */
export function triggerMatches(t: PlayerTriggerRow, e: EnforceEvent): boolean {
  if (!t.enabled || t.disarmedAt !== null) return false;
  if (t.serverId !== null && t.serverId !== e.serverId) return false;
  if (!triggerSubjectsOf(e).some((s) => s.event === t.event && subjectIsTriggerPlayer(t, s))) return false;
  return eventConditionHolds(t, e);
}

/** The weapons a "weaponkill" trigger listens for, in the shape the Rules tab's weapon trigger
 *  reads — so a weapon matches here exactly when it would there (any listed part of its name). */
export function weaponTriggerParams(params: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return { disallowedWeapons: String(params?.weapons ?? ""), allowedWeapons: "" };
}

/**
 * What an event must also be, beyond whose it is: the same tests the Rules tab's rules apply.
 * A team switch is a SIDE swap — every swap passes through Unassigned, and every connect lands on a
 * team, and neither is a change of side. A weapon kill is a kill with one of the listed weapons.
 */
function eventConditionHolds(t: PlayerTriggerRow, e: EnforceEvent): boolean {
  if (t.event === "teamswitch") return isSideSwap(e.data);
  // A roster detection is judged with ONE trigger's settings: a second trigger on the same player
  // and condition (another role list, another level) is detected on its own.
  // So is the AFK clock's: each AFK trigger waits its own number of minutes.
  if (isPlayerRosterEvent(t.event) || t.event === "afk") return ((e.data ?? {}) as { triggerId?: unknown }).triggerId === t.id;
  if (t.event === "weaponkill") return restrictedWeaponReason(e.weapon, weaponTriggerParams(t.params)) !== null;
  return true;
}

/** The game a trigger's player plays, as far as checking its settings goes: its id and the role ids
 *  its descriptor names (empty when it names none, which then refuses no role). */
export function triggerGameOf(game: string | null | undefined): { id: string | null; roles: Set<number> } {
  const roles = (game ? getGame(game)?.descriptor.roles : null) ?? {};
  return { id: game ?? null, roles: new Set(Object.keys(roles).map(Number)) };
}

/** A role id in words, in the player's game ("role 7" when its descriptor doesn't name it). */
export function roleNamerFor(game: string | null | undefined): (role: number) => string {
  const roles: Record<number, string> = (game ? getGame(game)?.descriptor.roles : null) ?? {};
  return (role) => roles[role] ?? `role ${role}`;
}

/** The settings an event carries, normalized for storage — or why they cannot be saved. One place,
 *  so the routes and the tests refuse the same shapes with the same sentences. A roster condition
 *  is checked against the player's own game: its roles, and whether the condition exists there. */
export function parseEventParams(
  event: PlayerTriggerEvent,
  raw: unknown,
  game: { id: string | null; roles: Set<number> } = { id: null, roles: new Set() },
): { params: Record<string, unknown> } | { error: string } {
  if (isPlayerRosterEvent(event)) return parseRosterParams(event, raw, game);
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (event === "afk") {
    const minutes = body.minutes === undefined || body.minutes === "" ? AFK_DEFAULT_MINUTES : Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return { error: "AFK minutes must be a whole number from 1 to 180" };
    return { params: { minutes } };
  }
  if (event === "weaponkill") {
    const weapons = String(body.weapons ?? "").split(",").map((w) => w.trim()).filter(Boolean).join(", ");
    if (!weapons) return { error: "list at least one weapon — part of its name is enough, e.g. FLAMETHROWER, SATCHEL" };
    if (weapons.length > 500) return { error: "the weapon list is too long (max 500 characters)" };
    return { params: { weapons } };
  }
  return { params: {} };
}

/** A one-shot disarms the instant it fires; an every-time trigger never does. The single place
 *  this rule is written, so the store call and the in-memory prune below cannot disagree. */
export function shouldDisarm(t: PlayerTriggerRow): boolean {
  return t.fireOnce;
}

/** The most steps one trigger may chain, and the longest a step may wait. The cap on delay is an
 *  honesty bound: a pending step lives only in this process's memory, so "kick them tomorrow"
 *  would silently die with the next restart — an hour is long enough for every real staging
 *  ("message now, kick in 60s") and short enough to usually survive. */
export const MAX_TRIGGER_STEPS = 5;
export const MAX_STEP_DELAY_SEC = 3600;
/** Delays run as a LADDER — each counted from the step before it — so the honesty bound has to
 *  hold on their SUM: one chain may keep a pending step in memory for at most an hour total. */
export const MAX_CHAIN_DELAY_SEC = 3600;

/**
 * Refuse the combinations that feed themselves: the kicked/banned events come from the game's
 * own log lines, and a trigger whose ACTION prints that same line would fire itself again —
 * "on banned, temp-ban" is a ban that bans forever. (The runner also carries a per-trigger
 * brake for cycles built across SEVERAL triggers, which no single-row check can see.)
 */
export function triggerLoopError(event: PlayerTriggerEvent, steps: Pick<PlayerTriggerStep, "action">[]): string | null {
  if (event === "banned" && steps.some((s) => s.action === "tempban" || s.action === "permaban")) {
    return "a trigger on “gets banned” cannot itself ban — the new ban prints another BAN line and fires the trigger again, forever";
  }
  if (event === "kicked" && steps.some((s) => s.action === "kick")) {
    return "a trigger on “gets kicked” cannot itself kick — the kick would print another KICK line and fire the trigger again";
  }
  if (event === "teamswitch" && steps.some((s) => s.action === "switch")) {
    return "a trigger on “switches team” cannot itself switch their team — the move is another team switch, and it would fire the trigger again";
  }
  return null;
}

/** Why a chain's delays are unbuildable as a whole, or null. Complements stepError, which sees
 *  one step at a time and so cannot see the sum. */
export function chainDelayError(steps: Pick<PlayerTriggerStep, "delaySec">[]): string | null {
  const total = steps.reduce((s, st) => s + st.delaySec, 0);
  if (total > MAX_CHAIN_DELAY_SEC) {
    return `the delays in one trigger run back to back and may add up to at most ${MAX_CHAIN_DELAY_SEC} seconds (this chain waits ${total}s in total)`;
  }
  return null;
}

/** One step, as a phrase: "grant 72h VIP", "kick (after 60s)". */
export function describeStep(st: PlayerTriggerStep): string {
  const does =
    st.action === "vip" ? (st.hours > 0 ? `grant ${st.hours}h VIP` : "grant VIP")
    : st.action === "vipremove" ? "remove VIP"
    : st.action === "points" ? `grant ${st.points} points`
    : st.action === "takepoints" ? `take ${st.points} points`
    : st.action === "tempban" ? (st.hours > 0 ? `temp-ban ${st.hours}h` : "temp-ban")
    : st.action === "switch" ? "switch team"
    : st.action === "watch" ? "watchlist"
    : st.action;
  // Same reading direction as the builder and the runner: the wait comes FIRST, then the action.
  return st.delaySec > 0 ? `wait ${st.delaySec}s, then ${does}` : does;
}

/** "A", "A or B", "A, B or C". */
function orList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
/** A clan key as staff read it: a split spelling's key is the spelling, a symbol-only tag's its text. */
const clanText = (k: string) => (k.startsWith("s:") ? k.slice(2) : k.startsWith("~") ? k.slice(1) : k);

/** How an event reads in a summary, where its id alone would not ("on weaponkill"). The events
 *  that read fine as their id ("on connect") keep reading that way. A roster condition names its
 *  settings: which roles, which level, which tags. */
const EVENT_PHRASE: Partial<Record<PlayerTriggerEvent, (params: Record<string, unknown>, roleName: (role: number) => string) => string>> = {
  teamswitch: () => "team switch",
  weaponkill: (p) => `kill with ${String(p.weapons ?? "").trim() || "a chosen weapon"}`,
  camenter: () => "admin camera on",
  camexit: () => "admin camera off",
  votestart: () => "starting a vote",
  votecast: () => "voting",
  afk: (p) => `${Number(p.minutes ?? AFK_DEFAULT_MINUTES)} minutes without a kill`,
  role: (p, rn) => `playing ${orList(idsOf(p.roles).map(rn)) || "a chosen role"}`,
  lowlevel: (p) => `level below ${Number(p.minLevel ?? 0)}`,
  rolelevel: (p, rn) => `level below ${Number(p.minLevel ?? 0)} on ${orList(idsOf(p.roles).map(rn)) || "a chosen role"}`,
  badname: () => "a name the filter catches",
  outofzone: (p) => (p.keepOut === true ? "standing in a no-go area" : "leaving the allowed area"),
  novip: () => "having no VIP",
  playtime: (p) => {
    const days = Number(p.periodDays ?? 0);
    return `reaching ${Number(p.hours ?? 0)} hours played${days > 0 ? ` in the last ${days} days` : ""}${p.allServers === true ? " on every server" : ""}`;
  },
  nodiscord: () => "having no Discord link",
  killrate: () => "a kill rate or K/D over the limit",
  ratio: (p) => {
    const pair = ratioPair(p.ratio);
    const words = { kills: "kills", deaths: "deaths", teamkills: "team kills" };
    return `a ratio${pair ? ` of ${words[pair[0]]} to ${words[pair[1]]}` : ""} at or ${p.direction === "below" ? "below" : "above"} ${Number(p.limit ?? 0)}`;
  },
  clantag: (p) => `wearing ${orList((Array.isArray(p.clans) ? p.clans : []).map((k) => clanText(String(k)))) || "a chosen clan tag"}`,
  noleader: () => "a squad with no leader",
  solotank: () => "a solo tank",
  soloheli: () => "a solo helicopter",
};

/** A short human summary of what a trigger does, for the row and the audit line. `roleName` puts a
 *  role id in the player's game's words (roleNamerFor); without it, roles read as numbers. */
export function describeTrigger(
  t: Pick<PlayerTriggerRow, "event" | "steps" | "fireOnce"> & { params?: Record<string, unknown> },
  roleName: (role: number) => string = (role) => `role ${role}`,
): string {
  const does = t.steps.map(describeStep).join(" + ") || "nothing";
  const on = EVENT_PHRASE[t.event]?.(t.params ?? {}, roleName) ?? t.event;
  return `on ${on}, ${does}${t.fireOnce ? " (once)" : " (every time)"}`;
}

/** The distinct capabilities a set of steps requires — creation must hold EVERY one of them:
 *  chaining a message to a tempban is exactly as privileged as doing both by hand. */
export function capabilitiesForSteps(steps: Pick<PlayerTriggerStep, "action">[]): { cap: string; level: "write" }[] {
  const seen = new Set<string>();
  const out: { cap: string; level: "write" }[] = [];
  for (const st of steps) {
    const need = ACTION_CAPABILITY[st.action];
    if (!seen.has(need.cap)) { seen.add(need.cap); out.push(need); }
  }
  return out;
}

/** Why a step is malformed, or null when it is buildable. One place, so the route and any future
 *  surface (Discord, import) refuse the same shapes with the same sentences. */
export function stepError(st: PlayerTriggerStep): string | null {
  if (!TRIGGER_ACTIONS.includes(st.action)) return `action must be one of: ${TRIGGER_ACTIONS.join(", ")}`;
  if (st.action === "message" && !st.message) return "a message step needs a message to send";
  if ((st.action === "kick" || st.action === "punish" || st.action === "tempban" || st.action === "permaban") && !st.message) {
    return `a ${st.action} step needs a reason`;
  }
  if (st.action === "vip" && st.hours <= 0) return "a VIP step needs a length in hours (VIP grants here are always timed)";
  if (st.action === "watch" && !st.message) return "a watchlist step needs a reason — it becomes the watch reason on their profile";
  if ((st.action === "points" || st.action === "takepoints") && st.points <= 0) return "a points step needs a positive number of points";
  if (st.delaySec < 0 || st.delaySec > MAX_STEP_DELAY_SEC) return `a step's delay must be between 0 and ${MAX_STEP_DELAY_SEC} seconds`;
  return null;
}
