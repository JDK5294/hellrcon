/**
 * The comparison that decides whether the auto-settings runner rewrites a setting. The two ways
 * to get this wrong are opposites: comparing raw values reports eternal drift ("on" !== true) and
 * rewrites the same value every thirty seconds forever; being too forgiving misses a real wipe.
 * These pin the line between them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { driftSignature, extractSettingValue, settingsDrift, writeOnlySettings } from "../dist/settings-drift.js";
import type { GameConfigField } from "@app/games";

const FIELDS = new Map<string, GameConfigField>([
  ["autoBalanceEnabled", { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", read: { command: "getAutoBalanceEnabled", key: "enable" }, write: { command: "setAutoBalanceEnabled", param: "enabled" } }],
  ["highPing", { field: "highPing", label: "High ping", kind: "num", read: { command: "getHighPing", key: "highPingThresholdMs" }, write: { command: "setHighPing", param: "ms" } }],
  ["idleKick", { field: "idleKick", label: "Idle kick", kind: "num", read: { command: "getIdleKickTime", key: "idleTimeoutMinutes" }, write: { command: "setKickIdleTime", param: "minutes" } }],
  // Write-only, like the welcome message: enforcement must never claim drift on it.
  ["welcomeMessage", { field: "welcomeMessage", label: "Welcome", kind: "str", write: { command: "setWelcomeMessage", param: "message" } }],
]);

test("a matching server reports no drift — across the wire's own type spellings", () => {
  // Profiles store "on"/"90"; the wire answers true/90. Equality is by KIND, or this loop would
  // rewrite identical values forever.
  const drift = settingsDrift(FIELDS, { autoBalanceEnabled: "on", highPing: "90" }, { autoBalanceEnabled: true, highPing: 90 });
  assert.deepEqual(drift, []);
});

test("a wiped server reports exactly the drifted fields, with both values", () => {
  const drift = settingsDrift(FIELDS,
    { autoBalanceEnabled: true, highPing: 90, idleKick: 10 },
    { autoBalanceEnabled: false, highPing: 500, idleKick: 10 });
  assert.deepEqual(drift.map((d) => d.field).sort(), ["autoBalanceEnabled", "highPing"]);
  assert.deepEqual(drift.find((d) => d.field === "highPing"), { field: "highPing", want: 90, have: 500 });
});

test("write-only and unanswered fields are never drift — no evidence, no claim", () => {
  // welcomeMessage has no read; idleKick was not answered (absent from current); highPing came
  // back null (unsupported on this build). None of the three may be reported.
  const drift = settingsDrift(FIELDS,
    { welcomeMessage: "hi", idleKick: 10, highPing: 90, autoBalanceEnabled: true },
    { highPing: null as unknown as number, autoBalanceEnabled: false });
  assert.deepEqual(drift.map((d) => d.field), ["autoBalanceEnabled"]);
});

test("an unparseable numeric answer is skipped, not treated as drifted", () => {
  assert.deepEqual(settingsDrift(FIELDS, { highPing: 90 }, { highPing: "not a number" }), []);
});

test("extractSettingValue: keyed object, bare primitive, and unknown shapes", () => {
  assert.equal(extractSettingValue({ enable: true }, "enable"), true);
  assert.equal(extractSettingValue(90, "highPingThresholdMs"), 90);
  assert.equal(extractSettingValue({ other: 1 }, "enable"), undefined);
  assert.equal(extractSettingValue(undefined, "enable"), undefined);
  // The same key in another case reads too — the API's reader accepts it, and a profile holding a
  // field (map shuffle) whose getter answers "Enable" must not be blind to the server's value.
  assert.equal(extractSettingValue({ Enable: false }, "enable"), false);
});

test("the signature is stable across ordering, so a standing drift reports once", () => {
  const a = settingsDrift(FIELDS, { highPing: 90, idleKick: 10 }, { highPing: 500, idleKick: 5 });
  const b = [...a].reverse();
  assert.equal(driftSignature(a), driftSignature(b));
  assert.notEqual(driftSignature(a), driftSignature(a.slice(0, 1)));
});

test("write-only fields ride along on a detected wipe — and only those", () => {
  const blind = writeOnlySettings(FIELDS, {
    welcomeMessage: "Welcome to LYNX", // write-only game field → re-taught
    highPing: 90,                       // readable → handled by the drift comparison instead
    "app:broadcast": true,              // app-side key, not a game field → never touched here
    "preset:mapvote": "weekend",        // same
  });
  assert.deepEqual(blind, [{ field: "welcomeMessage", want: "Welcome to LYNX" }]);
});
