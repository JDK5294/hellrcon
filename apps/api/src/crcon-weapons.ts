/**
 * What CRCON v12.3.0 derives from a round's weapon counts (rcon/models.py): kills per WeaponType
 * (calc_weapon_type_usage) and the side a player played for (PlayerStats.detect_team). The tables
 * are CRCON's own, generated from rcon/weapons.py (crcon-weapons-data.ts) — WW2's, which CRCON
 * reads for Vietnam rounds too, so a Vietnam weapon has no type and no side, as there.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { CRCON_WEAPON_SIDES, CRCON_WEAPON_TYPES } from "./crcon-weapons-data.js";
import { pyFloat, pyRound, type PyFloat } from "./crcon-json.js";

const TYPE_OF: ReadonlyMap<string, string> = new Map(CRCON_WEAPON_TYPES);
const SIDE_OF: ReadonlyMap<string, "allies" | "axis"> = new Map(CRCON_WEAPON_SIDES);

/** calc_weapon_type_usage: the kills per WeaponType, each type where the weapons first meet it. */
export function crconWeaponTypeUsage(weapons: Iterable<readonly [string, number]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, count] of weapons) {
    const type = TYPE_OF.get(name);
    if (type !== undefined) out.set(type, (out.get(type) ?? 0) + count);
  }
  return out;
}

export interface CrconUnitLeg {
  ts: number;
  team: number;
  squad: number | null;
  role: number;
}

/** PlayerTeamAssociation: side, confidence, ratio — the ratio an int where CRCON's is one. */
export interface CrconTeam {
  side: "allies" | "axis" | "unknown";
  confidence: "strong" | "mixed";
  ratio: number | PyFloat;
}

const ratioOf = (part: number, total: number): PyFloat => pyFloat(pyRound((part / total) * 100, 2));

/**
 * PlayerStats.detect_team. The unit history decides when there is one: one team throughout is
 * that team, "strong"; both is whichever had more seconds (each leg lasting until the next, the
 * last until the round's match_time), "mixed". Without units, the weapons decide: a kill with a
 * side's weapon counts for that side, a death to one counts for the other.
 */
export function crconDetectTeam(
  units: readonly CrconUnitLeg[] | null | undefined,
  matchTime: number | null,
  weapons: Iterable<readonly [string, number]>,
  deathByWeapons: Iterable<readonly [string, number]>,
): CrconTeam {
  const ordered = [...(units ?? [])].sort((a, b) => a.ts - b.ts);
  const seconds = { allies: 0, axis: 0 };
  const teams = new Set<"allies" | "axis">();
  ordered.forEach((unit, i) => {
    const team = unit.team === 1 ? "allies" : unit.team === 2 ? "axis" : null;
    if (!team) return;
    teams.add(team);
    const end = i + 1 < ordered.length ? ordered[i + 1]!.ts : matchTime;
    if (end !== null) seconds[team] += Math.max(0, end - unit.ts);
  });
  if (teams.size > 1) {
    const { allies, axis } = seconds;
    if (allies === axis) return { side: "unknown", confidence: "mixed", ratio: 50 };
    return allies > axis
      ? { side: "allies", confidence: "mixed", ratio: ratioOf(allies, allies + axis) }
      : { side: "axis", confidence: "mixed", ratio: ratioOf(axis, allies + axis) };
  }
  if (teams.size === 1) return { side: [...teams][0]!, confidence: "strong", ratio: 100 };

  let allies = 0;
  let axis = 0;
  for (const [name, count] of weapons) {
    const side = SIDE_OF.get(name);
    if (side === "allies") allies += count;
    else if (side === "axis") axis += count;
  }
  for (const [name, count] of deathByWeapons) {
    const side = SIDE_OF.get(name);
    if (side === "allies") axis += count;
    else if (side === "axis") allies += count;
  }
  if (allies === 0 && axis === 0) return { side: "unknown", confidence: "strong", ratio: 0 };
  let team: CrconTeam;
  if (axis > allies) team = { side: "axis", confidence: "mixed", ratio: ratioOf(axis, axis + allies) };
  else if (allies > axis) team = { side: "allies", confidence: "mixed", ratio: ratioOf(allies, axis + allies) };
  else team = { side: "unknown", confidence: "mixed", ratio: 50 };
  const ratio = typeof team.ratio === "number" ? team.ratio : team.ratio.value;
  team.confidence = ratio > 85 ? "strong" : "mixed";
  return team;
}
