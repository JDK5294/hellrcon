/**
 * Reading HLL's `readState` answers.
 *
 * The command table says how to ASK a server something; this says how to understand what comes
 * back. It belongs to the game module for the same reason the log parser does — the field names
 * here (`mAPS`, `iD`, `dialogueParameters`) are HLL's, and nothing outside a game module should
 * know them.
 *
 * It exists because they leaked anyway. The API and the worker each grew a private copy of these
 * three parsers, and the copies drifted:
 *
 *   • the worker's map-catalogue parser matched only `iD === "MapName"`, while the API's also
 *     accepted `id` — so against a server build that reports the lowercase spelling, the panel
 *     listed every map while the worker's map vote saw none to choose from;
 *   • the worker's player count read only `alliedPlayerCount`/`axisPlayerCount`, while the API's
 *     also accepted the snake_case spellings — so on those builds every population-gated
 *     auto-settings profile and the map vote's low-population pause silently never fired.
 *
 * Both readers now accept every spelling either copy did, because a server that answers in one of
 * them is a server we have already seen.
 */

import type { GameMapListEntry } from "../types.js";

/** Every reasonable spelling of a field, tried in order. */
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

const csv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The rotation and where in it the server currently sits. */
export function parseRotation(raw: unknown): { maps: string[]; currentIndex: number } {
  if (!raw) return { maps: [], currentIndex: 0 };
  // Some builds answer with the bare list rather than an object around it.
  if (Array.isArray(raw)) return { maps: raw.map(String), currentIndex: 0 };
  const o = raw as Record<string, unknown>;
  const rows = pick(o, "mAPS", "maps", "MAPS");
  const maps = Array.isArray(rows)
    ? rows
      .map((m) => (typeof m === "string" ? m : String(pick(m as Record<string, unknown>, "iD", "id") ?? "")))
      .filter(Boolean)
    : [];
  return { maps, currentIndex: Number(pick(o, "currentIndex", "current_index") ?? 0) || 0 };
}

/**
 * The rotation entry the game will play next, by index, or null when the answer does not say.
 *
 * It is NOT the first entry. The game keeps its own place in the list and plays the entry after
 * it, wrapping round, and edits do not carry that place along the way staff expect: add maps to
 * the end of a short list and "next" can jump from entry 1 to entry 3. Read from the place the
 * game reports, the same reading the live view and status board use for "next map" (and a next
 * index the answer states itself, as CRCON's flattened one does, wins).
 *
 * Null for a bare list or an answer with no index: guessing entry 2 would be the same misreading
 * this exists to stop.
 */
export function parseNextInRotation(raw: unknown): number | null {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") return null;
  const { maps } = parseRotation(raw);
  if (!maps.length) return null;
  const o = raw as Record<string, unknown>;
  const stated = pick(o, "nextIndex", "next_index");
  if (stated !== undefined) {
    const n = Number(stated);
    return Number.isInteger(n) && n >= 0 && n < maps.length ? n : null;
  }
  const at = Number(pick(o, "currentIndex", "current_index"));
  if (!Number.isInteger(at)) return null;
  return (((at + 1) % maps.length) + maps.length) % maps.length;
}

/**
 * A rotation or play-queue answer's entries, each with the game's own description of it.
 *
 * The play queue names its maps by a different id from the rotation's — a level path where the
 * rotation has the layer id the rotation commands take — so the two lists can only be lined up by
 * what the game says each entry IS: its name, mode and time of day. Shown raw, a queue entry read
 * "Game Bnw Maps Fra Smdm Smdm Day" and never compared equal to the rotation's own entry for the
 * same map.
 */
export function parseMapEntries(raw: unknown): GameMapListEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = Array.isArray(raw) ? raw : pick(raw as Record<string, unknown>, "mAPS", "maps", "MAPS");
  if (!Array.isArray(rows)) return [];
  const text = (v: unknown): string => (v == null ? "" : String(v).trim());
  return rows
    .map((m): GameMapListEntry => {
      if (typeof m === "string") return { id: m.trim(), name: "", gameMode: "", timeOfDay: "" };
      const o = (m ?? {}) as Record<string, unknown>;
      return {
        id: text(pick(o, "iD", "id")),
        name: text(pick(o, "name", "Name")),
        gameMode: text(pick(o, "gameMode", "GameMode", "game_mode")),
        timeOfDay: text(pick(o, "timeOfDay", "TimeOfDay", "time_of_day")),
      };
    })
    .filter((e) => e.id || e.name);
}

/**
 * Whether the game shuffles its play order, or null when the answer does not say.
 *
 * Shuffled, the order the rotation is listed in is not the order it plays — the one thing staff
 * editing that list need to know. v2 answers like its sibling getters (`{ enable: true }`); the
 * legacy wire answers in words.
 */
export function parseMapShuffle(raw: unknown): boolean | null {
  /*
   * A WHOLE answer that is one of these words, never a word found somewhere in a sentence: a reply
   * like "Map shuffle enabled: False" holds "enabled", and reading it as on would put a shuffle
   * warning on a server that is not shuffling. Anything else is unknown, which shows nothing.
   */
  const words = (t: string): boolean | null => {
    const w = t.trim().toLowerCase();
    return ["true", "on", "enabled", "yes", "1"].includes(w) ? true : ["false", "off", "disabled", "no", "0"].includes(w) ? false : null;
  };
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === 0) return raw === 1;
  if (typeof raw === "string") return words(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = pick(raw as Record<string, unknown>, "enable", "enabled", "Enable", "Enabled", "mapShuffleEnabled", "isEnabled");
  return typeof v === "boolean" ? v : typeof v === "string" ? words(v) : null;
}

/**
 * Every map the server will accept, out of the client-reference-data answer.
 *
 * The list arrives as a comma-separated string buried in a dialogue parameter, which is why this
 * has to accept a plain string and a plain array too: different builds hand it over at different
 * depths, and the shallow forms are what the tests and the CRCON bridge produce.
 */
export function parseMapCatalogue(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return csv(raw);
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  const params = (raw as { dialogueParameters?: unknown[] }).dialogueParameters;
  if (Array.isArray(params)) {
    const mapParam = params.find((x) => {
      if (!x || typeof x !== "object") return false;
      const o = x as Record<string, unknown>;
      return o.iD === "MapName" || o.id === "MapName";
    }) as Record<string, unknown> | undefined;
    const value = pick(mapParam ?? {}, "valueMember", "value");
    if (typeof value === "string") return csv(value);
  }
  return [];
}

/**
 * Players online, from the session read. Null when the answer doesn't say — which is not the same
 * as zero, and callers that gate on population must treat it as "unknown" rather than "empty".
 */
export function parsePlayerCount(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const total = Number(pick(o, "playerCount", "player_count"));
  if (Number.isFinite(total)) return total;
  const allied = Number(pick(o, "alliedPlayerCount", "allied_player_count"));
  const axis = Number(pick(o, "axisPlayerCount", "axis_player_count"));
  return Number.isFinite(allied) && Number.isFinite(axis) ? allied + axis : null;
}

/**
 * The 5×3 objective grid from GetClientReferenceData("SetSectorLayout"): five Sector_N dialogue
 * parameters, each a comma-list of the three objectives that sector can run. Order matters — the
 * row index IS the sector number — so this validates shape rather than tolerating partial data: a
 * missing sector answers [] rather than four rows that would shift every later pick up by one.
 *
 * Lifted out of the API's route kit so the worker (which applies objective presets once a map has
 * loaded) reads the grid with the same parser the panel's live picker does, instead of growing the
 * private copy this file's header warns about. Only the grid of the map PLAYING NOW can be read —
 * the command takes no map argument (docs/rcon-503.md).
 */
export function parseObjectiveRows(raw: unknown): string[][] {
  const params = (raw as { dialogueParameters?: unknown[] } | null)?.dialogueParameters;
  if (!Array.isArray(params)) return [];
  const rows: string[][] = [];
  for (let i = 1; i <= 5; i++) {
    const p = params.find((x) => x && typeof x === "object" && ((x as Record<string, unknown>).iD === `Sector_${i}` || (x as Record<string, unknown>).id === `Sector_${i}`)) as Record<string, unknown> | undefined;
    const v = p?.valueMember ?? p?.value;
    const opts = typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!opts.length) return [];
    rows.push(opts);
  }
  return rows;
}
