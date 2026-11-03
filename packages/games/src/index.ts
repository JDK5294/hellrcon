/**
 * @app/games — the game-module registry. Core resolves a module by `server.game`; game data
 * (command tables, log parsing, domain descriptors) never leaks into core directly.
 */
import type { GameModule, GameStateReader, PlayerIdentity } from "./types.js";
import { HLL_GAME } from "./hll.js";
import { HLLV_GAME } from "./hllv.js";
import { normalizeSession, type StateKind } from "@app/rcon-core";

export * from "./types.js";
export { HLL_GAME } from "./hll.js";
export { HLLV_GAME } from "./hllv.js";
export { HLL_BINARY_V2, V2_CATALOGUE_503 } from "./hll/commands.js";
export { HLLV_BINARY_V2, HLLV_DIVERGENT_COMMANDS } from "./hllv/commands.js";
export type { LogicalCommand } from "./hll/commands.js";
export { normalizeLine as hllNormalizeLine, logLineKey as hllLogLineKey, cameraEntered } from "./hll/log.js";
export { parseRotation as hllParseRotation, parseNextInRotation as hllParseNextInRotation, parseMapShuffle as hllParseMapShuffle, parseMapEntries as hllParseMapEntries, parseMapCatalogue as hllParseMapCatalogue, parsePlayerCount as hllParsePlayerCount, parseObjectiveRows } from "./hll/state.js";
export { parseStoredLayoutsStrict, type StoredLayoutEntry } from "./hllv/state.js";
export { parseMatchResult, resultMapName, sameMapName, sideFromTeam, type MatchOutcome, type MatchSide } from "./hll/match.js";
export { classifyWeapon, weaponClassesOf, OTHER_WEAPON_CLASS } from "./weapons.js";
export { resolveTeamSides, staticSideOf, teamSidesConfident, type SessionHeadcounts } from "./team-sides.js";
export { type SwitchHistoryColumns } from "./team-switch.js";
export { describeTeamSwitch, describeSwitchHistory, walkSwitchHistory, foldTeamSwitches, isSideSwap, isUnassigned, parseTeamSwitchBody, teamSwitchText, NO_SWITCHES, TEAMSWITCH_BODY_RE, type TeamSwitchData, type TeamSwitchState } from "./team-switch.js";
export { summarizeRoster, type RosterSummary, type SideComposition, type RosterPlayerLike } from "./roster.js";

const MODULES = new Map<string, GameModule>([
  [HLL_GAME.id, HLL_GAME],
  [HLLV_GAME.id, HLLV_GAME],
]);

/** Register (or replace) a game module. Plugins/new games call this at startup. */
export function registerGame(mod: GameModule): void {
  MODULES.set(mod.id, mod);
}

/**
 * The state reader for an unregistered game: every answer degrades to "nothing"/"unknown" rather
 * than throwing. Returned by `stateReaderFor` so a call site reads the same whether or not we
 * happen to have a module for the game.
 */
const NO_STATE_READER: GameStateReader = {
  rotation: () => ({ maps: [], currentIndex: 0 }),
  nextInRotation: () => null,
  mapShuffle: () => null,
  mapEntries: () => [],
  mapCatalogue: () => [],
  playerCount: () => null,
};

/** How to read this game's `readState` answers. Unknown game → the degrading reader above. */
export function stateReaderFor(gameId: string | null | undefined): GameStateReader {
  return getGame(gameId)?.stateReader ?? NO_STATE_READER;
}

/** Resolve a module by game id. Returns undefined for unknown games — callers degrade. */
export function getGame(id: string | null | undefined): GameModule | undefined {
  return MODULES.get(id ?? "");
}

/**
 * The one way roster payloads become player identities (see PlayerIdentity in types.ts).
 *
 * Every place that upserts players from a live read — the API's /live path, the worker's roster
 * snapshot — goes through here, so a game whose reported id is NOT the durable identity (HLL:
 * Vietnam keys everyone by a per-game EOS id and carries the Steam64 beside it) fixes all of
 * them by implementing `identity` on its module, and none of core changes.
 *
 * The default is HLL's shape and the safe one generally: the reported id is the platform id, and
 * an `eosId` field riding along is a link, not an identity.
 */
/**
 * A raw roster row's player id: the FIRST NON-EMPTY of the casings the wire has produced ("iD",
 * "id", "Id", "ID"). Not `iD ?? id` — `??` only skips null, so a build that sends `iD: ""` beside
 * a real id read as "", and that player vanished from every check built on it. For both current
 * games this is also the identity (playerIdentityOf); use that where a module is in hand.
 */
export function rosterPlayerId(pl: Record<string, unknown> | null | undefined): string {
  if (!pl) return "";
  return [pl.iD, pl.id, pl.Id, pl.ID].map((v) => String(v ?? "").trim()).find((v) => v) ?? "";
}

export function playerIdentityOf(mod: GameModule | undefined, pl: Record<string, unknown>): PlayerIdentity | null {
  if (mod?.identity) return mod.identity(pl);
  // Every casing of the same field, because the wire has produced several (binary v2 mangles
  // acronyms — `iD` — and other builds spell it plainly). Same word only: picking a DIFFERENT
  // field as identity is how players get keyed by an id the game will not act on. First
  // NON-EMPTY, not `??`: a build that sends `iD: ""` beside a real id under another casing
  // would otherwise drop the player on the empty string.
  const platformId = [pl?.iD, pl?.id, pl?.Id, pl?.ID]
    .map((v) => String(v ?? "").trim()).find((v) => v) ?? "";
  if (!platformId) return null;
  return {
    platform: String(pl?.platform ?? "unknown") || "unknown",
    platformId,
    ...(pl?.eosId ? { links: [{ provider: "eos", externalId: String(pl.eosId) }] } : {}),
  };
}

/** Resolve a module, throwing a clear error for unknown games (API write paths). */
export function requireGame(id: string | null | undefined): GameModule {
  const mod = getGame(id);
  if (!mod) throw new Error(`No game module registered for '${id ?? ""}' (known: ${[...MODULES.keys()].join(", ")})`);
  return mod;
}

export function listGames(): GameModule[] {
  return [...MODULES.values()];
}

/**
 * The live reads a message placeholder may ask for ({map_name}, {player_count}, {players_needed},
 * {next_map}), for either game — the session through the shared normalizer, the rotation through
 * this game's own reader. Nothing is read until a placeholder asks; the renderer caches each read
 * for its batch.
 */
export function liveFactsFor(client: { readState(kind: StateKind): Promise<unknown> }, gameId: string | null | undefined): {
  session(): Promise<{ mapName: string | null; playerCount: number | null }>;
  rotation(): Promise<{ maps: string[]; currentIndex: number }>;
} {
  return {
    session: async () => {
      const s = normalizeSession(await client.readState("session"));
      return { mapName: s.mapName ?? null, playerCount: s.playerCount ?? null };
    },
    rotation: async () => stateReaderFor(gameId).rotation(await client.readState("maprotation")),
  };
}
