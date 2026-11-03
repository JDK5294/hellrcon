/**
 * The Hell Let Loose game module — composes the HLL command table (./hll/commands), the HLL
 * log normalizer (./hll/log), and the HLL domain descriptor into one module.
 *
 * Domain data provenance (confirmed against live captures and reference tables, not guessed):
 *  - team encoding varies by server/version (axis seen as 0, allies as 1 and 3; console builds
 *    have produced 0/2 pairs) → parity fallback here, and live reads run resolveTeamSides
 *    (team-sides.ts) which corrects the mapping from the session's own headcounts
 *  - role indices were originally correlated against loadouts (e.g. 8 ↔ Pionier/Sapper = Engineer),
 *    which got 0–13 right and stopped there, because a live capture only ever shows the roles
 *    someone happened to be playing. They are now checked against `hllrcon`'s Role table
 *    (hllrcon/data/roles.py), which is keyed by this protocol's own `role` value and is what CRCON
 *    itself resolves names through — our fourteen agreed with it exactly, and it carries three more
 *  - score buckets are the v2 `scoreData` keys verbatim (cOMBAT quirk is the server's)
 *
 * ---------------------------------------------------------------------------------------------
 * Role ids checked against, and three taken from, hllrcon — https://github.com/timraay/hllrcon
 *   Copyright (c) 2025 Tim Raaymakers. MIT License; full text in third_party/hllrcon/LICENSE.
 */
import { HLL_BINARY_V2 } from "./hll/commands.js";
import { normalizeLine, logLineKey } from "./hll/log.js";
import { parseRotation, parseNextInRotation, parseMapShuffle, parseMapEntries, parseMapCatalogue, parsePlayerCount } from "./hll/state.js";
import { HLL_WEAPON_CLASSES } from "./hll/weapons.js";
import { HLL_WEAPON_NAMES, HLL_COMMANDER_ABILITIES } from "./hll/weapon-names.js";
import type { GameModule } from "./types.js";

export const HLL_GAME: GameModule = {
  id: "hll",
  label: "Hell Let Loose",
  protocols: [
    { id: "binary-v2", label: "binary-v2 (current HLL)" },
    { id: "legacy-text", label: "legacy-text (older HLL)" },
    { id: "crcon-bridge", label: "crcon-bridge (read via existing CRCON)" },
  ],
  commands: HLL_BINARY_V2,
  normalizeLine,
  logLineKey,
  stateReader: { rotation: parseRotation, nextInRotation: parseNextInRotation, mapShuffle: parseMapShuffle, mapEntries: parseMapEntries, mapCatalogue: parseMapCatalogue, playerCount: parsePlayerCount },
  descriptor: {
    id: "hll",
    label: "Hell Let Loose",
    sides: [
      // teamValues list only OBSERVED encodings; unlisted values fall back to parity, and the
      // live-read resolver (resolveTeamSides) corrects collapsed guesses from session headcounts.
      { id: "allies", label: "Allies", teamValues: [1, 3], parity: "odd", color: "blue" },
      { id: "axis", label: "Axis", teamValues: [0], parity: "even", color: "red" },
    ],
    roles: {
      0: "Rifleman", 1: "Assault", 2: "Automatic Rifleman", 3: "Medic", 4: "Spotter",
      5: "Support", 6: "Machinegunner", 7: "Anti-Tank", 8: "Engineer", 9: "Officer",
      10: "Sniper", 11: "Crewman", 12: "Tank Commander", 13: "Commander",
      14: "Artillery Observer", 15: "Operator", 16: "Gunner",
    },
    /*
     * A squad's leader is whichever leader role its TYPE offers, and HLL has four: infantry squads
     * are led by the Officer (9), recon by the Spotter (4), armour by the Tank Commander (12), and
     * artillery by the Artillery Observer (14). Listing only the Officer reported every recon,
     * armour and artillery squad on the server as leaderless, which is what staff kept seeing.
     *
     * Safe as a union rather than a per-squad-type table because the game does not offer these
     * roles across types, so a squad can only ever contain its own leader role.
     *
     * The Commander (13) is marked a leader by the reference table above, because it is exclusive
     * to the commander slot — but that is the army's commander, not a squad's, so it stays out of
     * a check about whether a squad has an SL. That is the same line CRCON draws in its own
     * `_has_leader`, which counts exactly {officer, spotter, tankcommander, artilleryobserver}.
     */
    squadLeaderRoles: [4, 9, 12, 14],
    squadLabel: "Squad",
    // Infantry (led by the Officer), recon (Spotter + Sniper), armour (Tank Commander + Crewmen),
    // artillery (Artillery Observer + Operators + Gunners). The Commander (13) leads the army.
    squadTypes: { infantry: [0, 1, 2, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], artillery: [14, 15, 16] },
    scoreFields: [
      { key: "cOMBAT", label: "Cbt", title: "Combat score" },
      { key: "offense", label: "Off", title: "Offense score" },
      { key: "defense", label: "Def", title: "Defense score" },
      { key: "support", label: "Sup", title: "Support score" },
    ],
    configFields: [
      { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", read: { command: "getAutoBalanceEnabled", key: "enable" }, write: { command: "setAutoBalanceEnabled", param: "enabled" } },
      { field: "autoBalanceThreshold", label: "Auto-balance threshold", kind: "num", read: { command: "getAutoBalanceThreshold", key: "autoBalanceThreshold" }, write: { command: "setAutoBalanceThreshold", param: "threshold" } },
      { field: "highPing", label: "High-ping kick (ms)", kind: "num", read: { command: "getHighPing", key: "highPingThresholdMs" }, write: { command: "setHighPing", param: "ms" } },
      { field: "idleKick", label: "Idle kick (minutes)", kind: "num", read: { command: "getIdleKickTime", key: "idleTimeoutMinutes" }, write: { command: "setKickIdleTime", param: "minutes" } },
      { field: "teamSwitchCooldown", label: "Team-switch cooldown (minutes)", kind: "num", read: { command: "getTeamSwitchCooldown", key: "teamSwitchTimer" }, write: { command: "setTeamSwitchCooldown", param: "minutes" } },
      { field: "voteKickEnabled", label: "Vote kick", kind: "bool", read: { command: "getVoteKickEnabled", key: "enable" }, write: { command: "setVoteKickEnabled", param: "enabled" } },
      { field: "maxQueuedPlayers", label: "Max queued players", kind: "num", write: { command: "setMaxQueuedPlayers", param: "count" } },
      { field: "numVipSlots", label: "VIP slots", kind: "num", write: { command: "setNumVipSlots", param: "count" } },
      { field: "welcomeMessage", label: "Welcome message", kind: "str", write: { command: "setWelcomeMessage", param: "message" } },
      // Shuffled, the game ignores the order the rotation is listed in. Set on Live settings or by an
      // Auto settings profile; the Maps tab only reports it (the owner's call: no switch there).
      { field: "mapShuffle", label: "Map shuffle", kind: "bool", read: { command: "getMapShuffleEnabled", key: "enable" }, write: { command: "setMapShuffleEnabled", param: "enabled" } },
    ],
    weaponClasses: HLL_WEAPON_CLASSES,
    weaponCatalog: HLL_WEAPON_NAMES,
    commanderAbilities: HLL_COMMANDER_ABILITIES,
  },
};
