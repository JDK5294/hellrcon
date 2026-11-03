/**
 * HLL command table — maps each *logical* command to its wire form per protocol (part of the
 * HLL game module; other games ship their own table).
 *
 * This is the data-driven RCON command layer: the rest of the system speaks logical
 * commands ("kick this player") and never cares which protocol/version a server runs.
 *
 * Wire sources:
 *  - **legacy-text** templates are authoritative — taken verbatim from the game's official
 *    external RCON client (`Commands.xml`, RCON_503). See docs/rcon-503.md, "v1 (legacy text) catalogue".
 *  - **binary-v2** command names AND request-body field schemas are authoritative — command names
 *    from a live `GetDisplayableCommands` and the exact `contentBody` field names cross-checked
 *    against the official v2 client + CRCON's protocol layer (format knowledge only; see
 *    docs/rcon-503.md, "v2 command surface" and "v2 payload shapes"). Getters take no body; every write carries its confirmed
 *    v2 wire. Commands without a `binaryV2` wire genuinely have no v2 equivalent (e.g. the legacy
 *    `togglemapshuffle`, whose v2 form is a set rather than a toggle).
 *
 * Access classification (`read` | `write`) is what the engagement-mode guard uses to keep
 * `observe` servers read-only (safe alongside an existing CRCON).
 */

export type LogicalCommand =
  // reads
  | "getPlayers"
  | "getSession"
  | "getServerConfig"
  | "getObjectives"
  | "getAdminLog"
  | "getServerName"
  | "getCurrentMap"
  | "getSlots"
  | "getGameMode"
  | "getTempBans"
  | "getPermaBans"
  | "getVipIds"
  | "getAdminIds"
  | "getAdminGroups"
  | "getMapsForRotation"
  | "getMapReferenceList"
  | "getChangeMapList"
  | "getObjectiveRows"
  | "getMapRotation"
  | "getMapSequence"
  | "getMapShuffleEnabled"
  | "getAutoBalanceEnabled"
  | "getAutoBalanceThreshold"
  | "getIdleKickTime"
  | "getHighPing"
  | "getMaxQueuedPlayers"
  | "getNumVipSlots"
  | "getTeamSwitchCooldown"
  | "getProfanity"
  | "getVoteKickEnabled"
  | "getVoteKickThreshold"
  | "getPlayerInfo"
  | "getServerCommands"
  // writes: player actions
  | "messagePlayer"
  | "kickPlayer"
  | "punishPlayer"
  | "tempBanPlayer"
  | "permaBanPlayer"
  | "removeTempBan"
  | "removePermaBan"
  | "switchTeamNow"
  | "switchTeamOnDeath"
  | "setSectorLayout"
  | "removeSectorLayout"
  // writes: map management
  | "changeMap"
  | "addMapToRotation"
  | "removeMapFromRotation"
  | "toggleMapShuffle"
  | "setMapShuffleEnabled"
  // writes: messaging
  | "broadcast"
  | "setWelcomeMessage"
  // writes: VIP / admin
  | "addVip"
  | "removeVip"
  | "setNumVipSlots"
  | "addAdmin"
  | "removeAdmin"
  // writes: server config
  | "setKickIdleTime"
  | "setHighPing"
  | "setAutoBalanceEnabled"
  | "setAutoBalanceThreshold"
  | "setTeamSwitchCooldown"
  | "setMaxQueuedPlayers"
  | "banProfanity"
  | "unbanProfanity"
  | "setVoteKickEnabled"
  | "setVoteKickThreshold"
  | "resetVoteKickThreshold";

export type CommandAccess = "read" | "write";

export interface BinaryV2Wire {
  /** v2 command name on the wire. */
  name: string;
  /** protocol/command version negotiated with the server. */
  version: number;
  /** builds the `contentBody` from logical params — usually a JSON object, but a few v2 commands
   *  (e.g. GetClientReferenceData) take a bare string body. */
  content: (params: Record<string, unknown>) => Record<string, unknown> | string;
}

/** Legacy text protocol: a command is a single line of text (see the HLL legacy RCON docs). */
export interface LegacyTextWire {
  /** builds the text command line sent over the (XOR-framed) socket. */
  build: (params: Record<string, unknown>) => string;
}

export interface CommandDef {
  logical: LogicalCommand;
  access: CommandAccess;
  /** present only where the v2 name is confirmed; absent → not mapped for binary-v2 yet. */
  binaryV2?: BinaryV2Wire;
  /** present for commands the legacy text protocol supports (authoritative from Commands.xml). */
  legacyText?: LegacyTextWire;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
/** Quote a legacy argument (all legacy args with spaces must be quoted; we always quote). */
const q = (v: unknown): string => `"${str(v).replace(/"/g, "")}"`;
/** Legacy boolean encoding (on/off). */
const onoff = (v: unknown): string => (bool_(v) ? "on" : "off");
/** binary-v2 boolean: a real JSON boolean (the v2 setters take `{Enable: true|false}`). */
const bool_ = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === "1" || Number(v) === 1;
/** Coerce a comma-separated string (or array) of words into the array the v2 banned-words API wants. */
const wordList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : str(v).split(",").map((s) => s.trim()).filter(Boolean));

/** Read getter with a fixed `get …` legacy template and no binary-v2 mapping. */
const getter = (logical: LogicalCommand, template: string): CommandDef => ({ logical, access: "read", legacyText: { build: () => template } });
/**
 * Read getter that also has a confirmed binary-v2 command name (from GetDisplayableCommands).
 * These standalone getters take no request body, so `content` is empty. Response *formats* are
 * captured live per command; the adapter returns the parsed content as-is.
 */
const getterV2 = (logical: LogicalCommand, template: string, v2name: string, version = 2): CommandDef => ({
  logical,
  access: "read",
  legacyText: { build: () => template },
  binaryV2: { name: v2name, version, content: () => ({}) },
});
/** Write command with a legacy template builder and (optionally) a binary-v2 wire. */
const legacy = (logical: LogicalCommand, build: (p: Record<string, unknown>) => string, binaryV2?: BinaryV2Wire): CommandDef => ({ logical, access: "write", legacyText: { build }, ...(binaryV2 ? { binaryV2 } : {}) });

/**
 * HLL command table. legacy-text templates are authoritative (Commands.xml); binary-v2 wires are
 * present where confirmed.
 */
export const HLL_BINARY_V2: Record<LogicalCommand, CommandDef> = {
  // ---- reads ----
  getPlayers: {
    logical: "getPlayers",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "players", Value: "" }) },
    legacyText: { build: () => "Get PlayerIds" }, // names + UIDs (tab-separated, leading count)
  },
  getSession: {
    logical: "getSession",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "session", Value: "" }) },
    legacyText: { build: () => "get gamestate" },
  },
  // The server's own identity card: name, build, platforms, whether it is passworded. Reached the
  // same way session/players/maprotation are — GetServerInformation with an info name — because v2
  // exposes no standalone getter for it (docs/hll-vietnam.md §2.4, rcon-v2.txt "serverconfig").
  // Legacy text has no equivalent, so a legacy server simply cannot answer this.
  getServerConfig: {
    logical: "getServerConfig",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "serverconfig", Value: "" }) },
  },
  getObjectives: {
    logical: "getObjectives",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "objectives", Value: "" }) },
  },
  /**
   * The server's OWN command catalogue — the discovery call the official client opens every
   * session with. v2-only by nature: a legacy-text server's surface is fixed by Commands.xml and
   * has nothing to enumerate. This is how a game update's new verbs get noticed: the client
   * package ships no list (RCON_504 proved that — byte-identical Commands.xml, same assembly),
   * so the only place "what can this server do NOW" lives is the running server itself.
   */
  getServerCommands: {
    logical: "getServerCommands",
    access: "read",
    binaryV2: { name: "GetDisplayableCommands", version: 2, content: () => ({}) },
  },
  getAdminLog: {
    logical: "getAdminLog",
    access: "read",
    binaryV2: { name: "GetAdminLog", version: 2, content: (p) => ({ LogBackTrackTime: Number(p.seconds ?? 60), Filters: str(p.filter) }) },
    legacyText: { build: (p) => `ShowLog ${Math.max(1, Math.ceil(Number(p.seconds ?? 60) / 60))}` },
  },
  getServerName: getter("getServerName", "get name"),
  getCurrentMap: getter("getCurrentMap", "get map"),
  getSlots: getter("getSlots", "get slots"),
  getGameMode: getter("getGameMode", "get gamemode"),
  getTempBans: getterV2("getTempBans", "get tempbans", "GetTemporaryBans"),
  getPermaBans: getterV2("getPermaBans", "get permabans", "GetPermanentBans"),
  // No STANDALONE v2 getter exists (GetDisplayableCommands 2026-07-23), but GetServerInformation
  // answers a `vipplayers` info request — confirmed on a live server 2026-08-15, which returned a
  // structured `{"vipPlayers":[...]}`. Lowercase on the wire: that is the spelling the capture
  // proved, and the request examples in Team 17's own docs use undecorated info names.
  getVipIds: {
    logical: "getVipIds",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "vipplayers", Value: "" }) },
    legacyText: { build: () => "get vipids" },
  },
  getAdminIds: getterV2("getAdminIds", "get adminids", "GetAdminUsers"),
  getAdminGroups: getterV2("getAdminGroups", "get admingroups", "GetAdminGroups"),
  getMapsForRotation: getter("getMapsForRotation", "get mapsforrotation"), // v2 exposes this via GetServerInformation
  // Authoritative catalogue of installable maps: GetClientReferenceData("AddMapToRotation") returns the
  // full comma-list under dialogueParameters[MapName]. This is the discovery the emergency-mapvote logic
  // relies on (broader than the current rotation pool). Read-only; binary-v2 takes a bare string body.
  getMapReferenceList: {
    logical: "getMapReferenceList",
    access: "read",
    binaryV2: { name: "GetClientReferenceData", version: 2, content: () => "AddMapToRotation" },
    legacyText: { build: () => "get mapsforrotation" }, // best-effort fallback (rotation pool only)
  },
  /**
   * The maps `ChangeMap` will accept — ITS OWN option list, not the one above.
   *
   * GetClientReferenceData is per-command: you ask it about a command and it answers with the
   * options that command takes. We had only ever asked about AddMapToRotation and then used the
   * answer for both, on the assumption that a map you can add to the rotation is a map you can
   * switch to. When the two vocabularies disagree the game does not complain — ChangeMap answers
   * 200 and does nothing at all, which is indistinguishable from success at this layer and is
   * exactly what "the map didn't change when applied from the catalogue" looks like.
   *
   * Read-only, same shape as its sibling (the option is called MapName in both), so it parses with
   * the same catalogue parser. A build that doesn't answer leaves callers with an empty list, which
   * they must read as "unknown, don't restrict" rather than "nothing is allowed".
   */
  getChangeMapList: {
    logical: "getChangeMapList",
    access: "read",
    binaryV2: { name: "GetClientReferenceData", version: 2, content: () => "ChangeMap" },
  },
  // The 5x3 objective grid for the CURRENT map: GetClientReferenceData("SetSectorLayout") returns
  // five Sector_N rows, each a comma-list of the three objectives that row can run. Read-only.
  getObjectiveRows: {
    logical: "getObjectiveRows",
    access: "read",
    binaryV2: { name: "GetClientReferenceData", version: 2, content: () => "SetSectorLayout" },
  },
  // Choose the objective each sector runs this match (one per row, from getObjectiveRows). The
  // game applies it to the CURRENT match immediately.
  setSectorLayout: {
    logical: "setSectorLayout",
    access: "write",
    binaryV2: { name: "SetSectorLayout", version: 2, content: (p) => ({
      Sector_1: str(p.sector1), Sector_2: str(p.sector2), Sector_3: str(p.sector3),
      Sector_4: str(p.sector4), Sector_5: str(p.sector5),
    }) },
  },
  /**
   * Deliberately WIRELESS on HLL: WW2 stores no objective layouts — its set applies once to the
   * round in play (restarting it) and leaves nothing to remove. The logical exists so the two
   * games' tables stay key-identical (a delta, never a subset); executing it here fails with the
   * transport's own "not mapped" instead of inventing a verb the server does not have. Vietnam
   * overrides it with the real RemoveSectorLayout (p11).
   */
  removeSectorLayout: {
    logical: "removeSectorLayout",
    access: "write",
  },
  /*
   * The game's own play queue — a second list beside the rotation (docs/hll-vietnam.md, p13), with
   * the place the game is at in it — and whether the game shuffles that queue. Read so the rotation
   * page can check what the game says it will play next, not just what the rotation list implies.
   * Both are in the live 5.03 catalogue; a server that does not answer leaves them unknown.
   */
  getMapSequence: {
    logical: "getMapSequence",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "mapsequence", Value: "" }) },
    legacyText: { build: () => "listcurrentmapsequence" },
  },
  getMapShuffleEnabled: getterV2("getMapShuffleEnabled", "querymapshuffle", "GetMapShuffleEnabled"),
  // v2 exposes the rotation via GetServerInformation (Name: "maprotation"), same as session/players.
  getMapRotation: {
    logical: "getMapRotation",
    access: "read",
    binaryV2: { name: "GetServerInformation", version: 2, content: () => ({ Name: "maprotation", Value: "" }) },
    legacyText: { build: () => "get mapsinrotation" },
  },
  getAutoBalanceEnabled: getterV2("getAutoBalanceEnabled", "get autobalanceenabled", "GetAutoBalanceEnabled"),
  getAutoBalanceThreshold: getterV2("getAutoBalanceThreshold", "get autobalancethreshold", "GetAutoBalanceThreshold"),
  getIdleKickTime: getterV2("getIdleKickTime", "get idletime", "GetKickIdleDuration"),
  getHighPing: getterV2("getHighPing", "get highping", "GetHighPingThreshold"),
  getMaxQueuedPlayers: getter("getMaxQueuedPlayers", "get maxqueuedplayers"), // no standalone v2 getter
  getNumVipSlots: getter("getNumVipSlots", "get numvipslots"), // no standalone v2 getter
  getTeamSwitchCooldown: getterV2("getTeamSwitchCooldown", "get teamswitchcooldown", "GetTeamSwitchCooldown"),
  getProfanity: getter("getProfanity", "get profanity"), // no standalone v2 getter (banned-words getter not exposed)
  getVoteKickEnabled: getterV2("getVoteKickEnabled", "get votekickenabled", "GetVoteKickEnabled"),
  getVoteKickThreshold: getterV2("getVoteKickThreshold", "get votekickthreshold", "GetVoteKickThreshold"),
  getPlayerInfo: { logical: "getPlayerInfo", access: "read", legacyText: { build: (p) => `playerinfo ${str(p.playerId)}` } },

  // ---- writes: player actions ----
  messagePlayer: {
    logical: "messagePlayer",
    access: "write",
    binaryV2: { name: "MessagePlayer", version: 2, content: (p) => ({ Message: str(p.message), PlayerId: str(p.playerId) }) },
    legacyText: { build: (p) => `Message ${q(p.playerId)} ${q(p.message)}` },
  },
  kickPlayer: {
    logical: "kickPlayer",
    access: "write",
    binaryV2: { name: "KickPlayer", version: 2, content: (p) => ({ PlayerId: str(p.playerId), Reason: str(p.reason) }) },
    legacyText: { build: (p) => `Kick ${q(p.playerId)} ${q(p.reason)}` },
  },
  punishPlayer: {
    logical: "punishPlayer",
    access: "write",
    binaryV2: { name: "PunishPlayer", version: 2, content: (p) => ({ PlayerId: str(p.playerId), Reason: str(p.reason) }) },
    legacyText: { build: (p) => `Punish ${q(p.playerId)} ${q(p.reason)}` },
  },
  tempBanPlayer: {
    logical: "tempBanPlayer",
    access: "write",
    binaryV2: { name: "TemporaryBanPlayer", version: 2, content: (p) => ({ PlayerId: str(p.playerId), Duration: Number(p.hours ?? 0), Reason: str(p.reason), AdminName: str(p.adminName) }) },
    legacyText: { build: (p) => `TempBan ${q(p.playerId)} ${Math.max(1, Number(p.hours ?? 2))} ${q(p.reason)} ${q(p.adminName)}` },
  },
  permaBanPlayer: {
    logical: "permaBanPlayer",
    access: "write",
    binaryV2: { name: "PermanentBanPlayer", version: 2, content: (p) => ({ PlayerId: str(p.playerId), Reason: str(p.reason), AdminName: str(p.adminName) }) },
    legacyText: { build: (p) => `PermaBan ${q(p.playerId)} ${q(p.reason)} ${q(p.adminName)}` },
  },
  removeTempBan: {
    logical: "removeTempBan",
    access: "write",
    binaryV2: { name: "RemoveTemporaryBan", version: 2, content: (p) => ({ PlayerId: str(p.playerId) }) },
    legacyText: { build: (p) => `pardontempban ${str(p.playerId)}` }, // authoritative: pardontempban {ban}
  },
  removePermaBan: {
    logical: "removePermaBan",
    access: "write",
    binaryV2: { name: "RemovePermanentBan", version: 2, content: (p) => ({ PlayerId: str(p.playerId) }) },
    legacyText: { build: (p) => `pardonpermaban ${str(p.playerId)}` }, // authoritative: pardonpermaban {ban}
  },
  // ForceTeamSwitch ForceMode: 1 = immediately, 0 = on next death (confirmed from the v2 client).
  switchTeamNow: legacy("switchTeamNow", (p) => `switchteamnow ${q(p.playerId)}`, { name: "ForceTeamSwitch", version: 2, content: (p) => ({ PlayerId: str(p.playerId), ForceMode: 1 }) }),
  switchTeamOnDeath: legacy("switchTeamOnDeath", (p) => `switchteamondeath ${q(p.playerId)}`, { name: "ForceTeamSwitch", version: 2, content: (p) => ({ PlayerId: str(p.playerId), ForceMode: 0 }) }),

  // ---- writes: map management ----
  changeMap: legacy("changeMap", (p) => `map ${str(p.mapName)}`, { name: "ChangeMap", version: 2, content: (p) => ({ MapName: str(p.mapName) }) }),
  // v2 addressing is by rotation Index (legacy is by name+after) — both accepted via params.
  /*
   * The two wires place an entry differently and cannot be made to agree in general: v2 inserts at
   * `Index`, legacy inserts after a NAMED entry and appends when told none — with no way at all to
   * express "put it first". Callers pass `index` and omit `after`, so on a legacy server a map
   * lands at the end of the rotation instead of at the requested position.
   *
   * That is a real divergence, and it is left alone deliberately rather than half-emulated: the one
   * caller where placement decides behaviour is scheduleNextMap, which only ever inserts at index 1
   * of a one-entry rotation — appending IS index 1 there, so the vote queues its winner correctly on
   * both wires. What differs is manual reordering from the panel, where a legacy server appends.
   */
  addMapToRotation: legacy("addMapToRotation", (p) => `rotadd ${str(p.mapName)}${p.after ? ` ${str(p.after)}` : ""}`, { name: "AddMapToRotation", version: 2, content: (p) => ({ MapName: str(p.mapName), Index: Number(p.index ?? 0) }) }),
  removeMapFromRotation: legacy("removeMapFromRotation", (p) => `rotdel ${str(p.mapName)}`, { name: "RemoveMapFromRotation", version: 2, content: (p) => ({ Index: Number(p.index ?? 0) }) }),
  toggleMapShuffle: legacy("toggleMapShuffle", () => "togglemapshuffle"), // v2 is a set (SetMapShuffleEnabled), not a toggle — kept legacy-only
  /*
   * Map shuffle as a SET — what a settings switch needs. Deliberately no legacy wire: legacy text
   * can only TOGGLE (`togglemapshuffle`), and a toggle sent to switch shuffle off turns a shuffle
   * that is already off ON. A legacy server refuses this instead of flipping the wrong way.
   * SetMapShuffleEnabled is in the live 5.03 catalogue; Vietnam documents it too (p13).
   */
  setMapShuffleEnabled: {
    logical: "setMapShuffleEnabled",
    access: "write",
    binaryV2: { name: "SetMapShuffleEnabled", version: 2, content: (p) => ({ Enable: bool_(p.enabled) }) },
  },

  // ---- writes: messaging ----
  broadcast: legacy("broadcast", (p) => `broadcast ${str(p.message)}`, { name: "ServerBroadcast", version: 2, content: (p) => ({ Message: str(p.message) }) }),
  setWelcomeMessage: legacy("setWelcomeMessage", (p) => `say ${str(p.message)}`, { name: "SetWelcomeMessage", version: 2, content: (p) => ({ Message: str(p.message) }) }),

  // ---- writes: VIP / admin ----
  addVip: legacy("addVip", (p) => `vipadd ${q(p.playerId)} ${q(p.description)}`, { name: "AddVip", version: 2, content: (p) => ({ PlayerId: str(p.playerId), Comment: str(p.description) }) }),
  removeVip: legacy("removeVip", (p) => `vipdel ${str(p.playerId)}`, { name: "RemoveVip", version: 2, content: (p) => ({ PlayerId: str(p.playerId) }) }),
  setNumVipSlots: legacy("setNumVipSlots", (p) => `setnumvipslots ${Number(p.count ?? 0)}`, { name: "SetVipSlotCount", version: 2, content: (p) => ({ VipSlotCount: Number(p.count ?? 0) }) }),
  addAdmin: legacy("addAdmin", (p) => `adminadd ${q(p.playerId)} ${q(p.group)} ${q(p.comment)}`, { name: "AddAdmin", version: 2, content: (p) => ({ PlayerId: str(p.playerId), AdminGroup: str(p.group), Comment: str(p.comment) }) }),
  removeAdmin: legacy("removeAdmin", (p) => `admindel ${str(p.playerId)}`, { name: "RemoveAdmin", version: 2, content: (p) => ({ PlayerId: str(p.playerId) }) }),

  // ---- writes: server config ----
  setKickIdleTime: legacy("setKickIdleTime", (p) => `setkickidletime ${Number(p.minutes ?? 0)}`, { name: "SetIdleKickDuration", version: 2, content: (p) => ({ IdleTimeoutMinutes: Number(p.minutes ?? 0) }) }),
  setHighPing: legacy("setHighPing", (p) => `sethighping ${Number(p.ms ?? 0)}`, { name: "SetHighPingThreshold", version: 2, content: (p) => ({ HighPingThresholdMs: Number(p.ms ?? 0) }) }),
  setAutoBalanceEnabled: legacy("setAutoBalanceEnabled", (p) => `setautobalanceenabled ${onoff(p.enabled)}`, { name: "SetAutoBalanceEnabled", version: 2, content: (p) => ({ Enable: bool_(p.enabled) }) }),
  setAutoBalanceThreshold: legacy("setAutoBalanceThreshold", (p) => `setautobalancethreshold ${Number(p.threshold ?? 0)}`, { name: "SetAutoBalanceThreshold", version: 2, content: (p) => ({ AutoBalanceThreshold: Number(p.threshold ?? 0) }) }),
  setTeamSwitchCooldown: legacy("setTeamSwitchCooldown", (p) => `setteamswitchcooldown ${Number(p.minutes ?? 0)}`, { name: "SetTeamSwitchCooldown", version: 2, content: (p) => ({ TeamSwitchTimer: Number(p.minutes ?? 0) }) }),
  setMaxQueuedPlayers: legacy("setMaxQueuedPlayers", (p) => `setmaxqueuedplayers ${Number(p.count ?? 1)}`, { name: "SetMaxQueuedPlayers", version: 2, content: (p) => ({ MaxQueuedPlayers: Number(p.count ?? 1) }) }),
  banProfanity: legacy("banProfanity", (p) => `banprofanity ${str(p.words)}`, { name: "AddBannedWords", version: 2, content: (p) => ({ BannedWords: wordList(p.words) }) }),
  // `word ?? words` in BOTH halves, not just the binary one. The only caller — the chat filter's
  // censor push — sends a list under `words`, so the legacy template's lone `p.word` rendered
  // "unbanprofanity " with nothing after it: a removal that quietly took nothing off the server's
  // list while the app recorded it as applied. There is no banned-words getter to reconcile
  // against, so those words would have stayed starred out of chat with nothing to show why.
  unbanProfanity: legacy("unbanProfanity", (p) => `unbanprofanity ${str(p.word ?? p.words)}`, { name: "RemoveBannedWords", version: 2, content: (p) => ({ BannedWords: wordList(p.word ?? p.words) }) }),
  setVoteKickEnabled: legacy("setVoteKickEnabled", (p) => `setvotekickenabled ${onoff(p.enabled)}`, { name: "SetVoteKickEnabled", version: 2, content: (p) => ({ Enable: bool_(p.enabled) }) }),
  setVoteKickThreshold: legacy("setVoteKickThreshold", (p) => `setvotekickthreshold ${str(p.thresholds)}`, { name: "SetVoteKickThreshold", version: 2, content: (p) => ({ ThresholdValue: p.thresholds }) }),
  resetVoteKickThreshold: legacy("resetVoteKickThreshold", () => "resetvotekickthreshold", { name: "ResetVoteKickThreshold", version: 2, content: () => ({}) }),
};

export function commandDef(logical: LogicalCommand): CommandDef {
  const def = HLL_BINARY_V2[logical];
  if (!def) throw new Error(`Unknown logical command: ${logical}`);
  return def;
}

/**
 * Every v2 command name our references know — the live `GetDisplayableCommands` capture of
 * 2026-07-23 (docs/rcon-503.md, "v2 command surface"), which predates the 5.04 game update on purpose: it is the
 * BASELINE the capability probe diffs a live server against, so anything a later update added
 * shows up as "new to us" instead of vanishing into the list. Do not "freshen" this from a newer
 * server — that would define the new verbs out of existence. A name being here says nothing
 * about whether the panel drives it; that comes from the command table's `binaryV2` wires.
 */
export const V2_CATALOGUE_503: readonly string[] = [
  "AddAdmin", "RemoveAdmin", "GetAdminGroups", "GetAdminUsers",
  "AddBannedWords", "RemoveBannedWords",
  "AddMapToRotation", "RemoveMapFromRotation",
  "AddMapToSequence", "RemoveMapFromSequence", "MoveMapInSequence",
  "ChangeMap", "GetMapShuffleEnabled", "SetMapShuffleEnabled",
  "AddVip", "RemoveVip", "SetVipSlotCount",
  "DisbandPlatoon", "RemovePlayerFromPlatoon",
  "ForceTeamSwitch", "GetTeamSwitchCooldown", "SetTeamSwitchCooldown",
  "GetAutoBalanceEnabled", "SetAutoBalanceEnabled", "GetAutoBalanceThreshold", "SetAutoBalanceThreshold",
  "KickPlayer", "PunishPlayer", "MessagePlayer", "MessageAllPlayers",
  "TemporaryBanPlayer", "PermanentBanPlayer", "RemoveTemporaryBan", "RemovePermanentBan",
  "GetTemporaryBans", "GetPermanentBans",
  "GetHighPingThreshold", "SetHighPingThreshold",
  "GetKickIdleDuration", "SetIdleKickDuration",
  "GetVoteKickEnabled", "SetVoteKickEnabled",
  "GetVoteKickThreshold", "SetVoteKickThreshold", "ResetVoteKickThreshold",
  "SetMatchTimer", "RemoveMatchTimer", "SetWarmupTimer", "RemoveWarmupTimer",
  "GetServerInformation", "GetServerChangelist",
  "SetWelcomeMessage", "SetDynamicWeatherEnabled", "SetMaxQueuedPlayers", "SetSectorLayout",
  "GetClientReferenceData", "GetDisplayableCommands", "GetAdminLog",
  "Login", "ServerConnect",
];

export function isWrite(logical: LogicalCommand): boolean {
  return commandDef(logical).access === "write";
}
