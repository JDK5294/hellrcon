/**
 * Fanning one message out to a whole server.
 *
 * The properties here are the ones the two callers (the map-vote reminder and the Messages screen)
 * both depend on, and each is a bug that has bitten a fan-out somewhere before: read the roster the
 * way both protocols actually spell it, keep going when one player drops mid-send, and refuse a
 * roster that reads absurdly large instead of emitting the burst.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageEveryone, rosterPlayerIds } from "../dist/broadcast-all.js";
import { ObserveModeViolation } from "../dist/engagement.js";

/** A client that records what it was asked to send. `fail` names players whose send throws. */
function fakeClient(roster: unknown, fail = new Set<string>()) {
  const sent: { playerId: string; message: string }[] = [];
  return {
    sent,
    readState: async () => roster,
    execute: async (command: string, params: Record<string, unknown>) => {
      assert.equal(command, "messagePlayer", "the top-right message is messagePlayer, never broadcast");
      const playerId = String(params.playerId);
      if (fail.has(playerId)) throw new Error("player left");
      sent.push({ playerId, message: String(params.message) });
      return null;
    },
  };
}

test("the roster is read the way both protocols spell it", () => {
  // Binary v2 says `iD`, the legacy text protocol says `id`, and the reader hands back either a
  // bare array or an object with `players`. Reading only one of those shapes is how a fan-out ends
  // up silently addressing nobody on half the fleet.
  assert.deepEqual(rosterPlayerIds([{ iD: "1" }, { id: "2" }]), ["1", "2"]);
  assert.deepEqual(rosterPlayerIds({ players: [{ iD: "3" }] }), ["3"]);
  assert.deepEqual(rosterPlayerIds([{ iD: "" }, { name: "no id" }, { iD: "  4  " }]), ["4"], "blanks are dropped, ids are trimmed");
  assert.deepEqual(rosterPlayerIds(null), [], "an empty server is not an error");
});

test("every player on the roster gets the message", async () => {
  const client = fakeClient([{ iD: "a" }, { iD: "b" }, { iD: "c" }]);
  const out = await messageEveryone(client, "vote for the next map", { delayMs: 0 });
  assert.deepEqual(out, { found: 3, sent: 3, failed: 0 });
  assert.deepEqual(client.sent.map((s) => s.playerId), ["a", "b", "c"]);
  assert.equal(client.sent[0]!.message, "vote for the next map");
});

test("one player leaving mid-fan-out costs one message, not everyone's", async () => {
  // The failure that matters: a send throws in the middle. Abandoning the loop there would mean a
  // single disconnect during a match-start reminder silently swallowed the reminder for everyone
  // after them on the roster.
  const client = fakeClient([{ iD: "a" }, { iD: "b" }, { iD: "c" }], new Set(["b"]));
  const seen: string[] = [];
  const out = await messageEveryone(client, "hello", { delayMs: 0, onError: (id) => seen.push(id) });
  assert.deepEqual(out, { found: 3, sent: 2, failed: 1 });
  assert.deepEqual(client.sent.map((s) => s.playerId), ["a", "c"], "the player after the failure still got it");
  assert.deepEqual(seen, ["b"], "and the failure was reported rather than thrown");
});

test("an absurd roster is refused rather than fanned out", async () => {
  const client = fakeClient(Array.from({ length: 250 }, (_, i) => ({ iD: String(i) })));
  await assert.rejects(() => messageEveryone(client, "x", { delayMs: 0 }), /past the 200 ceiling/);
  assert.equal(client.sent.length, 0, "nothing is sent when the ceiling is hit — it refuses, it does not truncate");
});

test("an empty server sends nothing and is not an error", async () => {
  const client = fakeClient([]);
  const out = await messageEveryone(client, "x", { delayMs: 0 });
  assert.deepEqual(out, { found: 0, sent: 0, failed: 0 });
});

test("pacing waits between sends but never after the last one", async () => {
  // The tail wait is pure dead time on every call, and on a one-player server it would be the
  // ONLY wait — a 40ms delay to send a single message.
  const client = fakeClient([{ iD: "a" }, { iD: "b" }]);
  const started = Date.now();
  await messageEveryone(client, "x", { delayMs: 30 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 25, `two players should wait once (~30ms), waited ${elapsed}ms`);
  assert.ok(elapsed < 200, `two players should not wait twice, waited ${elapsed}ms`);
});

test("a server refusing writes outright is reported as that, not as players who left", async () => {
  // Observe mode throws on every send. Swallowing those turned "this server is read-only" into a
  // successful-looking { sent: 0, failed: 100 }, which the panel then explained to staff as a
  // hundred players who had probably disconnected. It also meant 99 pointless retries of a command
  // the guard was never going to allow.
  let attempts = 0;
  const client = {
    readState: async () => [{ iD: "a" }, { iD: "b" }, { iD: "c" }],
    execute: async () => { attempts++; throw new ObserveModeViolation("messagePlayer"); },
  };
  await assert.rejects(() => messageEveryone(client, "x", { delayMs: 0 }), /observe mode/i);
  assert.equal(attempts, 1, "it gives up on the first refusal instead of retrying the whole roster");
});

test("a function message is called per recipient, with their name, so placeholders fill per player", async () => {
  const client = fakeClient({ players: [{ id: "p1", name: "Able" }, { iD: "p2", name: "Baker" }] });
  const out = await messageEveryone(client, (pl) => `hi ${pl.playerName} (${pl.playerId})`, { delayMs: 0 });
  assert.equal(out.sent, 2);
  assert.deepEqual(client.sent, [
    { playerId: "p1", message: "hi Able (p1)" },
    { playerId: "p2", message: "hi Baker (p2)" },
  ]);
});
