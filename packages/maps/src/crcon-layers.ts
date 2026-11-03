/**
 * Which Layer CRCON makes of a map id, and the exact dict that Layer dumps to on its API — ported
 * line for line from CRCON v12.3.0 (rcon/maps.py and rcon/game/hllv/maps.py), so that the public
 * API's `map` objects are CRCON's own bytes. The catalogue itself is generated data
 * (crcon-layer-data.ts); this file is the logic around it, quirks included:
 *
 *   - An id the catalogue does not know is parsed, never refused: WW2 tries the two newer id
 *     shapes (CAR_L_1944_Conquest_Day, ..._S_..._P_...) and then the old one (carentan_warfare);
 *     Vietnam keeps the id on an "unknown" map as a Domination layer.
 *   - The old WW2 shape never sets `attackers` for an id outside the catalogue: CRCON looks the
 *     faction's VALUE ("us") up as a Team member NAME, which always misses, and swallows the miss.
 *   - Python's `$` also matches before one trailing newline, and its `\w`/`\d` are Unicode-aware;
 *     the regexes below say so explicitly.
 *
 * It also files a round from its match log the way CRCON does (crconGuessMapFromLog).
 *
 * Only the CRCON wire uses this. Our own pages keep their staff-set map names (buildLayer).
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { HLL_LAYERS, HLL_MAPS, HLLV_LAYERS, HLLV_MAPS } from "./crcon-layer-data.js";

export interface CrconFactionData {
  name: string;
  team: string;
}

export interface CrconMapData {
  id: string;
  name: string;
  tag: string;
  pretty_name: string;
  shortname: string;
  allies: CrconFactionData;
  axis: CrconFactionData;
  orientation: string;
}

export interface CrconLayer {
  id: string;
  map: CrconMapData;
  game_mode: string;
  attackers: string | null;
  environment: string;
}

const UNKNOWN = "unknown";
/** GameMode members by NAME (what `GameMode[x.upper()]` looks up), and the small ones. */
const GAME_MODES = new Set(["WARFARE", "OFFENSIVE", "CONQUEST", "DOMINATION", "SKIRMISH", "PHASED", "MAJORITY"]);
const SMALL_MODES = new Set(["skirmish", "phased", "majority"]);
/** Environment members by NAME. */
const ENVIRONMENTS = new Set(["DAWN", "DAY", "DUSK", "NIGHT", "OVERCAST", "RAIN"]);

const W = "[\\p{L}\\p{N}_]"; // Python's Unicode \w
const END = "(?=\\n?$)"; // Python's $ without MULTILINE
const RE_LAYER_NAME_SMALL = new RegExp(`^(?<tag>[A-Z]{3,5})_S_(?<year>\\p{Nd}{4})_(?:(?<environment>${W}+)_)?P_(?<game_mode>${W}+)${END}`, "u");
const RE_LAYER_NAME_LARGE = new RegExp(`^(?<tag>[A-Z]{3,5})_L_(?<year>\\p{Nd}{4})_(?<game_mode>${W}+?)(?<attackers>US|GER|Ger|COM|USSR|RUS|GB|CW|Brit|British|can)?(?:_(?<environment>${W}+))?${END}`, "u");
const RE_LEGACY_LAYER_NAME = new RegExp(`^(?<name>[a-zA-Z0-9]+)_(?:(?<offensive>off(?:ensive)?)_?(?<attackers>[a-zA-Z]+)|(?<game_mode>[a-zA-Z]+)(?:_V2)?)(?:_(?<environment>[a-zA-Z]+))?${END}`, "u");

/** Python's str.capitalize(): first character upper, the rest lower. */
const capitalize = (s: string): string => {
  const [first = "", ...rest] = [...s];
  return first.toUpperCase() + rest.join("").toLowerCase();
};

const genericMap = (id: string, name: string, tag: string, pretty: string, short: string): CrconMapData => ({
  id, name, tag, pretty_name: pretty, shortname: short,
  allies: { name: "us", team: "allies" }, axis: { name: "ger", team: "axis" }, orientation: "vertical",
});

interface Catalogue {
  /** Insertion order kept: the WW2 tag search walks it front to back. */
  maps: Map<string, CrconMapData>;
  layers: Map<string, CrconLayer>;
}

function build(maps: readonly CrconMapData[], layers: readonly (readonly [string, string, string, string | null, string])[], layerKey: (id: string) => string): Catalogue {
  const mapIndex = new Map<string, CrconMapData>();
  for (const m of maps) mapIndex.set(m.id.toLowerCase(), m);
  const layerIndex = new Map<string, CrconLayer>();
  for (const [id, mapKey, mode, attackers, env] of layers) {
    const map = mapIndex.get(mapKey.toLowerCase());
    if (map) layerIndex.set(layerKey(id), { id, map, game_mode: mode, attackers, environment: env });
  }
  return { maps: mapIndex, layers: layerIndex };
}

/** rcon/maps.py: MAPS and LAYERS, both keyed by the lowercased id. */
const HLL = build(HLL_MAPS, HLL_LAYERS, (id) => id.toLowerCase());

/** rcon/game/hllv/maps.py: its own "unknown" first (factions named "unknown"), then hllrcon's.
 *  The layers are keyed by the id AS GIVEN while lookups lowercase it; hllrcon's ids are all
 *  lowercase, so that is only a difference for a future id that is not. */
const HLLV_UNKNOWN_MAP: CrconMapData = {
  id: UNKNOWN, name: UNKNOWN, tag: "", pretty_name: UNKNOWN, shortname: UNKNOWN,
  allies: { name: UNKNOWN, team: "allies" }, axis: { name: UNKNOWN, team: "axis" }, orientation: "vertical",
};
const HLLV = build([HLLV_UNKNOWN_MAP, ...HLLV_MAPS], [[UNKNOWN, UNKNOWN, "domination", null, "day"], ...HLLV_LAYERS], (id) => id);

const isServerLoadingMap = (name: string): boolean => name.toLowerCase().includes("untitled");

function parseLegacyLayer(layerName: string): CrconLayer {
  const m = RE_LEGACY_LAYER_NAME.exec(layerName)?.groups;
  if (!m) throw new Error(`Unparsable layer '${layerName}'`);
  const name = m.name!;
  const map = HLL.maps.get(name.toLowerCase())
    ?? genericMap(name, capitalize(name), name.toUpperCase(), capitalize(name), capitalize(name));
  const result: CrconLayer = { id: layerName, map, game_mode: "warfare", attackers: null, environment: "day" };
  if (m.offensive) {
    result.game_mode = "offensive";
    // Team[FactionName[x.upper()].value] never resolves (a value is not a member name): None.
  } else if (m.game_mode && GAME_MODES.has(m.game_mode.toUpperCase())) {
    result.game_mode = m.game_mode.toUpperCase().toLowerCase();
  }
  if (m.environment && ENVIRONMENTS.has(m.environment.toUpperCase())) {
    result.environment = m.environment.toUpperCase().toLowerCase();
  }
  return result;
}

/** WW2's parse_layer. Throws where CRCON raises ValueError (an id of no shape at all). */
function parseHllLayer(layerName: string): CrconLayer {
  if (isServerLoadingMap(layerName)) return HLL.layers.get(UNKNOWN)!;
  const known = HLL.layers.get(layerName.toLowerCase());
  if (known) return known;
  const m = (RE_LAYER_NAME_LARGE.exec(layerName) ?? RE_LAYER_NAME_SMALL.exec(layerName))?.groups;
  if (!m) return parseLegacyLayer(layerName);
  const tag = m.tag!;
  let map: CrconMapData | undefined;
  for (const candidate of HLL.maps.values()) {
    if (candidate.tag === tag) {
      map = candidate;
      break;
    }
  }
  map ??= genericMap(tag.toLowerCase(), tag, tag, capitalize(tag), tag);
  let gameMode = "warfare";
  let attackers: string | null = null;
  const mode = (m.game_mode ?? "").toUpperCase();
  if (GAME_MODES.has(mode)) {
    gameMode = mode.toLowerCase();
    if (gameMode === "offensive") attackers = "allies";
  }
  const env = m.environment ? m.environment.toUpperCase() : "";
  const environment = env && ENVIRONMENTS.has(env) ? env.toLowerCase() : "day";
  return { id: layerName, map, game_mode: gameMode, attackers, environment };
}

/** Vietnam's parse_layer: never raises. */
function parseHllvLayer(layerName: string): CrconLayer {
  if (isServerLoadingMap(layerName)) return HLLV.layers.get(UNKNOWN)!;
  return HLLV.layers.get(layerName.toLowerCase())
    ?? { id: layerName, map: HLLV_UNKNOWN_MAP, game_mode: "domination", attackers: null, environment: "day" };
}

/** `get_game_profile(game).parse_layer(name)`: "hllv" is Vietnam, anything else WW2. */
export function crconParseLayer(layerName: string, game: string): CrconLayer {
  return game === "hllv" ? parseHllvLayer(layerName) : parseHllLayer(layerName);
}

/** `parse_layer_or_unknown`: what the live game state uses, falling back to the "unknown" layer. */
export function crconParseLayerOrUnknown(layerName: string, game: string): CrconLayer {
  try {
    return crconParseLayer(layerName, game);
  } catch {
    return (game === "hllv" ? HLLV : HLL).layers.get(UNKNOWN)!;
  }
}

// ---------------------------------------------------------------------------
// From a match log line to a layer: rcon/utils.py guess_map_from_log, with rcon/maps.py's
// start/ended patterns and parse_map_string(_attacker), and GameProfile.resolve_layer
// (rcon/game/base.py). A match log names the map in display text ("MATCH START CARENTAN
// Warfare"), never by layer id, so this is how CRCON files a round it learnt of from the log.
//
// The patterns are Python's (IGNORECASE | VERBOSE, run with .search), and Python's meaning of
// each piece is spelt out rather than borrowed from JavaScript's look-alikes: `\s` is
// str.isspace() (which takes \x1c-\x1f and \x85 and not \ufeff), `.` is anything but "\n",
// IGNORECASE also matches i with İ and ı, k with the Kelvin sign and s with the long s, and `$`
// also matches before one trailing newline.

/** Python's `\s` on a str pattern, which is also str.strip()'s whitespace. */
const PY_SPACE = "[\\t-\\r\\x1c- \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu");
const IGNORECASE_EXTRA: Readonly<Record<string, string>> = { i: "\\u0130\\u0131", k: "\\u212a", s: "\\u017f" };
/** A letters-only literal as re.IGNORECASE matches it. */
const ignoreCase = (literal: string): string =>
  [...literal.toLowerCase()].map((c) => `[${c}${c.toUpperCase()}${IGNORECASE_EXTRA[c] ?? ""}]`).join("");
const alternation = (values: readonly string[]): string => values.map(ignoreCase).join("|");

/** The Environment and GameMode values, in their enums' order (the alternations' order). */
const ENVIRONMENT_VALUES: readonly string[] = ["dawn", "day", "dusk", "night", "overcast", "rain"];
const GAME_MODE_VALUES: readonly string[] = ["warfare", "offensive", "conquest", "domination", "skirmish", "phased", "majority"];
/** The attacker a log may put before the mode ("NVA Offensive"), and the side it names. */
const LOG_ATTACKER_TOKENS: readonly string[] = ["NVA", "USA", "US"];
const LOG_ATTACKER_SIDES: Readonly<Record<string, string>> = { nva: "axis", us: "allies", usa: "allies" };

const MAP_DETAILS = `(?<name>[^\\n]+?)(?:${PY_SPACE}+(?<env>${alternation(ENVIRONMENT_VALUES)}))?`
  + `(?:${PY_SPACE}+(?<attacker>${alternation(LOG_ATTACKER_TOKENS)}))?${PY_SPACE}+(?<mode>${alternation(GAME_MODE_VALUES)})`;
const ENDED_PATTERN = new RegExp(`${ignoreCase("MATCH")}${PY_SPACE}+${ignoreCase("ENDED")}${PY_SPACE}+\`${MAP_DETAILS}\``, "u");
const START_PATTERN = new RegExp(`${ignoreCase("MATCH")}${PY_SPACE}+${ignoreCase("START")}${PY_SPACE}+${MAP_DETAILS}(?:${PY_SPACE}|${END})`, "u");

interface LogMapDetails {
  name: string;
  environment: string | null;
  gameMode: string;
  attacker: string | null;
}

/** parse_map_string and parse_map_string_attacker together; null wherever either raises. */
function parseMapString(raw: string): LogMapDetails | null {
  const g = (ENDED_PATTERN.exec(raw) ?? START_PATTERN.exec(raw))?.groups;
  if (!g) return null;
  // Environment(x.lower()) and GameMode(x.lower()) raise for a match the enum does not hold: a
  // dotless ı satisfies IGNORECASE but lowercases to itself.
  const environment = g.env === undefined ? null : g.env.toLowerCase();
  const gameMode = g.mode!.toLowerCase();
  if (environment !== null && !ENVIRONMENT_VALUES.includes(environment)) return null;
  if (!GAME_MODE_VALUES.includes(gameMode)) return null;
  let attacker: string | null = null;
  if (g.attacker !== undefined) {
    // str.casefold(), which over what these tokens can match is lowercasing with ſ as s.
    const side = LOG_ATTACKER_SIDES[g.attacker.toLowerCase().replace(/ſ/g, "s")];
    if (side === undefined) return null;
    attacker = side;
  }
  return { name: g.name!.replace(PY_STRIP, ""), environment, gameMode, attacker };
}

/** unicodedata.normalize("NFKC", s).casefold(). Over every character that can reach a catalogue
 *  name, casefold is lowercasing with ß as "ss"; the two part only on letters no map is spelt with. */
const foldName = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss");
const FOLDED_NAMES = new WeakMap<CrconMapData, string>();
const foldedMapName = (m: CrconMapData): string => {
  let folded = FOLDED_NAMES.get(m);
  if (folded === undefined) FOLDED_NAMES.set(m, (folded = foldName(m.name)));
  return folded;
};

/**
 * GameProfile.resolve_layer: the catalogue layer for a map NAME as a log spells it, in this mode
 * (and for this attacker, when the log said one). Of those, the first in catalogue order in the
 * environment asked for (day when none), else the first at all; the unknown layer when none is.
 */
export function crconResolveLayer(mapName: string, gameMode: string, environment: string | null, attacker: string | null, game: string): CrconLayer {
  const { layers } = game === "hllv" ? HLLV : HLL;
  const wanted = foldName(mapName);
  const candidates: CrconLayer[] = [];
  for (const l of layers.values()) {
    if (foldedMapName(l.map) === wanted && l.game_mode === gameMode && (attacker === null || l.attackers === attacker)) candidates.push(l);
  }
  if (!candidates.length) return layers.get(UNKNOWN)!;
  const env = environment ?? "day";
  return candidates.find((l) => l.environment === env) ?? candidates[0]!;
}

/** guess_map_from_log: the layer a raw MATCH START / MATCH ENDED line names, or the unknown one. */
export function crconGuessMapFromLog(raw: string, game: string): CrconLayer {
  const d = parseMapString(raw);
  if (!d) return crconParseLayerOrUnknown(UNKNOWN, game);
  return crconResolveLayer(d.name, d.gameMode, d.environment, d.attacker, game);
}

const HAS_PY_SPACE = new RegExp(PY_SPACE, "u");

/**
 * The layer id CRCON would have filed a round under, read from a stored round's map when CRCON's
 * own decision at match start was never recorded for it. A round imported from CRCON stores
 * CRCON's id, kept as it is. A round our ingest recorded stores the MATCH START line's map text
 * ("CARENTAN Warfare"), read the way guess_map_from_log reads an old line. A layer id never holds
 * whitespace, and log text without any names no mode, which CRCON files as unknown.
 */
export function crconMapNameFromRecord(stored: string | null, game: string): string {
  if (stored && HAS_PY_SPACE.test(stored)) return crconGuessMapFromLog(`MATCH START ${stored}`, game).id;
  if (stored) {
    try {
      crconParseLayer(stored, game);
      return stored;
    } catch {
      // Not a layer id either: a log line CRCON could not have guessed from.
    }
  }
  return crconParseLayerOrUnknown(UNKNOWN, game).id;
}

/** Each game profile's supported_game_modes (rcon/game/hll/profile.py, rcon/game/hllv/profile.py). */
const SUPPORTED_MODES: Record<string, ReadonlySet<string>> = {
  hll: new Set(["warfare", "offensive", "conquest", "skirmish", "phased", "majority"]),
  hllv: new Set(["warfare", "offensive", "conquest", "domination"]),
};

/**
 * GameProfile.parse_game_mode_or_none: the live session's `gameMode` as a GameMode value, or null.
 * Vietnam prefixes Offensive with the attacker ("US Offensive"), so the LAST word is the mode; a
 * blank (between matches) or a mode the game's profile does not support is null.
 */
export function crconParseGameModeOrNone(gameMode: string, game: string): string | null {
  const normalised = gameMode.trim().toLowerCase();
  const tokens = normalised.split(/\s+/).filter(Boolean);
  const mode = tokens.length ? tokens[tokens.length - 1]! : normalised;
  const supported = SUPPORTED_MODES[game === "hllv" ? "hllv" : "hll"]!;
  return supported.has(mode) ? mode : null;
}

/**
 * rcon/maps.py get_theoretical_match_time: the full match window the server timer stands for. An
 * Offensive's timer is one objective's, up to five times over, and an untouched Offensive timer
 * is reported as Warfare's 90 minutes when it means 30.
 */
export function crconTheoreticalMatchTime(gameMode: string, matchTime: number): number {
  if (gameMode === "offensive") return (matchTime === 90 * 60 ? 30 * 60 : matchTime) * 5;
  return matchTime;
}

/** Layer.pretty_name, the computed field. */
export function crconLayerPrettyName(l: CrconLayer): string {
  let out = l.map.pretty_name;
  if (l.game_mode === "offensive") {
    out += " Off.";
    const faction = l.attackers === "allies" ? l.map.allies : l.attackers === "axis" ? l.map.axis : null;
    if (l.attackers && faction) out += ` ${faction.name.toUpperCase()}`;
  } else if (SMALL_MODES.has(l.game_mode)) {
    out += " Skirmish";
  } else {
    out += ` ${capitalize(l.game_mode)}`;
  }
  if (l.environment !== "day") out += ` (${capitalize(l.environment)})`;
  return out;
}

/** Layer.model_dump(): its fields in order, then the two computed ones. */
export function crconLayerDump(l: CrconLayer): Record<string, unknown> {
  const m = l.map;
  return {
    id: l.id,
    map: {
      id: m.id, name: m.name, tag: m.tag, pretty_name: m.pretty_name, shortname: m.shortname,
      allies: { name: m.allies.name, team: m.allies.team },
      axis: { name: m.axis.name, team: m.axis.team },
      orientation: m.orientation,
    },
    game_mode: l.game_mode,
    attackers: l.attackers,
    environment: l.environment,
    pretty_name: crconLayerPrettyName(l),
    image_name: `${m.id}-${l.environment}.webp`.toLowerCase(),
  };
}
