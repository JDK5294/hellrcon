/**
 * HLL: Vietnam's command table — HLL's, plus the deltas Team 17's own RCON document states.
 *
 * ## Why this file exists
 *
 * Vietnam's module used to set `commands: HLL_BINARY_V2` outright, on the reasoning that the two
 * games ship the same RCON. The transport genuinely is the same — same magic, same 12-byte header,
 * same XOR handshake, same envelope — and so are most of the verbs. But "the protocol is the same"
 * is not "the command set is the same", and `docs/hll-vietnam.md` §2.2–2.4 had already written down
 * the places they part company. Sharing the table meant every one of those was a command we send to
 * a Vietnam server in HLL's spelling.
 *
 * That failure mode is quiet by construction. A v2 server that dislikes a command answers with a
 * status code on a socket nobody is watching for this, and a command whose *body* is wrong is worse
 * still: the server accepts it, applies it to nothing, and returns 200. So a wrong wire here does
 * not look like a bug. It looks like the feature doing nothing.
 *
 * ## Why a delta and not a copy
 *
 * `docs/hll-vietnam.md` §7 says to copy HLL's table rather than share it, so the two cannot get
 * wedged into one set of conditionals. The concern is right; a second full copy is the wrong cure.
 * Sixty duplicated entries drift silently — a fix to a shared wire lands on one game and not the
 * other, and nothing tells you. What follows instead is HLL's table with an explicit override map:
 * every divergence is one named line with its page reference, and the ninety percent that really is
 * identical stays identical *by construction*. There are no conditionals — this is data, resolved
 * once at module load.
 *
 * A wire that is not named below is HLL's, deliberately, because the PDF documents it identically.
 *
 * ## Provenance
 *
 * Page references are to `docs/hll-vietnam/rcon-v2.pdf` (extracted as `rcon-v2.txt`), Team 17's
 * published Vietnam RCON document. That is the best authority available and it is not a live
 * capture — `docs/hll-vietnam.md` §8 lists what still wants probing against a real server. Where
 * the document contradicts itself, the note on the entry says so and says which way we went.
 */
import type { CommandDef, CommandTable } from "@app/rcon-core";
import { HLL_BINARY_V2 } from "../hll/commands.js";

const str = (v: unknown): string => (v == null ? "" : String(v));
/** binary-v2 boolean: a real JSON boolean (the v2 setters take `{Enable: true|false}`). */
const bool_ = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === "1" || Number(v) === 1;
/**
 * A comma-separated word list, normalised but kept as ONE STRING.
 *
 * HLL's v2 takes `BannedWords` as an array; Vietnam's document types it `string` and says outright
 * "Words should be separated with a comma" (p30). Same field name, different type — exactly the
 * shape of divergence that type-checks on our side and is rejected or silently misread on theirs.
 */
const wordCsv = (v: unknown): string =>
  (Array.isArray(v) ? v.map(String) : str(v).split(",")).map((s) => s.trim()).filter(Boolean).join(",");

/**
 * A sector choice as Vietnam wants it: an Int32 index into that sector's option row, where HLL
 * takes the option string itself (p11). Callers pass BOTH (`sectorN` and `sectorNIndex`) so neither
 * game has to be special-cased above this layer; this reads the one Vietnam means.
 */
const sectorIndex = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** `GetServerInformation` read: the info request is the whole payload (p19–20). */
const infoRead = (logical: string, name: string, value: (p: Record<string, unknown>) => string = () => ""): CommandDef => ({
  logical,
  access: "read",
  binaryV2: { name: "GetServerInformation", version: 2, content: (p) => ({ Name: name, Value: value(p) }) },
  ...(HLL_BINARY_V2[logical as keyof typeof HLL_BINARY_V2]?.legacyText
    ? { legacyText: HLL_BINARY_V2[logical as keyof typeof HLL_BINARY_V2]!.legacyText }
    : {}),
});

/**
 * Every command whose Vietnam wire differs from HLL's. Anything absent is identical on purpose.
 *
 * Legacy-text templates are carried over untouched: Vietnam ships the same external RconClient with
 * the same `Commands.xml`, and none of the deltas below is a legacy-protocol change.
 */
const HLLV_OVERRIDES: CommandTable = {
  // ---- renamed on the wire ----

  /**
   * The welcome/notice message.
   *
   * HLL's v2 calls this `SetWelcomeMessage` (confirmed live, `GetDisplayableCommands` 2026-07-23).
   * Vietnam's command list has no such verb: it names `SetNoticeMessage` (p7), and p18 documents it
   * as "Displays a notice message to all players on the server and to players upon joining the
   * server" — which is the welcome message, described. Sending HLL's name to a Vietnam server asks
   * for a command that is not there, and the config editor's "Welcome message" field silently did
   * nothing on Vietnam as a result.
   */
  setWelcomeMessage: {
    logical: "setWelcomeMessage",
    access: "write",
    binaryV2: { name: "SetNoticeMessage", version: 2, content: (p) => ({ Message: str(p.message) }) },
    legacyText: HLL_BINARY_V2.setWelcomeMessage.legacyText,
  },

  // ---- same name, different body ----

  /** `BannedWords` is a comma-separated STRING here, not HLL's array (p30). */
  banProfanity: {
    logical: "banProfanity",
    access: "write",
    binaryV2: { name: "AddBannedWords", version: 2, content: (p) => ({ BannedWords: wordCsv(p.words) }) },
    legacyText: HLL_BINARY_V2.banProfanity.legacyText,
  },
  /** Same string-not-array change as its sibling (p30). */
  unbanProfanity: {
    logical: "unbanProfanity",
    access: "write",
    binaryV2: { name: "RemoveBannedWords", version: 2, content: (p) => ({ BannedWords: wordCsv(p.word ?? p.words) }) },
    legacyText: HLL_BINARY_V2.unbanProfanity.legacyText,
  },

  /**
   * The objective layout, which changed shape in two ways that matter (p11).
   *
   * It now takes a **`MapId`**, and the sectors are **Int32 indices** rather than HLL's option
   * strings. It also no longer restarts the match. Those together are the difference between
   * "configure the layout stored for this map" and HLL's "apply it to the round happening right
   * now" — so a caller must say which map it means. Omitting `MapId` is not a smaller version of
   * the command; it is a command about no map.
   */
  setSectorLayout: {
    logical: "setSectorLayout",
    access: "write",
    binaryV2: { name: "SetSectorLayout", version: 2, content: (p) => ({
      MapId: str(p.mapId),
      Sector_1: sectorIndex(p.sector1Index), Sector_2: sectorIndex(p.sector2Index), Sector_3: sectorIndex(p.sector3Index),
      Sector_4: sectorIndex(p.sector4Index), Sector_5: sectorIndex(p.sector5Index),
    }) },
  },

  /**
   * Undo a stored layout (p11) — the other half of Vietnam's persistent objectives. A saved
   * layout re-applies every time its map plays until this is sent, so without it "set" is a
   * one-way door. HLL has no such verb because HLL stores nothing: its set is one round, once.
   */
  removeSectorLayout: {
    logical: "removeSectorLayout",
    access: "write",
    binaryV2: { name: "RemoveSectorLayout", version: 2, content: (p) => ({ MapId: str(p.mapId) }) },
  },

  // ---- reads HLL could only do over legacy text, which Vietnam exposes over v2 ----
  //
  // These are not new features. On a binary-v2 connection a legacy-only command throws outright
  // ("not mapped for binary-v2"), so on Vietnam — where binary-v2 is the native protocol — each of
  // these was simply unavailable. The info-request list on p19–20 gives them all a v2 form.

  // getVipIds is NOT an override any more: a live probe (2026-08-15) showed the `vipplayers` info
  // request answering on HLL's v2 as well, so the identical wire now lives in HLL's table and is
  // shared from there — the delta stays a delta.
  /** The custom profanity list (p20, `bannedwords`). */
  getProfanity: infoRead("getProfanity", "bannedwords"),
  /** One player in detail; the id rides in `Value` (p19). HLL has only the legacy `playerinfo`. */
  getPlayerInfo: infoRead("getPlayerInfo", "player", (p) => str(p.playerId)),

  /**
   * Map shuffle. HLL's v2 has no setter, so ours is legacy-only and phrased as a toggle; Vietnam
   * ships `SetMapShuffleEnabled` (p6, p13), which is a SET. Callers pass `enabled` — a toggle has
   * nothing to send here, because the wire wants the state you want, not a request to flip.
   */
  toggleMapShuffle: {
    logical: "toggleMapShuffle",
    access: "write",
    binaryV2: { name: "SetMapShuffleEnabled", version: 2, content: (p) => ({ Enable: bool_(p.enabled) }) },
    legacyText: HLL_BINARY_V2.toggleMapShuffle.legacyText,
  },

  // ---- gone from Vietnam ----

  /**
   * HLL reads the live objective state as `GetServerInformation {Name:"objectives"}`. Vietnam's
   * documented info-request list (p19–20) does not include `objectives` at all; the stored layouts
   * are read back with the new `GetSectorLayout` (p11) instead. Pointing this at a request the
   * server does not know would answer nothing and read as "no objectives", so it is wired to the
   * command that actually answers.
   */
  getObjectives: {
    logical: "getObjectives",
    access: "read",
    binaryV2: { name: "GetSectorLayout", version: 2, content: () => ({}) },
  },
};

/**
 * Vietnam's table: HLL's, with the overrides above applied.
 *
 * Frozen so a later caller cannot mutate one game's wire and move the other's with it — the whole
 * point of the two tables being separate values.
 */
export const HLLV_BINARY_V2: CommandTable = Object.freeze({ ...HLL_BINARY_V2, ...HLLV_OVERRIDES });

/** The logical commands whose Vietnam wire differs from HLL's — the audit surface, for tests. */
export const HLLV_DIVERGENT_COMMANDS: readonly string[] = Object.freeze(Object.keys(HLLV_OVERRIDES).sort());
