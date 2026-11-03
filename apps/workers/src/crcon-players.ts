/**
 * CRCON's per-round player cache, ported from rcon/logs/loop.py at v12.3.0 (record_player_stats)
 * with the roster parsing it reads through (rcon/utils.py parse_raw_player_info, against hllrcon
 * 2.0.0.6's faction and role tables). CRCON's live scoreboards lay this cache over every player's
 * row — the score buckets, level, side and whether they are still connected — and its stored
 * scoreboard takes the same fields from it when a round is filed, so this is the only place they
 * are decided.
 *
 * The recorder runs on the same passes as the score timeline (crcon-round.ts gives a step exactly
 * when CRCON's update_maps_history reaches record_cap_flips and record_player_stats), rule for
 * rule:
 *
 *   - A player first seen gets a line of zeros, an unassigned unit at the current second and no
 *     unit history yet; nothing else is read from that sample.
 *   - In a round's first 120 seconds nothing more is recorded (the game leaks the last round's
 *     scores into the next one before a player has loaded in), though new players are still added
 *     and leavers still marked.
 *   - A player missing from the roster is marked offline once, with an unassigned unit leg.
 *   - The first sample after a player first moves takes the game's figures as they stand. After
 *     that, a figure that went DOWN means the game reset it on a reconnect: the old total is banked
 *     in the p_* field and the new one counted from there.
 *   - A change of side, squad or role is a new unit leg at the current second.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 * and from hllrcon — https://github.com/timraay/hllrcon (the role ids and faction sides)
 *   Copyright (c) 2025 Tim Raaymakers. MIT License; full text in third_party/hllrcon/LICENSE.
 */
import type { CrconPlayerCache, CrconPlayerStat, CrconUnitEntry } from "@app/db";

const UNASSIGNED = -111;

/** HLLFaction / HLLVFaction id → side (Team.from_hllrcon of the faction's team). The unassigned
 *  ids (7 on HLL, 0 and 8 on HLLV) and unknown ones have no faction, so no side. */
const FACTION_SIDE: Record<string, Record<number, "allies" | "axis">> = {
  hll: { 0: "axis", 1: "allies", 2: "allies", 3: "allies", 4: "axis", 5: "allies", 6: "allies" },
  hllv: { 1: "allies", 6: "axis" },
};

/** The role ids hllrcon knows (role_ids maps each role's name back to its id); an unknown one is
 *  no role. The commander's squad is -1, never a lettered one. */
const ROLE_IDS: Record<string, ReadonlySet<number>> = {
  hll: new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  hllv: new Set([0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20]),
};
const COMMANDER_ROLE: Record<string, number> = { hll: 13, hllv: 20 };

/** What record_player_stats reads of one connected player (GetDetailedPlayer). */
export interface CrconDetailedPlayer {
  name: string;
  team: "allies" | "axis" | null;
  /** The role's id when hllrcon knows it; null otherwise. */
  role: number | null;
  unitId: number | null;
  level: number;
  kills: number;
  deaths: number;
  combat: number;
  offense: number;
  defense: number;
  support: number;
  vehicleKills: number;
  vehiclesDestroyed: number;
  worldPosition: { x: number; y: number; z: number };
}

/** Python's int() of a JSON number or numeric string, null where it raises. */
function pyIntOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** default_player_info_dict: the record CRCON falls back to when a player's info will not parse. */
function fallbackPlayer(name: string): CrconDetailedPlayer {
  return {
    name, team: null, role: null, unitId: null, level: 0, kills: 0, deaths: 0,
    combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
    worldPosition: { x: 0, y: 0, z: 0 },
  };
}

/**
 * One raw roster entry (the game's GetPlayers info) as parse_raw_player_info reads it. Anything it
 * would raise on — a missing score block, a level that is not a number — gives CRCON's fallback
 * record (zeros, no team, no unit) under the player's name, as get_detailed_players does.
 */
export function crconDetailedPlayer(raw: Record<string, unknown>, game: string): CrconDetailedPlayer {
  const name = String(raw.name ?? "");
  const stats = raw.stats as Record<string, unknown> | undefined;
  const score = raw.scoreData as Record<string, unknown> | undefined;
  const pos = raw.worldPosition as Record<string, unknown> | undefined;
  if (!stats || !score || typeof raw.loadout !== "string" || typeof raw.platform !== "string") return fallbackPlayer(name);
  const nums = [raw.level, stats.infantryKills, stats.deaths, stats.teamKills, stats.vehicleKills, stats.vehiclesDestroyed,
    score.cOMBAT, score.offense, score.defense, score.support].map(pyIntOf);
  if (nums.some((n) => n === null)) return fallbackPlayer(name);
  const [level, kills, deaths, , vehicleKills, vehiclesDestroyed, combat, offense, defense, support] = nums as number[];
  if (!pos || typeof pos !== "object") return fallbackPlayer(name);
  const g = game === "hllv" ? "hllv" : "hll";
  const teamId = typeof raw.team === "number" ? raw.team : NaN;
  const roleId = typeof raw.role === "number" ? raw.role : NaN;
  const role = ROLE_IDS[g]!.has(roleId) ? roleId : null;
  // `not raw["platoon"]` is any falsy value; anything else must be a string to index into.
  const platoon = typeof raw.platoon === "string" ? raw.platoon : !raw.platoon ? "" : null;
  if (platoon === null) return fallbackPlayer(name);
  const unitId = role !== null && role === COMMANDER_ROLE[g] ? -1 : !platoon ? 0 : platoon.codePointAt(0)! - 65;
  return {
    name,
    team: FACTION_SIDE[g]![teamId] ?? null,
    role,
    unitId,
    level: level!,
    kills: kills!,
    deaths: deaths!,
    combat: combat!,
    offense: offense!,
    defense: defense!,
    support: support!,
    vehicleKills: vehicleKills!,
    vehiclesDestroyed: vehiclesDestroyed!,
    worldPosition: { x: Number(pos.x ?? 0), y: Number(pos.y ?? 0), z: Number(pos.z ?? 0) },
  };
}

const SCORES = [
  ["combat", "p_combat", "combat"],
  ["offense", "p_offense", "offense"],
  ["defense", "p_defense", "defense"],
  ["support", "p_support", "support"],
  ["vehicle_kills", "p_vehicle_kills", "vehicleKills"],
  ["vehicles_destroyed", "p_vehicles_destroyed", "vehiclesDestroyed"],
] as const;

/**
 * One pass of record_player_stats over the round's cache. `players` is the roster keyed by player
 * id in the game's order; `secFromStart` is the pass's seconds since the round's start, and the
 * first two minutes after `startSec` (epoch seconds) are CRCON's settling window. Returns the new
 * cache; the one passed in is not changed.
 */
export function recordCrconPlayers(
  cache: CrconPlayerCache,
  players: Map<string, CrconDetailedPlayer>,
  secFromStart: number,
  startSec: number,
  nowSec: number,
): CrconPlayerCache {
  const cached = new Map<string, CrconPlayerStat>(structuredClone(cache));
  const skip = startSec + 120 >= nowSec;
  const offline = (): CrconUnitEntry => ({ ts: secFromStart, team: UNASSIGNED, squad: UNASSIGNED, role: UNASSIGNED });

  for (const [id, line] of cached) {
    if (!players.has(id) && line.status !== "offline") {
      line.status = "offline";
      line.p_unit = offline();
      line.units = [...(line.units ?? []), offline()];
    }
  }

  for (const [id, current] of players) {
    const line = cached.get(id);
    if (!line) {
      cached.set(id, {
        combat: 0, p_combat: 0, offense: 0, p_offense: 0, defense: 0, p_defense: 0, support: 0, p_support: 0,
        vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0,
        kills_and_assists: 0, p_kills_and_assists: 0, deaths_and_redeploys: 0, p_deaths_and_redeploys: 0,
        p_unit: { ts: secFromStart, team: UNASSIGNED, squad: UNASSIGNED, role: UNASSIGNED },
        units: [],
        level: current.level,
        p_coord: { ...current.worldPosition },
        has_spawned: false,
        names: [current.name],
        status: "online",
      });
      continue;
    }
    if (skip) continue;

    const at = current.worldPosition;
    if (!line.has_spawned && line.status !== "offline"
      && (line.p_coord.x !== at.x || line.p_coord.y !== at.y || line.p_coord.z !== at.z)) {
      for (const [field, , from] of SCORES) line[field] = current[from];
      line.kills_and_assists = current.kills;
      line.deaths_and_redeploys = current.deaths;
      line.has_spawned = true;
    }
    if (line.status === "offline") line.status = "online";

    for (const [field, banked, from] of SCORES) {
      if (current[from] < line[field]) line[banked] = line[banked] + line[field];
      line[field] = current[from];
    }
    if (current.kills < line.kills_and_assists) line.p_kills_and_assists = line.p_kills_and_assists + line.kills_and_assists;
    line.kills_and_assists = current.kills;
    if (current.deaths < line.deaths_and_redeploys) line.p_deaths_and_redeploys = line.p_deaths_and_redeploys + line.deaths_and_redeploys;
    line.deaths_and_redeploys = current.deaths;

    const role = current.role ?? UNASSIGNED;
    const team = current.team === "allies" ? 1 : current.team === "axis" ? 2 : UNASSIGNED;
    const squad = current.unitId;
    const unit = line.p_unit;
    if (role !== unit.role || squad !== unit.squad || team !== unit.team) {
      const leg: CrconUnitEntry = { ts: secFromStart, team, squad, role };
      line.p_unit = leg;
      line.units = [...(line.units ?? []), { ...leg }];
    }
    if (!line.names.includes(current.name)) line.names.push(current.name);
    line.level = current.level;
    line.p_coord = { ...at };
  }
  return [...cached.entries()];
}
