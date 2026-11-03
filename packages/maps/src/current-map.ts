/**
 * Which map is ACTUALLY being played.
 *
 * The rotation's own "current index" is not the answer, and on a server running the map vote it is
 * reliably the WRONG answer. The live-leader tracker collapses the rotation down to the single map
 * the vote is queuing (that is the old bot's placement algorithm, and it works), so a normal server's
 * rotation is one entry long — and its current index therefore points at the map about to play.
 * Every screen that asked the rotation "what is on now" was shown the NEXT map, and watched it
 * change each time the poll's leader changed.
 *
 * The session is the authority: it is the game saying what it is running. Its raw id is used when
 * the build reports one. Failing that the printable name is matched back to the catalogue — squashed
 * to bare letters, because "VẠN TƯỜNG" and `wdevb_offensivenva_day` line up no other way — and
 * disambiguated by mode, since one map's Warfare and Offensive variants share a printable name. The
 * rotation index survives only as the last resort, for a session read that failed outright.
 */

export interface CurrentMapSession {
  /** the exact map id, when the build reports one — always preferred. */
  mapId?: string;
  /** the printable name ("VẠN TƯỜNG"): accented free text, matched by squashing. */
  mapName?: string;
  /** "NVA Offensive", "Warfare" — separates variants that share a printable name. */
  gameMode?: string;
}

export interface CurrentMapCatalogueItem {
  id: string;
  prettyName: string;
  mode?: string;
}

export interface CurrentMapInput {
  session?: CurrentMapSession | null;
  /** used ONLY when the session cannot answer. */
  rotation?: { maps: string[]; currentIndex: number } | null;
  catalogue?: CurrentMapCatalogueItem[];
}

/** Letters and digits only, accents folded — the only form these two spellings share. */
function squash(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The id of the map in play, or null when nothing could say. */
export function resolveCurrentMapId(input: CurrentMapInput): string | null {
  const session = input.session ?? null;

  const id = session?.mapId?.trim();
  if (id) return id;

  const name = session?.mapName?.trim();
  const catalogue = input.catalogue ?? [];
  if (name && catalogue.length) {
    const wanted = squash(name);
    // The catalogue labels a map "Quảng Ngãi — Off NVA Day"; the session calls it "QUẢNG NGÃI". So
    // the comparison is against the NAME half, with the whole label accepted too for builds that
    // report the mode along with it.
    const matches = (m: CurrentMapCatalogueItem) => {
      const squashed = squash(m.prettyName);
      return squashed === wanted || squash(m.prettyName.split("—")[0] ?? "") === wanted;
    };
    // The printable name alone is ambiguous — Quảng Ngãi Warfare and Quảng Ngãi Offensive answer to
    // it equally — so a single match is taken and several are put to the mode before being used.
    const byName = catalogue.filter(matches);
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) {
      const mode = squash(session?.gameMode ?? "");
      const byMode = mode ? byName.filter((m) => m.mode && mode.includes(squash(m.mode))) : [];
      if (byMode.length === 1) return byMode[0]!.id;
      // Still ambiguous: answering with a coin flip would be worse than admitting the rotation is
      // all that is left, because the answer feeds map exclusion for the next vote.
    }
  }

  const rot = input.rotation;
  return rot?.maps[rot.currentIndex] ?? null;
}

/** A rotation or play-queue entry as the game describes it (see the game module's mapEntries). */
export interface ListedMap {
  id: string;
  name: string;
  gameMode: string;
  timeOfDay: string;
}

/**
 * The map id a listed entry means, in the vocabulary the rest of the app speaks: the rotation's
 * layer ids.
 *
 * The game's play queue names its maps by a level path ("/Game/…/SMDM…") where the rotation has
 * the layer id (`SMDM_S_1944_Day_P_Skirmish`). Taken raw, the queue's entry prettified to "Game Bnw
 * Maps Fra Smdm Smdm Day" and never compared equal to the rotation's entry for the very same map.
 * So, in order:
 *
 *   1. an id the app already knows (in the rotation or the catalogue) is used as it is;
 *   2. the ROTATION entry the game describes the same way — same name, mode and time of day — gives
 *      its layer id (both lists come from the same game, in the same words);
 *   3. failing that, the one catalogue map with that name and mode (time of day breaking a tie);
 *   4. failing everything, the id as given — a shown oddity beats a guessed map.
 */
export function resolveListedMapId(
  entry: ListedMap,
  ctx: { rotation: ListedMap[]; catalogue: CurrentMapCatalogueItem[] },
): string {
  const lower = (s: string) => s.trim().toLowerCase();
  const id = entry.id.trim();
  const known = new Set([...ctx.rotation.map((r) => lower(r.id)), ...ctx.catalogue.map((c) => lower(c.id))]);
  if (id && known.has(lower(id))) {
    return ctx.rotation.find((r) => lower(r.id) === lower(id))?.id ?? ctx.catalogue.find((c) => lower(c.id) === lower(id))?.id ?? id;
  }
  const name = squash(entry.name);
  if (!name) return id;
  const mode = squash(entry.gameMode);
  const time = squash(entry.timeOfDay);
  const same = ctx.rotation.find((r) => r.id && squash(r.name) === name && squash(r.gameMode) === mode && squash(r.timeOfDay) === time);
  if (same) return same.id;
  const byName = ctx.catalogue.filter((c) => squash(c.prettyName.split("—")[0] ?? "") === name && (!mode || !c.mode || squash(c.mode) === mode));
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1 && time) {
    const byTime = byName.filter((c) => squash(c.id).includes(time));
    if (byTime.length === 1) return byTime[0]!.id;
  }
  return id;
}
