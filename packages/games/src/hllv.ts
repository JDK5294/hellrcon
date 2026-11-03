/**
 * The Hell Let Loose: Vietnam game module.
 *
 * Vietnam ships the same RCON TRANSPORT as HLL, and the official protocol PDF confirms that much
 * wire for wire: the 0xDE450508 magic, the 12-byte header, the XOR handshake out of ServerConnect,
 * Login, and the same envelope. The admin log is the same engine writing the same sentences with
 * new faction tokens, which the normalizer was already built to accept (any token before the
 * slash — task #158). So the log normalizer and state readers are REUSED outright.
 *
 * The COMMAND SET is a different matter, and this module used to get it wrong: it set
 * `commands: HLL_BINARY_V2`, on the reading that the two games' verbs match. They mostly do, but
 * not entirely — `docs/hll-vietnam.md` §2.2–2.4 had already catalogued the exceptions from the same
 * PDF. Sending HLL's spelling to a Vietnam server is silent rather than loud (a wrong body is
 * accepted, applied to nothing, and answered 200), so those divergences showed up as features that
 * did nothing rather than as errors. `hllv/commands.ts` now holds Vietnam's table: HLL's, plus one
 * named override per documented difference.
 *
 * What is otherwise Vietnam's own is the DOMAIN DATA (hllv/data.ts: US/NVA, the mortar and
 * helicopter platoons, the weapon table) and the IDENTITY RULE below.
 */
import { HLLV_BINARY_V2 } from "./hllv/commands.js";
import { normalizeLine, logLineKey } from "./hll/log.js";
import { parseRotation, parseNextInRotation, parseMapShuffle, parseMapEntries, parseMapCatalogue, parsePlayerCount } from "./hll/state.js";
import { HLLV_ROLES, HLLV_SIDES, HLLV_SQUAD_LEADER_ROLES, HLLV_WEAPON_CLASSES } from "./hllv/data.js";
import { HLLV_WEAPON_NAMES, HLLV_COMMANDER_ABILITIES } from "./hllv/weapon-names.js";
import type { GameModule, PlayerIdentity } from "./types.js";

/**
 * Vietnam's identity rule — the one decision in this module that can fork a human into two rows,
 * or worse, key them by an id the game itself will not act on.
 *
 * Vietnam does NOT identify players by the Steam64. The roster's `Id` is a per-game EOS id and it
 * is THE player id: every command that takes a PlayerId — AddVip, RemoveVip, PunishPlayer,
 * TemporaryBanPlayer, MessagePlayer, all of them — means this value. `SteamId` rides alongside as
 * information only. The first version of this rule keyed Steam players by their Steam64 anyway,
 * for continuity with their HLL profile — which merged their Vietnam self into their WW2 row and
 * made every action the panel took against them a command the server accepted and matched against
 * nobody. VIP grants on the Vietnam server silently did nothing; that is not continuity, it is a
 * row the game cannot address.
 *
 * So the EOS id keys the row, always. The Steam64 is kept as an external link, where it stays
 * searchable and is the join point for connecting a person's Vietnam account to their WW2 one.
 */
/**
 * Which namespace the companion id in the `SteamId` field belongs to — decided by SHAPE, because
 * the wire calls the field "steamId" for EVERYONE while carrying whatever the player's platform
 * account id is. For a console player that is an Xbox XUID (16 digits in the 25332… range), and
 * filing it under "steam" printed a number that is not a Steam id under a STEAM heading on the
 * profile — and would poison the cross-game account join, which matches on (provider, id).
 * An id matching neither shape is still kept, under the honest name for "the platform account id
 * whose namespace we could not tell".
 */
function companionProvider(id: string): string {
  if (/^765\d{14}$/.test(id)) return "steam";
  if (/^25332\d{11}$/.test(id)) return "xbox";
  return "account";
}

function hllvIdentity(pl: Record<string, unknown>): PlayerIdentity | null {
  const steamId = String(pl?.steamId ?? pl?.SteamId ?? "").trim();
  // First NON-EMPTY across the casings the wire has produced — see playerIdentityOf's default.
  const eosId = [pl?.iD, pl?.id, pl?.Id, pl?.ID]
    .map((v) => String(v ?? "").trim()).find((v) => v) ?? "";
  const platform = String(pl?.platform ?? "unknown") || "unknown";
  if (!eosId) return null;
  return { platform, platformId: eosId, ...(steamId ? { links: [{ provider: companionProvider(steamId), externalId: steamId }] } : {}) };
}

export const HLLV_GAME: GameModule = {
  id: "hllv",
  label: "Hell Let Loose: Vietnam",
  protocols: [
    { id: "binary-v2", label: "binary-v2 (official Vietnam RCON)" },
    { id: "legacy-text", label: "legacy-text (external RconClient)" },
  ],
  commands: HLLV_BINARY_V2,
  normalizeLine,
  logLineKey,
  stateReader: { rotation: parseRotation, nextInRotation: parseNextInRotation, mapShuffle: parseMapShuffle, mapEntries: parseMapEntries, mapCatalogue: parseMapCatalogue, playerCount: parsePlayerCount },
  identity: hllvIdentity,
  descriptor: {
    id: "hllv",
    label: "Hell Let Loose: Vietnam",
    sides: HLLV_SIDES,
    roles: HLLV_ROLES,
    squadLeaderRoles: HLLV_SQUAD_LEADER_ROLES,
    // The game calls a squad a platoon (RemovePlayerFromPlatoon, the roster's `Platoon` field).
    squadLabel: "Platoon",
    // The five platoon types and the roles each offers (see HLLV_SQUAD_LEADER_ROLES for their
    // leaders). The Commander (20) leads the army, not a platoon.
    squadTypes: { infantry: [0, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], mortar: [13, 14, 15], helicopter: [16, 17] },
    // Same engine, same v2 scoreData keys — including the server's own cOMBAT capitalisation
    // quirk, which HLL live captures established and Vietnam inherits until a capture says
    // otherwise.
    scoreFields: [
      { key: "cOMBAT", label: "Cbt", title: "Combat score" },
      { key: "offense", label: "Off", title: "Offense score" },
      { key: "defense", label: "Def", title: "Defense score" },
      { key: "support", label: "Sup", title: "Support score" },
    ],
    // The settings surface reads the same as HLL's — the PDF documents the same setters with the
    // same argument names — so these fields name the same logical commands. Where the WIRE behind
    // one differs (the welcome message is `SetNoticeMessage` here), the game's own table absorbs
    // it; a descriptor names logical commands and never a wire.
    configFields: [
      { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", read: { command: "getAutoBalanceEnabled", key: "enable" }, write: { command: "setAutoBalanceEnabled", param: "enabled" } },
      { field: "autoBalanceThreshold", label: "Auto-balance threshold", kind: "num", read: { command: "getAutoBalanceThreshold", key: "autoBalanceThreshold" }, write: { command: "setAutoBalanceThreshold", param: "threshold" } },
      { field: "highPing", label: "High-ping kick (ms)", kind: "num", read: { command: "getHighPing", key: "highPingThresholdMs" }, write: { command: "setHighPing", param: "ms" } },
      { field: "idleKick", label: "Idle kick (minutes)", kind: "num", read: { command: "getIdleKickTime", key: "idleTimeoutMinutes" }, write: { command: "setKickIdleTime", param: "minutes" } },
      { field: "teamSwitchCooldown", label: "Team-switch cooldown (minutes)", kind: "num", read: { command: "getTeamSwitchCooldown", key: "teamSwitchTimer" }, write: { command: "setTeamSwitchCooldown", param: "minutes" } },
      { field: "voteKickEnabled", label: "Vote kick", kind: "bool", read: { command: "getVoteKickEnabled", key: "enable" }, write: { command: "setVoteKickEnabled", param: "enabled" } },
      { field: "maxQueuedPlayers", label: "Max queued players", kind: "num", write: { command: "setMaxQueuedPlayers", param: "count" } },
      { field: "numVipSlots", label: "VIP slots", kind: "num", write: { command: "setNumVipSlots", param: "count" } },
      // The game calls this a notice, and shows it on join as well as on demand (PDF p18).
      { field: "welcomeMessage", label: "Notice message", kind: "str", write: { command: "setWelcomeMessage", param: "message" } },
      // Shuffled, the game ignores the order the rotation is listed in. Set on Live settings or by an
      // Auto settings profile; the Maps tab only reports it (the owner's call: no switch there).
      { field: "mapShuffle", label: "Map shuffle", kind: "bool", read: { command: "getMapShuffleEnabled", key: "enable" }, write: { command: "setMapShuffleEnabled", param: "enabled" } },
    ],
    weaponClasses: HLLV_WEAPON_CLASSES,
    weaponCatalog: HLLV_WEAPON_NAMES,
    commanderAbilities: HLLV_COMMANDER_ABILITIES,
  },
};
