import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";
import { fakeGameServer } from "./fake-hll-server.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "rot", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

// Servers default to observe mode, so the write routes short-circuit at the pre-connection guards —
// which is exactly the validation/permission surface we want to lock down here.
for (const op of ["add", "remove", "move"] as const) {
  test(`rotation ${op}: guards (mapId, observe, permission, auth, 404)`, async () => {
    await withServer(async (base) => {
      const auth = await ownerAuth(base);
      const id = await makeServer(base, auth);
      const url = `${base}/api/servers/${id}/maprotation/${op}`;

      // missing mapId → 400 (checked before the observe guard)
      assert.equal((await jf(url, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 400);
      // valid mapId but server is in observe mode → 409
      assert.equal((await jf(url, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare", index: 0, fromIndex: 0, toIndex: 1 }) })).status, 409);
      // unknown server → 404
      assert.equal((await jf(`${base}/api/servers/nope/maprotation/${op}`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "x" }) })).status, 404);

      // a plain user lacks the permission → the call is FILED for someone who holds it (202,
      // before any connect), not refused. Nothing reaches the rotation until it is signed.
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: `plain-${op}`, password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: `plain-${op}`, password: "pw" }) });
      const plain = { authorization: `Bearer ${l.body.token as string}` };
      const asked = await jf(url, { method: "POST", headers: plain, body: JSON.stringify({ mapId: "carentan_warfare" }) });
      assert.equal(asked.status, 202, JSON.stringify(asked.body));
      assert.equal(asked.body.requested, true);
      // unauthenticated → 401
      assert.equal((await jf(url, { method: "POST", body: JSON.stringify({ mapId: "carentan_warfare" }) })).status, 401);
    });
  });
}

/*
 * The one-shot apply: a saved set replaces the whole rotation in ORDER, as one act — the feature
 * that retires the 70-click reshape (one staffer's card reads map.rotation.remove ×72). Exactness
 * matters twice: the final lineup must be the set's, order included, and the trail must carry ONE
 * row for it, not one per map.
 */
test("apply-set: replaces the rotation with the set's lineup, once, in order — recipes and wrong games refused", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const token = auth.authorization.slice("Bearer ".length);
    const { fake, serverId } = await fakeGameServer(base, token, "rotset");
    try {
      fake.catalogue = ["foy_warfare", "carentan_warfare", "sme_warfare", "kursk_warfare"];
      fake.rotation = ["foy_warfare", "carentan_warfare", "sme_warfare"];

      const lineup = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
        name: "Event night", game: "hll", pool: { sequence: ["carentan_warfare", "kursk_warfare", "foy_warfare"] },
      }) });
      assert.equal(lineup.status, 201, JSON.stringify(lineup.body));
      const recipe = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
        name: "Dice", game: "hll", pool: { dayCount: 3 },
      }) });
      const vietnam = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
        name: "Nam night", game: "hllv", pool: { sequence: ["hue_warfare"] },
      }) });

      const apply = (setId: string) => jf(`${base}/api/servers/${serverId}/maprotation/apply-set`, { method: "POST", headers: auth, body: JSON.stringify({ setId }) });
      // A recipe rolls dice; a rotation is a lineup — refused with the fix named.
      assert.match((await apply(recipe.body.set.id as string)).body.error.message as string, /recipe/);
      // Map ids do not cross games.
      assert.match((await apply(vietnam.body.set.id as string)).body.error.message as string, /hllv/);

      const r = await apply(lineup.body.set.id as string);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.changed, true);
      assert.deepEqual(fake.rotation, ["carentan_warfare", "kursk_warfare", "foy_warfare"],
        "the live rotation IS the set now — same maps, same order, nothing extra");

      // One act, one row: the volley never lands as per-map add/remove entries.
      const trail = await repo.audit.list({ limit: 50 });
      assert.equal(trail.filter((e) => e.action === "map.rotation.apply_set").length, 1);
      assert.equal(trail.filter((e) => e.action === "map.rotation.add" || e.action === "map.rotation.remove").length, 0);

      // Re-applying an already-matching set touches nothing and records nothing.
      const again = await apply(lineup.body.set.id as string);
      assert.equal(again.body.changed, false);
      assert.equal((await repo.audit.list({ limit: 50 })).filter((e) => e.action === "map.rotation.apply_set").length, 1);

      // The picker's listing says which sets can apply, and how big the lineup is.
      const sets = await jf(`${base}/api/servers/${serverId}/maprotation/sets`, { headers: auth });
      const byName = new Map((sets.body.sets as { name: string; lineup: number | null }[]).map((s) => [s.name, s.lineup]));
      assert.equal(byName.get("Event night"), 3);
      assert.equal(byName.get("Dice"), null, "a recipe lists as not-applicable rather than hiding");
      assert.ok(!byName.has("Nam night"), "another game's sets are not offered here");
    } finally {
      fake.close();
    }
  });
});
