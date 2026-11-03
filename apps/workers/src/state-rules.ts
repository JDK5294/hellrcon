/**
 * The worker's half of the roster-state triggers, as pure functions.
 *
 * The autosettings runner owns only what it alone can see — each server's live roster — and every
 * DECISION it makes on the way to emitting a state event lives here, testable without a game
 * server, a database or the runner's connection loop: which stored rules a server answers for,
 * which detections are due this tick (population bounds + per-(rule, player) pacing), and how a
 * raw roster entry becomes the `RulePlayer` the detectors read. The runner keeps only the I/O:
 * read the roster, translate platform ids, put events on the bus.
 */
import {
  PLAYER_ROSTER_EVENT_KIND, ROSTER_TRIGGER_CLEAR_MS, getStateTrigger, isPlayerRosterEvent, isStateTriggerKind, resolveTriggerParams,
  rosterDetectParams, stateTriggerAppliesTo, type PlayerRosterEvent, type RulePlayer, type ZoneCellSets,
} from "@app/rules";
import { playerIdentityOf, type GameDescriptor, type GameModule } from "@app/games";
import { matchWindowOpen } from "@app/schedule";
import { ruleLive, type PlayerTriggerRow, type RuleRow } from "@app/db";
import { rosterIdOf, rosterPosOf } from "./seeding.js";

/** One due detection: this rule fires on this player, with the sentence `{violation}` will carry. */
export interface StateFiring {
  rule: RuleRow;
  playerId: string;
  name: string;
  reason: string;
}

/**
 * The state rules THIS server answers for: switched on (its own switch and its section's) and not
 * paused, on a state trigger this build knows, in scope, and — load-bearing, not decorative —
 * applicable to this server's game: role ids collide across games (Vietnam's Pilot is WW2's
 * artillery Gunner), so a community-wide rule for a trigger this game doesn't have must detect
 * NOTHING here rather than misread the roster.
 */
export function stateRulesFor(rules: RuleRow[], server: { id: string; game: string }, nowMs: number = Date.now()): RuleRow[] {
  return rules.filter((r) => ruleLive(r, nowMs) && isStateTriggerKind(r.eventKind)
    && (!r.serverId || r.serverId === server.id) && stateTriggerAppliesTo(r.eventKind, server.game));
}

/**
 * Normalize one raw roster entry onto the shape the detectors read. Tags stay empty on purpose —
 * immunity is the enforcer's job, resolved where it is judged.
 *
 * The id is the player's IDENTITY — the game module's own rule (playerIdentityOf), the same one
 * the player directory, VIP grants and every command use. It was `iD ?? id`, which read "" wherever
 * a build sends an empty `iD` beside a real id, and nothing at all under the `Id`/`ID` spellings:
 * every roster rule dropped those players without a word.
 */
export function rosterToRulePlayer(pl: Record<string, unknown> | null | undefined, mod?: GameModule): RulePlayer {
  return {
    playerId: pl ? (playerIdentityOf(mod, pl)?.platformId ?? rosterIdOf(pl)) : "",
    name: String(pl?.name ?? ""),
    level: Number(pl?.level ?? 0),
    role: Number(pl?.role ?? -1),
    team: Number(pl?.team ?? 0),
    squad: String(pl?.platoon ?? ""),
    loadout: String(pl?.loadout ?? ""),
    tags: [],
    // The same reading the seeding containment gives positions: (0,0) is the deploy screen, and
    // a row with no position at all is nobody standing anywhere.
    pos: pl ? rosterPosOf(pl) : null,
    clanTag: String(pl?.clanTag ?? "").trim(),
    ...killsOf(pl),
  };
}

/**
 * One tick's due firings.
 *
 * Population bounds are judged HERE, against the live roster in hand — the enforcer deliberately
 * trusts a state event to arrive already judged, because its roster snapshot would be older
 * evidence than this count. `windowSec` is the rule's re-check cadence: a persisting violation
 * fires again (and climbs the enforcer's ladder) once per interval, not once per 10-second tick —
 * which is why `firedAt` (keyed `ruleId|playerId`) is MUTATED as firings are granted.
 */
export function dueStateFirings(opts: {
  rules: RuleRow[];
  players: RulePlayer[];
  playerCount: number;
  descriptor: GameDescriptor | null;
  firedAt: Map<string, number>;
  nowMs: number;
  /** the zone trigger's per-rule map context (rules reference different sets); absent when no
   *  zone rule is enabled this tick. A rule with no entry detects nothing — no paint, no policy. */
  zonesByRuleId?: Map<string, ZoneCellSets | null>;
  sideOfTeam?: (team: number) => string | null;
  /** Minutes the current match has run (null = unknown) — a rule's match-time window reads it. */
  matchMinutes?: number | null;
  /** The clan tag trigger's grouping (Players → Clans); absent when no clan rule is on, or when
   *  the grouping could not be read — the trigger then flags nobody. */
  clans?: { ofTag(tag: string): string; ofKey(key: string): string } | null;
  /** When given, filled per rule with what this check saw — the rule card's status line. */
  report?: Map<string, StateRuleReport>;
}): StateFiring[] {
  const due: StateFiring[] = [];
  for (const rule of opts.rules) {
    const def = getStateTrigger(rule.eventKind);
    if (!def) continue;
    const params = resolveTriggerParams(rule.eventKind, rule.params);
    const ctx = { players: opts.players, params, descriptor: opts.descriptor, zones: opts.zonesByRuleId?.get(rule.id) ?? null, sideOfTeam: opts.sideOfTeam, clans: opts.clans ?? null };
    const rep: StateRuleReport = { flagged: 0, due: 0, held: null, breakdown: {} };
    opts.report?.set(rule.id, rep);
    if (opts.report && def.explain) rep.breakdown = def.explain(ctx);
    if (rule.playersMin > 0 && opts.playerCount < rule.playersMin) { rep.held = `under its ${rule.playersMin}-player floor (${opts.playerCount} on)`; continue; }
    if (rule.playersMax > 0 && opts.playerCount > rule.playersMax) { rep.held = `over its ${rule.playersMax}-player ceiling (${opts.playerCount} on)`; continue; }
    // The match-time window: judged here, where the detection is, so the first firing lands the
    // moment it opens rather than a re-check interval later. Unknown match clock = closed.
    if (!matchWindowOpen(rule.matchMinutesMin ?? 0, rule.matchMinutesMax ?? 0, opts.matchMinutes ?? null)) {
      rep.held = opts.matchMinutes == null ? "its match window needs the match start, which isn't known" : "outside its match window";
      continue;
    }
    const intervalMs = Math.max(30, rule.windowSec || 60) * 1000;
    const hits = def.detect(ctx);
    rep.flagged = hits.length;
    for (const v of hits) {
      const key = `${rule.id}|${v.playerId}`;
      if (opts.nowMs - (opts.firedAt.get(key) ?? 0) < intervalMs) continue;
      opts.firedAt.set(key, opts.nowMs);
      rep.due++;
      due.push({ rule, playerId: v.playerId, name: v.name, reason: v.reason });
    }
  }
  return due;
}

/** What one check saw for one rule: flagged players, how many were due (outside the re-check
 *  interval), a reason the whole rule held back if it did, and the trigger's roster breakdown. */
export interface StateRuleReport { flagged: number; due: number; held: string | null; breakdown: Record<string, number> }

/** Bound the pacing map by "recently in violation": an entry older than an hour can only ever
 *  allow an EARLIER re-fire, so dropping it is safe and keeps the map from growing by every
 *  (rule, player) pair a long-running server has ever flagged. */
export function pruneStateFiredAt(firedAt: Map<string, number>, nowMs: number): void {
  for (const [key, at] of firedAt) if (nowMs - at > 3_600_000) firedAt.delete(key);
}

/** One VIP grant row, as far as "does this player hold VIP right now" needs it. */
export interface VipHolding { playerId: string; expiration: string | null; pausedUntil: string | null }

/**
 * True when this grant means the player HAS VIP right now: permanent, still dated in the future,
 * or PAUSED — a pause is a punishment in progress, and a rule granting VIP to players "without"
 * it must never be the way around one.
 */
export function holdsVip(row: VipHolding | undefined | null, nowMs: number): boolean {
  if (!row) return false;
  if (row.pausedUntil && Date.parse(row.pausedUntil) > nowMs) return true;
  if (row.expiration === null) return true;
  return Date.parse(row.expiration) > nowMs;
}

/**
 * Stamp each roster player with the two facts the no-VIP trigger reads. `vip` is true for a
 * holding grant of ours OR an entry on the game's own list (VIP set outside the panel — a grant
 * written over one would date it, and the expiry sweep would then take it away). `gameVipIds` null
 * = the game's list could not be read: every player's VIP is then UNKNOWN, and the trigger stays
 * silent rather than guess. `firstSeenMs` is this worker's own memory of when each was first on
 * the roster; it is updated here (players who left are forgotten).
 */
export function annotateVip(players: RulePlayer[], opts: {
  grants: VipHolding[];
  gameVipIds: ReadonlySet<string> | null;
  firstSeenMs: Map<string, number>;
  nowMs: number;
}): RulePlayer[] {
  const byId = new Map(opts.grants.map((g) => [g.playerId, g]));
  return stampOnline(players, opts.firstSeenMs, opts.nowMs).map((p) => {
    const grant = holdsVip(byId.get(p.playerId), opts.nowMs);
    const onGame = opts.gameVipIds?.has(p.playerId) ?? false;
    const vip = grant ? true : opts.gameVipIds === null ? null : onGame;
    return { ...p, vip, vipSource: grant ? "grant" : onGame ? "game" : null };
  });
}

/** The roster's per-match kills (infantry + vehicle), deaths and team kills; null when not reported. */
function killsOf(pl: Record<string, unknown> | null | undefined): { kills: number | null; deaths: number | null; teamkills: number | null } {
  const st = (pl?.stats ?? null) as { infantryKills?: unknown; vehicleKills?: unknown; deaths?: unknown; teamKills?: unknown } | null;
  if (!st) return { kills: null, deaths: null, teamkills: null };
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { kills: n(st.infantryKills) + n(st.vehicleKills), deaths: n(st.deaths), teamkills: n(st.teamKills) };
}

/**
 * Stamp each player's minutes on the server from this worker's memory of when it first saw them
 * (`firstSeenMs`, updated here; players who left are forgotten, so a rejoin starts over).
 */
export function stampOnline(players: RulePlayer[], firstSeenMs: Map<string, number>, nowMs: number): RulePlayer[] {
  const present = new Set(players.map((p) => p.playerId));
  for (const id of [...firstSeenMs.keys()]) if (!present.has(id)) firstSeenMs.delete(id);
  return players.map((p) => {
    if (!firstSeenMs.has(p.playerId)) firstSeenMs.set(p.playerId, nowMs);
    return { ...p, onlineMinutes: (nowMs - firstSeenMs.get(p.playerId)!) / 60_000 };
  });
}

/**
 * Minutes played THIS match — the kill-rate trigger's time base. Roster kills reset each match, so
 * a player on since the last one has only been earning these kills since this one started. With
 * no known match clock, time on the server is the (longer, so gentler) base.
 */
export function stampPlayMinutes(players: RulePlayer[], matchMinutes: number | null): RulePlayer[] {
  return players.map((p) => {
    const online = p.onlineMinutes ?? null;
    const play = online === null ? matchMinutes : matchMinutes === null ? online : Math.min(online, matchMinutes);
    return { ...p, playMinutes: play };
  });
}

/**
 * Stamp Discord links. `profileOf` maps a roster (platform) id to the player's profile id; `linked`
 * is the set of profile ids holding a Discord link, or null when it could not be read — then
 * everyone is unknown and the no-link trigger stays silent. A player our directory has never seen
 * is unknown too (ingest will have recorded them by the next tick).
 */
export function stampDiscord(players: RulePlayer[], profileOf: ReadonlyMap<string, string>, linked: ReadonlySet<string> | null): RulePlayer[] {
  return players.map((p) => {
    const id = profileOf.get(p.playerId);
    return { ...p, discordLinked: linked === null || !id ? null : linked.has(id) };
  });
}

/**
 * Stamp hours played under each playtime key. `secondsByKey` holds, per key, the recorded seconds
 * by profile id; the visit in progress (not recorded until it ends) is added from onlineMinutes. A
 * key whose read failed is simply absent, and so is every player we cannot place.
 */
export function stampPlaytime(players: RulePlayer[], profileOf: ReadonlyMap<string, string>, secondsByKey: ReadonlyMap<string, ReadonlyMap<string, number>>): RulePlayer[] {
  return players.map((p) => {
    const id = profileOf.get(p.playerId);
    if (!id) return p;
    const hours: Record<string, number> = {};
    for (const [key, secs] of secondsByKey) hours[key] = ((secs.get(id) ?? 0) + (p.onlineMinutes ?? 0) * 60) / 3600;
    return { ...p, playtimeHours: hours };
  });
}

/**
 * One armed player trigger on a roster condition that THIS server answers for: the Rules tab's
 * detector that judges it, its settings in that detector's shape, and the player's game id (the
 * one the roster speaks).
 */
export interface RosterTriggerWatch {
  trigger: PlayerTriggerRow;
  event: PlayerRosterEvent;
  kind: string;
  params: Record<string, unknown>;
  platformId: string;
}

/**
 * The roster-condition triggers this server answers for: armed, on a roster condition, scoped here
 * or to any server, for a player of THIS server's game (a trigger follows one game account, and
 * role ids collide across games), and on a condition the game has. `identities` maps a trigger's
 * player record to its game id and game; a player it cannot place is skipped.
 */
export function rosterTriggerWatchesFor(
  triggers: PlayerTriggerRow[],
  identities: ReadonlyMap<string, { platformId: string; game: string }>,
  server: { id: string; game: string },
): RosterTriggerWatch[] {
  const out: RosterTriggerWatch[] = [];
  for (const t of triggers) {
    if (!t.enabled || t.disarmedAt !== null || !isPlayerRosterEvent(t.event)) continue;
    if (t.serverId !== null && t.serverId !== server.id) continue;
    const who = identities.get(t.playerId);
    if (!who || !who.platformId || who.game !== server.game) continue;
    const kind = PLAYER_ROSTER_EVENT_KIND[t.event];
    if (!stateTriggerAppliesTo(kind, server.game)) continue;
    out.push({ trigger: t, event: t.event, kind, params: rosterDetectParams(t.event, t.params), platformId: who.platformId });
  }
  return out;
}

/** One roster-condition trigger due to fire: the detector's name for the player, and its sentence. */
export interface RosterTriggerFiring { trigger: PlayerTriggerRow; event: PlayerRosterEvent; name: string; reason: string }

/**
 * One tick's due roster-condition triggers.
 *
 * Each watch runs its detector over the WHOLE roster (the squad checks need the squad) and looks
 * for its own player among the hits. A trigger fires when its condition STARTS: `lastTrue` holds,
 * per trigger version, when the condition last held, and is MUTATED here. A condition that lasts
 * fires once; an every-time trigger fires again only once the condition has been gone for
 * ROSTER_TRIGGER_CLEAR_MS (they left the role or the server, and came back later). Keyed by the
 * trigger's version, so re-editing a trigger starts it over.
 */
export function dueRosterTriggerFirings(opts: {
  watches: RosterTriggerWatch[];
  players: RulePlayer[];
  descriptor: GameDescriptor | null;
  lastTrue: Map<string, number>;
  nowMs: number;
  /** each zone trigger's paint for the map being played, by trigger id (as dueStateFirings has it by rule id). */
  zonesById?: Map<string, ZoneCellSets | null>;
  sideOfTeam?: (team: number) => string | null;
  clans?: { ofTag(tag: string): string; ofKey(key: string): string } | null;
}): RosterTriggerFiring[] {
  const due: RosterTriggerFiring[] = [];
  for (const w of opts.watches) {
    const def = getStateTrigger(w.kind);
    if (!def || !opts.players.some((p) => p.playerId === w.platformId)) continue;
    const hit = def.detect({
      players: opts.players, params: w.params, descriptor: opts.descriptor,
      zones: opts.zonesById?.get(w.trigger.id) ?? null, sideOfTeam: opts.sideOfTeam, clans: opts.clans ?? null,
    }).find((v) => v.playerId === w.platformId);
    if (!hit) continue;
    const key = rosterTriggerKey(w.trigger);
    const last = opts.lastTrue.get(key);
    opts.lastTrue.set(key, opts.nowMs);
    if (last !== undefined && opts.nowMs - last < ROSTER_TRIGGER_CLEAR_MS) continue; // the same occurrence, still going
    due.push({ trigger: w.trigger, event: w.event, name: hit.name, reason: hit.reason });
  }
  return due;
}

/** A trigger version's key in the condition memory: an edit is a new version, and starts over. */
function rosterTriggerKey(t: PlayerTriggerRow): string {
  return `${t.id}|${t.updatedAt ?? ""}`;
}

/** Forget conditions gone longer than ROSTER_TRIGGER_CLEAR_MS: past that, an entry allows exactly
 *  what having no entry allows, and the map stays as small as what is happening right now. */
export function pruneRosterTriggerMemory(lastTrue: Map<string, number>, nowMs: number): void {
  for (const [key, at] of lastTrue) if (nowMs - at >= ROSTER_TRIGGER_CLEAR_MS) lastTrue.delete(key);
}

/**
 * What the auto-settings loop does on a server, from its "Auto settings & rules" switch and how
 * many player triggers on roster conditions are armed for it.
 *
 * The switch turns off the loop's OWN work: settings profiles, timed match messages, the roster
 * rules. It does not govern player triggers. The trigger runner fires every other kind whatever
 * the switch says, because a trigger is a deliberate instruction about one player, not part of
 * what the switch turns off. So with the switch off the loop still watches the roster for the
 * triggers on roster conditions, and holds a connection to the server only while one is armed.
 */
export function autoSettingsDuty(switchOn: boolean, rosterTriggers: number): { own: boolean; connect: boolean } {
  return { own: switchOn, connect: switchOn || rosterTriggers > 0 };
}
