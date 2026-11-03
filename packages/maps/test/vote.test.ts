import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoll, describeMaps, DEFAULT_POOL_CONFIG, POLL_OPTION_LIMIT, type MapItem, type MapPoolConfig } from "../dist/index.js";

/** Deterministic RNG (mulberry32) so shuffles are reproducible in tests. */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A catalogue with distinct families across day/night/offensive.
const IDS = [
  "carentan_warfare", "carentan_warfare_night",
  "foy_warfare", "foy_warfare_night",
  "hill400_warfare",
  "stalingrad_warfare", "stalingrad_warfare_night",
  "kursk_warfare", "kursk_warfare_night",
  "stmariedumont_off_us", "stmariedumont_off_ger", // same family (override)
  "omahabeach_offensiveus",
  "purpleheartlane_offensiveger",
];
const CAT = describeMaps(IDS);
function cfg(over: Partial<MapPoolConfig> = {}): MapPoolConfig {
  return { ...DEFAULT_POOL_CONFIG, ...over };
}
const families = (ids: string[]) => ids.map((id) => CAT.find((m) => m.id === id)!.family);

test("no duplicate families unless duplicates allowed", () => {
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 3, nightCount: 2, wildcardCount: 2 }), rng: rngFrom(1) });
  const fams = families(r.options.map((o) => o.id));
  assert.equal(new Set(fams).size, fams.length, `families should be unique: ${fams.join(",")}`);
});

test("respects bucket counts with duplicates allowed (family dedup off)", () => {
  // duplicate_maps=true removes the family constraint, so counts are met when the pool is big enough.
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 3, nightCount: 2, wildcardCount: 2, duplicateMaps: true, wildcardModes: ["offensive"] }), rng: rngFrom(7) });
  assert.equal(r.options.length, 7);
  assert.equal(r.shortfall.day, 0);
  assert.equal(r.shortfall.night, 0);
  assert.equal(r.shortfall.wildcard, 0);
});

test("day/night buckets only draw from their environment + battle mode", () => {
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 10, nightCount: 0, wildcardCount: 0, duplicateMaps: true }), rng: rngFrom(3) });
  // all options must be day + warfare
  for (const o of r.options) {
    const m = CAT.find((x) => x.id === o.id)!;
    assert.equal(m.environment === "night", false, `${o.id} should be day`);
    assert.equal(m.mode, "warfare");
  }
});

test("wildcard bucket draws from wildcard modes only", () => {
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 0, nightCount: 0, wildcardCount: 3, duplicateMaps: true, wildcardModes: ["offensive"] }), rng: rngFrom(5) });
  assert.ok(r.options.length > 0);
  for (const o of r.options) assert.equal(CAT.find((x) => x.id === o.id)!.mode, "offensive");
});

test("blacklist and current map are excluded", () => {
  const r = buildPoll({
    catalogue: CAT, currentMapId: "foy_warfare",
    config: cfg({ dayCount: 10, nightCount: 0, wildcardCount: 0, duplicateMaps: true, blacklistMaps: ["hill400_warfare"] }),
    rng: rngFrom(2),
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(!ids.includes("foy_warfare"), "current excluded");
  assert.ok(!ids.includes("hill400_warfare"), "blacklisted excluded");
});

test("allowlist restricts eligibility", () => {
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 10, nightCount: 0, wildcardCount: 0, duplicateMaps: true, allowedMaps: ["carentan_warfare", "foy_warfare"] }),
    rng: rngFrom(9),
  });
  assert.deepEqual(r.options.map((o) => o.id).sort(), ["carentan_warfare", "foy_warfare"]);
});

test("recently-played maps are excluded up to excludePlayedMaps", () => {
  const r = buildPoll({
    catalogue: CAT, recentIds: ["carentan_warfare", "foy_warfare", "hill400_warfare"],
    config: cfg({ dayCount: 10, nightCount: 0, wildcardCount: 0, duplicateMaps: true, excludePlayedMaps: 2 }),
    rng: rngFrom(4),
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(!ids.includes("carentan_warfare") && !ids.includes("foy_warfare"), "first 2 recent excluded");
  assert.ok(ids.includes("hill400_warfare"), "3rd recent NOT excluded (beyond excludePlayedMaps=2)");
});

test("previous-poll options excluded; hard mode keeps them out even on shortage", () => {
  const prev = ["carentan_warfare", "foy_warfare", "hill400_warfare", "stalingrad_warfare", "kursk_warfare"];
  const hard = buildPoll({
    catalogue: CAT, previousPollIds: prev,
    config: cfg({ dayCount: 5, nightCount: 0, wildcardCount: 0, duplicateMaps: true, previousPollExclusionMode: "hard" }),
    rng: rngFrom(6),
  });
  // every day-warfare map is in prev → hard mode yields none from that bucket
  for (const o of hard.options) assert.ok(!prev.includes(o.id));
  // soft mode allows them back rather than leaving the poll short
  const soft = buildPoll({
    catalogue: CAT, previousPollIds: prev,
    config: cfg({ dayCount: 5, nightCount: 0, wildcardCount: 0, duplicateMaps: true, previousPollExclusionMode: "soft" }),
    rng: rngFrom(6),
  });
  assert.ok(soft.options.length > hard.options.length, "soft fallback fills more than hard");
});

test("maxOptions caps the poll", () => {
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 5, nightCount: 3, wildcardCount: 4, duplicateMaps: true, wildcardModes: ["offensive"], maxOptions: 5 }), rng: rngFrom(8) });
  assert.equal(r.options.length, 5);
});

test("options carry the display name and the raw id", () => {
  const r = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 1, nightCount: 0, wildcardCount: 0, duplicateMaps: true }), rng: rngFrom(1) });
  const o = r.options[0]!;
  const m = CAT.find((x) => x.id === o.id)!;
  assert.equal(o.name, m.prettyName); // display
  assert.match(o.id, /_warfare/); // raw id used downstream
});

/* --- variety rules + variant preference (the old bot's behaviour, kept) --- */
const VARIETY_CATALOGUE: MapItem[] = [
  { id: "carentan_warfare", prettyName: "Carentan", mode: "warfare", environment: "day", family: "carentan" },
  { id: "carentan_warfare_night", prettyName: "Carentan (Night)", mode: "warfare", environment: "night", family: "carentan" },
  { id: "carentan_offensive_us", prettyName: "Carentan (Off.)", mode: "offensive", environment: "day", family: "carentan" },
  { id: "foy_warfare", prettyName: "Foy", mode: "warfare", environment: "day", family: "foy" },
];

test("variety per-map: only one option from a map family, whatever the mode", () => {
  const cfg: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, dayCount: 4, nightCount: 0, wildcardCount: 0, variety: "per-map", battleModes: ["warfare", "offensive"] };
  const poll = buildPoll({ catalogue: VARIETY_CATALOGUE, config: cfg, rng: rngFrom(7) });
  const families = poll.options.map((o) => o.id.split("_")[0]);
  assert.equal(new Set(families).size, families.length, "no family appears twice");
});

test("variety per-map-mode: same map may appear once per mode, never twice in one mode", () => {
  const cfg: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, dayCount: 4, nightCount: 0, wildcardCount: 0, variety: "per-map-mode", battleModes: ["warfare", "offensive"] };
  const poll = buildPoll({ catalogue: VARIETY_CATALOGUE, config: cfg, rng: rngFrom(7) });
  const keys = poll.options.map((o) => {
    const m = VARIETY_CATALOGUE.find((x) => x.id === o.id)!;
    return `${m.family}|${m.mode}`;
  });
  assert.equal(new Set(keys).size, keys.length, "no map+mode pair repeats");
  // carentan warfare + carentan offensive are allowed together under this rule
  assert.ok(poll.options.length >= 2);
});

test("variety random: duplicates of a family are permitted", () => {
  const cfg: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, dayCount: 3, nightCount: 0, wildcardCount: 0, variety: "random", battleModes: ["warfare", "offensive"] };
  const poll = buildPoll({ catalogue: VARIETY_CATALOGUE, config: cfg, rng: rngFrom(3) });
  assert.equal(poll.options.length, 3, "fills the bucket without family de-dup");
});

test("variety falls back to the legacy duplicateMaps flag when unset", () => {
  const legacyDup: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, variety: undefined, duplicateMaps: true, dayCount: 3, nightCount: 0, wildcardCount: 0, battleModes: ["warfare", "offensive"] };
  assert.equal(buildPoll({ catalogue: VARIETY_CATALOGUE, config: legacyDup, rng: rngFrom(3) }).options.length, 3);
  const legacyNoDup: MapPoolConfig = { ...legacyDup, duplicateMaps: false };
  const ids = buildPoll({ catalogue: VARIETY_CATALOGUE, config: legacyNoDup, rng: rngFrom(3) }).options.map((o) => o.id);
  assert.equal(new Set(ids.map((i) => i.split("_")[0])).size, ids.length, "old behaviour preserved");
});

test("variantPreference prefer-day favours day variants over night ones", () => {
  const onlyCarentan = VARIETY_CATALOGUE.filter((m) => m.family === "carentan" && m.mode === "warfare");
  const cfg: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, dayCount: 1, nightCount: 0, wildcardCount: 0, variety: "per-map", variantPreference: "prefer-day", battleModes: ["warfare"] };
  // Both a day and a night Carentan qualify; prefer-day must pick the day one every time.
  for (const seed of [1, 2, 3, 4, 5]) {
    const poll = buildPoll({ catalogue: onlyCarentan, config: cfg, rng: rngFrom(seed) });
    assert.equal(poll.options[0]?.id, "carentan_warfare", `seed ${seed} picked the day variant`);
  }
});

/* ---------- per-bucket modes and maps ---------- */

const modeOf = (id: string) => CAT.find((m) => m.id === id)!.mode;
const envOf = (id: string) => CAT.find((m) => m.id === id)!.environment;

test("a bucket with no mode list of its own still inherits battleModes", () => {
  // The compatibility guarantee: a profile written before per-bucket modes existed must compose
  // exactly as it did. Both spellings are run and the results compared, rather than eyeballed.
  const before = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 3, nightCount: 2, wildcardCount: 0 }), rng: rngFrom(11) });
  const after = buildPoll({
    catalogue: CAT,
    // dayModes/nightModes present but empty is the same as absent — "no opinion", not "nothing".
    config: cfg({ dayCount: 3, nightCount: 2, wildcardCount: 0, dayModes: [], nightModes: [], dayMaps: [], nightMaps: [] }),
    rng: rngFrom(11),
  });
  assert.deepEqual(after.options, before.options, "empty per-bucket lists change nothing");
});

test("day and night can ask for different game modes", () => {
  // The shape battleModes could not express: warfare by day, offensive at night.
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({
      dayCount: 2, nightCount: 0, wildcardCount: 0,
      dayModes: ["warfare"], nightModes: ["offensive"],
    }),
    rng: rngFrom(3),
  });
  assert.ok(r.options.length > 0, "the day bucket filled");
  for (const o of r.options) {
    assert.equal(modeOf(o.id), "warfare", `${o.id} is a warfare map`);
    assert.equal(envOf(o.id), "day", `${o.id} is a day map`);
  }

  // Night-only, offensive-only: the base filter has to let offensive through even though
  // battleModes is still the default ["warfare"], which is the bug this guards.
  const nightOnly = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 0, nightCount: 5, wildcardCount: 0, nightModes: ["offensive"] }),
    rng: rngFrom(3),
  });
  for (const o of nightOnly.options) assert.equal(modeOf(o.id), "offensive", `${o.id} is offensive`);
});

test("a bucket can be restricted to a named set of maps", () => {
  const only = ["foy_warfare", "hill400_warfare"];
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 5, nightCount: 0, wildcardCount: 0, dayMaps: only }),
    rng: rngFrom(5),
  });
  assert.ok(r.options.length > 0, "it drew something");
  for (const o of r.options) assert.ok(only.includes(o.id), `${o.id} came from the bucket's own list`);
  // Asking for more than the list holds is a shortfall, not an escape into the wider catalogue.
  assert.equal(r.options.length, 2);
  assert.equal(r.shortfall.day, 3);
});

test("one bucket's map list does not constrain another's", () => {
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({
      dayCount: 1, nightCount: 2, wildcardCount: 0,
      dayMaps: ["hill400_warfare"], // day is pinned; night must stay free
    }),
    rng: rngFrom(9),
  });
  const day = r.options.filter((o) => envOf(o.id) === "day");
  const night = r.options.filter((o) => envOf(o.id) === "night");
  assert.deepEqual(day.map((o) => o.id), ["hill400_warfare"]);
  assert.equal(night.length, 2, "night still drew from the whole catalogue");
  for (const o of night) assert.ok(!["hill400_warfare"].includes(o.id));
});

test("skirmish is a first-class mode a bucket can draw", () => {
  // A real server reports three modes — warfare, offensive AND skirmish. Not one preset or default
  // named skirmish, so on that catalogue 38 of 142 maps could never be offered. Nothing in the
  // engine forbade it; nothing selected it either. This proves a bucket can.
  const cat = describeMaps([
    "carentan_skirmish_day", "foy_skirmish_night", "tobruk_skirmish_day",
    "carentan_warfare", "foy_warfare",
  ]);
  const r = buildPoll({
    catalogue: cat,
    config: cfg({ dayCount: 2, nightCount: 0, wildcardCount: 0, dayModes: ["skirmish"] }),
    rng: rngFrom(2),
  });
  assert.ok(r.options.length > 0, "a skirmish-only bucket fills");
  for (const o of r.options) {
    assert.equal(cat.find((m) => m.id === o.id)!.mode, "skirmish", `${o.id} is skirmish`);
  }
});

test("only `night` is night — dusk, morning, overcast and rain are day maps", () => {
  // HLL reports six environments. The engine buckets on a coarse day/night where only "night" is
  // night, so anything that re-derives this rule elsewhere (the editor did, briefly) will offer
  // maps a night bucket can never draw.
  const ids = [
    "mortain_warfare_dusk", "elsenbornridge_warfare_morning", "mortain_warfare_overcast",
    "carentan_warfare", "foy_warfare_night",
  ];
  const cat = describeMaps(ids);
  const night = buildPoll({ catalogue: cat, config: cfg({ dayCount: 0, nightCount: 5, wildcardCount: 0 }), rng: rngFrom(4) });
  assert.deepEqual(night.options.map((o) => o.id), ["foy_warfare_night"], "the night bucket takes only the night map");

  // variety "random" so the family rule does not quietly drop one of Mortain's two variants —
  // this test is about the day/night split, and a shortfall there would prove nothing either way.
  const day = buildPoll({ catalogue: cat, config: cfg({ dayCount: 5, nightCount: 0, wildcardCount: 0, variety: "random" }), rng: rngFrom(4) });
  const dayIds = day.options.map((o) => o.id).sort();
  assert.ok(dayIds.includes("mortain_warfare_dusk"), "dusk is a day map");
  assert.ok(dayIds.includes("elsenbornridge_warfare_morning"), "so is morning");
  assert.ok(!dayIds.includes("foy_warfare_night"), "and night is not");
});

/*
 * Mode-first sets: the categories are the game modes, and each names how many maps it wants from
 * each ACTUAL time of day. The day/night buckets could not express this at all — they matched on
 * the coarse group where everything that is not night counts as day, so "one dusk map" silently
 * became "one of any daytime map".
 */
const ENV_CAT: MapItem[] = [
  { id: "carentan_warfare", prettyName: "Carentan", mode: "warfare", environment: "day", family: "carentan" },
  { id: "foy_warfare", prettyName: "Foy", mode: "warfare", environment: "day", family: "foy" },
  { id: "kharkov_warfare", prettyName: "Kharkov", mode: "warfare", environment: "day", family: "kharkov" },
  { id: "foy_warfare_night", prettyName: "Foy (Night)", mode: "warfare", environment: "night", family: "foy2" },
  { id: "mortain_warfare_dusk", prettyName: "Mortain (Dusk)", mode: "warfare", environment: "dusk", family: "mortain" },
  { id: "hill400_warfare_morning", prettyName: "Hill 400 (Morning)", mode: "warfare", environment: "morning", family: "hill400" },
  { id: "carentan_offensive_ger", prettyName: "Carentan Off.", mode: "offensive", environment: "day", family: "carentanoff" },
  { id: "omaha_offensive_us", prettyName: "Omaha Off.", mode: "offensive", environment: "day", family: "omaha" },
  { id: "tobruk_skirmish_day", prettyName: "Tobruk Skirmish", mode: "skirmish", environment: "day", family: "tobruk" },
];
const seq = () => { let i = 0; return () => ((i = (i + 7) % 97) / 97); };

test("mode buckets: each mode draws its own counts, per exact time of day", () => {
  const r = buildPoll({
    catalogue: ENV_CAT,
    rng: seq(),
    config: {
      ...DEFAULT_POOL_CONFIG,
      // The legacy counts are deliberately non-zero: mode buckets must REPLACE them, not add to them.
      dayCount: 3, nightCount: 1, wildcardCount: 3,
      modeBuckets: [
        { mode: "warfare", count: 3, limits: { day: 2, dusk: 1 } },
        { mode: "offensive", count: 1 },
      ],
    },
  });
  assert.equal(r.options.length, 4, "2 warfare day + 1 warfare dusk + 1 offensive — the old counts are ignored");
  const picked = new Set(r.options.map((o) => o.id));
  assert.ok(picked.has("mortain_warfare_dusk"), "the dusk map is the only one that can fill a dusk count");
  assert.ok([...picked].some((id) => id.startsWith("carentan_offensive") || id.startsWith("omaha_offensive")), "offensive is represented");
  assert.ok(!picked.has("foy_warfare_night"), "nothing asked for night, so no night map appears");
});

test("mode buckets: an exact time of day is never satisfied by a different one", () => {
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, modeBuckets: [{ mode: "warfare", count: 2, limits: { morning: 2 } }] },
  });
  assert.deepEqual(r.options.map((o) => o.id), ["hill400_warfare_morning"], "only the morning map qualifies");
  assert.equal(r.shortfall.warfare, 1, "and the unfilled one is reported against that exact request");
});

test("mode buckets: a category's own map list restricts it, and empty means everything", () => {
  const restricted = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [{ mode: "warfare", count: 3, limits: { day: 3 }, maps: ["foy_warfare"] }] },
  });
  assert.deepEqual(restricted.options.map((o) => o.id), ["foy_warfare"]);
  assert.equal(restricted.shortfall.warfare, 2, "a curated list is a ceiling, not a hint");

  const open = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [{ mode: "warfare", count: 3, limits: { day: 3 }, maps: [] }] },
  });
  assert.equal(open.options.length, 3, "an empty list means the whole mode, not nothing");
});

test("mode buckets: skirmish is a first-class category, not something to remember to allow", () => {
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, modeBuckets: [{ mode: "skirmish", count: 1 }] },
  });
  assert.deepEqual(r.options.map((o) => o.id), ["tobruk_skirmish_day"]);
});

test("mode buckets: a switched-off category never lends its map list to the next one", () => {
  // The warfare bucket is off (count 0) but keeps its curated list. Offensive follows it and has
  // NO list of its own — it must draw from the whole mode, not inherit foy_warfare (which would
  // match nothing in offensive and empty the poll). This is the filtered-index misalignment.
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [
        { mode: "warfare", count: 0, limits: { day: 0 }, maps: ["foy_warfare"] },
        { mode: "offensive", count: 2 },
      ] },
  });
  assert.equal(r.options.length, 2, "offensive draws its two maps from the whole mode");
  assert.ok(r.options.every((o) => o.id.includes("offensive")), "and every pick is actually offensive");
  assert.equal(r.shortfall.offensive ?? 0, 0);
});

test("a set with no mode buckets composes exactly as it always did", () => {
  const legacy = { ...DEFAULT_POOL_CONFIG, dayCount: 2, nightCount: 1, wildcardCount: 0 };
  const before = buildPoll({ catalogue: ENV_CAT, config: legacy, rng: seq() });
  const withEmpty = buildPoll({ catalogue: ENV_CAT, config: { ...legacy, modeBuckets: [] }, rng: seq() });
  const withZeros = buildPoll({ catalogue: ENV_CAT, config: { ...legacy, modeBuckets: [{ mode: "warfare", count: 0, limits: { day: 0 } }] }, rng: seq() });
  assert.deepEqual(withEmpty.options, before.options, "an empty list is not a mode-first set");
  assert.deepEqual(withZeros.options, before.options, "and neither is one that asks for nothing");
  assert.equal(before.shortfall.day, 0);
});


/*
 * The ceiling model is what makes a set fit in a Discord poll. Spelling "some mix of day, night and
 * dusk, four maps total" as exact quotas needs a category per combination and blows past the ten
 * options a poll holds; as ceilings it is one category whose mix varies between votes.
 */
test("mode buckets: ceilings bound the mix without fixing it", () => {
  const cfg = {
    ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, variety: "random" as const,
    modeBuckets: [{ mode: "warfare", count: 3, limits: { day: 3, night: 1, dusk: 1 } }],
  };
  // Every draw honours the count and every ceiling, whatever the shuffle does.
  const shapes = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    let i = seed;
    const r = buildPoll({ catalogue: ENV_CAT, config: cfg, rng: () => ((i = (i * 9301 + 49297) % 233280) / 233280) });
    assert.equal(r.options.length, 3, "the mode's count is what lands in the poll");
    const envOf = (id: string) => ENV_CAT.find((m) => m.id === id)!.environment;
    const byEnv = new Map<string, number>();
    for (const o of r.options) byEnv.set(envOf(o.id), (byEnv.get(envOf(o.id)) ?? 0) + 1);
    assert.ok((byEnv.get("night") ?? 0) <= 1, "never more night than its ceiling");
    assert.ok((byEnv.get("dusk") ?? 0) <= 1, "never more dusk than its ceiling");
    assert.ok((byEnv.get("morning") ?? 0) === 0, "a time with no ceiling is not eligible at all");
    shapes.add([...byEnv.entries()].sort().map(([e, n]) => `${e}${n}`).join(","));
  }
  assert.ok(shapes.size > 1, `the mix should vary between votes, got only ${[...shapes]}`);
});

test("mode buckets: ceilings summing to the count force an exact split", () => {
  // The tight end of the same dial — 4 maps, at most 3 day and at most 1 night, is always 3 + 1.
  const cfg = {
    ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
    modeBuckets: [{ mode: "warfare", count: 4, limits: { day: 3, night: 1 } }],
  };
  for (let seed = 1; seed <= 15; seed++) {
    let i = seed;
    const r = buildPoll({ catalogue: ENV_CAT, config: cfg, rng: () => ((i = (i * 9301 + 49297) % 233280) / 233280) });
    const envOf = (id: string) => ENV_CAT.find((m) => m.id === id)!.environment;
    const nights = r.options.filter((o) => envOf(o.id) === "night").length;
    assert.equal(r.options.length, 4);
    assert.equal(nights, 1, "exactly one night map, every time");
  }
});

test("mode buckets: no ceilings means any time of day, bounded only by the count", () => {
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, modeBuckets: [{ mode: "warfare", count: 5 }] },
  });
  assert.equal(r.options.length, 5, "it may reach into every environment the mode has");
});

test("mode buckets: a count above what the ceilings allow is reported short, not overfilled", () => {
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [{ mode: "warfare", count: 4, limits: { night: 1 } }] },
  });
  assert.equal(r.options.length, 1, "one night map is all the ceilings permit");
  assert.equal(r.shortfall.warfare, 3);
});

test("mode buckets: an explicit count of 0 turns the mode off even with ceilings set", () => {
  // Before the fix, `count || sum` read the explicit 0 as "absent" and drew the ceilings' sum anyway.
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [
        { mode: "warfare", count: 0, limits: { day: 2, dusk: 1 } },
        { mode: "offensive", count: 2 },
      ] },
  });
  const modeOf = (id: string) => ENV_CAT.find((m) => m.id === id)!.mode;
  assert.ok(r.options.length > 0, "the other category still draws");
  assert.ok(r.options.every((o) => modeOf(o.id) === "offensive"), "a zeroed mode contributes nothing");
});

test("mode buckets: enforced picks are drawn and their shortfall reported", () => {
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      enforceCount: 2, enforcedMaps: ["omaha_offensive_us", "not_a_real_map"],
      modeBuckets: [{ mode: "warfare", count: 1, limits: { day: 1 } }] },
  });
  assert.ok(r.options.some((o) => o.id === "omaha_offensive_us"), "the enforced map is in the poll");
  assert.equal(r.shortfall.enforced, 1, "the enforced pick that could not be filled is reported, not silently 0");
});

test("mode buckets: a set saved before counts existed still reads its caps as the quota", () => {
  // The pre-ceiling shape wrote `counts` and no `count`; it must compose as it did that day.
  const r = buildPoll({
    catalogue: ENV_CAT, rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0,
      modeBuckets: [{ mode: "warfare", counts: { day: 2, night: 1 } }] },
  });
  assert.equal(r.options.length, 3, "the caps sum is the draw when no count is given");
});

/*
 * Two different wishes about repetition, and they were one setting. "Don't re-offer the last N"
 * matches the EXACT map, so a Foy Warfare round says nothing about Foy at night — the place comes
 * straight back with different lighting. Resting the family is the other wish, and needs its own
 * (usually shorter) window.
 */
const FOY_CAT: MapItem[] = [
  { id: "foy_warfare", prettyName: "Foy", mode: "warfare", environment: "day", family: "foy" },
  { id: "foy_warfare_night", prettyName: "Foy (Night)", mode: "warfare", environment: "night", family: "foy" },
  { id: "foy_offensive_ger", prettyName: "Foy Off.", mode: "offensive", environment: "day", family: "foy" },
  { id: "carentan_warfare", prettyName: "Carentan", mode: "warfare", environment: "day", family: "carentan" },
  { id: "kharkov_warfare", prettyName: "Kharkov", mode: "warfare", environment: "day", family: "kharkov" },
  { id: "hill400_warfare", prettyName: "Hill 400", mode: "warfare", environment: "day", family: "hill400" },
];

test("excluding recently played maps matches the exact variant, leaving its siblings offerable", () => {
  const r = buildPoll({
    catalogue: FOY_CAT, recentIds: ["foy_warfare"], rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, variety: "random",
      excludePlayedMaps: 4, battleModes: ["warfare", "offensive"],
      modeBuckets: [{ mode: "warfare", count: 4 }, { mode: "offensive", count: 1 }] },
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(!ids.includes("foy_warfare"), "the map that just played is held back");
  assert.ok(ids.includes("foy_warfare_night"), "but its night variant is still fair game");
  assert.ok(ids.includes("foy_offensive_ger"), "and so is its offensive one");
});

test("resting families keeps every variant of a recently played map out", () => {
  const r = buildPoll({
    catalogue: FOY_CAT, recentIds: ["foy_warfare"], rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, variety: "random",
      excludePlayedMaps: 4, excludePlayedFamilies: 1, battleModes: ["warfare", "offensive"],
      modeBuckets: [{ mode: "warfare", count: 4 }, { mode: "offensive", count: 1 }] },
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(!ids.some((id) => id.startsWith("foy")), `no Foy of any kind, got ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("carentan_warfare") && ids.includes("kharkov_warfare"), "other places are untouched");
});

test("the two windows are independent: families can rest for fewer rounds than exact maps", () => {
  // Three rounds played; rest the exact map for all three but only the newest family.
  const r = buildPoll({
    catalogue: FOY_CAT, recentIds: ["foy_warfare", "carentan_warfare", "kharkov_warfare"], rng: seq(),
    config: { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, variety: "random",
      excludePlayedMaps: 3, excludePlayedFamilies: 1, battleModes: ["warfare", "offensive"],
      modeBuckets: [{ mode: "warfare", count: 4 }, { mode: "offensive", count: 2 }] },
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(!ids.some((id) => id.startsWith("foy")), "the newest family rests entirely");
  assert.ok(!ids.includes("carentan_warfare"), "and the exact maps behind it are still held back");
  assert.ok(!ids.includes("kharkov_warfare"));
  assert.deepEqual(ids.sort(), ["hill400_warfare"], "only the untouched place is left");
});

test("resting families is off unless asked for, so existing sets are unaffected", () => {
  const cfg = { ...DEFAULT_POOL_CONFIG, dayCount: 0, nightCount: 0, wildcardCount: 0, variety: "random" as const,
    excludePlayedMaps: 1, battleModes: ["warfare", "offensive"], modeBuckets: [{ mode: "warfare", count: 4 }] };
  const off = buildPoll({ catalogue: FOY_CAT, recentIds: ["foy_warfare"], config: cfg, rng: seq() });
  const zero = buildPoll({ catalogue: FOY_CAT, recentIds: ["foy_warfare"], config: { ...cfg, excludePlayedFamilies: 0 }, rng: seq() });
  assert.deepEqual(zero.options, off.options);
  assert.ok(off.options.some((o) => o.id === "foy_warfare_night"), "the sibling is offered when nothing rests the family");
});

/*
 * A poll of nothing has to say why.
 *
 * "day=3 night=1 wildcard=3 … → 0 options" tells staff what was asked for and that the answer was
 * zero, and leaves them to guess between an over-eager exclusion list, a catalogue the server never
 * returned, and categories that ask for a mode the server does not run. Those are three different
 * fixes, and this is the only place that knows which one happened.
 */
test("an empty poll names the filter that emptied it", () => {
  // Excluded by hand — the commonest cause, and the one staff can fix in a click.
  const blocked = buildPoll({ catalogue: CAT, config: cfg({ blacklistMaps: IDS }), rng: rngFrom(1) });
  assert.equal(blocked.options.length, 0);
  assert.match(blocked.diagnosis!, /never offer these/);
  assert.match(blocked.diagnosis!, new RegExp(`${IDS.length} maps`));

  // Narrowed to a map the catalogue does not have — a different mistake, a different sentence.
  const narrowed = buildPoll({ catalogue: CAT, config: cfg({ allowedMaps: ["nowhere_warfare"] }), rng: rngFrom(1) });
  assert.equal(narrowed.options.length, 0);
  assert.match(narrowed.diagnosis!, /limited to/);

  // Nothing came back from the server at all: a connection fault, and it must not be reported as a
  // settings problem — that sends staff to edit a map set that was never the cause.
  const empty = buildPoll({ catalogue: [], config: cfg(), rng: rngFrom(1) });
  assert.equal(empty.options.length, 0);
  assert.match(empty.diagnosis!, /no maps at all/);
  assert.doesNotMatch(empty.diagnosis!, /never offer|limited to/);

  // Maps survived every exclusion but no category wanted them — a counts problem, not an exclusion
  // one, and the advice has to change accordingly.
  const noAsk = buildPoll({ catalogue: CAT, config: cfg({ dayCount: 0, nightCount: 0, wildcardCount: 0 }), rng: rngFrom(1) });
  assert.equal(noAsk.options.length, 0);
  assert.match(noAsk.diagnosis!, /no category asked/);

  // A poll that works says nothing — the diagnosis exists only for the failure.
  assert.equal(buildPoll({ catalogue: CAT, config: cfg({ dayCount: 2 }), rng: rngFrom(1) }).diagnosis, undefined);
});

/*
 * A poll that asks for more options than the surface takes must lose the extra OPTIONS, not the
 * whole vote. `maxOptions` was read as a slice length with no ceiling, and both the pool endpoint
 * and map sets accept the key, so a stored 20 sent Discord an eleventh answer — which it refuses
 * outright, message and all. The result is no vote at all, every round, with nothing in the channel
 * to say why.
 */
test("no configuration can ask for a poll bigger than the surface takes", () => {
  // A catalogue big enough that the engine is limited by the cap rather than by the maps.
  const big = describeMaps([
    ...IDS, "remagen_warfare", "kharkov_warfare", "driel_warfare", "elalamein_warfare",
    "mortain_warfare", "utahbeach_warfare", "elsenbornridge_warfare", "tobruk_warfare",
  ]);
  for (const over of [POLL_OPTION_LIMIT + 1, 20, 999]) {
    // Both composition paths: the legacy day/night/wildcard buckets…
    const legacy = buildPoll({
      catalogue: big,
      config: cfg({ dayCount: 20, nightCount: 0, wildcardCount: 0, duplicateMaps: true, maxOptions: over }),
      rng: rngFrom(11),
    });
    assert.ok(legacy.options.length <= POLL_OPTION_LIMIT, `legacy path offered ${legacy.options.length} for maxOptions=${over}`);
    // …and the mode-first categories.
    const modeFirst = buildPoll({
      catalogue: big,
      config: cfg({ duplicateMaps: true, maxOptions: over, modeBuckets: [{ mode: "warfare", count: 20 }] }),
      rng: rngFrom(11),
    });
    assert.ok(modeFirst.options.length <= POLL_OPTION_LIMIT, `mode-first path offered ${modeFirst.options.length} for maxOptions=${over}`);
  }
  // A set asking for FEWER still gets fewer — the ceiling must not become a floor.
  assert.equal(buildPoll({ catalogue: big, config: cfg({ dayCount: 20, duplicateMaps: true, maxOptions: 4 }), rng: rngFrom(11) }).options.length, 4);
});

/*
 * Always offer: maps a set puts on every ballot it composes, added AFTER the draw. None of the
 * draw's rules reach them — recently played, family rests, the last vote, the set's own lists and
 * modes — because the reason to always offer a map is that it comes back however recently it ran.
 */
test("always offer: the map is on the ballot however recently it played, rested or was offered", () => {
  const r = buildPoll({
    catalogue: CAT,
    recentIds: ["carentan_warfare", "foy_warfare"],
    previousPollIds: ["carentan_warfare"],
    config: cfg({
      dayCount: 3, nightCount: 0, wildcardCount: 0,
      excludePlayedMaps: 2, excludePlayedFamilies: 2, previousPollExclusionMode: "hard",
      alwaysOffer: ["carentan_warfare"],
    }),
    rng: rngFrom(11),
  });
  const ids = r.options.map((o) => o.id);
  assert.ok(ids.includes("carentan_warfare"), `always offered: ${ids.join(", ")}`);
  assert.deepEqual(r.alwaysOffered, ["carentan_warfare"]);
  assert.equal(r.alwaysSkipped, undefined);
  // The draw's own rules still hold for everything it drew: Foy is resting.
  assert.ok(!ids.includes("foy_warfare") && !ids.includes("foy_warfare_night"), `Foy rests: ${ids.join(", ")}`);
});

test("always offer: sits out only while it is the map being played, or when the server lacks it", () => {
  const r = buildPoll({
    catalogue: CAT, currentMapId: "CARENTAN_WARFARE",
    config: cfg({ dayCount: 2, nightCount: 0, wildcardCount: 0, alwaysOffer: ["carentan_warfare", "nowhere_warfare"] }),
    rng: rngFrom(12),
  });
  assert.ok(!r.options.some((o) => o.id === "carentan_warfare"), "never the map being played");
  assert.deepEqual(r.alwaysSkipped, [{ id: "carentan_warfare", why: "in-play" }, { id: "nowhere_warfare", why: "not-on-server" }]);
  assert.deepEqual(r.alwaysOffered, []);
  assert.equal(r.options.length, 2, "the draw is untouched");
});

test("always offer: takes the slot of its own map's drawn option under the set's variety rule", () => {
  // The night category can only draw Carentan at night.
  const night = { dayCount: 0, nightCount: 1, nightMaps: ["carentan_warfare_night"], wildcardCount: 0, alwaysOffer: ["carentan_warfare"] };
  const perMap = buildPoll({ catalogue: CAT, config: cfg({ ...night, variety: "per-map" }), rng: rngFrom(13) });
  assert.deepEqual(perMap.options.map((o) => o.id), ["carentan_warfare"], "one Carentan — the always-offered one");
  const anything = buildPoll({ catalogue: CAT, config: cfg({ ...night, variety: "random" }), rng: rngFrom(13) });
  assert.deepEqual(anything.options.map((o) => o.id).sort(), ["carentan_warfare", "carentan_warfare_night"], "with repeats allowed, both stand");
});

test("always offer: a full ballot makes room — drawn options give way, never an always-offered one", () => {
  // Offensive maps are a mode this set never draws; always offer does not care.
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 5, nightCount: 0, wildcardCount: 0, variety: "random", maxOptions: 3, alwaysOffer: ["omahabeach_offensiveus", "purpleheartlane_offensiveger"] }),
    rng: rngFrom(14),
  });
  const ids = r.options.map((o) => o.id);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes("omahabeach_offensiveus") && ids.includes("purpleheartlane_offensiveger"), `both survive the cut: ${ids.join(", ")}`);
  assert.equal(ids.filter((id) => /_warfare/.test(id)).length, 1, "the drawn maps gave way");
});

test("always offer: the set's own allowed and never-offer lists do not reach it", () => {
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 2, nightCount: 0, wildcardCount: 0, allowedMaps: ["foy_warfare", "hill400_warfare"], blacklistMaps: ["kursk_warfare"], alwaysOffer: ["kursk_warfare"] }),
    rng: rngFrom(15),
  });
  assert.deepEqual(r.options.map((o) => o.id).sort(), ["foy_warfare", "hill400_warfare", "kursk_warfare"]);
});

test("always offer: more than the poll holds are reported, not squeezed in", () => {
  const r = buildPoll({
    catalogue: CAT,
    config: cfg({ dayCount: 0, nightCount: 0, wildcardCount: 0, maxOptions: 2, alwaysOffer: ["carentan_warfare", "foy_warfare", "hill400_warfare"] }),
    rng: rngFrom(16),
  });
  assert.deepEqual(r.options.map((o) => o.id).sort(), ["carentan_warfare", "foy_warfare"]);
  assert.deepEqual(r.alwaysSkipped, [{ id: "hill400_warfare", why: "no-room" }]);
  // The categories drew nothing, and the result still says so.
  assert.ok(r.diagnosis, "an empty draw is still diagnosed");
});

test("always offer: a set without any composes exactly as it always did", () => {
  const base = cfg({ dayCount: 3, nightCount: 1, wildcardCount: 2 });
  const before = buildPoll({ catalogue: CAT, config: base, rng: rngFrom(17) });
  const empty = buildPoll({ catalogue: CAT, config: { ...base, alwaysOffer: [] }, rng: rngFrom(17) });
  assert.deepEqual(empty, before);
  assert.equal("alwaysOffered" in before, false);
});

