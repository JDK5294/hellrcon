import { test } from "node:test";
import assert from "node:assert/strict";
import { errors, isAppError, toErrorResponse, codeForStatus } from "../src/errors.ts";
import { createLogger } from "../src/logger.ts";

test("error taxonomy: codes, statuses, and exposure", () => {
  assert.equal(errors.notFound().httpStatus, 404);
  assert.equal(errors.forbidden().code, "FORBIDDEN");
  assert.equal(errors.upstream("rcon timeout").httpStatus, 502);
  assert.ok(isAppError(errors.badRequest("x")));
  assert.equal(isAppError(new Error("plain")), false);
});

test("toErrorResponse: AppError is exposed; internal detail is hidden", () => {
  const exposed = toErrorResponse(errors.notFound("no such server"), "req-1");
  assert.deepEqual(exposed, { status: 404, body: { error: { code: "NOT_FOUND", message: "no such server", requestId: "req-1" } } });

  const secret = toErrorResponse(errors.internal("db password was wrong"), "req-2");
  assert.equal(secret.status, 500);
  assert.equal(secret.body.error.message, "internal error"); // not leaked
  assert.equal(secret.body.error.requestId, "req-2");

  const unknown = toErrorResponse(new Error("boom"), "req-3");
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.code, "INTERNAL");
  assert.equal(unknown.body.error.message, "internal error"); // never leak raw errors
});

test("codeForStatus maps statuses to stable codes", () => {
  assert.equal(codeForStatus(403), "FORBIDDEN");
  assert.equal(codeForStatus(502), "UPSTREAM_ERROR");
  assert.equal(codeForStatus(500), "INTERNAL");
  assert.equal(codeForStatus(418), "ERROR");
});

test("logger: JSON format includes component, bound context, and error stack", () => {
  process.env.LOG_FORMAT = "json";
  process.env.LOG_LEVEL = "debug";
  const lines: string[] = [];
  const orig = console.error;
  console.error = (l: string) => lines.push(l);
  try {
    const log = createLogger("api").child({ requestId: "abc" });
    log.error("request failed", { err: new Error("kaboom"), serverId: "s1" });
  } finally {
    console.error = orig;
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  }
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.component, "api");
  assert.equal(rec.requestId, "abc");
  assert.equal(rec.serverId, "s1");
  assert.equal(rec.msg, "request failed");
  assert.equal(rec.err.message, "kaboom");
  assert.ok(rec.err.stack.includes("kaboom"));
});

test("logger: level threshold filters lower levels", () => {
  process.env.LOG_LEVEL = "warn";
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    const log = createLogger("test");
    log.info("should be filtered");
    log.debug("also filtered");
  } finally {
    console.log = orig;
    delete process.env.LOG_LEVEL;
  }
  assert.equal(lines.length, 0);
});

/*
 * The pretty formatter (the default, what docker-compose logs show) used to destructure `err` out
 * of the fields and print it only when a stack was attached. Every worker call site passes
 * `err: (e as Error).message` — a plain string — so warnings like "mapvote live apply failed"
 * reached production logs with the actual reason silently dropped. The message must land ON the
 * line, whichever shape err arrives in.
 */
test("logger: pretty format prints the err detail for strings, Errors, and named errors", () => {
  process.env.LOG_LEVEL = "debug";
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (l: string) => lines.push(l);
  try {
    const log = createLogger("worker");
    log.warn("mapvote live apply failed", { err: "rotation verification failed", mapId: "FOY" });
    log.warn("mapvote open failed", { err: new Error("channel missing") });
    class WedgedError extends Error { constructor() { super("empty map list"); this.name = "WedgedError"; } }
    log.warn("wedged", { err: new WedgedError() });
  } finally {
    console.warn = orig;
    delete process.env.LOG_LEVEL;
  }
  assert.ok(lines[0]!.includes("err=rotation verification failed"), `string err detail must be on the line: ${lines[0]}`);
  assert.ok(lines[0]!.includes("mapId=FOY"), "other fields still render");
  assert.ok(lines[1]!.includes("err=channel missing"), `Error message must be on the line: ${lines[1]}`);
  assert.ok(lines[1]!.includes("at "), "the stack still follows on its own lines");
  assert.ok(lines[2]!.includes("err=WedgedError: empty map list"), `a named error keeps its name: ${lines[2]}`);
});
