/**
 * HLL: Vietnam domain data — built from the game's own reference export (`data.hllv.json`,
 * schema published with the official `hllrcon` 2.0 release), not guessed. That file is the
 * release-day dump of the game's factions, teams, roles, layers, weapons and vehicles, so every
 * table below has a provenance line back to it. When the game patches, re-derive from the new
 * export rather than editing values in place.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from hllrcon — https://github.com/timraay/hllrcon
 *   Copyright (c) 2025 Tim Raaymakers. MIT License; full text in third_party/hllrcon/LICENSE.
 */
import type { GameDescriptor, GameWeaponClass } from "../types.js";

/**
 * Vietnam's two factions. The game names its teams South/North and its factions US/NVA
 * (faction 1 = United States on team 1, faction 6 = NVA on team 2).
 *
 * The IDS stay `allies`/`axis` on purpose: those two strings are the app's cross-game vocabulary
 * for "the two sides of a match" — persisted in kill events (`actorSide`), match outcomes
 * (`winner`), and keyed by the panel's semantic side colors. The label is what humans see; the id
 * is what seven systems already agree on. The session block still reports `alliedPlayerCount`/
 * `axisPlayerCount` (US counts as allied), so the headcount-based side correction works unchanged.
 *
 * teamValues come from the reference export's team table (South=1, North=2). The parity fallback
 * mirrors HLL's, because this is the same engine and HLL builds have been seen encoding a team as
 * 0 — if a Vietnam build does the same, 0 lands on the even (NVA) side and the live resolver
 * corrects from headcounts when that guess collapses.
 */
const SIDES: GameDescriptor["sides"] = [
  { id: "allies", label: "US", teamValues: [1], parity: "odd", color: "blue" },
  { id: "axis", label: "NVA", teamValues: [2], parity: "even", color: "red" },
];

/**
 * Role id → display label, verbatim from the reference export's role table. Vietnam dropped HLL's
 * Assault (1) and Automatic Rifleman (2) — the gap is real, not an omission — and added the mortar
 * platoon (13–15) and the helicopter crew (16–17). The mortar trio's raw pretty-names are the bare
 * words "Support"/"Observer"/"Gunner", which read as nonsense in a role breakdown next to the
 * infantry roles, so they are qualified here the way the game's own UI does.
 */
const ROLES: Record<number, string> = {
  0: "Rifleman",
  3: "Medic",
  4: "Spotter",
  5: "Specialist",
  6: "Machine Gunner",
  7: "Grenadier",
  8: "Engineer",
  9: "Squad Leader",
  10: "Sniper",
  11: "Crewman",
  12: "Tank Commander",
  13: "Mortar Support",
  14: "Mortar Observer",
  15: "Mortar Gunner",
  16: "Pilot",
  17: "Logistics Officer",
  20: "Commander",
};

/**
 * Every role the export marks `is_squad_leader`, MINUS the army commander (20) — same line HLL
 * draws: the Commander leads the team, not a squad, and counting the commander slot as an SL would
 * hide a leaderless squad behind them. Vietnam has five squad types with five leader roles:
 * infantry → Squad Leader (9), recon → Spotter (4), armour → Tank Commander (12), mortar →
 * Mortar Observer (14), helicopter → Logistics Officer (17).
 */
const SQUAD_LEADER_ROLES = [4, 9, 12, 14, 17];

/**
 * Weapon buckets for kill/death breakdowns, derived from the export's weapon table (every name
 * below appears there; patterns are case-insensitive substrings of the kill log's weapon string).
 *
 * ORDER IS THE RULE — first match wins, so specific buckets outrank the general ones that would
 * swallow them: "TYPE 53 W/N4" is a scoped rifle and must hit Sniper before the rifle bucket takes
 * it; "M79 GRENADE LAUNCHER" belongs to Explosives & AT and is named there before the grenade
 * bucket can claim it by the word GRENADE; the tank coax "M73" and "SGMT" are armour, not MGs.
 *
 * Two buckets HLL does not have, because Vietnam's kit does: Mortar (the three-man mortar platoon
 * replaces HLL artillery) and Helicopter (door guns and the airframe itself as a roadkill).
 */
export const HLLV_WEAPON_CLASSES: GameWeaponClass[] = [
  { id: "melee", label: "Melee", melee: true, patterns: ["KNIFE", "HAMMER", "WRENCH", "BLOWTORCH", "MELEE"] },
  { id: "mortar", label: "Mortar", patterns: ["MORTAR"] },
  { id: "helicopter", label: "Helicopter", patterns: ["HELICOPTER", "UH-1", "IROQUOIS", "M60D"] },
  { id: "armor", label: "Armor", patterns: [
    "M48", "PATTON", "T54", "T-54", "100MM", "90MM", "D-10T", "M41", "COAXIAL", "M73", "SGMT", "DSHKM",
  ] },
  // Ground vehicles as the killer: trucks and boats appear in kill logs by their vehicle name.
  { id: "vehicle", label: "Vehicle", patterns: ["GAZ", "M35", "BOAT", "PBR"] },
  { id: "explosive", label: "Explosives & AT", patterns: [
    "M72", "LAW", "RPG", "MINE", "CLAYMORE", "DH-10", "DH10", "SATCHEL", "TNT", "DEMOLITION",
    "FLAMETHROWER", "LPO-50", "M2A1-7", "M79",
  ] },
  { id: "grenade", label: "Grenades", patterns: ["M61", "TYPE 67", "GRENADE", "MOLOTOV"] },
  { id: "sniper", label: "Sniper", patterns: ["M40", "W/N4", "X4", "X8", "SCOPED"] },
  // "DHSK" is the game's own misspelling of the DShK on the NVA boat mount — matched as spelled.
  { id: "mg", label: "Machine gun", patterns: ["M60", "RPD", "DSHK", "DHSK", "M2 BROWNING", "BROWNING"] },
  { id: "shotgun", label: "Shotgun", patterns: ["IZH", "MODEL 77", "SHOTGUN"] },
  { id: "smg", label: "SMG", patterns: ["K-50M", "K50M"] },
  { id: "pistol", label: "Pistol", patterns: ["M1911", "TYPE 54", "FLARE", "SIGNAL PISTOL", "REVOLVER"] },
  { id: "rifle", label: "Rifle", patterns: ["M16A1", "TYPE 56", "TYPE 53", "CARBINE", "RIFLE"] },
];

export { SIDES as HLLV_SIDES, ROLES as HLLV_ROLES, SQUAD_LEADER_ROLES as HLLV_SQUAD_LEADER_ROLES };
