"use client";
/**
 * The map set editor — what a vote is allowed to offer.
 *
 * The version this replaces put every knob on screen at once: day/night/wildcard counts, two
 * dropdowns about duplicate handling, and two search boxes, whether or not you were using any of
 * them. A set that only wanted night maps still had to look at the day fields, and the game modes
 * each bucket drew from were not editable at all — day and night silently shared one list.
 *
 * So it is three buckets, each behind its own switch, and a switch that is off shows nothing. Turn
 * on Night maps and you get exactly the three decisions night has: how many, which modes, which
 * maps. That is the whole idea — the screen only ever shows the options for the things you have
 * actually turned on.
 *
 * The count IS the switch: `nightCount > 0` is what the engine has always meant by "this set uses
 * night maps", so there is no second flag to fall out of step with it, and old sets light up the
 * right switches with no migration.
 *
 * Maps are chosen from a grid of pictures (MapGrid), never typed. Staff should not have to know
 * that Carentan's German offensive is spelled `carentan_offensive_ger`.
 */
import { useMemo, useState } from "react";
import { MapGrid, type GridMap } from "./MapGrid";
import { Callout } from "./ui";

export interface Pool {
  dayCount?: number; nightCount?: number; wildcardCount?: number; duplicateMaps?: boolean;
  battleModes?: string[]; wildcardModes?: string[]; allowedMaps?: string[]; blacklistMaps?: string[];
  excludePlayedMaps?: number;
  excludePlayedFamilies?: number;
  /** Guaranteed picks from enforcedMaps, drawn before any category. Set via presets/API only. */
  enforceCount?: number; enforcedMaps?: string[];
  /** Offered in every vote this set runs, added after the draw — see MapPoolConfig.alwaysOffer. */
  alwaysOffer?: string[];
  variety?: "random" | "per-map" | "per-map-mode";
  variantPreference?: "random" | "prefer-day";
  dayModes?: string[]; nightModes?: string[];
  dayMaps?: string[]; nightMaps?: string[]; wildcardMaps?: string[];
  /** Mode-first categories — see ModeBucket in @app/maps. Present = these compose the poll. */
  modeBuckets?: ModeBucket[];
}

export interface ModeBucket {
  mode: string;
  /** how many maps of this mode the poll gets. */
  count?: number;
  /** the most of each time of day allowed WITHIN that count. Empty = any time of day. */
  limits?: Record<string, number>;
  /** @deprecated pre-ceiling spelling of limits. */
  counts?: Record<string, number>;
  maps?: string[];
}

/** The caps a category carries, whichever field spelling it was saved with. */
const limitsOf = (b: ModeBucket): Record<string, number> => b.limits ?? b.counts ?? {};
/** How many maps it draws: its own count (0 really means 0), or — for a set saved before counts
 *  existed — the ceilings' sum. Mirrors the engine's resolveModeBucket exactly. */
const drawOf = (b: ModeBucket): number => {
  if (b.count === undefined || b.count === null) return Object.values(limitsOf(b)).reduce((n, v) => n + (Number(v) || 0), 0);
  return Math.max(0, Math.round(Number(b.count) || 0));
};

/** Every mode either game runs, in the order staff think about them. Only modes present in the
 *  server's own catalogue are offered (see `available` below), so an HLL server never sees
 *  Vietnam's Conquest/Domination and a Vietnam server never sees Skirmish. */
const MODES = ["warfare", "offensive", "skirmish", "conquest", "domination"] as const;
const MODE_LABEL: Record<string, string> = {
  warfare: "Warfare", offensive: "Offensive", skirmish: "Skirmish", conquest: "Conquest", domination: "Domination",
};
const MODE_BLURB: Record<string, string> = {
  warfare: "The standard game mode — both sides attack.",
  offensive: "One side attacks a fixed line of sectors.",
  skirmish: "Small-scale, one objective.",
  conquest: "Hold ground to drain the enemy's morale.",
  domination: "Control points scored over time.",
};

/** How the game itself labels a map's time of day, plus "any" for "whatever fits". */
const ENV_LABEL: Record<string, string> = {
  any: "Any time", day: "Day", night: "Night", dusk: "Dusk", morning: "Morning", overcast: "Overcast", rain: "Rain",
};
const ENV_ORDER = ["any", "day", "night", "dusk", "morning", "overcast", "rain"];

/** What a Discord poll holds. The engine caps at maxOptions too; this is so staff see it coming. */
const POLL_MAX = 10;



/**
 * One game mode, and how much of the vote it fills.
 *
 * Modes are the categories because that is the first thing staff decide — "I want three Warfare
 * maps and one Offensive" — and time of day is a property of the maps inside, not a separate
 * bucket that owns a mode list. The times offered are the ones this mode's maps ACTUALLY have on
 * this server: asking for two Skirmish night maps when the server ships none is a count that can
 * never fill, and the old editor let you write it.
 */
function ModeCategory({ bucket, set, remove, catalogue, disabled }: {
  bucket: ModeBucket; set: (patch: Partial<ModeBucket>) => void; remove: () => void;
  catalogue: GridMap[]; disabled?: boolean;
}) {
  const [showMaps, setShowMaps] = useState(false);
  const mode = bucket.mode;
  const limits = limitsOf(bucket);
  const draw = drawOf(bucket);

  // Only this mode's maps, and only the times of day they come in.
  const inMode = useMemo(() => catalogue.filter((m) => (m.mode ?? "").toLowerCase() === mode), [catalogue, mode]);
  const envs = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of inMode) {
      const e = (m.environment ?? "day").toLowerCase();
      seen.set(e, (seen.get(e) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => ENV_ORDER.indexOf(a[0]) - ENV_ORDER.indexOf(b[0]));
  }, [inMode]);

  // Which times this category may use: the capped ones, or all of them when nothing is capped.
  // Plain, not memoized — it is a filter over a few hundred items, and the caps object is rebuilt
  // each render anyway, so a memo here only buys a dependency that cannot be compared cheaply.
  const allowedEnvs = new Set(Object.entries(limits).filter(([, n]) => Number(n) > 0).map(([e]) => e));
  const capped = allowedEnvs.size > 0;
  const scoped = capped ? inMode.filter((m) => allowedEnvs.has((m.environment ?? "day").toLowerCase())) : inMode;

  const capTotal = Object.values(limits).reduce((n, v) => n + (Number(v) || 0), 0);

  const setLimit = (env: string, n: number) => {
    const next = { ...limits };
    if (n > 0) next[env] = n; else delete next[env];
    // A time that is no longer allowed can strand map picks; drop the ones this category can no
    // longer reach rather than leave a selection that silently contributes nothing.
    const allowed = new Set(Object.keys(next));
    const keep = (bucket.maps ?? []).filter((id) => {
      if (allowed.size === 0) return true;
      const item = catalogue.find((c) => c.id === id);
      return !item || allowed.has((item.environment ?? "day").toLowerCase());
    });
    // The count is the user's number, not this handler's: clamping it to the ceilings here meant
    // typing "4" and then setting the first ceiling silently rewrote the 4 to a 3, mid-thought.
    // A count the ceilings cannot reach is the red warning's job to say, not this one's to "fix".
    // A set from before counts existed gets its current draw pinned once, so editing a ceiling no
    // longer changes how many maps it asks for.
    const count = bucket.count === undefined || bucket.count === null ? drawOf(bucket) : bucket.count;
    set({ limits: next, counts: undefined, maps: keep, count });
  };

  return (
    <div className="setting-card mapset-bucket" style={{ marginTop: 10 }}>
      <div className="control-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong>{MODE_LABEL[mode] ?? mode}</strong>
          <div className="hint" style={{ marginTop: 2 }}>
            {MODE_BLURB[mode] ?? ""} {inMode.length} map{inMode.length === 1 ? "" : "s"} on this server.
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", margin: 0 }}>
          <label style={{ margin: 0, fontSize: ".85rem" }}>
            In the vote
            <input type="number" min={0} max={10} value={draw} disabled={disabled} style={{ width: 62, marginLeft: 6 }}
              onChange={(e) => set({ count: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <button type="button" className="ghost mini mapset-maps-toggle" onClick={() => setShowMaps((v) => !v)} aria-expanded={showMaps}>
            {showMaps ? "▾" : "▸"} Maps · {(bucket.maps?.length ?? 0) > 0 ? `${bucket.maps!.length} picked` : `all ${scoped.length}`}
          </button>
          {!disabled && <button type="button" className="danger mini" onClick={remove}>Remove</button>}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="hint" style={{ marginBottom: 4 }}>
          At most this many of each time of day {capped ? <>· leave a time at 0 to keep it out</> : <>· all 0 means any time of day</>}
        </div>
        <div className="mapset-envs">
          {envs.map(([e, have]) => (
            <label key={e} className="mapset-env">
              <span className="mapset-env-name">
                {ENV_LABEL[e] ?? e}
                <span className="hint"> · {have}</span>
              </span>
              <input
                type="number" min={0} max={10} value={limits[e] ?? 0} disabled={disabled}
                onChange={(ev) => setLimit(e, Math.max(0, Number(ev.target.value) || 0))}
              />
            </label>
          ))}
        </div>
        {/* The two ways a category disappoints, said before it happens rather than as a thin poll. */}
        {draw === 0 && <p className="hint" style={{ marginTop: 4 }}>Nothing asked for, so this mode adds no options.</p>}
        {draw > 0 && capped && capTotal < draw && (
          <p className="hint mapset-warn" style={{ marginTop: 4 }}>
            The ceilings only allow {capTotal}, so this asks for {draw} and can never fill. Raise a ceiling or lower the count.
          </p>
        )}
        {draw > 0 && scoped.length < draw && (
          <p className="hint mapset-warn" style={{ marginTop: 4 }}>
            Only {scoped.length} map{scoped.length === 1 ? "" : "s"} on this server match{scoped.length === 1 ? "es" : ""} these times — asking for {draw} will come up short.
          </p>
        )}
        {draw > 0 && capped && capTotal > draw && (
          <p className="hint" style={{ marginTop: 4 }}>
            Ceilings add up to {capTotal} for {draw} slot{draw === 1 ? "" : "s"}, so the mix varies between votes.
          </p>
        )}
      </div>

      {showMaps && (
        <div style={{ marginTop: 12 }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            Which maps {scoped.length > 0 && <>· {scoped.length} fit the times above</>}
          </div>
          <MapGrid
            catalogue={scoped}
            value={bucket.maps ?? []}
            onChange={(v) => set({ maps: v })}
            disabled={disabled}
            emptyMeans={`every ${MODE_LABEL[mode] ?? mode} map that fits`}
          />
        </div>
      )}
    </div>
  );
}

export function toModeBuckets(pool: Pool, defaultPool: Pool = {}): ModeBucket[] {
  const battle = pool.battleModes ?? defaultPool.battleModes ?? ["warfare"];
  const byMode = new Map<string, ModeBucket>();
  const bucketFor = (mode: string) => {
    const key = mode.toLowerCase();
    if (!byMode.has(key)) byMode.set(key, { mode: key, count: 0, limits: {}, maps: [] });
    return byMode.get(key)!;
  };
  const add = (count: number | undefined, modes: string[], env: string, maps: string[] | undefined) => {
    if (!count || !modes.length) return;
    const b = bucketFor(modes[0]!);
    // The old bucket's count becomes both the mode's draw and this time's ceiling, so the caps sum
    // to the count and the converted set draws exactly the split it drew before — no new variety
    // sneaks in behind a conversion that promised to change nothing.
    b.limits![env] = (b.limits![env] ?? 0) + count;
    b.count = (b.count ?? 0) + count;
    if (maps?.length) b.maps = [...new Set([...(b.maps ?? []), ...maps])];
    for (const extra of modes.slice(1)) bucketFor(extra); // offered, at zero
  };
  add(pool.dayCount, pool.dayModes?.length ? pool.dayModes : battle, "day", pool.dayMaps);
  add(pool.nightCount, pool.nightModes?.length ? pool.nightModes : battle, "night", pool.nightMaps);
  // Wildcard drew from any environment, so it converts to a count with no ceilings at all.
  add(pool.wildcardCount, pool.wildcardModes ?? defaultPool.wildcardModes ?? [], "any", pool.wildcardMaps);
  // …and "any" is spelled as the absence of ceilings, not as a time of day.
  for (const b of byMode.values()) if (b.limits?.any) { delete b.limits.any; }
  return [...byMode.values()];
}

export function MapSetEditor({ pool, set, catalogue, defaultPool = {}, disabled }: {
  pool: Pool; set: (patch: Pool) => void; catalogue: GridMap[]; defaultPool?: Pool; disabled?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [alwaysOpen, setAlwaysOpen] = useState(false);
  const buckets = pool.modeBuckets ?? [];
  // PRESENT, not non-empty. A mode-based set with no categories yet is still mode-based; reading
  // emptiness as "legacy" made every new set open on the convert-me notice, and made converting an
  // empty legacy set a no-op that left the notice on screen.
  const converted = Array.isArray(pool.modeBuckets);

  // Only modes the server actually runs can be added — a category for a mode with no maps is a
  // count that can never fill.
  const available = useMemo(() => {
    const seen = new Set<string>();
    for (const m of catalogue) if (m.mode) seen.add(m.mode.toLowerCase());
    return MODES.filter((m) => seen.has(m));
  }, [catalogue]);
  const missing = available.filter((m) => !buckets.some((b) => b.mode === m));

  const total = buckets.reduce((n, b) => n + drawOf(b), 0);
  // Enforced picks (presets/API only — no field here) land in the poll BEFORE the categories
  // draw, so they count against Discord's ten options exactly like a category's maps do.
  const enforce = (pool.enforceCount ?? defaultPool.enforceCount ?? 0) > 0 && (pool.enforcedMaps ?? defaultPool.enforcedMaps ?? []).length > 0
    ? (pool.enforceCount ?? defaultPool.enforceCount ?? 0) : 0;
  const excluded = pool.blacklistMaps?.length ?? 0;
  const always = pool.alwaysOffer ?? [];
  const nameOfMap = (id: string) => catalogue.find((m) => m.id.toLowerCase() === id.toLowerCase())?.prettyName;
  const namesOf = (ids: string[]) => ids.map((id) => nameOfMap(id) ?? `${id} (not on this server)`).join(", ");
  // On both lists is a contradiction staff should hear about: the engine adds always-offered maps
  // after the draw, so the veto never reaches them.
  const vetoed = always.filter((id) => (pool.blacklistMaps ?? []).some((b) => b.toLowerCase() === id.toLowerCase()));

  const setBucket = (i: number, patch: Partial<ModeBucket>) =>
    set({ modeBuckets: buckets.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  // The legacy shape is still what the engine composes until this is converted, so the old totals
  // are what the set really offers — saying otherwise would be a lie on screen.
  const legacyTotal = (pool.dayCount ?? 0) + (pool.nightCount ?? 0) + (pool.wildcardCount ?? 0);

  return (
    <>
      {!converted && (
        <>
          <p className="hint mt-0">
            This set still uses the older day/night/wildcard buckets: it offers <strong>{legacyTotal}</strong> map
            {legacyTotal === 1 ? "" : "s"} a vote.
          </p>
          <Callout variant="info">
            <strong>Build this set by game mode instead.</strong> Modes become the categories — Warfare, Offensive,
            Skirmish — and each one says how many maps it wants from each time of day, down to dusk and morning rather
            than everything-that-is-not-night. Converting keeps what this set offers today; nothing changes until you
            save.
            {!disabled && (
              <div className="actions" style={{ marginTop: 8 }}>
                <button type="button" onClick={() => set({ modeBuckets: toModeBuckets(pool, defaultPool) })}>
                  Convert this set
                </button>
              </div>
            )}
          </Callout>
        </>
      )}

      {converted && (
        <>
          <p className="hint mt-0">
            {total > 0
              ? <>Each vote offers <strong>{total}</strong> map{total === 1 ? "" : "s"}, drawn at random from the categories below{always.length > 0 && <> — plus <strong>{always.length}</strong> always offered</>}.</>
              : always.length > 0
                ? <>Every category asks for nothing, so each vote offers only the <strong>{always.length}</strong> always-offered map{always.length === 1 ? "" : "s"}.</>
                : <>Every category asks for nothing, so this set has nothing to offer.</>}
          </p>

          {/* Poll size is a hard limit, not a preference: Discord refuses more than ten options, so
              a set that adds up past it silently loses whatever falls off the end. Enforced picks
              land in the poll first, so they count against the limit too. */}
          {total + enforce + always.length > POLL_MAX && (
            <Callout variant="warn">
              These categories add up to <strong>{total}</strong> maps
              {enforce > 0 && <> plus <strong>{enforce}</strong> enforced pick{enforce === 1 ? "" : "s"}</>}
              {always.length > 0 && <> plus <strong>{always.length}</strong> always offered</>},
              but a Discord poll holds <strong>{POLL_MAX}</strong>. {total + enforce + always.length - POLL_MAX} would be
              dropped at random every vote{always.length > 0 && " (never an always-offered one)"}. Lower a category&apos;s
              count — or use the ceilings to get variety within a smaller total instead of a category per combination.
            </Callout>
          )}

          {buckets.map((b, i) => (
            <ModeCategory
              key={b.mode}
              bucket={b}
              set={(patch) => setBucket(i, patch)}
              remove={() => set({ modeBuckets: buckets.filter((_, j) => j !== i) })}
              catalogue={catalogue}
              disabled={disabled}
            />
          ))}

          {!disabled && missing.length > 0 && (
            <div className="actions" style={{ marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="hint">Add a mode:</span>
              {missing.map((m) => (
                <button key={m} type="button" className="ghost"
                  onClick={() => set({ modeBuckets: [...buckets, { mode: m, count: 0, limits: {}, maps: [] }] })}>
                  {MODE_LABEL[m] ?? m}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Outside the draw on purpose: these maps are added to the ballot after the categories
          have drawn theirs, so recently played, family rests and the last vote never hold them
          back. They ride in the set, so they are on exactly when the set is. */}
      <div className="setting-card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <strong className="fs-lg">Always offer</strong>
          {/* Read-only viewers already have the names in the line below; a grid they cannot change
              would only invite a press that does nothing. */}
          {!disabled && (
            <button type="button" className="ghost mini" onClick={() => setAlwaysOpen((v) => !v)} aria-expanded={alwaysOpen}>
              {alwaysOpen ? "Done" : always.length > 0 ? "Change" : "Choose maps"}
            </button>
          )}
        </div>
        <p className="hint" style={{ margin: "2px 0 6px" }}>
          {always.length > 0
            ? <>Every vote this set runs offers <strong>{namesOf(always)}</strong> — even right after {always.length === 1 ? "it" : "one of them"} played,
                while its map family is resting, or when it was in the last vote. Skipped only while it is the map being played.</>
            : <>Maps every vote this set runs offers on top of what the categories draw. Recently played, family rests and the
                last vote don&apos;t apply to them — and they are only offered while this set is the one in charge.</>}
        </p>
        {alwaysOpen && !disabled && (
          <MapGrid
            catalogue={catalogue}
            value={always}
            onChange={(v) => set({ alwaysOffer: v.slice(0, POLL_MAX) })}
            disabled={disabled}
            emptyMeans="nothing extra"
          />
        )}
        {vetoed.length > 0 && (
          <Callout variant="warn">
            <strong>{namesOf(vetoed)}</strong> {vetoed.length === 1 ? "is" : "are"} also under <strong>Never offer these</strong> (Advanced).
            Always offer wins — it is added after the vote is drawn — so take {vetoed.length === 1 ? "it" : "them"} off one of the two lists.
          </Callout>
        )}
      </div>

      <button
        type="button" className="ghost" style={{ marginTop: 12 }}
        onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}
      >
        {advanced ? "▾" : "▸"} Advanced
      </button>

      {advanced && (
        <div className="setting-card" style={{ marginTop: 8 }}>
          <div className="grid">
            <label>Don&apos;t re-offer the last
              <input type="number" min={0} max={20} value={pool.excludePlayedMaps ?? 4} disabled={disabled}
                onChange={(e) => set({ excludePlayedMaps: Number(e.target.value) })} />
              <span className="hint">
                Rounds, matched on the <strong>exact map</strong>: Foy Warfare having just played holds back Foy
                Warfare, and says nothing about Foy at night or Foy Offensive.
              </span>
            </label>
            <label>…and rest whole map families for
              <input type="number" min={0} max={20} value={pool.excludePlayedFamilies ?? 0} disabled={disabled}
                onChange={(e) => set({ excludePlayedFamilies: Number(e.target.value) })} />
              <span className="hint">
                {(pool.excludePlayedFamilies ?? 0) > 0
                  ? <>Rounds. A Foy round now rests <strong>every</strong> Foy — warfare, night and offensive — for {pool.excludePlayedFamilies} round{pool.excludePlayedFamilies === 1 ? "" : "s"}, so the place changes and not just the lighting.</>
                  : <>0 = off. Set it to rest every variant of a map for a few rounds after any of them plays, so players get a different place rather than the same one at a different time of day.</>}
              </span>
            </label>
            <label>Can the same map appear twice?
              <select value={pool.variety ?? (pool.duplicateMaps ? "random" : "per-map")} disabled={disabled}
                onChange={(e) => set({ variety: e.target.value as Pool["variety"] })}>
                <option value="per-map">No — one option per map</option>
                <option value="per-map-mode">Once per mode — Carentan Warfare and Carentan Offensive</option>
                <option value="random">Yes — anything goes</option>
              </select>
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong className="fs-lg">Never offer these</strong>
            <p className="hint" style={{ margin: "2px 0 6px" }}>
              {excluded > 0
                ? <><strong>{excluded}</strong> map{excluded === 1 ? "" : "s"} can never appear, whichever bucket would have drawn them.</>
                : <>A set-wide veto. Buckets already control what they offer, so you only need this for a map that must never come up at all.</>}
            </p>
            <MapGrid
              catalogue={catalogue}
              value={pool.blacklistMaps ?? []}
              onChange={(v) => set({ blacklistMaps: v })}
              disabled={disabled}
              emptyMeans="nothing is vetoed"
            />
          </div>
        </div>
      )}
    </>
  );
}

export default MapSetEditor;
