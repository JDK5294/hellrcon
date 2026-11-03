/**
 * The set→rotation apply, pure half: which sets resolve to a concrete lineup, and the exact
 * command plan that rebuilds a live rotation without ever leaving it empty (HLL refills an
 * emptied rotation with the whole catalogue — the one failure the plan exists to rule out).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explicitRotationOf, planRotationApply } from "../dist/index.js";

test("explicitRotationOf: sequence wins verbatim; recipes resolve only when fully explicit", () => {
  assert.deepEqual(
    explicitRotationOf({ sequence: [" foy_warfare ", "carentan_warfare", "foy_warfare"] }),
    ["foy_warfare", "carentan_warfare"],
    "trimmed, order kept, a duplicate collapses to its first appearance",
  );
  // sequence beats the recipe fields — it IS the lineup.
  assert.deepEqual(
    explicitRotationOf({ sequence: ["sme_warfare"], dayCount: 3 }),
    ["sme_warfare"],
  );
  // A counted mode bucket with explicit maps is a lineup; one without is a recipe (dice), so null.
  assert.deepEqual(
    explicitRotationOf({ modeBuckets: [
      { mode: "warfare", count: 2, limits: {}, maps: ["foy_warfare", "sme_warfare"] },
      { mode: "offensive", count: 1, limits: {}, maps: ["carentan_offensive_us"] },
    ] } as never),
    ["foy_warfare", "sme_warfare", "carentan_offensive_us"],
  );
  assert.equal(
    explicitRotationOf({ modeBuckets: [{ mode: "warfare", count: 3, limits: {}, maps: [] }] } as never),
    null,
    "a counted bucket with no explicit maps rolls dice — not applicable to a rotation",
  );
  // Legacy buckets: defaults count day/night/wildcard, so a bare recipe is null…
  assert.equal(explicitRotationOf({}), null);
  assert.equal(explicitRotationOf(null), null);
  // …and explicit legacy lists resolve, enforced maps first.
  assert.deepEqual(
    explicitRotationOf({ dayCount: 2, nightCount: 0, wildcardCount: 1, dayMaps: ["foy_warfare"], wildcardMaps: ["carentan_offensive_us"], enforceCount: 1, enforcedMaps: ["stalin_warfare"] }),
    ["stalin_warfare", "foy_warfare", "carentan_offensive_us"],
  );
});

test("planRotationApply: adds first (never empty), then the originals off the front — result is the target, in order", () => {
  const plan = planRotationApply(["a", "b", "c"], ["b", "d"]);
  assert.deepEqual(plan, [
    { op: "add", mapId: "b", index: 3 },
    { op: "add", mapId: "d", index: 4 },
    { op: "remove", mapId: "a", index: 0 },
    { op: "remove", mapId: "b", index: 0 },
    { op: "remove", mapId: "c", index: 0 },
  ]);
  // Replay the plan against a simulated rotation and the game's index semantics.
  const rot = ["a", "b", "c"];
  for (const s of plan) {
    if (s.op === "add") rot.splice(s.index, 0, s.mapId);
    else rot.splice(s.index, 1);
  }
  assert.deepEqual(rot, ["b", "d"], "the rotation ends exactly as the set says, order included");
  // The rotation is never empty at any point of the plan: every add precedes every remove.
  assert.ok(plan.findIndex((s) => s.op === "remove") > plan.map((s) => s.op).lastIndexOf("add"),
    "adds strictly precede removes — an emptied rotation is the failure this plan exists to rule out");

  assert.deepEqual(planRotationApply(["a", "b"], ["a", "b"]), [], "already equal — a re-apply touches nothing");
  assert.deepEqual(
    planRotationApply(["a", "b"], ["b", "a"]).length, 4,
    "same maps, different order is still a rebuild — order is the point of a saved rotation",
  );
  assert.throws(() => planRotationApply(["a"], []), /empty rotation/);
});

test("explicitRotationOf: always-offered maps ride in a lineup, but alone do not make one", () => {
  assert.deepEqual(
    explicitRotationOf({ modeBuckets: [{ mode: "warfare", count: 1, maps: ["foy_warfare"] }], alwaysOffer: ["carentan_warfare"] }),
    ["carentan_warfare", "foy_warfare"],
  );
  assert.equal(explicitRotationOf({ alwaysOffer: ["carentan_warfare"] }), null, "a recipe with always-offered maps is still a recipe");
  assert.deepEqual(explicitRotationOf({ sequence: ["foy_warfare"], alwaysOffer: ["carentan_warfare"] }), ["foy_warfare"], "a saved sequence stays verbatim");
});

