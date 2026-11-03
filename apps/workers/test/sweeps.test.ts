/**
 * No global sweep runs while a restore is replacing the database.
 *
 * The supervisor already stands the per-server runners down when the restore marker is fresh. The
 * sweeps on their own timers were not covered by that, and they are the ones that DELETE: against
 * a half-loaded table a restored VIP grant reads as an orphan, a restored request reads as
 * expired, and — with applying armed — a restored ban reads as one to lift off the live game
 * server. The restore then reports "whole" and is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { singleFlight, whilePaused } from "../src/sweeps.ts";

function recorder() {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => lines.push(`info:${m}`), warn: (m: string) => lines.push(`warn:${m}`) } };
}

test("a paused sweep does nothing at all", async () => {
  let runs = 0;
  const { lines, log } = recorder();
  const sweep = whilePaused("ban reconcile", async () => { runs++; }, { paused: () => true, log });
  await sweep();
  await sweep();
  assert.equal(runs, 0, "the body never runs while the marker is fresh");
  assert.deepEqual(lines, ["warn:ban reconcile stood down — a restore is in progress"], "said once, not once per tick");
});

test("it runs normally when nothing is paused, and says so when it comes back", async () => {
  let runs = 0;
  let paused = false;
  const { lines, log } = recorder();
  const sweep = whilePaused("VIP sweep", async () => { runs++; }, { paused: () => paused, log });

  await sweep();
  assert.equal(runs, 1);
  assert.deepEqual(lines, [], "nothing to say while it is simply working");

  paused = true;
  await sweep();
  await sweep();
  assert.equal(runs, 1, "stood down mid-flight");

  paused = false;
  await sweep();
  assert.equal(runs, 2, "and back on the next tick after the marker clears");
  assert.deepEqual(lines, [
    "warn:VIP sweep stood down — a restore is in progress",
    "info:VIP sweep running again",
  ]);
});

test("the wrapper hands back what the sweep returned, and lets its failures through", async () => {
  const { log } = recorder();
  assert.equal(await whilePaused("x", async () => "done", { paused: () => false, log })(), "done");
  await assert.rejects(
    whilePaused("x", async () => { throw new Error("the database blinked"); }, { paused: () => false, log })(),
    /the database blinked/,
    "a real failure still reaches repeatEvery's own error handling",
  );
});

/**
 * ...and the wiring cannot quietly grow an exception.
 *
 * The gate is applied where the timers are registered rather than inside each sweep, so that a
 * sweep added later is covered by the shape of the code instead of by somebody remembering. That
 * only holds while `sweepEvery` is the single way a global timer is registered.
 */
test("every global sweep timer goes through the restore gate", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  // The one legitimate `repeatEvery` is the gate's own definition; every other timer is a sweep.
  const raw = [...src.matchAll(/repeatEvery\(log, ([^;]*?)\)/gs)].map((m) => m[1]!.slice(0, 60).replace(/\s+/g, " "));
  const ungated = raw.filter((call) => !call.startsWith("what, ms, whilePaused("));
  assert.deepEqual(ungated, [], "register these with sweepEvery — a sweep that runs during a restore deletes restored rows");
  assert.ok(src.includes("const sweepEvery ="), "the gate itself is still there");
  // And it is actually used, so the check above cannot pass by there being no sweeps at all.
  assert.ok((src.match(/sweepEvery\(/g) ?? []).length >= 8, "the sweeps are registered through it");
});

test("a single-flight sweep skips the tick that arrives while the last run is still going", async () => {
  let runs = 0;
  let finish!: () => void;
  const sweep = singleFlight(async () => {
    runs++;
    await new Promise<void>((resolve) => { finish = resolve; });
    return "done";
  });
  const first = sweep();
  assert.equal(await sweep(), undefined, "the overlapping tick returns at once");
  assert.equal(runs, 1);
  finish();
  assert.equal(await first, "done");
  // The guard lifts when the run ends — failures included.
  const failing = singleFlight(async () => { runs++; throw new Error("the game timed out"); });
  await assert.rejects(failing(), /timed out/);
  await assert.rejects(failing(), /timed out/, "a failed run does not leave the sweep stuck");
  assert.equal(runs, 3);
});
