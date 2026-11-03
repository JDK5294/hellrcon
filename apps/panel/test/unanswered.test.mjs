// A bulk VIP grant that the proxy cut off may still be running: the screen must not read as
// "it failed, press it again" — that doubles everyone's time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STILL_RUNNING_NOTE, mayStillBeRunning } from "../lib/unanswered.ts";

test("no answer, or the proxy's own gateway error, may still be running", () => {
  for (const status of [0, 502, 504, 524]) assert.equal(mayStillBeRunning({ status }), true, `HTTP ${status}`);
  assert.match(STILL_RUNNING_NOTE, /before running it again/);
});

test("an answer from the API itself is final", () => {
  for (const status of [400, 403, 404, 409, 500]) assert.equal(mayStillBeRunning({ status }), false, `HTTP ${status}`);
  assert.equal(mayStillBeRunning(new Error("x")), false);
  assert.equal(mayStillBeRunning(null), false);
});

test("the bulk and group VIP grants wait for the server and use the note", async () => {
  const { readFile } = await import("node:fs/promises");
  const servers = await readFile(new URL("../components/Servers.tsx", import.meta.url), "utf8");
  const bulk = servers.slice(servers.indexOf("/vips/bulk`"), servers.indexOf("/actions/bulk`"));
  assert.match(bulk, /timeoutMs: 0/, "bulk VIP does not give up at the default minute");
  assert.match(bulk, /mayStillBeRunning\(e\)/);
  const groups = await readFile(new URL("../components/PlayerGroups.tsx", import.meta.url), "utf8");
  assert.match(groups, /\/apply`, \{ method: "POST", body, timeoutMs: 0 \}/);
  assert.match(groups, /action === "vip" && mayStillBeRunning\(e\)/);
});
