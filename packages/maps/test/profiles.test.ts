import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActivePool, DEFAULT_POOL_CONFIG, type MapVoteProfile } from "../dist/index.js";

const utc = (y: number, mo: number, d: number, h = 0) => new Date(Date.UTC(y, mo - 1, d, h));

const PROFILES: MapVoteProfile[] = [
  { name: "dday", spec: { dates: ["06-06"] }, pool: { dayCount: 5, nightCount: 0, wildcardCount: 0 } },
  { name: "seeding", spec: { playersBelow: 50 }, pool: { dayCount: 2, nightCount: 0, wildcardCount: 0, duplicateMaps: true } },
  { name: "night", spec: { start: "00:00", end: "07:00" }, pool: { dayCount: 0, nightCount: 3, wildcardCount: 0 } },
  { name: "default", pool: { dayCount: 3, nightCount: 1, wildcardCount: 3 } },
];

test("resolveActivePool picks the first matching profile and merges its pool over defaults", () => {
  // D-Day midday, busy → dday
  const r = resolveActivePool(PROFILES, utc(2026, 6, 6, 12), { playerCount: 80 }, "UTC");
  assert.equal(r.profileName, "dday");
  assert.equal(r.config.dayCount, 5);
  assert.equal(r.config.maxOptions, DEFAULT_POOL_CONFIG.maxOptions); // unspecified fields keep defaults
});

test("player-count profile wins when pop is low", () => {
  const r = resolveActivePool(PROFILES, utc(2026, 3, 10, 12), { playerCount: 20 }, "UTC");
  assert.equal(r.profileName, "seeding");
  assert.equal(r.config.duplicateMaps, true);
});

test("time-window profile at 03:00; default otherwise", () => {
  assert.equal(resolveActivePool(PROFILES, utc(2026, 3, 10, 3), { playerCount: 80 }, "UTC").profileName, "night");
  assert.equal(resolveActivePool(PROFILES, utc(2026, 3, 10, 12), { playerCount: 80 }, "UTC").profileName, "default");
});

test("fallback timezone is applied to specs that omit one", () => {
  // 05:00 UTC = 00:00 New York → the 00:00-07:00 night window should match under NY fallback
  const r = resolveActivePool(
    [{ name: "night", spec: { start: "00:00", end: "07:00" }, pool: {} }, { name: "default", pool: {} }],
    utc(2026, 3, 10, 5), { playerCount: 80 }, "America/New_York",
  );
  assert.equal(r.profileName, "night");
});

test("no match and no default → default pool with null name", () => {
  const r = resolveActivePool([{ name: "friday", spec: { daysOfWeek: ["fri"] }, pool: { dayCount: 9 } }], utc(2026, 6, 8, 12), {}, "UTC"); // Jun 8 2026 is a Monday
  assert.equal(r.profileName, null);
  assert.deepEqual(r.config, DEFAULT_POOL_CONFIG);
});

test("resolvePinnedPool takes a profile BY NAME, schedule ignored; a vanished name falls through", async () => {
  const { resolvePinnedPool } = await import("../dist/index.js");
  // "night" is scheduled for 00:00–07:00, but an event pinning it gets it at any hour — that is
  // the point of the pin: event maps while the event runs, whatever the clock says.
  const pinned = resolvePinnedPool(PROFILES, "night");
  assert.equal(pinned?.profileName, "night");
  assert.equal(pinned?.config.nightCount, 3);
  assert.equal(pinned?.config.maxOptions, DEFAULT_POOL_CONFIG.maxOptions, "unspecified fields keep defaults");
  // A profile renamed/deleted since the event was created: null, so the caller falls back to the
  // schedule instead of refusing to open votes for the rest of the event.
  assert.equal(resolvePinnedPool(PROFILES, "no such profile"), null);
});
