/**
 * Pure shaping of a player's combat record into the rich-profile figures — kill/death types by
 * weapon class, nemeses (most killed / most died to), squadmates (most played with / against),
 * killstreaks, melee record, rates, faction preference and map/mode/server habits. Everything is
 * derived from data already captured (the kill-event window + per-match scoreboard lines), so it
 * works retroactively over existing history. Kept out of the route so it's unit-testable with
 * fixture rows, and game-agnostic: weapon buckets come from the game descriptor and mode inference
 * arrives as a hook the route supplies.
 *
 * Honest-window rule: everything derived from the event window or the match window says so via
 * `window`, because the raw `evt` table is trimmable — these are "recent" figures, not lifetime
 * ones. The lifetime numbers (career K/D/playtime) come in as inputs from the untrimmable
 * player_stats rollup and are used only for the rates.
 */
import type { EvtRow, PlayerMatchRow, PlayerMatchStatRow } from "@app/db";
import type { GameDescriptor } from "@app/games";
import { classifyWeapon, sideFromTeam } from "@app/games";

export interface ClassCount { id: string; label: string; count: number }
export interface PersonCount { playerId: string | null; name: string; count: number }
export interface MapCount { map: string; count: number; wins: number; losses: number }
export interface NamedCount { name: string; count: number }
export interface RollingPoint { x: string; label: string; kd: number; winRate: number | null }

export interface CombatAnalytics {
  /** how much history the recent figures are based on (evt is trimmable, so say so). */
  window: { events: number; matches: number; firstEventAt: string | null };
  /** lifetime rates from the untrimmable career rollup: kills/deaths per minute of playtime. */
  rates: { kpm: number | null; dpm: number | null };
  killTypes: ClassCount[];
  deathTypes: ClassCount[];
  melee: {
    kills: number;
    deaths: number;
    lastDeath: { ts: string; by: string; weapon: string } | null;
  };
  streaks: { bestKillstreak: number; currentKillstreak: number; bestDeathstreak: number };
  mostKilled: PersonCount[];
  mostDiedTo: PersonCount[];
  playedWith: PersonCount[];
  playedAgainst: PersonCount[];
  faction: { allies: number; axis: number; alliesPct: number | null };
  maps: MapCount[];
  modes: NamedCount[];
  servers: { serverId: string; name: string; count: number }[];
  /** per-match rolling averages (window 10), oldest→newest, for the progression chart. */
  rolling: RollingPoint[];
}

export interface CombatInput {
  playerId: string;
  /** kill/teamkill events involving the player (either side), NEWEST first (as the repo returns). */
  events: EvtRow[];
  /** the player's per-match lines joined with the match, NEWEST first. */
  matches: PlayerMatchRow[];
  /** every player's line for those same matches (matches.participants). */
  participants: PlayerMatchStatRow[];
  /** lifetime figures from the career rollup — survive event trims. */
  career: { kills: number; deaths: number; playtimeSec: number };
  descriptor: GameDescriptor | null;
  serverNames: Map<string, string>;
  /** optional map→mode inference (HLL: @app/maps inferMode); omitted games skip `modes`. */
  modeOf?: (map: string) => string;
}

const ROLLING_WINDOW = 10;
const TOP = 10;

function topPeople(counts: Map<string, { playerId: string | null; name: string; count: number }>): PersonCount[] {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP);
}

/** Fold one sighting of a person into a tally keyed by identity (id when known, else name). */
function see(counts: Map<string, { playerId: string | null; name: string; count: number }>, playerId: string | null, name: string | null, by = 1) {
  const label = name || (playerId ? playerId.slice(0, 8) : "");
  if (!label) return;
  const key = playerId ?? `name:${label}`;
  const cur = counts.get(key) ?? { playerId, name: label, count: 0 };
  cur.count += by;
  if (name) cur.name = name; // newest sighting wins the display name
  counts.set(key, cur);
}

export function buildCombatAnalytics(input: CombatInput): CombatAnalytics {
  const { playerId, events, matches, participants, career, descriptor, serverNames, modeOf } = input;

  // ---- weapon-class breakdowns + nemeses + melee, from the event window ----
  const killClasses = new Map<string, ClassCount>();
  const deathClasses = new Map<string, ClassCount>();
  const killedCounts = new Map<string, { playerId: string | null; name: string; count: number }>();
  const diedToCounts = new Map<string, { playerId: string | null; name: string; count: number }>();
  let meleeKills = 0, meleeDeaths = 0;
  let lastMeleeDeath: CombatAnalytics["melee"]["lastDeath"] = null;

  const bump = (m: Map<string, ClassCount>, weapon: string | null) => {
    const cls = classifyWeapon(descriptor, weapon);
    const cur = m.get(cls.id) ?? { id: cls.id, label: cls.label, count: 0 };
    cur.count += 1;
    m.set(cls.id, cur);
    return cls;
  };

  for (const e of events) {
    if (e.kind !== "evt.kill") continue; // team kills stay out of the combat mix
    if (e.actorPlayerId === playerId) {
      const cls = bump(killClasses, e.weapon);
      if (cls.melee) meleeKills += 1;
      see(killedCounts, e.victimPlayerId, e.victimName);
    } else if (e.victimPlayerId === playerId) {
      const cls = bump(deathClasses, e.weapon);
      if (cls.melee) {
        meleeDeaths += 1;
        // events arrive newest first, so the first melee death seen IS the most recent one
        lastMeleeDeath ??= { ts: e.ts, by: e.actorName ?? "?", weapon: e.weapon ?? "?" };
      }
      see(diedToCounts, e.actorPlayerId, e.actorName);
    }
  }

  // ---- streaks: consecutive kills without dying (and the mirror), walked oldest→newest ----
  let best = 0, cur = 0, bestDeath = 0, curDeath = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const died = e.victimPlayerId === playerId; // a team kill still puts you on the ground
    const killed = e.kind === "evt.kill" && e.actorPlayerId === playerId;
    if (killed) { cur += 1; curDeath = 0; if (cur > best) best = cur; }
    else if (died) { curDeath += 1; cur = 0; if (curDeath > bestDeath) bestDeath = curDeath; }
  }

  // ---- squadmates from shared matches: same recorded side = with, opposite = against ----
  const sideByMatch = new Map(matches.map((m) => [m.matchId, m.side]));
  const withCounts = new Map<string, { playerId: string | null; name: string; count: number }>();
  const againstCounts = new Map<string, { playerId: string | null; name: string; count: number }>();
  for (const p of participants) {
    if (p.playerId === playerId) continue;
    const mySide = sideByMatch.get(p.matchId);
    if (!mySide || !p.side) continue; // unknown sides can't be attributed either way
    see(mySide === p.side ? withCounts : againstCounts, p.playerId, p.playerName);
  }

  // ---- habits from the match window: faction, maps (+outcome), modes, servers ----
  let allies = 0, axis = 0;
  const mapCounts = new Map<string, MapCount>();
  const modeCounts = new Map<string, number>();
  const serverCounts = new Map<string, number>();
  for (const m of matches) {
    if (m.side === "allies") allies += 1;
    else if (m.side === "axis") axis += 1;
    if (m.map) {
      const row = mapCounts.get(m.map) ?? { map: m.map, count: 0, wins: 0, losses: 0 };
      row.count += 1;
      if (m.endedAt && m.winner && m.side) { if (m.side === m.winner) row.wins++; else row.losses++; }
      mapCounts.set(m.map, row);
      if (modeOf) {
        const mode = modeOf(m.map);
        modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
      }
    }
    serverCounts.set(m.serverId, (serverCounts.get(m.serverId) ?? 0) + 1);
  }
  // No sided match rows — the usual state for an imported era (kills landed as events, but the
  // rounds either weren't recorded or the lines carried no side). The kill events themselves say
  // which side the player was on: imported lines store the parsed side, live lines the raw team.
  if (allies + axis === 0) {
    for (const e of events) {
      if (e.kind !== "evt.kill" && e.kind !== "evt.teamkill") continue;
      const d = (e.data ?? {}) as Record<string, unknown>;
      const isActor = e.actorPlayerId === playerId;
      const parsed = isActor ? d.actorSide : d.victimSide;
      const team = isActor ? d.playerTeam : d.victimTeam;
      const side = parsed === "allies" || parsed === "axis" ? parsed : typeof team === "string" ? sideFromTeam(team) : null;
      if (side === "allies") allies += 1;
      else if (side === "axis") axis += 1;
    }
  }
  const sided = allies + axis;

  // ---- rolling averages over the last ROLLING_WINDOW matches, oldest→newest ----
  const chrono = [...matches].reverse();
  const rolling: RollingPoint[] = chrono.map((m, i) => {
    const win = chrono.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1);
    let k = 0, d = 0, wins = 0, decided = 0;
    for (const w of win) {
      k += w.kills; d += w.deaths;
      if (w.endedAt && w.winner && w.side) { decided += 1; if (w.side === w.winner) wins += 1; }
    }
    return {
      x: m.startedAt, label: m.map ?? m.startedAt.slice(5, 10),
      kd: Number((d ? k / d : k).toFixed(2)),
      winRate: decided ? Number((wins / decided).toFixed(2)) : null,
    };
  });

  const minutes = career.playtimeSec / 60;
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

  return {
    window: { events: events.length, matches: matches.length, firstEventAt: events.at(-1)?.ts ?? null },
    rates: {
      kpm: minutes >= 1 ? Number((career.kills / minutes).toFixed(2)) : null,
      dpm: minutes >= 1 ? Number((career.deaths / minutes).toFixed(2)) : null,
    },
    killTypes: [...killClasses.values()].sort(byCount),
    deathTypes: [...deathClasses.values()].sort(byCount),
    melee: { kills: meleeKills, deaths: meleeDeaths, lastDeath: lastMeleeDeath },
    streaks: { bestKillstreak: best, currentKillstreak: cur, bestDeathstreak: bestDeath },
    mostKilled: topPeople(killedCounts),
    mostDiedTo: topPeople(diedToCounts),
    playedWith: topPeople(withCounts),
    playedAgainst: topPeople(againstCounts),
    faction: { allies, axis, alliesPct: sided ? Number((allies / sided).toFixed(2)) : null },
    maps: [...mapCounts.values()].sort(byCount).slice(0, TOP),
    modes: [...modeCounts.entries()].map(([name, count]) => ({ name, count })).sort(byCount),
    servers: [...serverCounts.entries()]
      .map(([serverId, count]) => ({ serverId, name: serverNames.get(serverId) ?? serverId, count }))
      .sort(byCount),
    rolling,
  };
}
