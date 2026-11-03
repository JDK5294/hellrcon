/**
 * The sweeps in server-sweeps.ts against a real in-memory store and a fake game, each run over a
 * live server and a RETIRED one side by side.
 *
 * Retiring promises the server disappears from every worker with nothing deleted, and it can be
 * undone. These sweeps looked their server up by id, which still finds a retired one, so they kept
 * dialing it: console admins whose time was up came off its game, a lapsed VIP pause went back on
 * it, and an event opening replaced its rotation. The live server in each test is the control —
 * it shows the sweep does run and that the fake game hears it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import type { ServerRow } from "@app/db";
import type { Logger } from "@app/shared";
import { applyEventRotations, resumeLapsedVipPauses, sweepExpiredConsoleAdmins, type ServerSweepDeps, type SweepGameClient } from "../src/server-sweeps.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A fake game per server: who was dialed, and every command each one was sent. */
function fakeGame(rotation: string[] = []) {
  const dialed: string[] = [];
  const sent: { serverId: string; command: string }[] = [];
  const clientFor = (server: ServerRow): SweepGameClient => ({
    connect: async () => { dialed.push(server.id); },
    execute: async (command) => { sent.push({ serverId: server.id, command }); return {}; },
    readState: async () => rotation,
    disconnect: async () => {},
  });
  return { dialed, sent, clientFor };
}

/** A live server and a retired one, both active, so observe mode cannot be what holds a sweep back. */
async function liveAndRetired(repo: InMemoryRepository) {
  const live = await repo.servers.create({ name: "Live", game: "hll", host: "10.0.0.1", port: 1, password: "x", engagementMode: "active" });
  const old = await repo.servers.create({ name: "Old", game: "hll", host: "10.0.0.2", port: 1, password: "x", engagementMode: "active" });
  await repo.servers.setRetired(old.id, true);
  return { live, old };
}

test("console admins: an expired grant on a retired server is left on its game and in the table", async () => {
  const repo = new InMemoryRepository();
  const { live, old } = await liveAndRetired(repo);
  for (const s of [live, old]) {
    await repo.consoleAdmins.upsert({ serverId: s.id, playerId: "76561198000000001", playerName: "Ana", adminGroup: "junior", expiration: ago(HOUR), createdByName: "staff" });
  }
  const game = fakeGame();
  await sweepExpiredConsoleAdmins({ repo, log: quiet, clientFor: game.clientFor } satisfies ServerSweepDeps);

  assert.deepEqual(game.sent, [{ serverId: live.id, command: "removeAdmin" }], "only the live server's game is told");
  assert.deepEqual(game.dialed, [live.id], "the retired server is never dialed");
  assert.equal(await repo.consoleAdmins.get(live.id, "76561198000000001"), null, "the live grant is gone");
  assert.ok(await repo.consoleAdmins.get(old.id, "76561198000000001"), "the retired server's grant waits for it to come back");
});

test("VIP pauses: a lapsed pause on a retired server stays, with the VIP still off the game", async () => {
  const repo = new InMemoryRepository();
  const { live, old } = await liveAndRetired(repo);
  for (const s of [live, old]) {
    await repo.vips.upsert({ serverId: s.id, playerId: "76561198000000002", playerName: "Ben", expiration: ahead(30 * 24 * HOUR), createdByName: "staff" });
    await repo.vips.setPause(s.id, "76561198000000002", { until: ago(HOUR), reason: "teamkilling", by: "staff", mode: "running", at: ago(3 * HOUR) });
  }
  const game = fakeGame();
  await resumeLapsedVipPauses({ repo, log: quiet, clientFor: game.clientFor });

  assert.deepEqual(game.sent, [{ serverId: live.id, command: "addVip" }], "only the live server gets its VIP back");
  assert.deepEqual(game.dialed, [live.id]);
  assert.equal((await repo.vips.get(live.id, "76561198000000002"))?.pausedUntil, null, "the live pause is over");
  assert.ok((await repo.vips.get(old.id, "76561198000000002"))?.pausedUntil, "the retired server's pause is kept, to run out when it is back");
});

test("event rotations: an event opening on a retired server leaves its rotation, and does not latch", async () => {
  const repo = new InMemoryRepository();
  const { live, old } = await liveAndRetired(repo);
  const set = await repo.mapSets.create({ name: "Event night", game: "hll", pool: { sequence: ["foy_warfare", "kursk_warfare"] } });
  const ids: Record<string, string> = {};
  for (const s of [live, old]) {
    const ev = await repo.payoutEvents.create({
      name: `Event on ${s.name}`, serverId: s.id, openMode: "at", openAnchor: ago(HOUR), closeMode: "at", closeAnchor: ahead(HOUR),
      minMinutes: 0, mapVoteProfile: null, rotationSetId: set.id, createdBy: "staff",
    });
    await repo.payoutEvents.applyTransition(ev.id, { openedAt: ago(HOUR) });
    ids[s.id] = ev.id;
  }
  const game = fakeGame(["stmariedumont_warfare"]);
  await applyEventRotations({ repo, log: quiet, clientFor: game.clientFor });

  assert.deepEqual(game.dialed, [live.id], "the retired server is never dialed");
  assert.ok(game.sent.length > 0 && game.sent.every((c) => c.serverId === live.id), "only the live rotation is rebuilt");
  const events = await repo.payoutEvents.list();
  assert.ok(events.find((e) => e.id === ids[live.id])?.rotationAppliedAt, "the live event is latched");
  assert.equal(events.find((e) => e.id === ids[old.id])?.rotationAppliedAt, null, "not latched: brought back while open, it still gets its lineup");
  const notes = (await repo.audit.list({ limit: 50 })).filter((a) => a.action === "map.rotation.apply_set");
  assert.deepEqual(notes.map((a) => a.serverId), [live.id], "and no note claims anything about the retired one");
});
