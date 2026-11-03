/**
 * The guard around every process's periodic jobs and event handlers.
 *
 * With crash handlers installed an unhandled rejection is an exit, and `void someAsyncFn()` is
 * exactly how one gets made. The worker's server rescan was one — a transient failure reading the
 * servers table took every RCON connection, the log ingest, the auto-mod and the map vote down with
 * it. These pin the two properties that make that impossible to reintroduce: nothing a background
 * job does escapes, and a failed cycle does not stop the next one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { background, repeatEvery } from "../src/background.ts";

interface Logged { msg: string; meta?: Record<string, unknown> }
function recorder() {
  const warns: Logged[] = [];
  const log = {
    warn: (msg: string, meta?: Record<string, unknown>) => { warns.push({ msg, meta }); },
    info: () => {}, error: () => {}, debug: () => {},
    child: () => log,
  };
  return { log: log as never, warns };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("a rejecting background job is logged, not thrown", async () => {
  const { log, warns } = recorder();
  background(log, "rescan", async () => { throw new Error("database went away"); });
  await tick();
  assert.equal(warns.length, 1);
  assert.equal(warns[0]!.msg, "rescan failed");
  assert.equal(warns[0]!.meta?.err, "database went away", "the reason reaches the log, not just the fact");
});

test("a job that throws before its first await is caught too", async () => {
  // `fn()` is called inside the promise chain rather than before it, so a synchronous throw is a
  // rejection like any other. Called bare, this one would escape as a thrown error.
  const { log, warns } = recorder();
  background(log, "sync job", (() => { throw new Error("boom"); }) as () => Promise<unknown>);
  await tick();
  assert.equal(warns.length, 1);
  assert.equal(warns[0]!.meta?.err, "boom");
});

test("a non-Error rejection still says something", async () => {
  const { log, warns } = recorder();
  background(log, "odd job", async () => { throw "just a string"; });
  await tick();
  assert.equal(warns[0]!.meta?.err, "just a string");
});

test("a successful job logs nothing", async () => {
  const { log, warns } = recorder();
  background(log, "quiet", async () => 42);
  await tick();
  assert.deepEqual(warns, []);
});

test("repeatEvery runs immediately and keeps running after a failed cycle", async () => {
  const { log, warns } = recorder();
  let calls = 0;
  const handle = repeatEvery(log, "sweep", 10, async () => {
    calls += 1;
    if (calls <= 2) throw new Error(`cycle ${calls} failed`);
  });
  try {
    await tick();
    assert.equal(calls, 1, "the first cycle runs without waiting out the interval");
    // Two failures in a row must not stop the third — a job that gives up after one bad cycle is
    // the same outage as no job at all, just quieter.
    await new Promise((r) => setTimeout(r, 45));
    assert.ok(calls >= 3, `expected the timer to keep firing, got ${calls} cycles`);
    assert.equal(warns.length, 2, "each failed cycle is logged once");
  } finally {
    clearInterval(handle);
  }
});
