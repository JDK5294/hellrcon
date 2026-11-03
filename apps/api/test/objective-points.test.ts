/**
 * The staff-taught objective layer: names for the options the wire only numbers (Vietnam), and
 * the tactical-map cell each option sits in — what the picker highlights.
 *
 * Under test: teaching persists per (game, map family) and rides back on the objectives read for
 * whatever map is playing; the cell vocabulary is validated as the map's own A1–J10 grid; blank
 * halves clear and an empty row drops; the write is maps.names-gated and audited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";
import { fakeGameServer } from "./fake-hll-server.ts";

test("taught names and cells round-trip onto the objectives read, validated and audited", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const token = (auth.authorization as string).slice("Bearer ".length);
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      fake.objectiveRows = [
        ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"],
      ];
      fake.session = { mapId: "carentan_warfare" };

      // Teach one option a name and a cell.
      const put = await jf(`${base}/api/servers/${serverId}/maps/objective-points`, {
        method: "PUT", headers: auth,
        body: JSON.stringify({ mapKey: "carentan", row: 0, idx: 0, name: "Convoy Ambush", sector: "e6" }),
      });
      assert.equal(put.status, 200);
      assert.equal(put.body.point.sector, "E6", "cells normalise to the grid's own spelling");

      // The objectives read joins the layer for the map that is PLAYING.
      const got = await jf(`${base}/api/servers/${serverId}/maps/objectives`, { headers: auth });
      assert.equal(got.status, 200);
      assert.equal(got.body.mapKey, "carentan");
      assert.deepEqual(
        (got.body.points as any[]).map((p) => [p.row, p.idx, p.name, p.sector]),
        [[0, 0, "Convoy Ambush", "E6"]],
      );

      // The grid is the vocabulary: a cell off it is refused, as are slots off the 5×3.
      assert.equal((await jf(`${base}/api/servers/${serverId}/maps/objective-points`, {
        method: "PUT", headers: auth, body: JSON.stringify({ mapKey: "carentan", row: 0, idx: 0, sector: "K11" }),
      })).status, 400);
      assert.equal((await jf(`${base}/api/servers/${serverId}/maps/objective-points`, {
        method: "PUT", headers: auth, body: JSON.stringify({ mapKey: "carentan", row: 5, idx: 0, name: "x" }),
      })).status, 400);

      // Blank halves clear; a row left with neither is dropped.
      await jf(`${base}/api/servers/${serverId}/maps/objective-points`, {
        method: "PUT", headers: auth, body: JSON.stringify({ mapKey: "carentan", row: 0, idx: 0, name: "", sector: "" }),
      });
      const empty = await jf(`${base}/api/servers/${serverId}/maps/objectives`, { headers: auth });
      assert.deepEqual(empty.body.points, []);

      // Teaching is the maps.names act — and like every server-scoped write, lacking the grant
      // FILES the ask instead of refusing it (Approvals L). Nothing is taught until it is signed.
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
      const filed = await jf(`${base}/api/servers/${serverId}/maps/objective-points`, {
        method: "PUT", headers: { authorization: `Bearer ${l.body.token as string}` },
        body: JSON.stringify({ mapKey: "carentan", row: 0, idx: 0, name: "nope" }),
      });
      assert.equal(filed.status, 202);
      assert.equal(filed.body.requested, true);
      const still = await jf(`${base}/api/servers/${serverId}/maps/objectives`, { headers: auth });
      assert.deepEqual(still.body.points, [], "a filed ask teaches nothing until someone signs it");
      const audit = await jf(`${base}/api/audit`, { headers: auth });
      assert.ok((audit.body.entries as any[]).some((e) => e.action === "map.objectivePoints"));

      // …and SIGNING it is when the teach lands: the same handler replays on the approver's
      // authority, credited to whoever asked, provenance stamped on the handler's own audit row.
      const req = (await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any;
      const signed = await jf(`${base}/api/requests/${req.id}/lines/${req.lines[0].id}/approve`, {
        method: "POST", headers: auth, body: "{}",
      });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null);
      const taught = await jf(`${base}/api/servers/${serverId}/maps/objectives`, { headers: auth });
      assert.deepEqual((taught.body.points as any[]).map((pt) => [pt.row, pt.idx, pt.name]), [[0, 0, "nope"]]);
      const row = ((await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[])
        .find((e) => e.action === "map.objectivePoints" && e.data?.requestId === req.id);
      assert.ok(row, "the replayed teach carries the request it came through");
      assert.match(String(row.summary), /\(approved by /);
    } finally {
      fake.close();
    }
  });
});
