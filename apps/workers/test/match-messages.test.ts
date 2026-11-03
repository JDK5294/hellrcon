import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dueMatchMessages, matchMessageKey, sentMatchMessageKeys } from "../dist/match-messages.js";

const start = "2026-09-27T12:00:00.000Z";
const msg = (minutes: number, extra: Partial<{ message: string; minPlayers: number; enabled: boolean }> = {}) =>
  ({ minutes, message: extra.message ?? `at ${minutes}`, minPlayers: extra.minPlayers ?? 0, enabled: extra.enabled ?? true });
const due = (matchMinutes: number | null, messages: ReturnType<typeof msg>[], o: { playerCount?: number; sent?: Set<string> } = {}) =>
  dueMatchMessages({ messages, matchStartedAt: start, matchMinutes, playerCount: o.playerCount ?? 50, sent: o.sent ?? new Set() }).map((d) => d.message.minutes);

test("a timed message is due from its minute, within the grace, and not before or long after", () => {
  const list = [msg(10), msg(30)];
  assert.deepEqual(due(9.9, list), []);
  assert.deepEqual(due(10, list), [10]);
  assert.deepEqual(due(14.9, list), [10], "a restart a few minutes late still sends it");
  assert.deepEqual(due(15, list), [], "noticed too late: skipped, never dumped on players");
  assert.deepEqual(due(31, list), [30]);
  assert.deepEqual(due(null, list), [], "no match in progress: nothing is due");
});

test("a timed message goes out once per match, honours its player minimum and its switch", () => {
  const list = [msg(10, { minPlayers: 20 }), msg(10, { message: "off", enabled: false })];
  assert.deepEqual(due(11, list, { playerCount: 19 }), [], "below the minimum");
  assert.deepEqual(due(12, list, { playerCount: 20 }), [10], "the population arrived inside the grace");
  const sent = new Set([matchMessageKey(start, list[0]!)]);
  assert.deepEqual(due(12, list, { sent }), [], "already sent this match");
  // The next match is a new key: the same message goes out again.
  const next = dueMatchMessages({ messages: list, matchStartedAt: "2026-09-27T13:40:00.000Z", matchMinutes: 10, playerCount: 50, sent });
  assert.equal(next.length, 1);
});

test("sentMatchMessageKeys reads the keys back from the audit rows, real sends apart from dry-run", () => {
  const rows = [{ data: { key: "a" } }, { data: {} }, { data: null }, {}, { data: { key: "b", dryRun: false } }, { data: { key: "c", dryRun: true } }];
  assert.deepEqual([...sentMatchMessageKeys(rows)].sort(), ["a", "b"]);
  assert.deepEqual([...sentMatchMessageKeys(rows, true)], ["c"], "a dry-run line never counts as the real message sent");
});

test("the runner sends due match messages and feeds the match clock to the profiles", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  assert.ok(src.includes("resolveProfile(profiles, new Date(), { playerCount, alliedCount, axisCount, matchMinutes })"), "profiles see the match clock");
  const at = src.indexOf("---- timed match messages");
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf("// ---- roster-state rules ----", at));
  assert.ok(block.indexOf("sentSet.add(key)") < block.indexOf("messageEveryone("), "marked sent before sending: never repeated");
  assert.ok(block.includes("live && !config.dryRun"), "dry-run and observe mode only record");
  const fail = block.slice(block.indexOf("} catch (err) {"));
  assert.ok(fail.includes("sentSet.delete(key)") && fail.indexOf("continue;") < fail.indexOf("repo.audit.create("),
    "a send that reached nobody is retried on the next check and never recorded as sent");
  assert.ok(block.includes("out.sent === 0 && out.failed > 0"), "every send failing counts as reaching nobody");
  assert.ok(block.includes('action: "autosettings.message"'), "every send is on the record, which is also how a restart knows");
  assert.ok(src.includes('actions: ["autosettings.message"], serverId: server.id, from: openMatch.startedAt'), "a restart reads back what this match already sent");
  assert.ok(src.includes("const sentSet = send ? matchMsgSent : matchMsgWould;"), "dry-run and real sends are remembered apart");
  assert.ok(src.includes("!stateRules.length && !profilesOn && !matchMessagesOn"), "messages alone keep the loop awake");
});
