/**
 * Find the bundled map artwork for a round, so the Discord board can carry the same picture the
 * panel's match card does.
 *
 * The art ships with the panel (`apps/panel/out/game/hll/maps/<family>-<env>.webp`) and the worker
 * runs the same image as the API, so the files are on disk beside it. Rather than duplicate the
 * panel's manifest here — two lists that would drift the first time art is added — the directory
 * IS the manifest: whatever is on disk is what can be drawn.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "@app/db";

/** Same reduction the panel uses: drop accents, fold "Saint(e)" to "St", keep letters and digits. */
const squash = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bsainte?\b/g, "st")
    .replace(/[^a-z0-9]/g, "");

const ENVS = ["night", "dusk", "rain", "dawn", "overcast", "morning"];
/** Walked in order when the round's own time of day has no art (morning/overcast → dawn/day). */
const FALLBACK = ["dawn", "day", "dusk", "night", "rain"];

/**
 * Pick the artwork file for a map, from the filenames that exist.
 *
 * `text` is any map text — the raw id ("stmereeglise_offensive_us") or the printable name. Longest
 * family match wins so "stmereeglise" never half-matches "stmariedumont". Returns null for a map we
 * have no art for, which is a board without a picture rather than a broken one.
 */
export function pickMapArt(files: string[], text: string | null | undefined): string | null {
  if (!text) return null;
  const byFamily = new Map<string, Set<string>>();
  for (const f of files) {
    const m = /^(.+)-([a-z]+)\.webp$/.exec(f);
    if (!m) continue;
    const [, family, env] = m as unknown as [string, string, string];
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family)!.add(env);
  }

  const hay = squash(text);
  let fam: string | null = null;
  for (const family of byFamily.keys()) if (hay.includes(family) && (!fam || family.length > fam.length)) fam = family;
  if (!fam) return null;

  const lower = text.toLowerCase();
  const wanted = ENVS.find((e) => lower.includes(e)) ?? "day";
  const have = byFamily.get(fam)!;
  for (const env of [wanted, ...FALLBACK]) if (have.has(env)) return `${fam}-${env}.webp`;
  return null;
}

/**
 * The root the panel's game artwork is published under.
 *
 * WEB_ROOT is what the image the API and worker share sets, but the same files also sit in the
 * panel's source `public/` — so a deployment that lays things out differently, or a dev running the
 * worker straight from the repo, still finds them. First root that actually has the maps wins.
 */
const ROOTS = [
  process.env.GAME_ART_DIR,
  process.env.WEB_ROOT && join(process.env.WEB_ROOT, "game", "hll"),
  "/app/apps/panel/out/game/hll",
  join("apps", "panel", "out", "game", "hll"),
  join("apps", "panel", "public", "game", "hll"),
].filter(Boolean) as string[];

const resolved = new Map<string, Promise<{ dir: string; maps: string[] }>>();
/**
 * Find a GAME's artwork root once, and remember what's in its maps folder.
 *
 * The published layout is `game/<gameId>/…`, so every other game is a sibling of the HLL root the
 * ROOTS list finds. Only HLL ships art today; another game's root resolves to an empty listing,
 * which draws boards without pictures — and the moment files are dropped into `game/hllv/maps`
 * (or `teams`), they are the manifest, no code change.
 */
function root(game: string): Promise<{ dir: string; maps: string[] }> {
  let r = resolved.get(game);
  if (!r) {
    r = (async () => {
      for (const hll of ROOTS) {
        const dir = game === "hll" ? hll : join(hll, "..", game);
        const maps = await readdir(join(dir, "maps")).catch(() => null);
        if (maps?.length) return { dir, maps };
      }
      const fallback = ROOTS[0] ?? "";
      return { dir: game === "hll" ? fallback : join(fallback, "..", game), maps: [] };
    })();
    resolved.set(game, r);
  }
  return r;
}

interface Nation { code: string; name: string }

/**
 * Which nation fights for the allies on a WW2 map, and what each side is called.
 *
 * Display only — the game reports faction ids we have no table for, and every map the art covers
 * has exactly one allied nation. Anything unlisted is the US, which is the common case.
 */
const ALLIED_NATION: Record<string, Nation> = {
  elalamein: { code: "gb", name: "UNITED KINGDOM" },
  tobruk: { code: "gb", name: "UNITED KINGDOM" },
  driel: { code: "gb", name: "UNITED KINGDOM" },
  stalingrad: { code: "rus", name: "SOVIET UNION" },
  kursk: { code: "rus", name: "SOVIET UNION" },
  kharkov: { code: "rus", name: "SOVIET UNION" },
  smolensk: { code: "rus", name: "SOVIET UNION" },
  junobeach: { code: "can", name: "CANADA" },
};
const US = { code: "us", name: "UNITED STATES" };
const AXIS = { code: "ger", name: "GERMANY" };

/** HLL: Vietnam is one matchup on every map — the game's reference export has faction 1
 *  (United States) on team 1 and faction 6 (NVA) on team 2, map-independent. */
const HLLV_NATIONS: [Nation, Nation] = [US, { code: "nva", name: "NORTH VIETNAM" }];

/**
 * The two nations playing this round: [allies, axis] — or null for a game this table does not
 * know, which a caller must treat as "use the game's own side labels, show no emblems".
 *
 * Keyed by GAME first, map second. This used to answer from the WW2 table for any map at all,
 * so a Hell Let Loose: Vietnam round flew GERMANY over the NVA — the same bug the panel's
 * factionIconUrls already fixed on its side.
 */
export function nationsFor(game: string | null | undefined, text: string | null | undefined): [Nation, Nation] | null {
  if (game === "hllv") return HLLV_NATIONS;
  if (game !== "hll") return null;
  const fam = text ? familyOf(text) : null;
  return [(fam && ALLIED_NATION[fam]) || US, AXIS];
}

/** Resolve a family name from map text without needing the file listing (nations don't need it). */
function familyOf(text: string): string | null {
  const hay = squash(text);
  let best: string | null = null;
  for (const fam of Object.keys(ALLIED_NATION)) if (hay.includes(fam) && (!best || fam.length > best.length)) best = fam;
  return best;
}

/** The game's own score glyphs, keyed the way the board asks for them. */
const SCORE_ICON: Record<string, string> = {
  kills: "infantry.png",
  combat: "score_combat.png",
  offense: "score_offensive.png",
  defense: "score_defensive.png",
  support: "score_support.png",
};

/** The score glyphs for the totals row. Missing art simply means a card without a mark on it.
 *  Deliberately NOT per-game: combat/offense/defense/support are the app's scoring vocabulary in
 *  every game, and the glyphs are the shared marks for them. */
export async function loadScoreIcons(): Promise<Record<string, Uint8Array | null>> {
  const { dir } = await root("hll");
  const out: Record<string, Uint8Array | null> = {};
  for (const [key, file] of Object.entries(SCORE_ICON)) {
    try { out[key] = await readFile(join(dir, "roles", file)); } catch { out[key] = null; }
  }
  return out;
}

/** A nation's colour emblem, for the scoreline — from the GAME's own art, because these are
 *  period insignia: Vietnam-era US must not inherit the WW2 star by accident, and the NVA must
 *  never inherit anything. Null when the art isn't there, which draws a name-only side. */
export async function loadEmblem(game: string, code: string): Promise<Uint8Array | null> {
  const { dir } = await root(game);
  for (const file of [`${code}_colored.webp`, `${code}.webp`]) {
    try { return await readFile(join(dir, "teams", file)); } catch { /* try the next */ }
  }
  return null;
}

/**
 * The community's own badge, for the corner of the match board: uploaded in the panel (Discord,
 * Relay & alerts) and kept with the community's other settings. None is built in. One shipped as a
 * file once, and every install's board wore that one community's badge; without an upload, the
 * board carries only the server's name. A read that fails draws the board without it, as a plainer
 * board beats none.
 */
export async function loadBoardLogo(repo: Pick<Repository, "brandImages">): Promise<Uint8Array | null> {
  return (await repo.brandImages.get("board-badge").catch(() => null))?.bytes ?? null;
}

export interface MapArt { name: string; bytes: Uint8Array }

/** The artwork for a round, from the GAME's own maps folder — or null when there is none to
 *  attach. Per-game so a WW2 filename can never answer for a Vietnam map (or vice versa). */
export async function loadMapArt(game: string, text: string | null | undefined): Promise<MapArt | null> {
  const { dir, maps } = await root(game);
  const name = pickMapArt(maps, text);
  if (!name) return null;
  try {
    return { name, bytes: await readFile(join(dir, "maps", name)) };
  } catch {
    return null; // listed but unreadable: draw the board without a picture
  }
}
