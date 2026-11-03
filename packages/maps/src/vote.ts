/**
 * Map-vote poll composition — a cleaned-up port of the earlier bot's `_build_candidates` /
 * `_filter_base`. Given the server's map catalogue plus what's current / recently played / used in
 * recent polls, it composes the list of maps to vote on: day + night + wildcard buckets, an optional
 * "enforced" bucket, family de-duplication, and allow/deny/recent exclusion — and then adds the
 * set's always-offered maps on top, outside every one of those rules (finishBallot).
 *
 * PURE and deterministic when given an `rng`, so it unit-tests without a server. The winner is later
 * applied by the TESTED `scheduleNextMap` (raw ids only) — poll options carry a display `name` for
 * humans but everything downstream keys off `id`.
 *
 * This is the "room for improvement" layer the original author flagged, so it's tidied rather than
 * copied line-for-line; the placement reference in `schedule.ts` is the part kept verbatim.
 */
import { inferEnvironmentGroup, inferFamily, type MapItem } from "./hll-maps.js";

/**
 * One game mode's share of a poll, broken down by time of day.
 *
 * The day/night/wildcard buckets below can only ask "how many daytime maps", where "daytime" is
 * every environment the game does not call night — so "one dusk map" or "two morning maps" are not
 * sayable at all, and the mode is a filter buried inside a bucket rather than the thing being
 * chosen. A mode bucket turns that around: pick the mode, then say how many you want from each
 * actual environment the game reports (`day`, `night`, `dusk`, `morning`, `overcast`, `rain`, or
 * `any` for "whatever fits"), then curate the maps that answer to it.
 */
export interface ModeBucket {
  /** the game mode this category draws from (warfare | offensive | skirmish). */
  mode: string;
  /**
   * How many maps of this mode the poll gets. Absent falls back to the sum of `limits`, which is
   * what makes a set written before counts existed compose identically.
   */
  count?: number;
  /**
   * The most of each time of day that may appear WITHIN this mode's `count` — a ceiling, not a
   * quota. Two rules follow from that and they are the whole point:
   *
   *  - Caps that sum to more than `count` buy variety: "4 Warfare, at most 3 day, at most 2 night,
   *    at most 1 dusk" is a different-looking poll every time inside a shape you chose. Spelling
   *    the same range as exact quotas would need a category per combination, and Discord only
   *    allows ten options.
   *  - Caps that sum to exactly `count` force the split: "4 Warfare, day 3, night 1" is always
   *    three day and one night. So exact quotas are still sayable; they are just the tight end of
   *    the same dial.
   *
   * Empty (or containing the legacy `any` key) means no per-time restriction: every environment is
   * eligible, bounded only by `count`. An environment that is listed nowhere is not eligible.
   */
  limits?: Record<string, number>;
  /** @deprecated the pre-cap name for `limits`; read as limits so early sets still load. */
  counts?: Record<string, number>;
  /** raw ids this category may draw from; empty/absent = anything in the mode + chosen times. */
  maps?: string[];
}

/** A category's caps, and how many maps it should draw, resolved from either field spelling. */
export function resolveModeBucket(b: ModeBucket): { mode: string; count: number; caps: Map<string, number> | null } {
  const raw = b.limits ?? b.counts ?? {};
  const caps = new Map<string, number>();
  let unrestricted = false;
  let sum = 0;
  for (const [env, v] of Object.entries(raw)) {
    const n = Math.max(0, Math.round(Number(v) || 0));
    if (n <= 0) continue;
    sum += n;
    if (lc(env) === "any") unrestricted = true;
    else caps.set(lc(env), n);
  }
  // `count` is authoritative once it exists: 0 is a real answer (this mode contributes nothing),
  // not an invitation to fall back. Only its ABSENCE — a set saved before counts existed — reads
  // the ceilings' sum as the draw. `count || sum` here once made an explicit 0 snap back to the
  // sum, so a mode could not be turned off while its ceilings were still written down.
  const count = b.count === undefined || b.count === null ? sum : Math.max(0, Math.round(Number(b.count) || 0));
  return { mode: lc(b.mode), count, caps: unrestricted || caps.size === 0 ? null : caps };
}

export interface MapPoolConfig {
  /**
   * Mode-first composition. When this is present and asks for at least one map, it REPLACES the
   * day/night/wildcard buckets entirely — the two shapes are alternative ways to describe a poll,
   * never layers, and mixing them would double-count. Absent (or all-zero) leaves the buckets in
   * charge, so every set written before this existed composes exactly as it did.
   */
  modeBuckets?: ModeBucket[];
  /** how many "day"-environment battle-mode maps to include. */
  dayCount: number;
  /** how many "night"-environment battle-mode maps to include. */
  nightCount: number;
  /** how many wildcard-mode maps to include (0 or empty wildcardModes disables). */
  wildcardCount: number;
  /** allow the same map "family" more than once (off = one variant per base map).
   *  Legacy switch; `variety` supersedes it and is derived from it when absent. */
  duplicateMaps: boolean;
  /**
   * How much the same map may repeat within one poll:
   *  - "random"       — no de-duplication; two Carentan variants can both appear.
   *  - "per-map"      — at most one option per map, whatever the mode (the usual choice).
   *  - "per-map-mode" — at most one option per map PER MODE, so Carentan Warfare and Carentan
   *                     Offensive may both appear, but never two Warfare variants of Carentan.
   */
  variety?: "random" | "per-map" | "per-map-mode";
  /** When several variants of a map qualify, which to favour. "prefer-day" keeps polls off
   *  night/dusk variants unless nothing else fits. */
  variantPreference?: "random" | "prefer-day";
  /** modes counted as the day/night "battle" buckets (default ["warfare"]). */
  battleModes: string[];
  /** modes counted as wildcard (e.g. ["offensive"]). */
  wildcardModes: string[];
  /**
   * Per-bucket overrides. Each bucket may name its own game modes and its own eligible maps, which
   * is what lets one set ask for "3 daytime Warfare maps and 2 night Offensive maps" — a shape
   * `battleModes` alone cannot express, because day and night shared it.
   *
   * Every one is optional and absent means "as before": the mode lists fall back to `battleModes`
   * (wildcard to `wildcardModes`), and an empty/absent map list means the bucket may draw from
   * anything otherwise eligible. So a profile written before these existed composes identically.
   */
  dayModes?: string[];
  nightModes?: string[];
  /** raw ids this bucket may draw from; empty = no restriction beyond the set-wide rules. */
  dayMaps?: string[];
  nightMaps?: string[];
  wildcardMaps?: string[];
  /** if non-empty, ONLY these raw ids are eligible (allowlist). */
  allowedMaps: string[];
  /** raw ids that are never eligible. */
  blacklistMaps: string[];
  /**
   * How many recently-played maps to exclude, matched on the EXACT map — Foy Warfare having just
   * played holds back Foy Warfare, and says nothing about Foy at night or Foy Offensive.
   */
  excludePlayedMaps: number;
  /**
   * How many recently-played maps to exclude by FAMILY: every variant of them, so a Foy round
   * rests Foy Warfare, Foy Night and Foy Offensive alike. Counted in rounds played, not variants —
   * 3 means "the last three maps played, whole families". 0 disables it, which is the default and
   * the behaviour every set had before this existed.
   */
  excludePlayedFamilies?: number;
  /** exclusion of maps used in recent polls: "soft" allows them back on a shortage, "hard" never does. */
  previousPollExclusionMode: "soft" | "hard";
  /** force this many picks from `enforcedMaps` (0 disables). */
  enforceCount: number;
  enforcedMaps: string[];
  /**
   * Maps every vote this set composes offers, added AFTER the ballot is drawn — so none of the
   * draw's rules reach them: not the recently-played or family rests, not the previous-poll
   * exclusion, not this set's own allowed/never lists or modes. Enforced picks are different: they
   * are drawn like any category, so a just-played one sits out. Two things still skip an
   * always-offered map: it is the map being played (the vote picks the NEXT one, and the replay
   * guard refuses to queue the map in play), or the server does not have it. Riding in the set is
   * the point — it is offered exactly when the set is in charge, schedule and all.
   */
  alwaysOffer?: string[];
  /** hard cap on options. Never above POLL_OPTION_LIMIT — see there for why. */
  maxOptions: number;
  /**
   * An explicit, ordered ROTATION lineup — what "save the rotation as a set" writes and what
   * "apply this set to the rotation" reads (see rotation.ts). The vote engine ignores it: a poll
   * composes from the recipe fields above, while a rotation is a literal list where order is the
   * point. One set may carry both, so an event's set can drive its vote AND its rotation.
   */
  sequence?: string[];
}

/**
 * The most options a poll can carry. This is the VOTE SURFACE's limit, not a preference: a Discord
 * native poll takes at most ten answers and REFUSES the whole message when handed an eleventh, so
 * an over-large number here does not produce a bigger vote — it produces no vote at all, silently,
 * every round, until somebody reads the worker log.
 *
 * `maxOptions` was only ever consulted as a slice length, with 10 written inline as the fallback
 * for an unset value; nothing stopped a stored 20 (the API coerces rather than rejects, and both
 * the pool endpoint and map sets accept the key) from reaching the surface. It is a ceiling now as
 * well as a default, so a configuration that asks for too many loses the extra options rather than
 * the entire vote.
 */
export const POLL_OPTION_LIMIT = 10;

export const DEFAULT_POOL_CONFIG: MapPoolConfig = {
  dayCount: 3, nightCount: 1, wildcardCount: 3, duplicateMaps: false,
  variety: "per-map", variantPreference: "random",
  battleModes: ["warfare"], wildcardModes: ["offensive"],
  allowedMaps: [], blacklistMaps: [], excludePlayedMaps: 4, excludePlayedFamilies: 0,
  previousPollExclusionMode: "soft", enforceCount: 0, enforcedMaps: [], maxOptions: 10,
};

export interface PollOption { id: string; name: string }
export interface BuildPollInput {
  catalogue: MapItem[];
  config: MapPoolConfig;
  currentMapId?: string;
  /** recently-played raw ids (newest first); the first `excludePlayedMaps` are excluded. */
  recentIds?: string[];
  /** raw ids used in recent polls, to avoid repeating options. */
  previousPollIds?: string[];
  /** injectable RNG in [0,1) for deterministic tests (defaults to Math.random). */
  rng?: () => number;
}
export interface BuildPollResult {
  options: PollOption[];
  /**
   * Requested-minus-picked per bucket, so callers can warn when the pool was too thin. Mode-first
   * sets report one key per game mode instead — "warfare", "offensive" — which is why this is
   * open-ended rather than the four fixed keys it started as.
   */
  shortfall: { enforced: number; day: number; night: number; wildcard: number } & Record<string, number>;
  summary: string;
  /**
   * When nothing could be composed: which filter emptied the pool, in words, naming the counts.
   *
   * The summary alone says what was ASKED for and that the answer was zero — "day=3 night=1
   * wildcard=3 … → 0 options" — which leaves staff to guess between an over-eager exclusion list, a
   * catalogue the server never returned, and a set curated down to nothing. Every one of those is a
   * different fix, and the engine is the only place that knows which happened.
   */
  diagnosis?: string;
  /** The set's always-offered maps that made this ballot, by id (see MapPoolConfig.alwaysOffer).
   *  Present only when the set has any. */
  alwaysOffered?: string[];
  /** …and the ones that did not, with why. */
  alwaysSkipped?: { id: string; why: AlwaysSkip }[];
}

/** Why an always-offered map was left off a ballot: it is the map being played, the server does
 *  not have it, or the set lists more of them than the poll can hold. */
export type AlwaysSkip = "in-play" | "not-on-server" | "no-room";

const lc = (s: string) => s.toLowerCase();
const lcSet = (xs: string[]) => new Set(xs.map(lc));

/** Fisher–Yates shuffle using the injected rng (does not mutate the input). */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Why maps fell out of the base pool, counted so a poll of nothing can name its own cause. */
interface BaseDrops {
  catalogue: number;
  current: number;
  notAllowed: number;
  blacklisted: number;
  recentlyPlayed: number;
  restedFamily: number;
  otherMode: number;
}

/** Base eligibility: dedupe, drop current, apply allow/deny, drop recent, keep only known modes. */
function filterBase(input: BuildPollInput, drops?: BaseDrops): MapItem[] {
  const { catalogue, config, currentMapId } = input;
  const allowed = lcSet(config.allowedMaps);
  const blacklist = lcSet(config.blacklistMaps);
  const played = input.recentIds ?? [];
  const recent = lcSet(played.slice(0, Math.max(0, config.excludePlayedMaps)));
  // Resting a whole family is a separate, usually shorter window than resting the exact variant:
  // "not Foy Warfare again for four rounds" and "no Foy of any kind for two" are different wishes.
  // The catalogue is the source of a map's family; ids it does not carry (a map dropped from the
  // server since it was played) still resolve, because the family is derivable from the id.
  const familyById = new Map(catalogue.map((m) => [lc(m.id), lc(m.family)]));
  const familyOf = (id: string) => familyById.get(lc(id)) ?? lc(inferFamily(id));
  const restedFamilies = new Set(played.slice(0, Math.max(0, config.excludePlayedFamilies ?? 0)).map(familyOf));
  // Every mode any bucket might ask for. Per-bucket lists widen this: a night bucket set to
  // Offensive must survive the base filter even when `battleModes` is Warfare only. Mode buckets
  // are the same story — a set built only from them names its modes nowhere else.
  const modes = new Set([
    ...config.battleModes, ...config.wildcardModes,
    ...(config.dayModes ?? []), ...(config.nightModes ?? []),
    ...(config.modeBuckets ?? []).map((b) => b.mode),
  ].map(lc));
  const current = currentMapId ? lc(currentMapId) : "";
  const seen = new Set<string>();
  const out: MapItem[] = [];
  for (const item of catalogue) {
    const key = lc(item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (drops) drops.catalogue++;
    if (current && key === current) { if (drops) drops.current++; continue; }
    if (allowed.size && !allowed.has(key)) { if (drops) drops.notAllowed++; continue; }
    if (blacklist.has(key)) { if (drops) drops.blacklisted++; continue; }
    if (recent.has(key)) { if (drops) drops.recentlyPlayed++; continue; }
    if (restedFamilies.size && restedFamilies.has(lc(item.family))) { if (drops) drops.restedFamily++; continue; }
    if (!modes.has(lc(item.mode))) { if (drops) drops.otherMode++; continue; }
    out.push(item);
  }
  return out;
}

/**
 * Say, in one sentence a person can act on, why a poll came out empty.
 *
 * Ordered by how badly each cause misleads. An empty catalogue is a server problem, not a settings
 * one, and must not be reported as "check your exclusions". Everything the exclusions removed comes
 * next, largest first, because that is the knob staff actually reach for. A pool that survived every
 * filter and still drew nothing is a counts problem, which reads completely differently.
 */
function diagnose(drops: BaseDrops, eligible: number, config: MapPoolConfig): string {
  if (drops.catalogue === 0) {
    return "the server returned no maps at all — this is a connection or game problem, not a map-set one";
  }
  if (eligible > 0) {
    return `${eligible} of the server's ${drops.catalogue} maps got past every exclusion, but no category asked for any of them — check the category counts, and that each category's mode has maps on this server`;
  }
  const causes: { n: number; say: string }[] = [
    { n: drops.blacklisted, say: `${drops.blacklisted} are on this set's "never offer these" list` },
    { n: drops.notAllowed, say: `${drops.notAllowed} are outside the maps this set is limited to` },
    { n: drops.otherMode, say: `${drops.otherMode} are modes this set never asks for` },
    { n: drops.recentlyPlayed, say: `${drops.recentlyPlayed} were played too recently (exclude the last ${config.excludePlayedMaps})` },
    { n: drops.restedFamily, say: `${drops.restedFamily} are resting with the rest of their map family` },
    { n: drops.current, say: `${drops.current} is the map playing right now` },
  ].filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
  const because = causes.length ? causes.map((c) => c.say).join(", ") : "every one was filtered out";
  return `not one of the server's ${drops.catalogue} maps survived this set's filters: ${because}`;
}

/** Effective variety: the newer `variety` if set, else derived from the legacy duplicateMaps flag. */
function varietyOf(config: MapPoolConfig): "random" | "per-map" | "per-map-mode" {
  return config.variety ?? (config.duplicateMaps ? "random" : "per-map");
}

/** The key two options must not share, given the variety rule. `null` = never collides. */
function varietyKey(item: MapItem, config: MapPoolConfig): string | null {
  switch (varietyOf(config)) {
    case "random": return null;
    case "per-map-mode": return `${lc(item.family)}|${lc(item.mode)}`;
    default: return lc(item.family);
  }
}

/** Order a shuffled pool by variant preference: day-ish variants first when asked, order kept
 *  otherwise. Stable, so the shuffle still decides among equally-preferred variants. */
function byVariantPreference(pool: MapItem[], config: MapPoolConfig): MapItem[] {
  if (config.variantPreference !== "prefer-day") return pool;
  const rank = (m: MapItem) => (inferEnvironmentGroup(m.environment) === "day" ? 0 : 1);
  return pool.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

/**
 * Randomly pick up to `count`, respecting the variety rule and — when given — a per-environment
 * ceiling. `caps` null means no per-time restriction; an environment absent from a non-null caps
 * map is not eligible at all. Consumed caps are written back so a second pass (the soft fallback)
 * cannot spend the same allowance twice.
 */
function pickRandom(items: MapItem[], count: number, config: MapPoolConfig, rng: () => number, caps?: Map<string, number> | null): MapItem[] {
  if (count <= 0 || items.length === 0) return [];
  const pool = byVariantPreference(shuffle(items, rng), config);
  const selected: MapItem[] = [];
  const seen = new Set<string>();
  for (const item of pool) {
    if (caps) {
      const env = lc(item.environment);
      const left = caps.get(env);
      if (!left) continue; // not eligible, or its ceiling is already spent
    }
    const key = varietyKey(item, config);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (caps) {
      const env = lc(item.environment);
      caps.set(env, (caps.get(env) ?? 0) - 1);
    }
    selected.push(item);
    if (selected.length >= count) break;
  }
  return selected;
}

/** Remove already-selected ids (and anything colliding under the variety rule) from a pool. */
function removeSelected(pool: MapItem[], selected: MapItem[], config: MapPoolConfig): MapItem[] {
  const ids = new Set(selected.map((x) => x.id));
  const keys = new Set(selected.map((x) => varietyKey(x, config)).filter((k): k is string => k !== null));
  return pool.filter((item) => {
    if (ids.has(item.id)) return false;
    const key = varietyKey(item, config);
    return key === null || !keys.has(key);
  });
}

/** Pick one bucket: prefer maps not in recent polls, falling back on a shortage when mode is "soft". */
function pickBucket(pool: MapItem[], count: number, selected: MapItem[], previousIds: Set<string>, config: MapPoolConfig, rng: () => number, caps?: Map<string, number> | null): MapItem[] {
  const available = removeSelected(pool, selected, config);
  const preferred = previousIds.size ? available.filter((m) => !previousIds.has(lc(m.id))) : available;
  // One caps map across both passes: pickRandom spends it, so the fallback can only use what the
  // first pass left. Copied so the caller's ceilings are not mutated between categories.
  const budget = caps ? new Map(caps) : caps;
  const picked = pickRandom(preferred, count, config, rng, budget);
  if (picked.length < count && previousIds.size && config.previousPollExclusionMode === "soft") {
    const fallbackPool = removeSelected(available, picked, config);
    picked.push(...pickRandom(fallbackPool, count - picked.length, config, rng, budget));
  }
  return picked;
}

/** How many options this poll may carry: what the set asks for, never more than the surface takes,
 *  and the limit itself when the set says nothing. */
const pollSize = (config: MapPoolConfig): number =>
  config.maxOptions > 0 ? Math.min(config.maxOptions, POLL_OPTION_LIMIT) : POLL_OPTION_LIMIT;

const toOption = (m: MapItem): PollOption => ({ id: m.id, name: m.prettyName });

/**
 * The ballot, finished: the drawn maps shuffled into place, and then the set's always-offered maps
 * added on top (MapPoolConfig.alwaysOffer).
 *
 * Each always-offered map takes the place of any drawn option it collides with under this set's
 * variety rule — the same map, or (one option per map) another variant of it — so offering
 * Carentan Warfare every vote never leaves Carentan Night beside it splitting the Carentan vote.
 * Past that, the drawn maps give way: a full ballot drops drawn options at random to make room,
 * and an always-offered map is never the one cut. The result is shuffled again, so an
 * always-offered map does not sit first on every ballot (the replay guard reads the first eligible
 * option as a random pick from the set).
 *
 * A set with nothing to always offer takes exactly the path it always did.
 */
function finishBallot(selected: MapItem[], input: BuildPollInput, rng: () => number): Pick<BuildPollResult, "options" | "alwaysOffered" | "alwaysSkipped"> {
  const config = input.config;
  const size = pollSize(config);
  const wanted = (config.alwaysOffer ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (!wanted.length) return { options: shuffle(selected, rng).slice(0, size).map(toOption) };

  const byId = new Map(input.catalogue.map((m) => [lc(m.id), m]));
  const current = input.currentMapId ? lc(input.currentMapId) : "";
  const always: MapItem[] = [];
  const skipped: { id: string; why: AlwaysSkip }[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    const key = lc(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byId.get(key);
    if (!item) { skipped.push({ id, why: "not-on-server" }); continue; }
    if (key === current) { skipped.push({ id: item.id, why: "in-play" }); continue; }
    if (always.length >= size) { skipped.push({ id: item.id, why: "no-room" }); continue; }
    always.push(item);
  }
  const ids = new Set(always.map((m) => lc(m.id)));
  const keys = new Set(always.map((m) => varietyKey(m, config)).filter((k): k is string => k !== null));
  const drawn = shuffle(selected, rng).filter((m) => {
    if (ids.has(lc(m.id))) return false;
    const k = varietyKey(m, config);
    return k === null || !keys.has(k);
  });
  const ballot = shuffle([...always, ...drawn.slice(0, Math.max(0, size - always.length))], rng);
  return {
    options: ballot.map(toOption),
    alwaysOffered: always.map((m) => m.id),
    ...(skipped.length ? { alwaysSkipped: skipped } : {}),
  };
}

/** The summary's word for the always-offered maps, when the set has any. */
const alwaysNote = (config: MapPoolConfig): string =>
  config.alwaysOffer?.length ? ` always=${config.alwaysOffer.length}` : "";

/** Compose the poll. Options carry a display `name` (already the effective/overridden pretty name). */
export function buildPoll(input: BuildPollInput): BuildPollResult {
  const config = input.config;
  const rng = input.rng ?? Math.random;
  const drops: BaseDrops = { catalogue: 0, current: 0, notAllowed: 0, blacklisted: 0, recentlyPlayed: 0, restedFamily: 0, otherMode: 0 };
  const base = filterBase(input, drops);
  const battleModes = new Set((config.battleModes.length ? config.battleModes : ["warfare"]).map(lc));
  const previousIds = lcSet(input.previousPollIds ?? []);
  const selected: MapItem[] = [];

  // Enforced picks first (a bucket drawn only from enforcedMaps).
  let enforced: MapItem[] = [];
  if (config.enforceCount > 0 && config.enforcedMaps.length) {
    const enforcedSet = lcSet(config.enforcedMaps);
    const pool = base.filter((m) => enforcedSet.has(lc(m.id)));
    enforced = pickBucket(pool, config.enforceCount, selected, previousIds, config, rng);
    selected.push(...enforced);
  }

  // A bucket's own mode list wins where it has one; otherwise it inherits, exactly as before.
  const modesFor = (own: string[] | undefined, inherited: Set<string>) => (own?.length ? lcSet(own) : inherited);
  // …and its own map list restricts it where it has one; an empty list is "no restriction", NOT
  // "nothing", so a bucket nobody has curated still draws from the whole catalogue.
  const mapsFor = (own: string[] | undefined) => (own?.length ? lcSet(own) : null);
  const inBucket = (m: MapItem, allow: Set<string> | null) => allow === null || allow.has(lc(m.id));

  // --- mode-first sets: one category per game mode, drawn under per-time-of-day ceilings ---
  // The raw bucket's curated map list rides along BEFORE the filter: indexing back into
  // config.modeBuckets with the filtered position handed every bucket after a switched-off one
  // (count: 0) the WRONG bucket's allowlist.
  const modeBuckets = (config.modeBuckets ?? [])
    .map((raw) => ({ ...resolveModeBucket(raw), maps: raw.maps }))
    .filter((b) => b.mode && b.count > 0);
  if (modeBuckets.length) {
    // Enforced picks were drawn above, before the branch — a mode-first set with enforceCount
    // still gets them, so their shortfall must be reported the same way the legacy path does.
    const shortfall: BuildPollResult["shortfall"] = {
      enforced: Math.max(0, (config.enforceCount && config.enforcedMaps.length ? config.enforceCount : 0) - enforced.length),
      day: 0, night: 0, wildcard: 0,
    };
    const asked: string[] = [];
    for (const bucket of modeBuckets) {
      const allow = mapsFor(bucket.maps);
      // The environment is matched EXACTLY, not by the coarse day/night grouping — asking for a
      // dusk map and being handed a rain one is the thing this shape exists to fix. A null caps
      // map means the mode takes any time of day; otherwise only the capped ones are eligible.
      const pool = base.filter((m) => lc(m.mode) === bucket.mode
        && (bucket.caps === null || bucket.caps.has(lc(m.environment)))
        && inBucket(m, allow));
      const picked = pickBucket(pool, bucket.count, selected, previousIds, config, rng, bucket.caps);
      selected.push(...picked);
      shortfall[bucket.mode] = (shortfall[bucket.mode] ?? 0) + Math.max(0, bucket.count - picked.length);
      const shape = bucket.caps ? [...bucket.caps].map(([e, n]) => `${e}<=${n}`).join(",") : "any";
      asked.push(`${bucket.mode}=${bucket.count}(${shape})`);
    }
    const ballot = finishBallot(selected, input, rng);
    return {
      ...ballot,
      shortfall,
      summary: `${asked.join(" ")} enforce=${config.enforceCount}${alwaysNote(config)} exclude_recent=${config.excludePlayedMaps} → ${ballot.options.length} options`,
      // Said whenever the DRAW came up empty, even with always-offered maps filling the ballot:
      // the set's categories are still offering nothing, and that is still worth knowing.
      ...(selected.length === 0 ? { diagnosis: diagnose(drops, base.length, config) } : {}),
    };
  }

  const dayModes = modesFor(config.dayModes, battleModes);
  const dayMaps = mapsFor(config.dayMaps);
  const dayPool = base.filter((m) => inferEnvironmentGroup(m.environment) === "day" && dayModes.has(lc(m.mode)) && inBucket(m, dayMaps));
  const day = pickBucket(dayPool, config.dayCount, selected, previousIds, config, rng);
  selected.push(...day);

  const nightModes = modesFor(config.nightModes, battleModes);
  const nightMaps = mapsFor(config.nightMaps);
  const nightPool = base.filter((m) => inferEnvironmentGroup(m.environment) === "night" && nightModes.has(lc(m.mode)) && inBucket(m, nightMaps));
  const night = pickBucket(nightPool, config.nightCount, selected, previousIds, config, rng);
  selected.push(...night);

  let wildcard: MapItem[] = [];
  if (config.wildcardCount > 0 && config.wildcardModes.length) {
    const wildcardSet = lcSet(config.wildcardModes);
    const wildcardMaps = mapsFor(config.wildcardMaps);
    const pool = base.filter((m) => wildcardSet.has(lc(m.mode)) && inBucket(m, wildcardMaps));
    wildcard = pickBucket(pool, config.wildcardCount, selected, previousIds, config, rng);
    selected.push(...wildcard);
  }

  const ballot = finishBallot(selected, input, rng);
  const options = ballot.options;
  const shortfall = {
    enforced: Math.max(0, (config.enforceCount && config.enforcedMaps.length ? config.enforceCount : 0) - enforced.length),
    day: Math.max(0, config.dayCount - day.length),
    night: Math.max(0, config.nightCount - night.length),
    wildcard: Math.max(0, (config.wildcardCount && config.wildcardModes.length ? config.wildcardCount : 0) - wildcard.length),
  };
  const summary = `day=${config.dayCount} night=${config.nightCount} wildcard=${config.wildcardCount} enforce=${config.enforceCount}${alwaysNote(config)} exclude_recent=${config.excludePlayedMaps} duplicates=${config.duplicateMaps} → ${options.length} options`;
  return { ...ballot, shortfall, summary, ...(selected.length === 0 ? { diagnosis: diagnose(drops, base.length, config) } : {}) };
}
