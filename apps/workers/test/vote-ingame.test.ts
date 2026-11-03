/**
 * The in-game vote surface — CRCON's votemap shape: players vote by typing the option's number
 * in team or unit chat. What is pinned here: only a bare number is a ballot ("3 tanks on E5" is
 * conversation), a player's newest vote replaces their older one, out-of-range numbers count for
 * nothing, the surface derives everything from stored chat events (stateless — a worker restart
 * mid-vote loses no ballots), and its open announcement numbers the options in a fixed order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldChatBallots, InGameChatVote, listIngameVoters, ttlMemo, type ChatBallotEvent } from "../dist/vote-surface.js";

const chat = (ts: string, who: { id?: string; name: string }, message: string): ChatBallotEvent =>
  ({ ts, actorPlayerId: who.id ?? null, actorName: who.name, data: { message } });

test("only number lines are ballots; the newest per player wins; range is enforced", () => {
  // Newest first, as the repo pages them.
  const events = [
    chat("t9", { id: "p1", name: "Able" }, "2"),          // Able's standing vote
    chat("t8", { id: "p2", name: "Baker" }, " !3 "),      // punctuation-tolerant
    chat("t7", { id: "p3", name: "Chaz" }, "3 tanks on E5"), // conversation, not a ballot
    chat("t6", { id: "p1", name: "Able" }, "1"),          // Able's OLDER vote — replaced
    chat("t5", { id: "p4", name: "Dog" }, "9"),           // out of range: a typo, not a vote
    chat("t4", { name: "ConsoleGuy" }, "1"),              // no id — keyed by name, still counts
    chat("t3", { name: "ConsoleGuy" }, "2"),              // older line from the same name
  ];
  const { counts, voters } = foldChatBallots(events, 3);
  assert.deepEqual(counts, [1, 1, 1]);
  // The vote command players bring from other servers counts the same as the bare number.
  const typed = foldChatBallots([
    chat("t3", { id: "p5", name: "Lucid" }, "!votemap 3"),
    chat("t2", { id: "p6", name: "Mig" }, "!VM 3"),
    chat("t1", { id: "p7", name: "Gagen" }, "!vm2"),
  ], 3);
  assert.deepEqual(typed.counts, [0, 1, 2], "!votemap 3, !VM 3 and !vm2 are three votes");
  assert.deepEqual(voters[1]!.map((v) => v.name), ["Able"]);
  assert.deepEqual(voters[2]!.map((v) => v.name), ["Baker"]);
  assert.deepEqual(voters[0]!.map((v) => v.name), ["ConsoleGuy"]);
  assert.equal(voters[1]![0]!.key, "p1", "id-keyed where the log gave one");
  assert.equal(voters[0]![0]!.key, "name:consoleguy", "name-keyed otherwise");
});

test("the surface is stateless: ballots derive from stored chat since the handle's open time", async () => {
  const store: ChatBallotEvent[] = [
    chat("2026-09-15T02:00:05.000Z", { id: "p1", name: "Able" }, "1"),
    chat("2026-09-15T02:00:02.000Z", { id: "p2", name: "Baker" }, "2"),
    chat("2026-09-15T01:59:00.000Z", { id: "p3", name: "Early" }, "1"), // before the vote opened
  ];
  const queries: { from: string; offset: number }[] = [];
  const announced: string[] = [];
  const surface = new InGameChatVote({
    serverId: "s1",
    query: async (q) => {
      queries.push({ from: q.from, offset: q.offset });
      return store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit);
    },
    announce: async (m) => { announced.push(m); },
  });

  const options = [{ id: "foy", name: "Foy" }, { id: "kursk", name: "Kursk" }] as never;
  const before = "2026-09-15T02:00:00.000Z";
  const handle = await surface.open("Vote for the next map", options);
  assert.ok(handle.messageId.startsWith("ingame:"), "the handle carries the open time, not a Discord id");
  assert.ok(handle.messageId.slice("ingame:".length) >= before);
  assert.match(announced[0]!, /1\. Foy/);
  assert.match(announced[0]!, /2\. Kursk/);
  assert.match(announced[0]!, /NUMBER in chat/);

  // Pretend the vote opened just before those two chat lines: both count, the earlier one doesn't.
  const opened = { messageId: `ingame:${before}`, channelId: "ingame" };
  assert.deepEqual(await surface.tally(opened, 2), [1, 1]);
  assert.deepEqual(await surface.close(opened, 2), [1, 1], "closing is just the final read — nothing to take down in game");
  const voters = await surface.voters(opened, 2);
  assert.deepEqual(voters[0]!.map((v) => v.name), ["Able"]);
  // A SYNTHETIC id, never an empty one: both stores drop id-less voters when they flatten the
  // ballot, so an empty id erased every in-game voter from who-voted-what and the leaderboard.
  assert.equal(voters[0]![0]!.discordId, "player:p1");
  assert.ok(queries.every((q) => q.from === before), "every read is bounded to the vote's own window");

  // The surface was switched mid-vote: the state still carries a Discord message id. There is no
  // open time to bound a scan, so the honest tally is zero — never the newest chat re-read as
  // ballots against options it was not about.
  assert.deepEqual(await surface.tally({ messageId: "1418273645362514", channelId: "C1" }, 2), [0, 0]);
});

test("a failed open announcement does not fail the vote — reminders carry it", async () => {
  const surface = new InGameChatVote({
    serverId: "s1",
    query: async () => [],
    announce: async () => { throw new Error("observe mode refused the broadcast"); },
    log: { warn: () => {} },
  });
  const handle = await surface.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.ok(handle.messageId.startsWith("ingame:"), "the vote still opened");
});

test("ttlMemo: one lookup per key per TTL, failures uncached, concurrent callers share the call", async () => {
  let calls = 0;
  let clock = 0;
  const memo = ttlMemo<string>(async (key) => { calls += 1; return `${key}!`; }, 1000, () => clock);

  assert.equal(await memo("a"), "a!");
  assert.equal(await memo("a"), "a!");
  assert.equal(calls, 1, "the second read inside the window costs nothing");
  await memo("b");
  assert.equal(calls, 2, "each key is remembered on its own");

  clock = 1500;
  await memo("a");
  assert.equal(calls, 3, "past the TTL it asks again — a player who links mid-vote starts counting");

  // A database hiccup must not decide a ballot for the rest of the window.
  let fail = true;
  let tries = 0;
  const flaky = ttlMemo<string>(async () => { tries += 1; if (fail) throw new Error("down"); return "ok"; }, 1000, () => clock);
  await assert.rejects(() => flaky("x"));
  fail = false;
  assert.equal(await flaky("x"), "ok", "the failure was not cached");
  assert.equal(tries, 2);

  // The first tally of a busy vote asks each question once, not once per caller.
  let slowCalls = 0;
  const slow = ttlMemo<number>(async () => { slowCalls += 1; await new Promise((r) => setImmediate(r)); return 7; }, 1000, () => clock);
  assert.deepEqual(await Promise.all([slow("k"), slow("k"), slow("k")]), [7, 7, 7]);
  assert.equal(slowCalls, 1, "three concurrent readers, one lookup");
});

test("a memoized link lookup survives the per-tick rebuild: repeated tallies cost one query per voter", async () => {
  // The surfaces are rebuilt every poll tick on purpose (stateless, so a restart mid-vote loses
  // nothing), which used to mean every tally re-asked the database whether each voter had a
  // Discord link — once per voter, every thirty seconds, for the life of the vote.
  const from = "2026-09-15T02:00:00.000Z";
  const store: ChatBallotEvent[] = [
    chat("2026-09-15T02:00:05.000Z", { id: "p1", name: "Able" }, "1"),
    chat("2026-09-15T02:00:04.000Z", { id: "p2", name: "Baker" }, "2"),
  ];
  let lookups = 0;
  const linkOf = ttlMemo<string | null>(async (playerId) => { lookups += 1; return playerId === "p1" ? "D1" : null; }, 5 * 60_000);

  const handle = { messageId: `ingame:${from}`, channelId: "ingame" };
  // Three ticks, each with a FRESH surface — exactly what the worker does.
  for (let tick = 0; tick < 3; tick++) {
    const surface = new InGameChatVote({
      serverId: "s1",
      query: async (q) => store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit),
      announce: async () => {},
      linkOf,
    });
    assert.deepEqual(await surface.tally(handle, 2), [1, 1], "the ballots read the same every tick");
  }
  assert.equal(lookups, 2, "two voters, two lookups across three ticks — not six");
});

test("a bare in-game surface reads its own half of a combined handle; a Discord-only id still counts nothing", async () => {
  /*
   * Switching "Both" → "In-game only" mid-vote hands this surface the combined handle
   * ("<snowflake>|ingame:<iso>"). The players who typed their numbers voted on THIS surface —
   * the config change is no reason to throw their ballots away — and the open time after the
   * "|" is exactly the bound the scan needs. A raw Discord snowflake, by contrast, still counts
   * nothing: it carries no open time, and a scan without one invents a tally out of old chat.
   */
  const from = "2026-09-15T02:00:00.000Z";
  const store: ChatBallotEvent[] = [
    chat("2026-09-15T02:00:09.000Z", { id: "p1", name: "Able" }, "1"),
    chat("2026-09-15T02:00:05.000Z", { id: "p2", name: "Baker" }, "2"),
    chat("2026-09-15T01:59:00.000Z", { id: "p3", name: "Early" }, "1"), // before the vote opened
  ];
  let queries = 0;
  const surface = new InGameChatVote({
    serverId: "s1",
    query: async (q) => { queries += 1; return store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit); },
    announce: async () => {},
  });

  const combined = { messageId: `d123|ingame:${from}`, channelId: "c1" };
  assert.deepEqual(await surface.tally(combined, 2), [1, 1], "the chat ballots survive the surface switch");
  assert.deepEqual(
    (await surface.voters(combined, 2)).map((l) => l.map((x) => x.name)),
    [["Able"], ["Baker"]],
  );

  queries = 0;
  assert.deepEqual(await surface.tally({ messageId: "d123", channelId: "c1" }, 2), [0, 0], "no open time, no invented tally");
  assert.equal(queries, 0, "and no scan was even attempted");
});

/*
 * Who voted in game, for the public vote_status (CRCON lists its voters): the counts and the
 * voters come off the one chat read the counts already cost, and the list the API publishes runs
 * oldest standing ballot first under the game's own player ids, resolved in one read.
 */
test("the in-game surface hands its counted voters over with the counts, off one chat read", async () => {
  const store: ChatBallotEvent[] = [
    chat("2026-10-13T20:00:09.000Z", { id: "p1", name: "Able" }, "!vm 2"),
    chat("2026-10-13T20:00:05.000Z", { id: "p2", name: "Baker" }, "1"),
    chat("2026-10-13T20:00:02.000Z", { name: "ConsoleGuy" }, "1"),
  ];
  let reads = 0;
  const surface = new InGameChatVote({
    serverId: "s1",
    query: async (q) => { reads++; return store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit); },
    announce: async () => {},
  });
  const r = await surface.tallyWithVoters({ messageId: "ingame:2026-10-13T20:00:00.000Z", channelId: "ingame" }, 2);
  assert.deepEqual(r.counts, [2, 1]);
  assert.deepEqual(r.ingame, [[{ name: "Baker", key: "p2" }, { name: "ConsoleGuy", key: "name:consoleguy" }], [{ name: "Able", key: "p1" }]]);
  assert.equal(reads, 1, "one read for both");
});

test("the published list: oldest ballot first, the game's ids in one read, none for a name-matched ballot", async () => {
  const lookups: string[][] = [];
  const platformIds = async (ids: string[]) => {
    lookups.push(ids);
    return new Map([["p1", "76561198000000001"], ["p2", "76561198000000002"]]);
  };
  const listed = await listIngameVoters([
    [{ name: "Baker", key: "p2" }, { name: "ConsoleGuy", key: "name:consoleguy" }, { name: "Gone", key: "p9" }],
    [{ name: "Able", key: "p1" }],
    [],
  ], platformIds);
  assert.deepEqual(listed, [
    [{ name: "Gone", playerId: null }, { name: "ConsoleGuy", playerId: null }, { name: "Baker", playerId: "76561198000000002" }],
    [{ name: "Able", playerId: "76561198000000001" }],
    [],
  ], "the fold reads newest first; the list runs the order players voted in, as CRCON's does");
  assert.deepEqual(lookups, [["p2", "p9", "p1"]], "one lookup, for the id-keyed ballots only");
  assert.deepEqual(await listIngameVoters([[], []], platformIds), [[], []]);
  assert.equal(lookups.length, 1, "nobody to look up, no lookup");
});
