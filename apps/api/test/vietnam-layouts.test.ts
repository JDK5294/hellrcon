/**
 * Vietnam's PERSISTENT objective layouts (docs/hll-vietnam.md p11) — the half we never wired.
 *
 * Under test: setting objectives on a Vietnam server STORES a per-map layout the objectives read
 * can see; clearing sends RemoveSectorLayout and the store empties; and WW2 — whose set applies
 * once to the round and stores nothing — has nothing to clear and says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";
import { fakeGameServer } from "./fake-hll-server.ts";

test("a Vietnam set stores per-map, the read shows it, and clear removes it", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const token = (auth.authorization as string).slice("Bearer ".length);
    const nam = await fakeGameServer(base, token, "nam", "hllv");
    try {
      nam.fake.objectiveRows = [
        ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"],
      ];
      nam.fake.session = { mapId: "vantuong_warfare" };

      // Nothing stored yet.
      const before = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, { headers: auth });
      assert.equal(before.status, 200);
      assert.equal(before.body.saved, null);

      // Set a layout — Vietnam's wire carries the MapId, so the game stores it for the map.
      const set = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["0", "1", "2", "0", "1"] }),
      });
      assert.equal(set.status, 200);
      assert.deepEqual(nam.fake.storedLayouts.get("vantuong_warfare"), [0, 1, 2, 0, 1], "stored under the map, not fired into the void");

      // The read now reports the SAVED layout for the map in play — no countdown: "until cleared".
      const after = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, { headers: auth });
      assert.deepEqual(after.body.saved, [0, 1, 2, 0, 1]);
      assert.equal(after.body.savedPlays, null);

      // Re-saving with keepPlays starts OUR countdown (the game itself has no expiry) …
      const kept = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["0", "1", "2", "0", "1"], keepPlays: 2 }),
      });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      const withCount = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, { headers: auth });
      assert.equal(withCount.body.savedPlays, 2);
      // …and re-saving permanent replaces it: back to "until cleared".
      await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["0", "1", "2", "0", "1"] }),
      });
      assert.equal((await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, { headers: auth })).body.savedPlays, null);

      // Clear it: RemoveSectorLayout reaches the game, the store empties, the read agrees.
      const clear = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives/clear`, {
        method: "POST", headers: auth, body: JSON.stringify({}),
      });
      assert.equal(clear.status, 200);
      assert.equal(clear.body.mapId, "vantuong_warfare");
      assert.ok(nam.fake.received.includes("RemoveSectorLayout"));
      assert.equal(nam.fake.storedLayouts.size, 0);
      const gone = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, { headers: auth });
      assert.equal(gone.body.saved, null);
    } finally {
      nam.fake.close();
    }
  });
});

test("WW2 stores no layouts: the read says null and clear refuses with the reason", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const token = (auth.authorization as string).slice("Bearer ".length);
    const ww2 = await fakeGameServer(base, token, "ww2");
    try {
      ww2.fake.objectiveRows = [
        ["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"], ["D1", "D2", "D3"], ["E1", "E2", "E3"],
      ];
      ww2.fake.session = { mapId: "carentan_warfare" };

      // WW2's set names no map on the wire, so nothing is ever stored…
      await jf(`${base}/api/servers/${ww2.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["A1", "B2", "C3", "random", "E1"] }),
      });
      assert.equal(ww2.fake.storedLayouts.size, 0, "a WW2 set is one round, once — the wire carries no MapId");
      const read = await jf(`${base}/api/servers/${ww2.serverId}/maps/objectives`, { headers: auth });
      assert.equal(read.body.saved, null);

      // …and clear is honest about why there is nothing to do.
      const clear = await jf(`${base}/api/servers/${ww2.serverId}/maps/objectives/clear`, {
        method: "POST", headers: auth, body: JSON.stringify({}),
      });
      assert.equal(clear.status, 400);
      assert.match(JSON.stringify(clear.body), /Vietnam stores objective layouts/);

      // keepPlays on WW2 is a misunderstanding worth answering, not silently dropping.
      const kept = await jf(`${base}/api/servers/${ww2.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["A1", "B2", "C3", "random", "E1"], keepPlays: 3 }),
      });
      assert.equal(kept.status, 400);
      assert.match(JSON.stringify(kept.body), /only means something on HLL: Vietnam/);
    } finally {
      ww2.fake.close();
    }
  });
});

test("a filed layout clear lands when signed: the shared core replays with RemoveSectorLayout", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const token = (auth.authorization as string).slice("Bearer ".length);
    const nam = await fakeGameServer(base, token, "nam2", "hllv");
    try {
      nam.fake.objectiveRows = [
        ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"],
      ];
      nam.fake.session = { mapId: "quangngai_warfare" };
      // A layout stands, stored by someone who may.
      await jf(`${base}/api/servers/${nam.serverId}/maps/objectives`, {
        method: "POST", headers: auth, body: JSON.stringify({ objectives: ["0", "1", "2", "0", "1"] }),
      });
      assert.ok(nam.fake.storedLayouts.has("quangngai_warfare"));

      // A grantless asker files the clear instead of firing it…
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "asker", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "asker", password: "pw" }) });
      const filed = await jf(`${base}/api/servers/${nam.serverId}/maps/objectives/clear`, {
        method: "POST", headers: { authorization: `Bearer ${l.body.token as string}` }, body: JSON.stringify({}),
      });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      assert.equal(filed.body.requested, true);
      assert.ok(nam.fake.storedLayouts.has("quangngai_warfare"), "filing clears nothing");

      // …and the signature is what dials the game.
      const req = (await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any;
      const signed = await jf(`${base}/api/requests/${req.id}/lines/${req.lines[0].id}/approve`, {
        method: "POST", headers: auth, body: "{}",
      });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null);
      assert.ok(nam.fake.received.includes("RemoveSectorLayout"));
      assert.equal(nam.fake.storedLayouts.size, 0, "the signed clear reached the game");
    } finally {
      nam.fake.close();
    }
  });
});
