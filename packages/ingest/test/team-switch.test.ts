import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import { ingestLines } from "../dist/index.js";

/*
 * The owner's case: a player swapping sides mid-round to find the other team's garrisons. The game
 * writes each change as a TEAMSWITCH line with Unassigned between the sides and no player id, so
 * ingest links the line to its player by name and reads the join that lands on the other side as
 * the swap.
 */
const T0 = 1784760000;
const at = (sec: number, body: string) => `[1.0 sec (${T0 + sec})] ${body}`;
const BOB = "76561198000000101";
const switches = async (repo: InMemoryRepository, server = "s1") =>
  (await repo.events.listRecent(server, 200)).filter((e) => e.kind === "evt.player.teamSwitched").sort((a, b) => a.ts.localeCompare(b.ts) || (a.dedupeKey ?? "").localeCompare(b.dedupeKey ?? ""));

test("a switch in the same batch as the player's id-bearing line is filed under that player — and reaches his profile", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [
    at(0, "MATCH START Carentan Warfare"),
    at(5, `CONNECTED Bob (${BOB})`),
    at(6, "TEAMSWITCH Bob (None > Allies)"),
  ]);
  const bob = (await repo.players.findByPlatformId(BOB))!;
  const [sw] = await switches(repo);
  assert.equal(sw!.actorPlayerId, bob.id);
  assert.deepEqual(sw!.data, { from: "None", to: "Allies", change: "joined Allies" });
  const profile = await repo.events.listByPlayer(bob.id, 50);
  assert.ok(profile.some((e) => e.kind === "evt.player.teamSwitched"), "on his profile at last");
});

test("a switch alone in its batch is linked through the player on the server under that name", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${BOB})`)]);
  await ingestLines(repo, "s1", [at(60, "TEAMSWITCH Bob (None > Allies)")]);
  const bob = (await repo.players.findByPlatformId(BOB))!;
  assert.equal((await switches(repo))[0]!.actorPlayerId, bob.id);
});

test("a name more than one player answers to is never guessed", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [
    at(5, `CONNECTED Player (${BOB})`),
    at(5, "CONNECTED Player (76561198000000102)"),
    at(9, "TEAMSWITCH Player (None > Axis)"),
  ]);
  assert.equal((await switches(repo))[0]!.actorPlayerId, null, "unlinked beats filed under the wrong person");
  // …and the online list does not get to pick one of them either, in a later batch.
  await ingestLines(repo, "s1", [at(30, "TEAMSWITCH Player (Axis > None)")]);
  assert.ok((await switches(repo)).every((e) => e.actorPlayerId === null));
});

test("a swap whose two lines land in different polls — delivered newest first in the same second — is read as one swap", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${BOB})`), at(6, "TEAMSWITCH Bob (None > Allies)")]);
  // The next poll: Allies → Unassigned → Axis within one second, newest first (as CRCON serves it).
  await ingestLines(repo, "s1", [at(300, "TEAMSWITCH Bob (None > Axis)"), at(300, "TEAMSWITCH Bob (Allies > None)")]);
  const rows = await switches(repo);
  const join = rows.find((e) => (e.data as any)?.to === "Axis")!;
  assert.deepEqual(join.data, { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
  assert.equal((rows.find((e) => (e.data as any)?.from === "Allies")!.data as any).change, "left Allies");

  // A second swap back counts on; dropping to Unassigned and returning to the same side does not.
  await ingestLines(repo, "s1", [at(400, "TEAMSWITCH Bob (Axis > None)")]);
  await ingestLines(repo, "s1", [at(401, "TEAMSWITCH Bob (None > Allies)")]);
  await ingestLines(repo, "s1", [at(500, "TEAMSWITCH Bob (Allies > None)"), at(501, "TEAMSWITCH Bob (None > Allies)")]);
  const after = (await switches(repo)).filter((e) => (e.data as any)?.swapFrom);
  assert.deepEqual(after.map((e) => [(e.data as any).change, (e.data as any).swapCount]), [["switched sides Allies → Axis", 1], ["switched sides Axis → Allies", 2]]);
});

test("a new round starts the count again — in a later batch and inside the same one", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [
    at(0, "MATCH START Carentan Warfare"),
    at(5, "TEAMSWITCH Bob (None > Allies)"),
    at(10, "TEAMSWITCH Bob (Allies > None)"),
    at(11, "TEAMSWITCH Bob (None > Axis)"),
    at(3600, "MATCH ENDED `Carentan Warfare` ALLIED (5 - 0) AXIS"),
    at(3700, "MATCH START Foy Warfare"),
    at(3705, "TEAMSWITCH Bob (None > Allies)"),
  ]);
  const rows = await switches(repo);
  assert.equal((rows.at(-1)!.data as any).change, "joined Allies", "last round's side is not this round's");
  await ingestLines(repo, "s1", [at(3800, "TEAMSWITCH Bob (Allies > None)"), at(3801, "TEAMSWITCH Bob (None > Axis)")]);
  assert.equal(((await switches(repo)).at(-1)!.data as any).swapCount, 1, "the first swap of the new round");
});

test("reading the same window twice stores nothing new and counts nothing twice", async () => {
  const repo = new InMemoryRepository();
  const window = [at(0, "MATCH START Carentan Warfare"), at(6, "TEAMSWITCH Bob (None > Allies)"), at(9, "TEAMSWITCH Bob (Allies > None)"), at(9, "TEAMSWITCH Bob (None > Axis)")];
  assert.equal(await ingestLines(repo, "s1", window), 4);
  const first = (await switches(repo)).map((e) => e.data);
  assert.equal(await ingestLines(repo, "s1", window), 0);
  assert.deepEqual((await switches(repo)).map((e) => e.data), first);
  // A later swap still counts as the second, not the third.
  await ingestLines(repo, "s1", [...window, at(20, "TEAMSWITCH Bob (Axis > None)"), at(20, "TEAMSWITCH Bob (None > Allies)")]);
  assert.equal(((await switches(repo)).at(-1)!.data as any).swapCount, 2);
});

test("a lookup that fails costs nothing but the link and the round's reading — the batch is stored, a warning raised, nothing thrown", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${BOB})`)]);
  const realQuery = repo.events.query;
  const realOnline = repo.sessions.openOnServer;
  repo.events.query = async () => { throw new Error("db hiccup"); };
  repo.sessions.openOnServer = async () => { throw new Error("db hiccup"); };
  const warnings: string[] = [];
  const published: string[] = [];
  try {
    const n = await ingestLines(repo, "s1", [at(60, "TEAMSWITCH Bob (Allies > None)"), at(61, "KILL: Al(Allies/76561198000000201) -> Ze(Axis/76561198000000202) with M1 GARAND")], (e) => published.push(e.kind), "hll", (w) => warnings.push(w));
    assert.equal(n, 2);
  } finally {
    repo.events.query = realQuery;
    repo.sessions.openOnServer = realOnline;
  }
  assert.ok(warnings.some((w) => /team switches could not be/.test(w)), "reported for the log");
  assert.deepEqual(published, ["evt.player.teamSwitched", "evt.kill"], "and the batch went on to the bus as ever — its rewards and announcements with it");
  const rows = await switches(repo);
  assert.equal(rows.length, 1, "stored all the same");
  assert.deepEqual(rows[0]!.data, { from: "Allies", to: "None", change: "left Allies" }, "as the parser described it");
  assert.equal(rows[0]!.actorPlayerId, null, "unknown who else is on under the name: no link");
  assert.ok((await repo.events.listRecent("s1", 50)).some((e) => e.kind === "evt.kill"), "and the rest of the batch with it");
});

test("a kill by one Bob does not file another Bob's swap under him — every player the name could mean counts", async () => {
  const repo = new InMemoryRepository();
  const A = BOB, B = "76561198000000102";
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${A})`), at(6, `CONNECTED Bob (${B})`)]);
  // A kills somebody while B swaps, all in one poll.
  await ingestLines(repo, "s1", [
    at(100, `KILL: Bob(Allies/${A}) -> Ze(Axis/76561198000000202) with M1 GARAND`),
    at(101, "TEAMSWITCH Bob (Axis > None)"),
    at(102, "TEAMSWITCH Bob (None > Allies)"),
  ]);
  assert.ok((await switches(repo)).every((e) => e.actorPlayerId === null), "two players answer to Bob — neither is guessed");
  assert.equal(((await switches(repo)).at(-1)!.data as any).change, "joined Allies", "nor read as a swap: the leave may be the other Bob's");
  // Once B has gone, the kill's Bob is the only one: linked.
  await ingestLines(repo, "s1", [at(200, `DISCONNECTED Bob (${B})`)]);
  await ingestLines(repo, "s1", [at(300, `KILL: Bob(Allies/${A}) -> Ze(Axis/76561198000000202) with M1 GARAND`), at(301, "TEAMSWITCH Bob (Allies > None)")]);
  const a = (await repo.players.findByPlatformId(A))!;
  assert.equal((await switches(repo)).at(-1)!.actorPlayerId, a.id);
});

test("two players online under one name: each one's join is read on its own, never as a swap off the other's side", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${BOB})`), at(6, "CONNECTED Bob (76561198000000102)")]);
  await ingestLines(repo, "s1", [at(10, "TEAMSWITCH Bob (None > Allies)")]);
  await ingestLines(repo, "s1", [at(20, "TEAMSWITCH Bob (None > Axis)")]);
  // …and inside one poll: one Bob leaves Axis as the other joins Allies, in the same second.
  await ingestLines(repo, "s1", [at(30, "TEAMSWITCH Bob (Axis > None)"), at(30, "TEAMSWITCH Bob (None > Allies)")]);
  const rows = await switches(repo);
  assert.ok(rows.every((e) => !(e.data as any).swapFrom), JSON.stringify(rows.map((e) => (e.data as any).change)));
});

test("another player under the same name never inherits a side — no swap read off somebody else's team", async () => {
  const repo = new InMemoryRepository();
  const A = BOB, B = "76561198000000102";
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, `CONNECTED Bob (${A})`), at(6, "TEAMSWITCH Bob (None > Allies)")]);
  await ingestLines(repo, "s1", [at(100, `DISCONNECTED Bob (${A})`)]);
  await ingestLines(repo, "s1", [at(200, `CONNECTED Bob (${B})`), at(201, "TEAMSWITCH Bob (None > Axis)")]);
  const last = (await switches(repo)).at(-1)!;
  assert.equal(last.actorPlayerId, (await repo.players.findByPlatformId(B))!.id);
  assert.deepEqual(last.data, { from: "None", to: "Axis", change: "joined Axis" }, "his first pick, not a swap");
  // And the same player under a new name is still the same player: his swap is not missed.
  await ingestLines(repo, "s1", [at(300, "TEAMSWITCH Bob (Axis > None)")]);
  await ingestLines(repo, "s1", [at(400, `DISCONNECTED Bob (${B})`), at(401, `CONNECTED Bobby (${B})`), at(402, "TEAMSWITCH Bobby (None > Allies)")]);
  assert.equal(((await switches(repo)).at(-1)!.data as any).change, "switched sides Axis → Allies");
});

test("a round whose start was missed is not read as the last one — an open match from yesterday counts for nothing", async () => {
  const repo = new InMemoryRepository();
  const DAY = 86_400;
  await ingestLines(repo, "s1", [at(-DAY, "MATCH START Foy Warfare"), at(-DAY + 5, `CONNECTED Bob (${BOB})`), at(-DAY + 6, "TEAMSWITCH Bob (None > Allies)")]);
  // The poller was down across the map change: today's MATCH START never arrived, yesterday's match is still open.
  assert.ok(await repo.matches.getOpen("s1"));
  await ingestLines(repo, "s1", [at(-DAY + 600, `DISCONNECTED Bob (${BOB})`)]);
  await ingestLines(repo, "s1", [at(5, `CONNECTED Bob (${BOB})`), at(6, "TEAMSWITCH Bob (None > Axis)")]);
  assert.deepEqual((await switches(repo)).at(-1)!.data, { from: "None", to: "Axis", change: "joined Axis" });
});

test("a match end splits the round the same whether it shares a poll with the next switch or not", async () => {
  const one = new InMemoryRepository();
  await ingestLines(one, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, "TEAMSWITCH Bob (None > Allies)"), at(10, "TEAMSWITCH Bob (Allies > None)")]);
  await ingestLines(one, "s1", [at(3600, "MATCH ENDED `Carentan Warfare` ALLIED (5 - 0) AXIS"), at(3630, "TEAMSWITCH Bob (None > Axis)")]);
  const two = new InMemoryRepository();
  await ingestLines(two, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, "TEAMSWITCH Bob (None > Allies)"), at(10, "TEAMSWITCH Bob (Allies > None)")]);
  await ingestLines(two, "s1", [at(3600, "MATCH ENDED `Carentan Warfare` ALLIED (5 - 0) AXIS")]);
  await ingestLines(two, "s1", [at(3630, "TEAMSWITCH Bob (None > Axis)")]);
  assert.deepEqual((await switches(one)).at(-1)!.data, { from: "None", to: "Axis", change: "joined Axis" });
  assert.deepEqual((await switches(two)).at(-1)!.data, (await switches(one)).at(-1)!.data);
});

test("a swap delivered newest first is stored and published in the game's order — the leave before the join", async () => {
  const repo = new InMemoryRepository();
  const published: string[] = [];
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare"), at(5, "TEAMSWITCH Bob (None > Allies)")]);
  await ingestLines(repo, "s1", [at(300, "TEAMSWITCH Bob (None > Axis)"), at(300, "TEAMSWITCH Bob (Allies > None)")], (e) => published.push(String((e.data as any)?.change)));
  assert.deepEqual(published, ["left Allies", "switched sides Allies → Axis"]);
});

test("switches stored before the teams were kept are still read for the round, off their original line", async () => {
  const repo = new InMemoryRepository();
  await ingestLines(repo, "s1", [at(0, "MATCH START Carentan Warfare")]);
  // A row as the old ingest stored it: no data, the line's text only in its key.
  await repo.events.insert([{ serverId: "s1", ts: new Date((T0 + 10) * 1000).toISOString(), kind: "evt.player.teamSwitched", actorPlayerId: null, actorName: "Bob", victimPlayerId: null, victimName: null, weapon: null, data: null, dedupeKey: `${T0 + 10}|TEAMSWITCH Bob (None > Allies)` }]);
  await ingestLines(repo, "s1", [at(100, "TEAMSWITCH Bob (Allies > None)"), at(101, "TEAMSWITCH Bob (None > Axis)")]);
  assert.equal(((await switches(repo)).at(-1)!.data as any).change, "switched sides Allies → Axis");
});
