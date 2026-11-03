import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGameBans } from "../src/protocol/binary-v2/responses.ts";

// Shapes match the confirmed live capture (values here are synthetic, not real data).
test("normalizes a temporary ban list", () => {
  const raw = { banList: [
    { userId: "abc", userName: "Player One", timeOfBanning: "2026-07-14T12:01:03.993Z", durationHours: 2, banReason: "reason", adminName: "admin" },
  ] };
  const bans = normalizeGameBans(raw, "temp");
  assert.equal(bans.length, 1);
  assert.deepEqual(bans[0], {
    playerId: "abc", playerName: "Player One", ts: "2026-07-14T12:01:03.993Z",
    durationHours: 2, reason: "reason", by: "admin", type: "temp",
  });
});

test("permaban rows keep durationHours 0 and are typed perma", () => {
  const raw = { banList: [{ userId: "x", userName: "", timeOfBanning: "2025-05-16T02:22:55.000Z", durationHours: 0, banReason: "r", adminName: "a" }] };
  const bans = normalizeGameBans(raw, "perma");
  assert.equal(bans[0]!.type, "perma");
  assert.equal(bans[0]!.durationHours, 0);
  assert.equal(bans[0]!.playerName, null); // empty userName → null
});

test("returns [] for non-v2 / unexpected shapes", () => {
  assert.deepEqual(normalizeGameBans("some legacy text", "temp"), []);
  assert.deepEqual(normalizeGameBans(null, "temp"), []);
  assert.deepEqual(normalizeGameBans({ other: 1 }, "perma"), []);
  assert.deepEqual(normalizeGameBans({ banList: "nope" }, "temp"), []);
});

test("coerces missing fields defensively", () => {
  const bans = normalizeGameBans({ banList: [{}] }, "temp");
  assert.equal(bans[0]!.playerId, "");
  assert.equal(bans[0]!.reason, "");
  assert.equal(bans[0]!.by, null);
  assert.equal(bans[0]!.ts, null);
});
