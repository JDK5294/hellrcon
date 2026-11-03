/**
 * The plays-left countdown on a saved Vietnam layout — the decision half, held to its own rules
 * (layout-expiry.ts spells them out): one round never counts twice, the round already running at
 * save time never counts at all, other maps' rounds don't touch the row, a zero on an observe
 * server waits, and a zero left behind by a failed clear is offered again. Then the tick itself, on
 * the in-memory store and a fake game: it clears once, and keeps a refused clear for the next tick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import { planLayoutExpiryTick, runLayoutExpiryTick, type LayoutExpiryClient, type LayoutExpiryDeps } from "../dist/layout-expiry.js";
import type { ObjectiveLayoutExpiryRow, ServerRow } from "@app/db";

const row = (over: Partial<ObjectiveLayoutExpiryRow> = {}): ObjectiveLayoutExpiryRow => ({
  serverId: "s1", mapId: "vantuong_warfare", playsLeft: 2, lastMatchId: "m0", setBy: "owner",
  updatedAt: new Date().toISOString(), ...over,
});
const server = (mode: "active" | "observe" = "active"): ServerRow =>
  ({ id: "s1", name: "NAM", game: "hllv", engagementMode: mode } as unknown as ServerRow);

test("a new round of the map counts once; the save-time round and other maps never do", () => {
  // The round open at save time (m0) is pinned as lastMatchId — same tick, nothing moves.
  let t = planLayoutExpiryTick([row()], { serverOf: () => server(), openMatchOf: () => ({ id: "m0", map: "vantuong_warfare" }) });
  assert.deepEqual([t.counted.length, t.clears.length, t.orphans.length], [0, 0, 0]);

  // Another map's round: not a play of this layout's map.
  t = planLayoutExpiryTick([row()], { serverOf: () => server(), openMatchOf: () => ({ id: "m1", map: "quangngai_warfare" }) });
  assert.equal(t.counted.length, 0);

  // A NEW round of the map, spelled the way match rows really are — the admin log's DISPLAY
  // text, accents and all — while the expiry row holds the session's map id. The compare is by
  // family, because a literal compare here matched nothing real and never counted a play.
  t = planLayoutExpiryTick([row()], { serverOf: () => server(), openMatchOf: () => ({ id: "m1", map: "V\u1ea1n T\u01b0\u1eddng WARFARE" }) });
  assert.equal(t.counted.length, 1);
  assert.equal(t.counted[0]!.playsLeft, 1);
  assert.equal(t.counted[0]!.lastMatchId, "m1");
  assert.equal(t.clears.length, 0, "one play still remains — nothing to clear");

  // The same round seen on the next tick: already counted.
  t = planLayoutExpiryTick([row({ playsLeft: 1, lastMatchId: "m1" })], { serverOf: () => server(), openMatchOf: () => ({ id: "m1", map: "vantuong_warfare" }) });
  assert.equal(t.counted.length, 0);
});

test("the Nth play clears DURING that round; observe holds it; a failed clear is offered again", () => {
  // Last play begins: count to zero AND clear now — the running round already took the layout.
  let t = planLayoutExpiryTick([row({ playsLeft: 1, lastMatchId: "m1" })], { serverOf: () => server(), openMatchOf: () => ({ id: "m2", map: "VAN TUONG Warfare" }) });
  assert.equal(t.counted[0]?.playsLeft, 0);
  assert.equal(t.clears.length, 1);

  // The same moment on an observe server: the count advances (the round really happened), but a
  // read-only server is never written to.
  t = planLayoutExpiryTick([row({ playsLeft: 1, lastMatchId: "m1" })], { serverOf: () => server("observe"), openMatchOf: () => ({ id: "m2", map: "vantuong_warfare" }) });
  assert.equal(t.counted[0]?.playsLeft, 0);
  assert.equal(t.clears.length, 0, "observe holds the clear");

  // A zero left behind (failed clear, or observe at the time): due again with no new round.
  t = planLayoutExpiryTick([row({ playsLeft: 0, lastMatchId: "m2" })], { serverOf: () => server(), openMatchOf: () => null });
  assert.equal(t.clears.length, 1, "a refusal is a retry, not a loss");
  assert.equal(t.counted.length, 0);

  // A row whose server is gone: dropped quietly.
  t = planLayoutExpiryTick([row()], { serverOf: () => null, openMatchOf: () => null });
  assert.equal(t.orphans.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The tick, on the in-memory store and a fake Vietnam game
// ---------------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
type Entry = { mapId: string; sectors: number[] };

/** One Vietnam game server: the stored layouts and every command sent, shared by every client. */
function vietnamGame(entries: Entry[], fail: Record<string, string> = {}) {
  const g = { entries, fail, calls: [] as { cmd: string; params: Record<string, unknown> }[] };
  const client: LayoutExpiryClient = {
    connect: async () => {},
    disconnect: async () => {},
    execute: async (cmd, params = {}) => {
      g.calls.push({ cmd, params });
      if (g.fail[cmd]) throw new Error(g.fail[cmd]);
      if (cmd === "getObjectives") return { entries: g.entries.map((e) => ({ mapId: e.mapId, sectors: [...e.sectors] })) };
      if (cmd === "setSectorLayout") {
        const sectors = [1, 2, 3, 4, 5].map((n) => Number(params[`sector${n}Index`]));
        g.entries = [...g.entries.filter((e) => e.mapId !== params.mapId), { mapId: String(params.mapId), sectors }];
      }
      if (cmd === "removeSectorLayout") g.entries = g.entries.filter((e) => e.mapId !== params.mapId);
      return {};
    },
  };
  return { g, client };
}

async function namWorld() {
  const repo = new InMemoryRepository();
  const created = await repo.servers.create({ name: "Nam #1", game: "hllv", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(created.id, "active");
  const sv = (await repo.servers.findById(created.id))!;
  const now = Date.now();
  const baseline = await repo.matches.open({ serverId: sv.id, map: "Quang Ngai Warfare", startedAt: iso(now - 30 * 60_000) });
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) };
  const deps = (client: LayoutExpiryClient): LayoutExpiryDeps => ({ repo, clientFor: () => client, log });
  return { repo, sv, now, baseline, logs, log, deps };
}

const R0 = [0, 1, 0, 1, 0];

test("the tick clears a countdown at zero once, and keeps it on a refusal", async () => {
  const w = await namWorld();
  await w.repo.layoutExpiries.set({ serverId: w.sv.id, mapId: "WDEV_A", playsLeft: 0, lastMatchId: w.baseline.id, setBy: "Staff" });
  const refusing = vietnamGame([{ mapId: "WDEV_A", sectors: R0 }], { removeSectorLayout: "connection reset" });
  await runLayoutExpiryTick(w.deps(refusing.client));
  assert.ok(await w.repo.layoutExpiries.get(w.sv.id, "WDEV_A"), "a refusal is a retry, not a loss");
  assert.equal(w.logs.filter((l) => l.startsWith("warn:layout expiry could not clear")).length, 1);

  const game = vietnamGame([{ mapId: "WDEV_A", sectors: R0 }]);
  await runLayoutExpiryTick(w.deps(game.client));
  assert.deepEqual(game.g.calls.map((c) => [c.cmd, c.params]), [["removeSectorLayout", { mapId: "WDEV_A" }]]);
  assert.deepEqual(game.g.entries, []);
  assert.equal(await w.repo.layoutExpiries.get(w.sv.id, "WDEV_A"), null);
  const audits = (await w.repo.audit.list({ actions: ["map.objectives"] })).filter((a) => a.actorName === "layout expiry");
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!.data, { mapId: "WDEV_A", cleared: true, auto: true, setBy: "Staff" });
});
