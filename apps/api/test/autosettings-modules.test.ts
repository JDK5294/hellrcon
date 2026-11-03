/**
 * The player-rule scenarios live on ENFORCER RULES now — Rules is the one place server rule
 * customization comes from. This file (which used to test the standalone module routes) now
 * proves two things: the retired module surface is really gone, and the state/weapon triggers
 * round-trip through the rules routes with their params validated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "am", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("the standalone module routes are gone — the scenarios are Rules triggers now", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    assert.equal((await jf(`${base}/api/autosettings/modules`, { headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings/modules`, { headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings/modules/no_leader`, { headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings/modules/no_leader`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 404);
  });
});

test("a state-trigger rule round-trips with its params; the interval and threshold snap to state semantics", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "No solo tank", eventKind: "app.state.solo_tank", action: "message",
      reason: "{violation}", escalateActions: ["punish", "kick"],
      params: { tankRoles: [11, 12], minCrew: 3 }, playersMin: 40,
    }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rule = created.body.rule;
    assert.deepEqual(rule.params, { tankRoles: [11, 12], minCrew: 3 });
    assert.equal(rule.playersMin, 40, "the population floor lives on the rule, beside active hours");
    assert.equal(rule.windowSec, 60, "a blank interval defaults to a minute between re-checks");
    assert.equal(rule.threshold, 1, "a persisting state is paced, not counted");

    // PATCH must carry the params through unrelated edits — a rename that wiped the tank roles
    // would leave a rule that can never match a squad again.
    const renamed = await jf(`${base}/api/enforcer/rules/${rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "Armor crews" }) });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body.rule.params, { tankRoles: [11, 12], minCrew: 3 });
    assert.equal(renamed.body.rule.playersMin, 40);

    // …and editing the params alone works too.
    const edited = await jf(`${base}/api/enforcer/rules/${rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ params: { tankRoles: [12], minCrew: 2 } }) });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.rule.params, { tankRoles: [12], minCrew: 2 });
  });
});

test("params are validated by the trigger's own schema, with never-fires configs refused", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "r", action: "message", ...body }) });

    assert.equal((await post({ eventKind: "app.state.bogus" })).status, 400, "an unknown state kind is refused, not stored");
    assert.equal((await post({ eventKind: "app.state.solo_tank", params: { tankRoles: [] } })).status, 400, "no vehicle roles = no squad can ever match");
    assert.equal((await post({ eventKind: "app.state.solo_tank", params: { minCrew: "lots" } })).status, 400);
    assert.equal((await post({ eventKind: "app.state.solo_tank", windowSec: 5 })).status, 400, "a 5-second re-check interval is a spam machine");
    assert.equal((await post({ eventKind: "app.state.bad_name" })).status, 400, "an empty name filter matches nobody");
    assert.equal((await post({ eventKind: "app.weapon.restricted" })).status, 400, "empty weapon lists match nothing");
    const weapons = await post({ eventKind: "app.weapon.restricted", params: { disallowedWeapons: "FLAMETHROWER, SATCHEL" } });
    assert.equal(weapons.status, 201, JSON.stringify(weapons.body));
    assert.equal(weapons.body.rule.params.disallowedWeapons, "FLAMETHROWER, SATCHEL");

    // Vietnam's helicopter trigger takes the air roles; a role no game has is refused.
    const heli = await post({ eventKind: "app.state.solo_heli", params: { heliRoles: [16, 17] } });
    assert.equal(heli.status, 201, JSON.stringify(heli.body));
    assert.equal((await post({ eventKind: "app.state.solo_heli", params: { heliRoles: [999] } })).status, 400);

    // A plain event rule stores no params, whatever the client sends.
    const plain = await post({ eventKind: "evt.teamkill", params: { anything: true } });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.rule.params, null);
  });
});

test("a state rule pinned to a game its trigger doesn't apply to is refused; community-wide is allowed", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const hllServer = await makeServer(base, auth); // default game: hll
    // Vietnam's Pilot (16) is WW2's artillery Gunner (16) — pinned to a WW2 server this rule
    // could only ever misread artillery squads, so the save is refused with the reason named.
    const pinned = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "heli", eventKind: "app.state.solo_heli", action: "message", serverId: hllServer,
      params: { heliRoles: [16, 17] },
    }) });
    assert.equal(pinned.status, 400, JSON.stringify(pinned.body));
    assert.match(String(pinned.body.error?.message ?? ""), /does not apply/);
    // Community-wide saves fine — the worker runs it only on the game it applies to.
    const wide = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "heli", eventKind: "app.state.solo_heli", action: "message", params: { heliRoles: [16, 17] },
    }) });
    assert.equal(wide.status, 201, JSON.stringify(wide.body));
    // …and PATCH cannot sneak the pin in behind validation's back.
    const moved = await jf(`${base}/api/enforcer/rules/${wide.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ serverId: hllServer }) });
    assert.equal(moved.status, 400, JSON.stringify(moved.body));
  });
});
