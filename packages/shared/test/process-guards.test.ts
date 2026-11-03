import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * These have to run in a child process: the behaviour under test IS the process exiting, and a
 * handler installed in the test runner would swallow the runner's own faults.
 *
 * The point of the handlers is not that the process dies — Node already does that. It is that the
 * death is legible: one line, in the same structured stream as everything else, naming the
 * component and the reason. A container that restarts with nothing in the log is the failure mode
 * we are fixing.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "index.js");

function runChild(body: string, env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const src = `
    import { createLogger, installCrashHandlers } from ${JSON.stringify(DIST)};
    const log = createLogger("probe");
    ${body}
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8",
    env: { ...process.env, LOG_FORMAT: "json", ...env },
    timeout: 15_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** The structured line the handler emits, parsed back out of the child's stderr. */
function fatalLine(err: string): Record<string, unknown> | null {
  for (const line of err.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.msg === "string" && rec.msg.startsWith("fatal:")) return rec;
    } catch { /* not our line */ }
  }
  return null;
}

test("an unhandled rejection exits non-zero with a structured reason", () => {
  const r = runChild(`
    installCrashHandlers(log);
    Promise.reject(new Error("the database went away"));
    setInterval(() => {}, 1000); // keep the loop alive, as a real service does
  `);
  assert.equal(r.code, 1, "must exit non-zero so a supervisor restarts it");
  const rec = fatalLine(r.err);
  assert.ok(rec, `no structured fatal line in stderr:\n${r.err}`);
  assert.equal(rec.component, "probe", "the line must name the component that died");
  assert.match(String(rec.msg), /unhandled promise rejection/);
  assert.match(JSON.stringify(rec.err), /the database went away/, "the reason must survive into the log");
});

test("a rejection with a non-Error value still reports what was thrown", () => {
  // `throw "string"` and `Promise.reject(undefined)` are common in third-party code, and the
  // logger's error serializer produces nothing useful for them unless we wrap first.
  const r = runChild(`
    installCrashHandlers(log);
    Promise.reject("just a string");
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1);
  const rec = fatalLine(r.err);
  assert.ok(rec, "a non-Error rejection must still produce a fatal line");
  assert.match(JSON.stringify(rec.err), /just a string/);
});

test("an uncaught exception on a timer stack exits non-zero with a stack", () => {
  const r = runChild(`
    installCrashHandlers(log);
    setTimeout(() => { throw new Error("boom in a callback"); }, 1);
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1);
  const rec = fatalLine(r.err);
  assert.ok(rec);
  assert.match(String(rec.msg), /uncaught exception/);
  assert.match(JSON.stringify(rec.err), /boom in a callback/);
});

test("cleanup runs before the process goes away", () => {
  const r = runChild(`
    installCrashHandlers(log, { beforeExit: async () => { log.info("flushed the buffer"); } });
    Promise.reject(new Error("x"));
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /flushed the buffer/, "beforeExit must get a chance to run");
});

test("a hung cleanup cannot turn a crash into a hang", () => {
  // A container that hangs is worse than one that dies: it keeps its port and its locks, the
  // supervisor sees a live process, and nothing ever restarts. The budget is what prevents that.
  const started = Date.now();
  const r = runChild(`
    installCrashHandlers(log, { beforeExit: () => new Promise(() => {}) }); // never resolves
    Promise.reject(new Error("x"));
    setInterval(() => {}, 1000);
  `);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 1, "must still exit");
  assert.ok(elapsed < 12_000, `exited in ${elapsed}ms — the cleanup budget did not fire`);
  assert.match(r.err, /cleanup did not finish in time/);
});

test("a throw inside cleanup does not stop the exit", () => {
  const r = runChild(`
    installCrashHandlers(log, { beforeExit: () => { throw new Error("cleanup itself failed"); } });
    Promise.reject(new Error("original"));
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1);
  assert.match(r.err, /cleanup failed/);
  assert.match(r.err, /original/, "the original fault must still be reported");
});

test("only the first fault is reported, and installing twice installs once", () => {
  // A cascade — one fault triggering three more as connections tear down — must not produce a
  // wall of fatal lines that buries the one that matters.
  const r = runChild(`
    installCrashHandlers(log);
    installCrashHandlers(log); // second call is a no-op
    Promise.reject(new Error("first cause"));
    Promise.reject(new Error("second cause"));
    Promise.reject(new Error("third cause"));
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1);
  const fatals = r.err.split("\n").filter((l) => l.includes('"msg":"fatal:'));
  assert.equal(fatals.length, 1, `expected exactly one fatal line, got ${fatals.length}:\n${r.err}`);
  assert.match(fatals[0]!, /first cause/, "the FIRST fault is the one worth reporting");
});

test("without the handlers a rejection leaves nothing in the structured stream", () => {
  // The control case: this is what operators were seeing before — a dead container, exit 1, and
  // no line in the JSON log explaining it.
  const r = runChild(`
    Promise.reject(new Error("silent death"));
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.code, 1, "Node's own behaviour also exits non-zero");
  assert.equal(fatalLine(r.err), null, "…but with no structured line — which is the gap being closed");
});
