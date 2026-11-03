import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "@app/shared";
import { createSupervisor, runnerControl, connectionFingerprint, type RunnerControl } from "../src/supervisor.ts";

const log = createLogger("test");
const tick = () => new Promise<void>((r) => setImmediate(r));

interface Srv {
  id: string;
  host: string;
  port: number;
  password: string;
  protocol: string;
  game: string;
  engagementMode: string;
  name: string;
}
const srv = (id: string, over: Partial<Srv> = {}): Srv => ({
  id,
  host: "10.0.0.1",
  port: 9001,
  password: "pw",
  protocol: "v2",
  game: "hll",
  engagementMode: "active",
  name: id,
  ...over,
});

/** A runner shaped like the real ones: loop until cancelled, sleeping between passes. */
function loopRunner() {
  const passes = new Map<string, number>();
  const live = new Set<string>();
  return {
    passes,
    live,
    what: "loop",
    run: async (s: Srv, ctl: RunnerControl) => {
      live.add(s.id);
      try {
        while (!ctl.stopped) {
          passes.set(s.id, (passes.get(s.id) ?? 0) + 1);
          await ctl.sleep(5);
        }
      } finally {
        live.delete(s.id);
      }
    },
  };
}

test("runnerControl: sleep returns immediately once cancelled, rather than waiting out the delay", async () => {
  const ctl = runnerControl();
  const started = Date.now();
  const slept = ctl.sleep(30_000);
  ctl.cancel();
  await slept;
  assert.ok(Date.now() - started < 1_000, "cancel must wake a sleep in progress");
  assert.equal(ctl.stopped, true);
  // Sleeping after cancellation is a no-op, so a loop that checks `stopped` only at the top still exits.
  await ctl.sleep(30_000);
});

test("sync starts a runner per server, once", async () => {
  const r = loopRunner();
  const sup = createSupervisor<Srv>({ log, runners: [r], fingerprint: connectionFingerprint });

  assert.deepEqual(sup.sync([srv("a"), srv("b")]), { started: ["a", "b"], stopped: [], restarted: [] });
  await tick();
  assert.deepEqual([...r.live].sort(), ["a", "b"]);
  assert.equal(sup.size, 2);

  assert.deepEqual(sup.sync([srv("a"), srv("b")]), { started: [], stopped: [], restarted: [] });
  sup.stopAll();
});

test("a deleted server's runner is cancelled, not left reconnecting forever", async () => {
  const r = loopRunner();
  const sup = createSupervisor<Srv>({ log, runners: [r], fingerprint: connectionFingerprint });
  sup.sync([srv("a"), srv("b")]);
  await tick();

  assert.deepEqual(sup.sync([srv("a")]), { started: [], stopped: ["b"], restarted: [] });
  await tick();
  assert.deepEqual([...r.live], ["a"], "b's loop must have exited");
  assert.equal(sup.size, 1);
  sup.stopAll();
});

test("changing connection details restarts that server's runners; cosmetic-free changes do not", async () => {
  const r = loopRunner();
  const sup = createSupervisor<Srv>({ log, runners: [r], fingerprint: connectionFingerprint });
  sup.sync([srv("a")]);
  await tick();
  const before = r.passes.get("a") ?? 0;

  // The case that used to silently do nothing: a wrong password corrected in the panel.
  assert.deepEqual(sup.sync([srv("a", { password: "corrected" })]), { started: [], stopped: [], restarted: ["a"] });
  await tick();
  assert.ok((r.passes.get("a") ?? 0) > before, "the restarted loop must have run again");
  assert.deepEqual([...r.live], ["a"], "exactly one loop is live after a restart");

  // Same row again — no churn.
  assert.deepEqual(sup.sync([srv("a", { password: "corrected" })]), { started: [], stopped: [], restarted: [] });
  sup.stopAll();
});

test("engagementMode is part of the fingerprint, so observe → active takes effect without a worker restart", () => {
  assert.notEqual(
    connectionFingerprint(srv("a", { engagementMode: "observe" })),
    connectionFingerprint(srv("a", { engagementMode: "active" })),
  );
});

test("all of a server's runners share one control, so stopping the server stops all of them", async () => {
  const a = loopRunner();
  const b = loopRunner();
  const sup = createSupervisor<Srv>({ log, runners: [a, b], fingerprint: connectionFingerprint });
  sup.sync([srv("x")]);
  await tick();
  assert.deepEqual([[...a.live], [...b.live]], [["x"], ["x"]]);

  sup.sync([]);
  await tick();
  assert.deepEqual([[...a.live], [...b.live]], [[], []]);
});

test("a runner that ends on its own is restarted by the next sync instead of staying dead", async () => {
  let attempts = 0;
  const sup = createSupervisor<Srv>({
    log,
    fingerprint: connectionFingerprint,
    runners: [
      {
        what: "flaky",
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("fell out of the loop");
          await new Promise(() => {}); // second attempt stays up
        },
      },
    ],
  });

  sup.sync([srv("a")]);
  await tick();
  await tick();
  assert.equal(sup.size, 0, "the dead runner's entry is dropped so it can be restarted");

  assert.deepEqual(sup.sync([srv("a")]), { started: ["a"], stopped: [], restarted: [] });
  await tick();
  assert.equal(attempts, 2);
  assert.equal(sup.size, 1, "the healthy retry stays supervised");
  sup.stopAll();
});

test("stopAll cancels every server (process shutdown)", async () => {
  const r = loopRunner();
  const sup = createSupervisor<Srv>({ log, runners: [r], fingerprint: connectionFingerprint });
  sup.sync([srv("a"), srv("b"), srv("c")]);
  await tick();
  assert.equal(r.live.size, 3);

  sup.stopAll();
  await tick();
  assert.equal(r.live.size, 0);
  assert.equal(sup.size, 0);
});

test("a switch only the app-wide sweeps read never restarts a server's runners; a runner's own switch does", () => {
  const base = { host: "10.0.0.1", port: 9001, password: "pw", protocol: "v2", game: "hll", engagementMode: "active", name: "a" };
  const fp = (automation: Record<string, boolean>) => connectionFingerprint({ ...base, automation });
  // The reconcilers, their fixes and the expiry sweeps read each server's switches on every tick.
  // Restarting the map vote and seeding loops (and their connection) for one of those was pure
  // churn — and arming a reconciler's fix is exactly the switch staff flip while the server is busy.
  for (const sweepOnly of ["banSyncApply", "vipSyncApply", "banSync", "vipSync", "vipSweep", "consoleAdminSweep"]) {
    assert.equal(fp({ [sweepOnly]: sweepOnly.endsWith("Apply") }), fp({}), `${sweepOnly} is not a runner's switch`);
  }
  // The runners read theirs once at start and hold a connection for hours: off must restart them.
  for (const runner of ["mapvote", "broadcast", "seeding", "autosettings"]) {
    assert.notEqual(fp({ [runner]: false }), fp({}), `${runner} must restart its loops`);
  }
  assert.notEqual(fp({ mapvote: false, banSyncApply: true }), fp({ banSyncApply: true }), "a runner switch still counts beside a sweep-only one");
});
