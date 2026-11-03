/**
 * What the removed objective presets left behind (preset-leftovers.ts): a Vietnam row's layout is
 * put back — only while the stored entry is still the preset's — and every row is then forgotten;
 * a WW2 row or one whose server is gone is simply dropped; a retired or read-only server is never
 * written to; and a server that cannot be read keeps its row for the next sweep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPutBack, planUndo, runPresetLeftovers } from "../dist/preset-leftovers.js";
import { QuietFailures } from "../dist/quiet-failure.js";
import type { MapPointPendingRow, Repository, ServerRow } from "@app/db";

const OURS = [2, 1, 0, 2, 1];
const STAFF = [0, 0, 1, 1, 2];
const EARLIER = [1, 2, 1, 2, 1];

// ---- planPutBack: compare before restoring ----

test("put back: still ours → restore what was there, or remove ours when nothing was", () => {
  const entries = [{ mapId: "WDEV_A", sectors: OURS }, { mapId: "WDEV_B", sectors: STAFF }];
  assert.deepEqual(planPutBack({ entries, storedMapId: "WDEV_A", storedIndices: OURS, restore: STAFF }), { action: "restore", sectors: STAFF });
  assert.deepEqual(planPutBack({ entries, storedMapId: "WDEV_A", storedIndices: OURS, restore: null }), { action: "remove" });
  assert.deepEqual(planPutBack({ entries, storedMapId: "wdev_a", storedIndices: OURS, restore: null }), { action: "remove" }, "any casing");
  // A restore that is not five valid indices counts as none (only damaged data gets here).
  assert.deepEqual(planPutBack({ entries, storedMapId: "WDEV_A", storedIndices: OURS, restore: [0, 1] }), { action: "remove" });
});

test("put back: already gone → nothing to undo; staff changed it → left alone; a row missing what it stored never restores blind", () => {
  assert.deepEqual(planPutBack({ entries: [], storedMapId: "WDEV_A", storedIndices: OURS, restore: STAFF }), { action: "none", why: "gone" });
  assert.deepEqual(planPutBack({ entries: [{ mapId: "WDEV_B", sectors: OURS }], storedMapId: "WDEV_A", storedIndices: OURS, restore: null }),
    { action: "none", why: "gone" }, "another map holding the same indices is not ours");
  const changed = [{ mapId: "WDEV_A", sectors: [1, 1, 1, 1, 1] }];
  assert.deepEqual(planPutBack({ entries: changed, storedMapId: "WDEV_A", storedIndices: OURS, restore: STAFF }), { action: "none", why: "changed" });
  assert.deepEqual(planPutBack({ entries: [{ mapId: "WDEV_A", sectors: OURS }], storedMapId: null, storedIndices: OURS, restore: STAFF }), { action: "none", why: "gone" });
  assert.deepEqual(planPutBack({ entries: [{ mapId: "WDEV_A", sectors: OURS }], storedMapId: "WDEV_A", storedIndices: null, restore: STAFF }), { action: "none", why: "changed" });
});

test("undo: a carried list still standing is ours too — never mistaken for a staff layout", () => {
  const row = { storedMapId: "WDEV_A", storedIndices: OURS, restore: STAFF };
  const entries = [{ mapId: "wdev_a", sectors: EARLIER }];
  assert.deepEqual(planPutBack({ entries, ...row }), { action: "none", why: "changed" }, "the single-list compare alone");
  assert.deepEqual(planUndo(entries, row, [EARLIER]), { action: "restore", sectors: STAFF });
  assert.deepEqual(planUndo(entries, { ...row, restore: null }, [EARLIER]), { action: "remove" });
  assert.deepEqual(planUndo(entries, row, [null, [0, 0, 0, 0, 0], EARLIER]), { action: "restore", sectors: STAFF }, "a null list is skipped");
  assert.deepEqual(planUndo([{ mapId: "WDEV_A", sectors: OURS }], row, [EARLIER]), { action: "restore", sectors: STAFF }, "its own list first");
});

// ---- the sweep ----

const server = (id: string, over: Partial<ServerRow> = {}): ServerRow =>
  ({ id, name: id, game: "hllv", engagementMode: "active", retiredAt: null, ...over } as unknown as ServerRow);

const row = (serverId: string, over: Partial<MapPointPendingRow> = {}): MapPointPendingRow => ({
  serverId, id: `row-${serverId}`, game: "hllv", mapKey: "vantuong", modeKey: "warfare", mapId: "vantuong_warfare_day",
  beforeMapId: null, phase: "armed", picks: [], storedMapId: "WDEV_A", storedIndices: OURS, carriedIndices: null, restore: STAFF,
  baselineMatchId: null, requestedBy: "Owner", requestedAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-01T10:20:00.000Z",
  claimedAt: null, ...over,
});

/** A store holding `rows`, the servers listed, and a game per server whose stored list is `stored`. */
function world(rows: MapPointPendingRow[], servers: ServerRow[], stored: Record<string, unknown>) {
  const pending = new Map(rows.map((r) => [r.serverId, r]));
  const sent: { serverId: string; command: string; params?: Record<string, unknown> }[] = [];
  const dialed: string[] = [];
  const warned: string[] = [];
  const repo = {
    mapPointPending: {
      list: async () => [...pending.values()].map((r) => structuredClone(r)),
      take: async (serverId: string, id: string) => {
        const cur = pending.get(serverId);
        if (!cur || cur.id !== id) return null;
        pending.delete(serverId);
        return cur;
      },
    },
    servers: { list: async (opts?: { includeRetired?: boolean }) => (opts?.includeRetired ? servers : servers.filter((s) => !s.retiredAt)) },
  } as unknown as Repository;
  const deps = {
    repo,
    now: () => Date.now(),
    failures: new QuietFailures(),
    log: { info: () => {}, warn: (m: string) => { warned.push(m); } },
    clientFor: (s: ServerRow) => ({
      connect: async () => { dialed.push(s.id); },
      execute: async (command: string, params?: Record<string, unknown>) => {
        sent.push({ serverId: s.id, command, params });
        if (command === "getObjectives") {
          const answer = stored[s.id];
          if (answer instanceof Error) throw answer;
          return answer;
        }
        return {};
      },
      disconnect: async () => {},
    }),
  };
  const writes = () => sent.filter((c) => c.command !== "getObjectives");
  return { deps, pending, sent, writes, dialed, warned };
}

test("a Vietnam leftover puts back the layout from before, or removes the preset — then the row is forgotten", async () => {
  const w = world(
    [row("s1"), row("s2", { restore: null }), row("s3"), row("s4", { storedIndices: [0, 0, 0, 0, 0], carriedIndices: EARLIER })],
    [server("s1"), server("s2"), server("s3"), server("s4")],
    {
      s1: { entries: [{ mapId: "WDEV_A", sectors: OURS }] },
      s2: { Entries: [{ MapId: "wdev_a", Sectors: OURS }] },
      s3: { entries: [{ mapId: "WDEV_A", sectors: [1, 1, 1, 1, 1] }] }, // staff stored their own since
      s4: { entries: [{ mapId: "WDEV_A", sectors: EARLIER }] },       // the carried press's layout stands
    });
  assert.equal(await runPresetLeftovers(w.deps), false, "there was work this sweep");
  assert.deepEqual(w.writes(), [
    { serverId: "s1", command: "setSectorLayout", params: { mapId: "WDEV_A", sector1Index: 0, sector2Index: 0, sector3Index: 1, sector4Index: 1, sector5Index: 2 } },
    { serverId: "s2", command: "removeSectorLayout", params: { mapId: "wdev_a" } },
    { serverId: "s4", command: "setSectorLayout", params: { mapId: "WDEV_A", sector1Index: 0, sector2Index: 0, sector3Index: 1, sector4Index: 1, sector5Index: 2 } },
  ], "restored or removed under the spelling the game listed; a staff layout is left alone");
  assert.equal(w.pending.size, 0, "every row is done with, the staff-changed one included");
  assert.equal(await runPresetLeftovers(w.deps), true, "and the next sweep finds nothing left");
});

test("WW2 rows and rows whose server is gone are dropped without dialing; retired and read-only servers keep theirs untouched", async () => {
  const w = world(
    [row("ww2", { phase: "await_load", game: "hll" }), row("gone"), row("old"), row("ro")],
    [server("ww2", { game: "hll" }), server("old", { retiredAt: "2026-10-01T00:00:00.000Z" }), server("ro", { engagementMode: "observe" })],
    {});
  assert.equal(await runPresetLeftovers(w.deps), false);
  assert.deepEqual(w.dialed, [], "nothing to undo for a WW2 press, no server to undo it on, and no writes to a retired or read-only one");
  assert.deepEqual([...w.pending.keys()].sort(), ["old", "ro"], "the put-backs still owed wait for their servers");
});

test("a server whose stored layouts cannot be read keeps its row, warned once, and is finished on a later sweep", async () => {
  const stored: Record<string, unknown> = { s1: new Error("connection reset") };
  const w = world([row("s1")], [server("s1")], stored);
  await runPresetLeftovers(w.deps);
  stored.s1 = { unexpected: true }; // read, but not a list: a retry, never "nothing stored"
  await runPresetLeftovers(w.deps);
  assert.equal(w.pending.size, 1, "the row is the only record of what to undo");
  assert.deepEqual(w.writes(), []);
  assert.equal(w.warned.length, 1, "one warning, not one a sweep");
  stored.s1 = { entries: [{ mapId: "WDEV_A", sectors: OURS }] };
  await runPresetLeftovers(w.deps);
  assert.equal(w.pending.size, 0);
  assert.equal(w.writes().length, 1);
});
