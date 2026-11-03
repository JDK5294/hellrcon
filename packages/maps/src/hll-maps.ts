/**
 * HLL map-id inference — a faithful port of the earlier bot's `rcon/client.py` helpers. HLL rotation
 * entries are opaque ids like `carentan_offensive_ger` or `PHL_L_1944`; these derive a human name,
 * game mode, time-of-day environment, and map "family" (base map, ignoring mode/time) from the id.
 *
 * The `family` grouping is the known-soft area (hardcoded overrides below) that the original author
 * flagged as "not fully solved" — ported as-is so behaviour matches the battle-tested bot; improve
 * here rather than reinventing.
 */

const MAP_SPLIT_RE = /[_\-/\s]+/;

/**
 * One separator, whatever the source spelled it with.
 *
 * A map reaches us two ways: as an id (`wdevd_warfare_day`) from the rotation and catalogue, and
 * as the game's own display name ("Đăk Tô Airfield Warfare") off the MATCH START line, which is
 * what a recorded round stores. Every marker below is written with underscores, so folding
 * whitespace into one lets a single set of rules read both spellings — without it a display name
 * kept its mode word in the NAME and came out "Đăk tô airfield warfare — Warfare".
 */
const unify = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, "_");

const MAP_NAME_ALIASES: Record<string, string> = {
  PHL: "Purple Heart Lane", PHL_L_1944: "Purple Heart Lane", PHL_S_1944: "Purple Heart Lane",
  STA: "Stalingrad", STA_L_1942: "Stalingrad", STA_S_1942: "Stalingrad",
  REM: "Remagen", REM_L_1945: "Remagen", REM_S_1945: "Remagen",
  DRL: "Driel", DRL_S_1944: "Driel",
  ELA: "El Alamein", ELA_S_1942: "El Alamein",
  CAR: "Carentan", CAR_S_1944: "Carentan",
  HIL: "Hill 400", HIL_S_1944: "Hill 400",
  SME: "Sainte-Mère-Église", SME_S_1944: "Sainte-Mère-Église",
  SMDM: "St Marie Du Mont", SMDM_S_1944: "St Marie Du Mont",
  // Update 21's conquest layers extend the compact spelling to large layouts (oma_l_1944_conquest_day).
  OMA: "Omaha Beach", OMA_L_1944: "Omaha Beach",
  // HLL: Vietnam (release reference export). The MAP ids are WDEV_A…WDEV_F; the LAYER ids compact
  // the underscore away (wdeva_warfare_day) — both spellings are listed because both reach us:
  // the map id from session/GetSectorLayout answers, the layer id from the rotation and catalogue.
  WDEV_A: "Vạn Tường", WDEVA: "Vạn Tường",
  WDEV_B: "Quảng Ngãi", WDEVB: "Quảng Ngãi",
  WDEV_C: "Huế Outskirts", WDEVC: "Huế Outskirts",
  WDEV_D: "Đăk Tô Airfield", WDEVD: "Đăk Tô Airfield",
  WDEV_E: "Cam Ranh Port", WDEVE: "Cam Ranh Port",
  WDEV_F: "Thanh Hòa Bridge", WDEVF: "Thanh Hòa Bridge",
};

const NORMAL_MAP_ALIASES: Record<string, string> = {
  stmariedumont: "St Marie Du Mont", stmereeglise: "Sainte-Mère-Église", hurtgenforest: "Hürtgen Forest",
  utahbeach: "Utah Beach", omahabeach: "Omaha Beach", hill400: "Hill 400", elalamein: "El Alamein",
  elsenbornridge: "Elsenborn Ridge", purpleheartlane: "Purple Heart Lane",
  junobeach: "Juno Beach", // Update 21 — the Canadian landing beach
};

const TEAM_PATTERNS: [string, string][] = [
  ["offensivebritish", "British"], ["offensive_ger", "GER"], ["offensiveger", "GER"], ["_off_ger", "GER"], ["_offger", "GER"],
  // NVA before US: "offensivenva" does not contain "offensiveus", but keeping the more specific
  // Vietnam token first costs nothing and reads as the rule it is.
  ["offensivenva", "NVA"], ["offensive_nva", "NVA"],
  ["offensive_us", "US"], ["offensiveus", "US"], ["_off_us", "US"], ["_offus", "US"],
  // A DISPLAY name puts the attacker first ("Vạn Tường US Offensive"), where an id puts it last.
  // Same two facts, opposite order, so both spellings are listed. NVA before US for the reason
  // above.
  ["nva_offensive", "NVA"], ["us_offensive", "US"], ["ger_offensive", "GER"],
  ["rus_offensive", "RUS"], ["cw_offensive", "CW"], ["british_offensive", "British"],
  ["offensive_rus", "RUS"], ["offensiverus", "RUS"], ["offensive_cw", "CW"], ["offensivecw", "CW"],
];

const ENV_LABELS: Record<string, string> = { night: "Night", dusk: "Dusk", overcast: "Overcast", morning: "Morning", rain: "Rain", day: "Day" };
const STRUCTURAL_TOKENS = new Set(["l", "s", "p", "1942", "1944", "1945"]);
const SPECIAL_TOKENS: Record<string, string> = { us: "US", ger: "GER", rus: "RUS", uk: "UK", cw: "CW", v2: "V2" };
const ALIAS_PREFIXES: [string, string][] = Object.entries(MAP_NAME_ALIASES)
  .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
  .sort((a, b) => b[0].length - a[0].length);

function titleToken(token: string): string {
  const low = token.toLowerCase();
  const special = SPECIAL_TOKENS[low];
  if (special) return special;
  return token.slice(0, 1).toUpperCase() + token.slice(1).toLowerCase();
}

function fallbackMapName(mapId: string): string {
  const lower = unify(mapId);
  let base = lower;
  for (const marker of ["_warfare", "_offensive", "_off_", "_skirmish", "_conquest", "_domination"]) {
    if (base.includes(marker)) { base = base.split(marker)[0]!; break; }
    if (base.endsWith(marker.replace(/_$/, ""))) { base = base.slice(0, -marker.replace(/_$/, "").length); break; }
  }
  for (const suffix of ["_day", "_night", "_dusk", "_overcast", "_morning", "_rain"]) {
    if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  }
  // A display name puts the attacking side BEFORE the mode ("Vạn Tường US Offensive"), so cutting
  // at the mode leaves it dangling on the end of the name. It belongs in the variant list, which
  // `teamLabel` builds from the same string — drop it here rather than print "Vạn Tường US — …".
  base = base.replace(/_(us|nva|ger|rus|cw|uk|british)$/, "");
  const byBase = NORMAL_MAP_ALIASES[base];
  if (byBase) return byBase;
  let tokens = base.split(MAP_SPLIT_RE).filter((t) => t && !STRUCTURAL_TOKENS.has(t.toLowerCase()));
  if (tokens.length === 0) tokens = [mapId];
  const compact = tokens.join("").toLowerCase();
  const byCompact = NORMAL_MAP_ALIASES[compact];
  if (byCompact) return byCompact;
  return tokens.map(titleToken).join(" ");
}

function mapName(mapId: string): string {
  const lower = unify(mapId);
  for (const [prefix, alias] of ALIAS_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + "_")) return alias;
  }
  let base = lower;
  for (const marker of ["_warfare", "_offensive", "_off_", "_skirmish", "_conquest", "_domination"]) {
    if (base.includes(marker)) { base = base.split(marker)[0]!; break; }
  }
  const byBase = NORMAL_MAP_ALIASES[base];
  if (byBase) return byBase;
  return fallbackMapName(mapId);
}

/** Every mode either game runs. Warfare stays the fallback: it is both games' default mode. */
export type MapMode = "warfare" | "offensive" | "skirmish" | "conquest" | "domination";

export function inferMode(mapId: string): MapMode {
  const lower = mapId.toLowerCase();
  if (lower.includes("skirmish")) return "skirmish";
  // Vietnam's two large modes (wdeve_conquest_day / wdeve_domination_day).
  if (lower.includes("conquest")) return "conquest";
  if (lower.includes("domination")) return "domination";
  const markers = ["offensive", "_off_", "_offus", "_offger", "_offrus", "_offbritish", "offensiveus", "offensiveger", "offensiverus", "offensivebritish"];
  if (markers.some((m) => lower.includes(m))) return "offensive";
  return "warfare";
}

export function inferEnvironment(mapId: string): string {
  const lower = mapId.toLowerCase();
  for (const env of ["night", "dusk", "overcast", "morning", "rain", "day"]) if (lower.includes(env)) return env;
  return "day";
}

/** Coarse day/night bucket (all non-night environments count as "day"). */
export function inferEnvironmentGroup(environment: string): "day" | "night" {
  return (environment || "").toLowerCase() === "night" ? "night" : "day";
}

/**
 * The compact layer ids spell the same PLACES as the classic full-word ids — CAR_S_1944 is
 * Carentan, and Update 21's conquest layers reuse the compact spelling for large layouts
 * (car_l_1944_conquest_day, oma_l_1944_conquest_day). Without this fold each spelling minted its
 * own family, so "avoid two variants of the same map in one poll" did not hold across spellings:
 * a vote could offer Carentan twice, once as warfare and once as its conquest layer.
 */
const COMPACT_FAMILY: Record<string, string> = {
  car: "carentan", oma: "omahabeach", uta: "utahbeach", sme: "stmereeglise", smdm: "stmariedumont",
  hil: "hill400", ela: "elalamein", phl: "purpleheartlane", sta: "stalingrad", rem: "remagen", drl: "driel",
};

/** Base map, stripping mode + team + time — used to avoid two variants of the same map in one poll. */
export function inferFamily(mapId: string): string {
  let lower = mapId.toLowerCase();
  const overrides: Record<string, string> = {
    stmariedumont_off_us: "stmariedumont", stmariedumont_off_ger: "stmariedumont", carentan_offensive_gerf: "carentan",
  };
  const override = overrides[lower];
  if (override) return override;
  for (const marker of ["_offensive", "_warfare", "_skirmish", "_conquest", "_domination"]) {
    if (lower.includes(marker)) { lower = lower.split(marker)[0]!; break; }
  }
  for (const marker of ["_off_us", "_off_ger"]) {
    if (lower.includes(marker)) { lower = lower.split(marker)[0]!; break; }
  }
  for (const suffix of ["_day", "_night", "_dusk", "_overcast", "_morning", "_rain"]) {
    if (lower.endsWith(suffix)) lower = lower.slice(0, -suffix.length);
  }
  // What's left of a compact id is its tag plus structural/time tokens (car_s_1944 → car,
  // car_s_1944_day_p → car): fold it to the classic family. Time-of-day counts as structural here
  // because the skirmish ids carry it MID-id (CAR_S_1944_Day_P_Skirmish), where the suffix strip
  // above cannot reach it. Anything with a real remaining token (junobeach, wdeve) passes untouched.
  const timeTokens = new Set(["day", "night", "dusk", "overcast", "morning", "rain"]);
  const tokens = lower.split(MAP_SPLIT_RE).filter((t) => t && !STRUCTURAL_TOKENS.has(t) && !timeTokens.has(t));
  if (tokens.length === 1 && COMPACT_FAMILY[tokens[0]!]) return COMPACT_FAMILY[tokens[0]!]!;
  return lower;
}

function modeLabel(mapId: string): string {
  const mode = inferMode(mapId);
  // Spelled out: this label is read by players on the public stats site, where "Off" beside a map
  // name reads as a switch rather than the game mode.
  if (mode === "offensive") return "Offensive";
  return mode.slice(0, 1).toUpperCase() + mode.slice(1).toLowerCase();
}

function teamLabel(mapId: string): string | null {
  const lower = unify(mapId);
  for (const [marker, label] of TEAM_PATTERNS) if (lower.includes(marker)) return label;
  return null;
}

/**
 * The attacking team on an offensive layer ("US", "GER", "NVA", "RUS", "CW", "British"), or null
 * when the id is not an offensive layer or spells no attacker the patterns recognize. Offensive
 * ids carry their attacker by convention in BOTH games (carentan_offensive_ger,
 * wdevb_offensivenva_day), which is what makes attacker-side rules possible with no per-map table.
 */
export function attackerTeam(mapId: string): string | null {
  if (inferMode(mapId) !== "offensive") return null;
  return teamLabel(mapId);
}

function hasEnvToken(mapId: string, env: string): boolean {
  const lower = unify(mapId);
  if (env === "night" && lower.includes("warfarenight")) return true;
  return new RegExp(`(^|[_\\-/])${env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[_\\-/])`).test(lower);
}

function variantLabels(mapId: string): string[] {
  const variants: string[] = [];
  const lower = mapId.toLowerCase();
  if (/(^|[_\-/])v2($|[_\-/])/.test(lower)) variants.push("V2");
  const team = teamLabel(mapId);
  if (team) variants.push(team);
  const env = inferEnvironment(mapId);
  const envLabel = ENV_LABELS[env];
  if (envLabel && hasEnvToken(mapId, env)) variants.push(envLabel);
  return variants;
}

/** Human label, e.g. "Carentan — Off GER" or "Purple Heart Lane — Warfare". */
export function prettifyMapId(mapId: string): string {
  const name = mapName(String(mapId));
  const parts = [modeLabel(String(mapId)), ...variantLabels(String(mapId))];
  return `${name} — ${parts.join(" ")}`;
}

export interface MapItem {
  id: string;
  prettyName: string;
  mode: MapMode;
  environment: string;
  family: string;
}

/** Full derived metadata for one HLL map id. */
export function describeMap(mapId: string): MapItem {
  return { id: mapId, prettyName: prettifyMapId(mapId), mode: inferMode(mapId), environment: inferEnvironment(mapId), family: inferFamily(mapId) };
}

/** Describe a list of ids, de-duplicated case-insensitively (preserves first-seen order). */
export function describeMaps(mapIds: string[]): MapItem[] {
  const out: MapItem[] = [];
  const seen = new Set<string>();
  for (const id of mapIds) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(describeMap(id));
  }
  return out;
}
