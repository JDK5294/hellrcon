/**
 * The expired-VIP sweep's decisions.
 *
 * The one that matters: a grant can reach its expiry while PAUSED, because a running-mode pause
 * lets the clock keep running on purpose. Pausing already took the VIP out of the game, so the
 * sweep's RemoveVip has nothing to remove — and the row used to be cleared only if that call
 * succeeded, so where the game answers "not a VIP" with an error the grant outlived its own
 * expiry forever, retried and warned about on every tick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planVipExpiry, pausedOffTheGame, readVipExpiryPlan } from "../src/vip-expiry.ts";
import { InMemoryRepository } from "@app/db";
import type { ServerRow, VipRow } from "@app/db";

function vip(p: Partial<VipRow>): VipRow {
  return {
    serverId: "s1", playerId: "765", playerName: "Someone", comment: null,
    expiration: "2026-08-01T00:00:00.000Z",
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null,
    createdByUserId: null, createdByName: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...p,
  } as VipRow;
}
function server(p: Partial<ServerRow>): ServerRow {
  return { id: "s1", name: "Server 1", engagementMode: "active", automation: null, ...p } as ServerRow;
}
const world = (...list: ServerRow[]) => new Map(list.map((s) => [s.id, s]));

test("a paused grant is already off the game, so a refusal must not block its row", () => {
  assert.equal(pausedOffTheGame(vip({ pausedUntil: "2026-09-01T00:00:00.000Z" })), true);
  // A pause that has lapsed still counts: the resume clears `pausedUntil` only when it has
  // actually put the VIP back, and it runs AFTER this sweep in the same tick.
  assert.equal(pausedOffTheGame(vip({ pausedUntil: "2026-07-01T00:00:00.000Z" })), true);
  assert.equal(pausedOffTheGame(vip({ pausedUntil: null })), false);

  const plan = planVipExpiry(
    [vip({ playerId: "a" }), vip({ playerId: "b", pausedUntil: "2026-09-01T00:00:00.000Z" })],
    world(server({})),
  );
  assert.equal(plan.work.length, 1);
  assert.deepEqual(
    plan.work[0]!.rows.map((r) => [r.row.playerId, r.gameMayStillHoldIt]),
    [["a", true], ["b", false]],
  );
});

test("a grant whose server is gone is simply dropped, and never grouped for a connection", () => {
  const plan = planVipExpiry([vip({ serverId: "vanished" }), vip({ playerId: "b" })], world(server({})));
  assert.deepEqual(plan.orphans.map((v) => v.serverId), ["vanished"]);
  assert.deepEqual(plan.work.map((w) => w.serverId), ["s1"]);
  assert.deepEqual(plan.skipped, []);
});

test("observe servers and switched-off sweeps are left alone, with the reason named", () => {
  const plan = planVipExpiry(
    [vip({ serverId: "obs" }), vip({ serverId: "off" }), vip({ serverId: "s1" })],
    world(
      server({ id: "obs", engagementMode: "observe" }),
      server({ id: "off", automation: { vipSweep: false } }),
      server({ id: "s1" }),
    ),
  );
  assert.deepEqual(plan.work.map((w) => w.serverId), ["s1"]);
  assert.deepEqual(
    [...plan.skipped].sort((a, b) => a.serverId.localeCompare(b.serverId)),
    [{ serverId: "obs", reason: "observe" }, { serverId: "off", reason: "sweep-off" }],
  );
});

test("rows are grouped so each server is connected to once", () => {
  const plan = planVipExpiry(
    [vip({ playerId: "a" }), vip({ serverId: "s2", playerId: "b" }), vip({ playerId: "c" })],
    world(server({}), server({ id: "s2", name: "Server 2" })),
  );
  assert.deepEqual(plan.work.map((w) => [w.serverId, w.rows.length]), [["s1", 2], ["s2", 1]]);
});

test("a RETIRED server's expired grants wait for it, rows and all — only a deleted server's are orphans", () => {
  const plan = planVipExpiry(
    [vip({ serverId: "old", playerId: "a" }), vip({ serverId: "gone", playerId: "b" }), vip({ playerId: "c" })],
    world(server({ id: "old", retiredAt: "2026-07-15T00:00:00.000Z" } as Partial<ServerRow>), server({})),
  );
  assert.deepEqual(plan.orphans.map((v) => v.serverId), ["gone"]);
  assert.deepEqual(plan.work.map((w) => w.serverId), ["s1"], "a retired server is not dialled");
  assert.deepEqual(plan.skipped, [{ serverId: "old", reason: "retired" }]);
});

test("the sweep's read sees retired servers, so retiring a server leaves its VIP rows alone", async () => {
  // Retiring is reversible. The sweep used to plan against servers.list(), which leaves retired
  // servers out, so their expired grants read as orphans: rows deleted, the game never told. A
  // server brought back then kept those VIPs on the game, with nothing left to take them off.
  const repo = new InMemoryRepository();
  const old = await repo.servers.create({ name: "Old", host: "10.0.0.1", port: 1, password: "x" });
  await repo.vips.upsert({ serverId: old.id, playerId: "76561198000000001", playerName: "Ana", expiration: "2026-08-01T00:00:00.000Z", createdByName: "staff" });
  await repo.servers.setRetired(old.id, true);
  const read = await readVipExpiryPlan(repo, "2026-09-01T00:00:00.000Z");
  assert.ok(read, "the grant has expired");
  assert.deepEqual(read.plan.orphans, [], "not an orphan: the server still exists");
  assert.deepEqual(read.plan.skipped, [{ serverId: old.id, reason: "retired" }]);
  assert.equal(await readVipExpiryPlan(repo, "2026-07-01T00:00:00.000Z"), null, "nothing expired yet, nothing planned");
});
