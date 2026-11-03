/**
 * Bundled game artwork resolution (HLL) — turns map names/ids, role names, and factions into
 * URLs under /game/hll/* with graceful fallbacks, using the generated manifest so we only ever
 * emit URLs for files that actually exist. Everything returns null when there's no match, so
 * callers render their plain-text look unchanged for unknown maps/games.
 *
 * EVERY resolver here takes the game and answers only for games whose art is actually bundled.
 * The rule exists because it was broken twice: a Vietnam round flew a Balkenkreuz over the NVA
 * until `factionIconUrls` learned to ask, and the map/role resolvers went on answering for any
 * game at all, which put WW2 role icons on Vietnam rosters and left a Vietnam map one unlucky
 * substring away from wearing a Normandy photograph.
 *
 * Vietnam now ships its own faction emblems, role icons (see ICONS below), AND its six gridded
 * tactical maps, so every resolver answers for it from ITS set — never by falling back to the
 * other game's. A game with none of these still gets null everywhere, which callers render as
 * their plain-text look.
 */
import { HLL_MAP_IMAGES, HLL_TAC_MAPS, HLL_ROLE_ICONS, HLL_TEAM_ICONS, HLLV_ROLE_ICONS, HLLV_TEAM_ICONS } from "./hllAssetManifest.ts";

const BASE = "/game/hll";
/** The game whose WW2 map-art SETS (banners, thumbs, tac maps, day/night variants) ship with the
 *  panel. Vietnam's maps are handled separately: one gridded set under /game/hllv/maps. */
const ART_GAME = "hll";

/**
 * Per-game art, chosen by game id and never shared.
 *
 * Two games ship icons now, and their sets are deliberately separate rather than merged: a lookup
 * that fell back from one to the other is exactly how a Vietnam round flew a Balkenkreuz over the
 * NVA. A game with no entry here has no art, and every resolver below returns null for it — the
 * callers already render their plain-text look when they get one.
 */
const ICONS: Record<string, { base: string; roles: Set<string>; teams: Set<string> }> = {
  hll: { base: "/game/hll", roles: HLL_ROLE_ICONS, teams: HLL_TEAM_ICONS },
  hllv: { base: "/game/hllv", roles: HLLV_ROLE_ICONS, teams: HLLV_TEAM_ICONS },
};

/** Map families that have a tactical map — doubles as the canonical family list. */
const FAMILIES = [...HLL_TAC_MAPS].map((f) => f.replace(/\.webp$/, ""));

/**
 * Reduce any map text to the bare letters the family names are written in.
 *
 * Two steps matter and both were learned the hard way from live servers:
 *  - accents are decomposed and dropped, so the game's own "SAINTE-MÈRE-ÉGLISE" and "HÜRTGEN
 *    FOREST" don't squash to "saintemreglise"/"hrtgenforest" and miss every file we ship;
 *  - "Saint"/"Sainte" is folded to "St", because the art is named stmereeglise/stmariedumont
 *    while the server spells the saints out in full.
 */
const squash = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") // combining marks left behind by NFD
    .toLowerCase()
    .replace(/\bsainte?\b/g, "st")
    .replace(/[^a-z0-9]/g, "");

/** Find the map family inside ANY map text — a raw id ("stmariedumont_off_ger"), a pretty name
 *  ("Sainte-Mère-Église Offensive"), or an already-clean family. Longest match wins so
 *  "stmereeglise" never half-matches "stmariedumont". */
export function mapFamilyOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const hay = squash(text);
  let best: string | null = null;
  for (const fam of FAMILIES) if (hay.includes(fam) && (!best || fam.length > best.length)) best = fam;
  return best;
}

const envOf = (text: string): string => {
  const lower = text.toLowerCase();
  for (const env of ["night", "dusk", "rain", "dawn", "overcast", "morning"]) if (lower.includes(env)) return env;
  return "day";
};

/** Full-size map image (banner). `sub` picks the thumbnail set instead. */
function mapUrl(text: string | null | undefined, gameId: string | null | undefined, sub: "maps" | "map-icons"): string | null {
  // Vietnam ships exactly ONE art set — the six gridded tactical maps the live screen draws — so
  // banner and thumbnail both answer from it. Before this, every Vietnam surface that asked for
  // map art (rotation banner, catalogue thumbs, live view, match reports) got null and rendered
  // bare text next to art-rich WW2 screens, while the art sat bundled the whole time.
  if (gameId === "hllv") {
    const fam = liveMapFamily(text, text, gameId);
    return fam ? `/game/hllv/maps/${fam}.webp` : null;
  }
  // Game first: the family match is a SUBSTRING search over WW2 names, so another game's map is
  // only ever one unlucky collision away from claiming one ("Foy" inside some future map id).
  if (gameId !== ART_GAME) return null;
  const fam = mapFamilyOf(text);
  if (!fam) return null;
  // The art doesn't cover every time-of-day; walk sensible fallbacks (morning/overcast → dawn/day).
  const envs = [envOf(text!), "dawn", "day", "dusk", "night", "rain"];
  for (const env of envs) if (HLL_MAP_IMAGES.has(`${fam}-${env}.webp`)) return `${BASE}/${sub}/${fam}-${env}.webp`;
  return null;
}
export const mapImageUrl = (text: string | null | undefined, gameId: string | null | undefined): string | null => mapUrl(text, gameId, "maps");
export const mapIconUrl = (text: string | null | undefined, gameId: string | null | undefined): string | null => mapUrl(text, gameId, "map-icons");

/** The clean tactical map (the objectives grid background). */
export function tacMapUrl(text: string | null | undefined, gameId: string | null | undefined): string | null {
  if (gameId !== ART_GAME) return null;
  const fam = mapFamilyOf(text);
  return fam && HLL_TAC_MAPS.has(`${fam}.webp`) ? `${BASE}/tac-maps/${fam}.webp` : null;
}

// Descriptor role names → icon file bases (the art uses HLL's internal spellings).
const ROLE_FILE: Record<string, string> = {
  machinegunner: "heavymachinegunner",
  antitank: "antitank",
  commander: "armycommander",
  tankcommander: "tankcommander",
  automaticrifleman: "automaticrifleman",
};

/**
 * Role icon (white-on-transparent; light theme inverts via CSS class `role-icon`).
 *
 * Gated on the game even though several role NAMES are shared, because the icon set is HLL's own
 * taxonomy — it has antitank, artillery observer and automatic rifleman, none of which Vietnam
 * fields, and its rifleman is a WW2 rifle. A Vietnam roster was drawing WW2 icons for the names
 * that happened to collide and nothing for its own roles (pilot, the mortar trio, logistics
 * officer), which is a half-iconed table pretending to be a whole one. Text for every row is the
 * honest version until Vietnam's icons exist.
 */
export function roleIconUrl(roleName: string | null | undefined, gameId: string | null | undefined): string | null {
  const art = gameId ? ICONS[gameId] : undefined;
  if (!roleName || !art) return null;
  const base = squash(roleName);
  const file = `${ROLE_FILE[base] ?? base}.png`;
  // Each game answers from ITS OWN set, so a name the other game happens to share (rifleman,
  // medic, engineer) still resolves to that game's own drawing of it.
  return art.roles.has(file) ? `${art.base}/roles/${file}` : null;
}

// Which nation fights for the Allies on each map family (Axis is Germany everywhere the art
// covers). Display-only: anything unlisted shows the US emblem.
const ALLIED_NATION: Record<string, string> = {
  elalamein: "gb", tobruk: "gb", driel: "gb",
  stalingrad: "rus", kursk: "rus", kharkov: "rus", smolensk: "rus",
  junobeach: "can",
};

/**
 * Faction emblems for a map: colored side icons for the match header.
 *
 * `gameId` is required and checked FIRST because these are Hell Let Loose's WW2 emblems and
 * nothing else ships with them. This function used to answer for any map at all, defaulting to
 * the US star and the German cross — so a Hell Let Loose: Vietnam round flew a Balkenkreuz over
 * the NVA. Every other resolver here returns null when it has no art for something; this one now
 * does too, and the header falls back to the game's own side labels.
 */
export function factionIconUrls(mapText: string | null | undefined, gameId: string | null | undefined): { allies: string | null; axis: string | null } {
  const art = gameId ? ICONS[gameId] : undefined;
  if (!art) return { allies: null, axis: null };
  const pick = (nation: string): string | null =>
    art.teams.has(`${nation}_colored.webp`) ? `${art.base}/teams/${nation}_colored.webp`
    : art.teams.has(`${nation}.webp`) ? `${art.base}/teams/${nation}.webp` : null;
  // Vietnam fields one pairing on every map, so there is no per-map table to consult: US against
  // the NVA, in the side order the descriptor uses (allies first).
  if (gameId === "hllv") return { allies: pick("us"), axis: pick("nva") };
  const fam = mapFamilyOf(mapText);
  return { allies: pick((fam && ALLIED_NATION[fam]) || "us"), axis: pick("ger") };
}

/**
 * The tactical map behind the live-position overlay — the one place Vietnam maps ARE bundled.
 *
 * WW2 answers from the existing tac-map set. Vietnam ships its own six gridded maps (the whole
 * catalogue — Warfare is the only mode with them), matched by folded name or by the game's own
 * map-id prefix (wdeva…wdevf), which the wire sometimes speaks when the display name is blank.
 */
const HLLV_LIVE_MAPS: Record<string, string> = {
  vantuong: "vantuong", quangngai: "quangngai", hueoutskirts: "hueoutskirts",
  daktoairfield: "daktoairfield", camranhport: "camranhport", thanhhoabridge: "thanhhoabridge",
};
const HLLV_MAP_PREFIX: Record<string, string> = {
  wdeva: "vantuong", wdevb: "quangngai", wdevc: "hueoutskirts",
  wdevd: "daktoairfield", wdeve: "camranhport", wdevf: "thanhhoabridge",
};
const foldLetters = (text: string): string =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * The map FAMILY key the live round belongs to — the same key zone paints are stored under
 * (zoneKeyOf server-side folds display names to these art-family spellings). Null when the map
 * can't be recognized, in which case there is no paint to look up either.
 */
export function liveMapFamily(mapText: string | null | undefined, mapId: string | null | undefined, gameId: string | null | undefined): string | null {
  if (gameId === "hllv") {
    const folded = foldLetters(mapText ?? "");
    for (const fam of Object.keys(HLLV_LIVE_MAPS)) if (folded.includes(fam)) return fam;
    const idFolded = foldLetters(mapId ?? "");
    for (const [prefix, fam] of Object.entries(HLLV_MAP_PREFIX)) if (idFolded.includes(prefix)) return fam;
    return null;
  }
  return mapFamilyOf(mapText);
}

export function liveMapUrl(mapText: string | null | undefined, mapId: string | null | undefined, gameId: string | null | undefined): string | null {
  if (gameId === "hllv") {
    const fam = liveMapFamily(mapText, mapId, gameId);
    return fam ? `/game/hllv/maps/${fam}.webp` : null;
  }
  return tacMapUrl(mapText, gameId) ?? mapImageUrl(mapText, gameId);
}

/**
 * World coordinates → a fraction of the map image. Every map both games ship runs the same
 * ±100,000cm square (verified across all 26 tactical maps), so this is one constant, not a
 * per-map calibration table. X grows east (image right), Y grows south (image down) — the same
 * orientation the tactical map is drawn in.
 */
export const WORLD_EXTENT = 100_000;
export function worldToFrac(v: number): number {
  return Math.min(1, Math.max(0, (v + WORLD_EXTENT) / (2 * WORLD_EXTENT)));
}
