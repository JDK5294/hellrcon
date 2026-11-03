import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository, kindsForCategories } from "@app/db";
import { ingestLines, inferPlatform } from "../dist/index.js";

test("inferPlatform: 17-digit numeric = steam, else other", () => {
  assert.equal(inferPlatform("76561198000000043"), "steam");
  assert.equal(inferPlatform("0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"), "other");
});

test("ingestLines: stores events, upserts players, skips noise", async () => {
  const repo = new InMemoryRepository();
  const lines = [
    "KILL: wren(Allies/76561198000000043) -> ZX204(Axis/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0) with M1 CARBINE",
    "CONNECTED wren (76561198000000043)",
    "this is not a recognized line",
    "CHAT[Team][wren(Allies/76561198000000043)]: hello",
  ];
  const n = await ingestLines(repo, "srv-1", lines);
  assert.equal(n, 3); // 3 recognized, 1 noise skipped

  const events = await repo.events.listRecent("srv-1");
  assert.equal(events.length, 3);
  const kill = events.find((e) => e.kind === "evt.kill");
  assert.equal(kill?.actorName, "wren");
  assert.equal(kill?.weapon, "M1 CARBINE");
  assert.ok(kill?.actorPlayerId); // player resolved
  assert.ok(kill?.victimPlayerId);

  // wren (steam) and ZX204 (other) tracked as distinct players
  const players = await repo.players.list();
  assert.equal(players.length, 2);
  assert.ok(players.some((p) => p.platform === "steam" && p.name === "wren"));
  assert.ok(players.some((p) => p.platform === "other" && p.name === "ZX204"));
});

test("re-ingesting the same admin-log window is idempotent (no double-counted stats)", async () => {
  const repo = new InMemoryRepository();
  // A real prefixed line. The relative time in the prefix changes between polls; the unix
  // timestamp + body do not — so this is the SAME event read twice.
  const poll1 = ["[13.8 sec (1784761672)] KILL: A(Allies/id1) -> B(Axis/id2) with M1918A2 BAR"];
  const poll2 = ["[3.20 sec (1784761672)] KILL: A(Allies/id1) -> B(Axis/id2) with M1918A2 BAR"];

  assert.equal(await ingestLines(repo, "s1", poll1), 1); // first time: inserted
  assert.equal(await ingestLines(repo, "s1", poll2), 0); // same event again: nothing new
  // Simulates clicking "Ingest now" a third time on the same window.
  assert.equal(await ingestLines(repo, "s1", poll1), 0);

  assert.equal((await repo.events.listRecent("s1")).length, 1); // stored once
  const board = await repo.stats.leaderboard("kills", 10);
  assert.equal(board.find((e) => e.name === "A")?.kills, 1); // counted once, not 3x
  assert.equal(board.find((e) => e.name === "B")?.deaths, 1);
});

test("connect/disconnect accumulate a visit and the session's playtime", async () => {
  const repo = new InMemoryRepository();
  // Same unix ts embedded in the prefix drives evt.ts; connect at t, disconnect one hour later.
  await ingestLines(repo, "s1", ["[5.0 sec (1784761600)] CONNECTED Solo (76561198000000042)"]);
  await ingestLines(repo, "s1", ["[5.0 sec (1784765200)] DISCONNECTED Solo (76561198000000042)"]);

  const player = (await repo.players.list()).find((p) => p.name === "Solo")!;
  const stats = await repo.stats.get(player.id);
  assert.equal(stats?.visits, 1);
  assert.equal(stats?.playtimeSec, 3600); // 1784765200 - 1784761600
});

test("a session adds at most a day of playtime — a disconnect 30 hours on, or a connect 66 days on", async () => {
  const repo = new InMemoryRepository();
  const t0 = 1774591200; // 2026-03-27T06:00:00Z
  const line = (secs: number, what: "CONNECTED" | "DISCONNECTED") => `[1.0 sec (${t0 + secs})] ${what} Stayer (76561198000000077)`;
  await ingestLines(repo, "s1", [line(0, "CONNECTED")]);
  await ingestLines(repo, "s1", [line(30 * 3600, "DISCONNECTED")]);
  const player = (await repo.players.list()).find((p) => p.name === "Stayer")!;
  assert.equal((await repo.stats.get(player.id))?.playtimeSec, 86_400, "a day, not 30 hours");

  // Connected again, then nothing until a connect 66 days later: the last one banks a day.
  await ingestLines(repo, "s1", [line(40 * 3600, "CONNECTED")]);
  await ingestLines(repo, "s1", [line((40 + 66 * 24) * 3600, "CONNECTED")]);
  assert.equal((await repo.stats.get(player.id))?.playtimeSec, 2 * 86_400, "a day banked, not 66");
  assert.deepEqual((await repo.sessions.list(player.id)).map((s) => s.durationSec), [86_400, 86_400]);
});

test("a duplicate line within one batch collapses to a single event", async () => {
  const repo = new InMemoryRepository();
  const dup = "[5.0 sec (1784761680)] KILL: X(Allies/idx) -> Y(Axis/idy) with M1 GARAND";
  assert.equal(await ingestLines(repo, "s1", [dup, dup]), 1);
  assert.equal(board1(await repo.stats.leaderboard("kills", 10), "X"), 1);
  function board1(b: { name: string; kills: number }[], name: string) { return b.find((e) => e.name === name)?.kills; }
});

test("match tracking: MATCH START opens a round, kills accrue per-player scoreboards, MATCH ENDED closes with outcome", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const lines = [
    "[1.0 sec (1784760000)] MATCH START Carentan Warfare",
    "[1.0 sec (1784760100)] KILL: Ally(Allies/76561198000000001) -> Foe(Axis/76561198000000002) with M1 GARAND",
    "[1.0 sec (1784760200)] KILL: Ally(Allies/76561198000000001) -> Foe(Axis/76561198000000002) with M1 GARAND",
    "[1.0 sec (1784760300)] TEAM KILL: Ally(Allies/76561198000000001) -> Mate(Allies/76561198000000003) with GRENADE",
    "[1.0 sec (1784760900)] MATCH ENDED `Carentan Warfare` ALLIED (3 - 1)",
  ];
  await ingestLines(repo, s.id, lines, undefined, "hll");

  const matches = await repo.matches.list(s.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.map, "Carentan Warfare");
  assert.equal(matches[0]!.winner, "allies");
  assert.equal(matches[0]!.alliedScore, 3);
  assert.ok(matches[0]!.endedAt);

  const ally = (await repo.players.list()).find((p) => p.name === "Ally")!;
  const board = await repo.matches.statsForMatch(matches[0]!.id);
  const allyLine = board.find((b) => b.playerId === ally.id)!;
  assert.equal(allyLine.kills, 2);
  assert.equal(allyLine.teamkills, 1);
  assert.equal(allyLine.side, "allies");

  const agg = await repo.matches.aggregateForPlayer(ally.id);
  assert.equal(agg.matches, 1);
  assert.equal(agg.wins, 1); // allies side, allies won
  assert.equal(agg.kills, 2);
});

test("the modern flanked MATCH ENDED credits the side the score says, not the first word", async () => {
  // "`Kharkov Warfare` ALLIED (2 - 3) AXIS": both sides are score labels, no winner is named.
  // The old parse took ALLIED as the winner, so an Axis 3–2 round settled as an Allied win —
  // on the round, on every player's won flag, and on the career win counts. This is the whole
  // pipeline: raw line → parse → close → settle.
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const lines = [
    "[1.0 sec (1784760000)] MATCH START Kharkov Warfare",
    "[1.0 sec (1784760100)] KILL: Jaeger(Axis/76561198000000021) -> Doughboy(Allies/76561198000000022) with MP40",
    "[1.0 sec (1784760900)] MATCH ENDED `Kharkov Warfare` ALLIED (2 - 3) AXIS",
  ];
  await ingestLines(repo, s.id, lines, undefined, "hll");

  const matches = await repo.matches.list(s.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.winner, "axis");
  assert.equal(matches[0]!.alliedScore, 2);
  assert.equal(matches[0]!.axisScore, 3);

  const jaeger = (await repo.players.list()).find((p) => p.name === "Jaeger")!;
  const agg = await repo.matches.aggregateForPlayer(jaeger.id);
  assert.equal(agg.wins, 1, "the Axis player won this round");
  const doughboy = (await repo.players.list()).find((p) => p.name === "Doughboy")!;
  assert.equal((await repo.matches.aggregateForPlayer(doughboy.id)).wins, 0, "the Allied player did not");
});

test("a stale whistle from an unseen round cannot close the round in progress", async () => {
  // The wide first read after a reconnect can carry the END of a round the tracker never saw
  // OPEN (the worker was down across its start). That whistle names ITS map; when the round in
  // progress is a different one, closing it with the stray result would stamp Kharkov's score
  // and winner onto SME. The guard leaves the open round alone; its own whistle still closes it.
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  await ingestLines(repo, s.id, [
    "[9.0 sec (1784800000)] MATCH START SME Warfare",
    "[8.0 sec (1784800100)] KILL: A(Allies/76561198000000031) -> B(Axis/76561198000000032) with M1 GARAND",
    "[7.0 sec (1784800200)] MATCH ENDED `Kharkov Warfare` ALLIED (2 - 3) AXIS", // not our whistle
  ], undefined, "hll");

  let matches = await repo.matches.list(s.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.endedAt, null, "the stray whistle must not close SME");
  assert.equal(matches[0]!.winner, null);

  // SME's own whistle arrives and closes it exactly as normal.
  await ingestLines(repo, s.id, [
    "[1.0 sec (1784800900)] MATCH ENDED `SME Warfare` ALLIED (4 - 1) AXIS",
  ], undefined, "hll");
  matches = await repo.matches.list(s.id);
  assert.ok(matches[0]!.endedAt, "its own end still counts");
  assert.equal(matches[0]!.winner, "allies");
  assert.equal(matches[0]!.alliedScore, 4);
});

test("match tracking: re-ingesting the same window never double-counts a scoreboard", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const window = [
    "[9.0 sec (1784761000)] MATCH START Foy Warfare",
    "[9.0 sec (1784761100)] KILL: A(Allies/76561198000000010) -> B(Axis/76561198000000011) with M1 GARAND",
  ];
  await ingestLines(repo, s.id, window, undefined, "hll");
  await ingestLines(repo, s.id, window.map((l) => l.replace("9.0 sec", "2.1 sec")), undefined, "hll"); // same events, new relative time

  const m = (await repo.matches.list(s.id))[0];
  const a = (await repo.players.list()).find((p) => p.name === "A")!;
  const line = (await repo.matches.statsForMatch(m!.id)).find((b) => b.playerId === a.id)!;
  assert.equal(line.kills, 1); // counted once despite two reads
});

/*
 * ┌─────────────────────────────────────────────────────────────────────────────────┐
 * │ PROTECTED INVARIANT — DO NOT DELETE OR WEAKEN.                                     │
 * │ Career/game stats are accumulated at INGEST time into a rollup that is independent │
 * │ of the raw `evt` store. Therefore trimming raw events (by category and/or age, up  │
 * │ to and including deleting ALL of them) must NEVER change a player's career stats.  │
 * │ This is the core promise that makes the trim tool safe. If this test ever needs to │
 * │ change, the stats/trim design has regressed — fix the code, not the test.          │
 * └─────────────────────────────────────────────────────────────────────────────────┘
 */
test("[INVARIANT] game stats accumulate at ingest and survive event trimming", async () => {
  const repo = new InMemoryRepository();
  // A rich mix: two killers, several victims, a teamkill, plus non-combat events.
  await ingestLines(repo, "s1", [
    "CONNECTED A (76561198000000001)",
    "KILL: A(Allies/76561198000000001) -> B(Axis/hashB) with M1",
    "KILL: A(Allies/76561198000000001) -> C(Axis/hashC) with M1",
    "KILL: B(Axis/hashB) -> A(Allies/76561198000000001) with KARABINER 98K",
    "TEAM KILL: A(Allies/76561198000000001) -> D(Allies/hashD) with SATCHEL",
    "CHAT[Team][A(Allies/76561198000000001)]: gg",
  ]);

  // Capture the full career picture up front.
  const snapshot = async () => {
    const board = await repo.stats.leaderboard("kills", 100);
    return Object.fromEntries(board.map((e) => [e.name, e]));
  };
  const before = await snapshot();
  assert.equal(before.A?.kills, 2);
  assert.equal(before.A?.deaths, 1); // B killed A once
  assert.equal(before.A?.teamkills, 1);
  assert.equal(before.A?.kd, 2); // 2 kills / 1 death = 2
  assert.equal(before.B?.kills, 1);
  assert.equal(before.B?.deaths, 1);
  assert.equal(before.B?.kd, 1);
  assert.equal(before.C?.deaths, 1);
  assert.equal(before.D?.deaths, 1); // teamkill victim still counts a death

  // 1) PARTIAL trim: remove only the "kills" category. Career stats must be identical.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  await repo.events.trim({ kinds: kindsForCategories(["kills"]), olderThanIso: future });
  assert.deepEqual(await snapshot(), before);
  // connections/chat/teamkill events are untouched by a "kills" trim
  assert.ok((await repo.events.listRecent("s1")).some((e) => e.kind === "evt.player.connected"));

  // 2) FULL trim: remove every remaining event kind. Career stats STILL identical.
  await repo.events.trim({
    kinds: ["evt.kill", "evt.teamkill", "evt.player.connected", "evt.player.disconnected", "evt.chat.team", "evt.chat.squad", "evt.player.teamSwitched", "evt.vote.started"],
    olderThanIso: future,
  });
  assert.equal((await repo.events.listRecent("s1")).length, 0); // event store fully emptied
  assert.deepEqual(await snapshot(), before); // ← the guarantee
});

/*
 * The case batching made dangerous. Stat writes are now accumulated across the batch instead of
 * issued per event, so a batch that straddles a round boundary has to flush the outgoing round's
 * scoreboard BEFORE the next round opens and before settleMatch reads it. Get that wrong and
 * either every kill lands on the last round of the batch, or a round is settled against an empty
 * scoreboard. One poll window covering a map change is completely ordinary, so this is the shape
 * that must hold.
 */
test("one batch spanning two rounds keeps each round's scoreboard on its own round", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const A = "76561198000000021", B = "76561198000000022";
  await ingestLines(repo, s.id, [
    "[1.0 sec (1784770000)] MATCH START Carentan Warfare",
    `[1.0 sec (1784770100)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
    `[1.0 sec (1784770200)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
    "[1.0 sec (1784770400)] MATCH ENDED `Carentan Warfare` ALLIED (5 - 2)",
    "[1.0 sec (1784770500)] MATCH START Foy Warfare",
    `[1.0 sec (1784770600)] KILL: B(Axis/${B}) -> A(Allies/${A}) with MP40`,
    "[1.0 sec (1784770900)] MATCH ENDED `Foy Warfare` AXIS (2 - 5)",
  ], undefined, "hll");

  const players = await repo.players.list();
  const a = players.find((p) => p.name === "A")!;
  const b = players.find((p) => p.name === "B")!;
  const rounds = await repo.matches.list(s.id);
  assert.equal(rounds.length, 2);
  const carentan = rounds.find((m) => m.map === "Carentan Warfare")!;
  const foy = rounds.find((m) => m.map === "Foy Warfare")!;

  // Round one: A killed twice, B died twice. None of it may leak into round two.
  const r1 = await repo.matches.statsForMatch(carentan.id);
  assert.equal(r1.find((x) => x.playerId === a.id)!.kills, 2);
  assert.equal(r1.find((x) => x.playerId === a.id)!.deaths, 0);
  assert.equal(r1.find((x) => x.playerId === b.id)!.deaths, 2);

  // Round two: exactly one kill the other way.
  const r2 = await repo.matches.statsForMatch(foy.id);
  assert.equal(r2.find((x) => x.playerId === b.id)!.kills, 1);
  assert.equal(r2.find((x) => x.playerId === a.id)!.deaths, 1);
  assert.equal(r2.find((x) => x.playerId === a.id)!.kills, 0);

  // settleMatch runs per round and must have seen a populated scoreboard both times: A was allies
  // when allies won, then allies when axis won — one win, one loss, and two rounds played.
  const agg = await repo.matches.aggregateForPlayer(a.id);
  assert.equal(agg.matches, 2);
  assert.equal(agg.wins, 1);
  assert.equal(agg.losses, 1);
  assert.equal(agg.kills, 2);

  // Careers are flushed once at the end of the batch; the totals must still be the per-event sum.
  assert.equal((await repo.stats.get(a.id))!.kills, 2);
  assert.equal((await repo.stats.get(a.id))!.deaths, 1);
  assert.equal((await repo.stats.get(b.id))!.kills, 1);
  assert.equal((await repo.stats.get(b.id))!.deaths, 2);
});

/*
 * Batch order is the adapter's choice, not a guarantee — CRCON serves its log newest-first — so
 * ingest imposes chronological order itself. The same window delivered REVERSED must produce the
 * identical record: the disconnect pairs with the connect before it, and each kill lands on the
 * round that was open at that moment. Before the sort, a reversed batch closed no session (the
 * disconnect arrived "first"), attributed kills to no round, and stamped one round's outcome on
 * the other.
 */
test("a newest-first batch (CRCON's order) ingests identically to an oldest-first one", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const P = "76561198000000051", Q = "76561198000000052";
  const chronological = [
    `[9 sec (1784790000)] CONNECTED P (${P})`,
    "[8 sec (1784790100)] MATCH START Carentan Warfare",
    `[7 sec (1784790200)] KILL: P(Allies/${P}) -> Q(Axis/${Q}) with M1 GARAND`,
    "[6 sec (1784790450)] MATCH ENDED `Carentan Warfare` ALLIED (5 - 0)",
    "[5 sec (1784790500)] MATCH START Foy Warfare",
    `[4 sec (1784790550)] KILL: Q(Axis/${Q}) -> P(Allies/${P}) with MP40`,
    `[3 sec (1784790600)] DISCONNECTED P (${P})`,
  ];
  await ingestLines(repo, s.id, [...chronological].reverse(), undefined, "hll");

  const p = (await repo.players.list()).find((x) => x.name === "P")!;
  const stats = await repo.stats.get(p.id);
  assert.equal(stats?.visits, 1);
  assert.equal(stats?.playtimeSec, 600, "the disconnect pairs with the connect 600s before it");

  const rounds = await repo.matches.list(s.id);
  const carentan = rounds.find((m) => m.map === "Carentan Warfare")!;
  const foy = rounds.find((m) => m.map === "Foy Warfare")!;
  assert.equal(carentan.winner, "allies", "the outcome closed its own round, not the next one");
  assert.equal((await repo.matches.statsForMatch(carentan.id)).find((x) => x.playerId === p.id)?.kills, 1);
  assert.equal((await repo.matches.statsForMatch(foy.id)).find((x) => x.playerId === p.id)?.deaths, 1);
});

/*
 * A round whose MATCH ENDED line was never seen — server crash, worker down across the boundary —
 * is closed when the next MATCH START supersedes it. Closing is not settling: the people on its
 * scoreboard played that round. They are counted as having played it (with no winner invented),
 * and the internal settle bookkeeping stays out of the result text the panel displays.
 */
test("a round whose MATCH ENDED was never seen still counts as played when the next round opens", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const A = "76561198000000061", B = "76561198000000062";
  await ingestLines(repo, s.id, [
    "[1 sec (1784800000)] MATCH START Carentan Warfare",
    `[1 sec (1784800100)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
  ], undefined, "hll");
  // The server crashes; no MATCH ENDED ever appears. The next thing the log says:
  await ingestLines(repo, s.id, [
    "[1 sec (1784803600)] MATCH START Foy Warfare",
  ], undefined, "hll");

  const carentan = (await repo.matches.list(s.id)).find((m) => m.map === "Carentan Warfare")!;
  assert.ok(carentan.endedAt, "the dead round is closed when the next one opens");
  assert.equal(carentan.winner, null, "no winner is invented");
  assert.equal(carentan.result, null, "no bookkeeping marker leaks into the display text");
  assert.ok(carentan.settledAt, "but its careers were rolled up");

  const a = (await repo.players.list()).find((x) => x.name === "A")!;
  const agg = await repo.matches.aggregateForPlayer(a.id);
  assert.equal(agg.matches, 1, "A played the dead round");
  assert.equal(agg.wins, 0, "and won nothing");
  assert.equal((await repo.stats.get(a.id))?.matchesPlayed, 1);

  // A replayed MATCH START (same line re-read next poll) must not settle — or double-count —
  // anything: the event store already knows it.
  await ingestLines(repo, s.id, ["[1 sec (1784803600)] MATCH START Foy Warfare"], undefined, "hll");
  assert.equal((await repo.stats.get(a.id))?.matchesPlayed, 1);
});

/*
 * A round shorter than five minutes is not a game (MIN_MATCH_MS). Field report, with screenshots:
 * "0m" rounds in the match list, each counted as a win or a loss for everyone on it. Both shapes
 * from the screenshots: a start line written on the end screen and closed by the whistle a moment
 * later with the round before's score, and a map switched away from as soon as it loaded.
 */
test("a round that ends inside five minutes is dropped: no match, no played, no win or loss", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const A = "76561198000000071", B = "76561198000000072";
  await ingestLines(repo, s.id, [
    "[1 sec (1784900000)] MATCH START KURSK Warfare",
    `[1 sec (1784900600)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
    "[1 sec (1784903900)] MATCH ENDED `KURSK Warfare` ALLIED (0 - 5) AXIS",
    // On the end screen: a start line for the same map, closed by a whistle 35 seconds later.
    "[1 sec (1784903905)] MATCH START KURSK Warfare",
    `[1 sec (1784903910)] KILL: B(Axis/${B}) -> A(Allies/${A}) with MP40`,
    "[1 sec (1784903940)] MATCH ENDED `KURSK Warfare` ALLIED (0 - 5) AXIS",
  ], undefined, "hll");

  const rounds = await repo.matches.list(s.id);
  assert.deepEqual(rounds.map((m) => [m.map, m.winner]), [["KURSK Warfare", "axis"]], "only the real round is listed, with its own result");
  const a = (await repo.players.list()).find((p) => p.name === "A")!;
  const b = (await repo.players.list()).find((p) => p.name === "B")!;
  assert.equal((await repo.stats.get(a.id))!.matchesPlayed, 1, "one game played, not two");
  assert.equal((await repo.stats.get(b.id))!.matchesPlayed, 1);
  assert.equal((await repo.stats.get(b.id))!.matchesWon, 1, "the real round's win, and no second one");
  // A kill is a kill whatever round it fell in: careers keep both, from the kill stream.
  assert.equal((await repo.stats.get(a.id))!.kills, 1);
  assert.equal((await repo.stats.get(b.id))!.kills, 1);
  // CRCON lists every round it saw start, so the CRCON-compatible endpoints still have the short
  // one: its own whistle's text and time, its own public alias.
  const crcon = await repo.matches.crconRounds(s.id, 500, 0);
  assert.deepEqual(crcon.map((r) => [r.short, r.map, r.endedAt, r.result]), [
    [true, "KURSK Warfare", new Date(1784903940_000).toISOString(), "`KURSK Warfare` ALLIED (0 - 5) AXIS"],
    [false, "KURSK Warfare", new Date(1784903900_000).toISOString(), "`KURSK Warfare` ALLIED (0 - 5) AXIS"],
  ]);
  assert.notEqual(crcon[0]!.seq, crcon[1]!.seq);
});

test("a round superseded inside five minutes is dropped, not settled; a long one still counts", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const A = "76561198000000081", B = "76561198000000082";
  await ingestLines(repo, s.id, [
    "[1 sec (1785000000)] MATCH START SAINTE-MERE-EGLISE Warfare",
    `[1 sec (1785000010)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
    // Switched away from 40 seconds after it loaded.
    "[1 sec (1785000040)] MATCH START UTAH BEACH Offensive",
    `[1 sec (1785000400)] KILL: A(Allies/${A}) -> B(Axis/${B}) with M1 GARAND`,
    // The server goes down mid-round: the next start supersedes a round that ran 30 minutes.
    "[1 sec (1785001840)] MATCH START OMAHA BEACH Warfare",
  ], undefined, "hll");

  const rounds = await repo.matches.list(s.id);
  assert.deepEqual(rounds.map((m) => m.map), ["OMAHA BEACH Warfare", "UTAH BEACH Offensive"], "the 40-second round is gone");
  const a = (await repo.players.list()).find((p) => p.name === "A")!;
  assert.equal((await repo.stats.get(a.id))!.matchesPlayed, 1, "the 30-minute round counts as played; the 40-second one does not");
  assert.equal((await repo.stats.get(a.id))!.kills, 2);
  const crcon = await repo.matches.crconRounds(s.id, 500, 0);
  assert.deepEqual(crcon.map((r) => [r.short, r.map, r.endedAt]), [
    [false, "OMAHA BEACH Warfare", null],
    [false, "UTAH BEACH Offensive", new Date(1785001840_000).toISOString()],
    [true, "SAINTE-MERE-EGLISE Warfare", new Date(1785000040_000).toISOString()],
  ], "the 40-second round, ended by the next start, as CRCON lists it");
});

test("a player mentioned many times in one batch is resolved to one row, with the last name seen", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const ID = "76561198000000031";
  await ingestLines(repo, s.id, [
    `[1.0 sec (1784780000)] KILL: OldName(Allies/${ID}) -> V(Axis/76561198000000032) with M1 GARAND`,
    `[1.0 sec (1784780100)] KILL: OldName(Allies/${ID}) -> V(Axis/76561198000000032) with M1 GARAND`,
    `[1.0 sec (1784780200)] KILL: NewName(Allies/${ID}) -> V(Axis/76561198000000032) with M1 GARAND`,
  ], undefined, "hll");

  // Identity is resolved in ONE upsertMany now rather than per line — same outcome as the loop:
  // one row, and the last mention names it.
  const rows = (await repo.players.list()).filter((p) => p.platformId === ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "NewName");
  assert.equal((await repo.stats.get(rows[0]!.id))!.kills, 3);
});

/*
 * Admin camera is a PAIR — the enter line and the leave line — and the pair is the only thing that
 * answers "who was watching, and for how long". Two loose events cannot, and the game log they came
 * from is trimmable, so the pairing is folded into its own table as the lines arrive.
 */
test("ingestLines: admin camera enter/leave becomes one timed session", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28011, password: "p" });
  const at = (unix: number) => `[1 sec (${unix})]`;
  const base = 1785000000;

  await ingestLines(repo, s.id, [`${at(base)} CAMERA [Mod Jane (76561198000000009)] Entered Admin Camera`]);
  const open = await repo.adminCam.list({ serverId: s.id });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.playerName, "Mod Jane");
  // Still in cam: no exit and no duration is a LIVE reading, not a broken row.
  assert.equal(open[0]!.exitedAt, null);
  assert.equal(open[0]!.durationSec, null);

  await ingestLines(repo, s.id, [`${at(base + 300)} CAMERA [Mod Jane (76561198000000009)] Left Admin Camera`]);
  const closed = await repo.adminCam.list({ serverId: s.id });
  assert.equal(closed.length, 1, "the leave closes the open session rather than opening a second row");
  assert.equal(closed[0]!.durationSec, 300);
  assert.ok(closed[0]!.exitedAt);
  assert.ok(closed[0]!.playerId, "the session is attributed to the resolved player");

  // The worker re-reads the last few seconds of admin log every poll and again after a reconnect.
  // A replayed enter must not open a second overlapping session on top of a closed one…
  await ingestLines(repo, s.id, [`${at(base)} CAMERA [Mod Jane (76561198000000009)] Entered Admin Camera`]);
  assert.equal((await repo.adminCam.list({ serverId: s.id })).length, 1, "the replayed line was already stored");

  // …and an exit with no matching entry is dropped, not recorded as a zero-length visit.
  await ingestLines(repo, s.id, [`${at(base + 900)} CAMERA [Ghost (76561198000000010)] Left Admin Camera`]);
  assert.equal((await repo.adminCam.list({ serverId: s.id })).length, 1);

  // A wording the parser could not read is stored as an event but starts no session — an
  // unrecognised camera line is a gap in the record, not a session that never ends.
  await ingestLines(repo, s.id, [`${at(base + 1000)} CAMERA [Mod Jane (76561198000000009)] did something new`]);
  assert.equal((await repo.adminCam.list({ serverId: s.id })).length, 1);
  const logged = (await repo.events.listRecent(s.id, 50)).filter((e) => e.kind === "evt.admin.camera");
  assert.ok(logged.length >= 3, "every camera line is still in the game log, readable or not");
});

test("one failing rollup does not cost the batch its stats", async () => {
  /*
   * The events go in ABOVE the rollup loop, in one statement, and `insertedKeys` is what keeps the
   * stats idempotent — so a throw part-way through that loop is unrecoverable rather than merely
   * inconvenient. Those lines are already marked ingested; the next read dedupes them away and the
   * work never happens. And because the career deltas only flushed after the loop, one hiccup on
   * one player's session write silently dropped every kill, death and minute the WHOLE batch had
   * accumulated.
   */
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });

  // Exactly one transition is broken: opening a session for the player who connects.
  const realOpen = repo.sessions.open.bind(repo.sessions);
  let broke = 0;
  repo.sessions.open = async () => { broke += 1; throw new Error("sessions table is having a moment"); };

  const lines = [
    "[1.0 sec (1784770000)] MATCH START Foy Warfare",
    "[1.0 sec (1784770100)] KILL: Ally(Allies/76561198000000101) -> Foe(Axis/76561198000000102) with M1 GARAND",
    "[1.0 sec (1784770200)] CONNECTED Ally (76561198000000101)",
    "[1.0 sec (1784770300)] KILL: Ally(Allies/76561198000000101) -> Foe(Axis/76561198000000102) with M1 GARAND",
  ];

  // The caller still hears about it — silence would be the other way to lose the information.
  await assert.rejects(
    () => ingestLines(repo, s.id, lines, undefined, "hll"),
    /failed to update their rollups.*sessions table is having a moment/s,
    "the failure is reported, naming what broke",
  );
  assert.equal(broke, 1, "only the one transition was attempted and failed");
  repo.sessions.open = realOpen;

  // …and everything either side of it landed anyway. Both kills count, on the career rollup and
  // on the round's scoreboard, which is the whole point: they were charged for, so they must be
  // counted, because nothing will ever offer them again.
  const ally = (await repo.players.list()).find((p) => p.name === "Ally")!;
  const foe = (await repo.players.list()).find((p) => p.name === "Foe")!;
  assert.equal((await repo.stats.get(ally.id))?.kills, 2, "both kills survived the failed session write");
  assert.equal((await repo.stats.get(foe.id))?.deaths, 2, "and both deaths did");

  const matches = await repo.matches.list(s.id);
  assert.equal(matches.length, 1, "the round still opened");
  const board = await repo.matches.statsForMatch(matches[0]!.id);
  assert.equal(board.find((b) => b.playerId === ally.id)?.kills, 2, "the round scoreboard is complete too");

  // The events themselves are stored, so a retry would dedupe them away — which is exactly why
  // the rollups had to be applied on this pass rather than left for one.
  assert.equal(await ingestLines(repo, s.id, lines, undefined, "hll"), 0, "a replay adds nothing");
});
