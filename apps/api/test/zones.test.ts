/**
 * The zone-set library's contract: gated on its own capability (read by the rule engine's too),
 * validated by the same closed sector vocabulary as the seeding paint, and referentially safe both
 * ways — a rule cannot point at a set that is gone, and a set cannot be deleted out from under a rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedFor, jf, ownerAuth, withServer } from "./harness.ts";

async function staff(base: string, ownerHeaders: Record<string, string>, username: string, caps: { capability: string; level: string }[]) {
  const created = await jf(`${base}/api/users`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ username, password: "pw" }) });
  const userId = (created.body.user as { id: string }).id;
  if (caps.length) {
    const set = await jf(`${base}/api/users/${userId}/grants`, {
      method: "PUT", headers: ownerHeaders,
      body: JSON.stringify({ grants: caps.map((c) => ({ ...c, scopeType: "global", scopeId: null })) }),
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token as string}` };
}

test("zone sets: capability-gated CRUD, sector validation, and referential safety with zone rules", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const outsider = await staff(base, owner, "zoneless", [{ capability: "server.view", level: "read" }]);

    // The library rides moderation.zones — without it (or the rules permission, which reads it)
    // there is nothing to see, and a write is only asked of someone who holds it.
    assert.equal((await jf(`${base}/api/zones`, { headers: outsider })).status, 403);
    const asked = await jf(`${base}/api/zones`, { method: "POST", headers: outsider, body: JSON.stringify({ name: "X", game: "hll" }) });
    assert.deepEqual(await askedFor(base, owner, asked), { capability: "moderation.zones", serverId: null });
    assert.deepEqual((await jf(`${base}/api/zones`, { headers: owner })).body.sets, [], "nothing saved on the asking");

    // A set names its game, always; the paint speaks the closed A1–J10 vocabulary.
    assert.equal((await jf(`${base}/api/zones`, { method: "POST", headers: owner, body: JSON.stringify({ name: "No game" }) })).status, 400);
    const badCell = await jf(`${base}/api/zones`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Bad", game: "hll", zones: { carentan: { allies: ["K1"], axis: [], shared: [] } } }),
    });
    assert.equal(badCell.status, 400, JSON.stringify(badCell.body));
    assert.match(String(badCell.body.error?.message), /not a sector/);

    const created = await jf(`${base}/api/zones`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Fight Club", game: "hll", zones: { carentan: { allies: ["A1", "a1", "B2"], axis: ["J10"], shared: ["E5"] } } }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const setId = created.body.set.id as string;
    assert.deepEqual(created.body.set.zones.carentan.allies, ["A1", "B2"], "cells are upper-cased and deduped");

    // Listing narrows by game and carries the paintable catalogue for the editor.
    const listed = await jf(`${base}/api/zones?game=hll`, { headers: owner });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sets.length, 1);
    assert.ok((listed.body.maps as unknown[]).length > 10, "the WW2 map catalogue rides along");
    assert.equal((await jf(`${base}/api/zones?game=hllv`, { headers: owner })).body.sets.length, 0, "another game's view is empty");

    // A zone rule must reference a set that exists — a dangling id would enforce nothing forever.
    const badRule = await jf(`${base}/api/enforcer/rules`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Zoned", eventKind: "app.state.out_of_zone", action: "message", windowSec: 60, params: { zoneSet: "not-a-set" } }),
    });
    assert.equal(badRule.status, 400, JSON.stringify(badRule.body));
    assert.match(String(badRule.body.error?.message), /zone set/);
    const rule = await jf(`${base}/api/enforcer/rules`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Zoned", eventKind: "app.state.out_of_zone", action: "message", windowSec: 60, params: { zoneSet: setId } }),
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));

    // …and the set cannot be deleted while that rule stands; the refusal names it.
    const blocked = await jf(`${base}/api/zones/${setId}`, { method: "DELETE", headers: owner });
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.body.error?.message), /Zoned/);
    assert.equal((await jf(`${base}/api/enforcer/rules/${rule.body.rule.id}`, { method: "DELETE", headers: owner })).status, 200);
    assert.equal((await jf(`${base}/api/zones/${setId}`, { method: "DELETE", headers: owner })).status, 200);

    // A rule with an EMPTY zoneSet is refused by the trigger's own never-fires rule.
    const empty = await jf(`${base}/api/enforcer/rules`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Aimless", eventKind: "app.state.out_of_zone", action: "message", windowSec: 60, params: {} }),
    });
    assert.equal(empty.status, 400);
    assert.match(String(empty.body.error?.message), /zone set/);
  });
});

test("zone sets: a player trigger on leaving the allowed area holds its set as a rule does", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const ana = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000009", name: "Ana", ts: new Date().toISOString() });
    const made = await jf(`${base}/api/zones`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Keep-in", game: "hll" }) });
    const setId = made.body.set.id as string;
    const trigger = (zoneSet: string) => jf(`${base}/api/players/${ana.id}/triggers`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ event: "outofzone", params: { zoneSet }, steps: [{ action: "message", message: "back to your area" }] }),
    });
    const usedBy = async () => ((await jf(`${base}/api/zones?game=hll`, { headers: owner })).body.sets as { id: string; usedBy: string[] }[]).find((s) => s.id === setId)?.usedBy;

    // Like a rule, a trigger cannot name a set that is not there…
    const dangling = await trigger("0b6e3c8e-0000-4000-8000-000000000000");
    assert.equal(dangling.status, 400, JSON.stringify(dangling.body));
    assert.match(String(dangling.body.error?.message), /zone set no longer exists/);

    // …and the set it names says so, and cannot be deleted under it.
    const made2 = await trigger(setId);
    assert.equal(made2.status, 201, JSON.stringify(made2.body));
    const triggerId = made2.body.trigger.id as string;
    assert.deepEqual(await usedBy(), ["player trigger on Ana"]);
    const blocked = await jf(`${base}/api/zones/${setId}`, { method: "DELETE", headers: owner });
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.body.error?.message), /player trigger on Ana/);

    // Switched off, it holds nothing; the set can go — and then switching it back on is refused,
    // not armed to watch a set that is gone.
    const toggle = (enabled: boolean) => jf(`${base}/api/players/${ana.id}/triggers/${triggerId}`, { method: "PATCH", headers: owner, body: JSON.stringify({ enabled }) });
    assert.equal((await toggle(false)).status, 200);
    assert.deepEqual(await usedBy(), []);
    assert.equal((await jf(`${base}/api/zones/${setId}`, { method: "DELETE", headers: owner })).status, 200);
    const back = await toggle(true);
    assert.equal(back.status, 400, JSON.stringify(back.body));
    assert.match(String(back.body.error?.message), /zone set no longer exists/);
    assert.equal((await repo.playerTriggers.get(triggerId))?.enabled, false, "still off");
  });
});
