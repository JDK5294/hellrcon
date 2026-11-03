import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, assertAsked } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>, name = "s1") {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("profiles accept team-count conditions and actions; junk is rejected", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (profiles: unknown) => jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles }) });

    // The full master-control shape round-trips: team conditions + next map + template. A
    // moduleOverrides blob from the retired module era is DROPPED, not stored — the scenarios
    // live on enforcer rules now, and a profile cannot flip what no longer exists.
    const ok = await put([{
      name: "lopsided", settings: { autoBalanceThreshold: 1 },
      spec: { alliedAbove: 30, axisBelow: 20, teamDiffAbove: 14.6 },
      nextMap: "  carentan_warfare  ", moduleOverrides: { no_leader: true }, applyTemplate: "night",
    }]);
    assert.equal(ok.status, 200);
    const p = ok.body.config.profiles[0];
    assert.equal(p.spec.teamDiffAbove, 15); // rounded
    assert.equal(p.spec.alliedAbove, 30);
    assert.equal(p.nextMap, "carentan_warfare"); // trimmed
    assert.equal(p.moduleOverrides, undefined, "the retired override blob is not stored");
    assert.equal(p.applyTemplate, "night");

    // Negative bounds are refused.
    assert.equal((await put([{ name: "a", settings: {}, spec: { axisBelow: -1 } }])).status, 400);

    // Blank action strings are dropped, not stored as empty strings.
    const blank = await put([{ name: "b", settings: {}, nextMap: "  ", applyTemplate: "" }]);
    assert.equal(blank.status, 200);
    assert.equal(blank.body.config.profiles[0].nextMap, undefined);
    assert.equal(blank.body.config.profiles[0].applyTemplate, undefined);
  });
});

test("templates: save snapshots the stored config, list/delete work, names upsert case-insensitively", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Give the server some behaviour to snapshot: a profile and one configured rule.
    await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, timezone: "Europe/Berlin",
      profiles: [{ name: "night", spec: { start: "22:00", end: "06:00" }, settings: { autoBalanceEnabled: true } }],
    }) });
    const saved = await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Standard", serverId: id }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.template.name, "Standard");
    assert.equal(saved.body.template.config.timezone, "Europe/Berlin");
    assert.equal(saved.body.template.config.profiles.length, 1);
    // The player-rule scenarios live on enforcer rules now; a template carries no module blob.
    assert.ok(!("modules" in saved.body.template.config), "the retired module blob must not reappear on new templates");
    // The snapshot is behaviour only — no arming switches.
    assert.equal(saved.body.template.config.enabled, undefined);
    assert.equal(saved.body.template.config.dryRun, undefined);

    // Same name in a different case REPLACES, not duplicates.
    const again = await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "standard", serverId: id }) });
    assert.equal(again.status, 200);
    const list = await jf(`${base}/api/autosettings/templates`, { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.body.templates.length, 1);
    assert.equal(list.body.templates[0].name, "standard");

    // Validation + delete.
    assert.equal((await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "", serverId: id }) })).status, 400);
    assert.equal((await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", serverId: "nope" }) })).status, 404);
    const tplId = list.body.templates[0].id as string;
    assert.equal((await jf(`${base}/api/autosettings/templates/${tplId}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/autosettings/templates/${tplId}`, { method: "DELETE", headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/autosettings/templates`, { headers: auth })).body.templates.length, 0);
  });
});

test("apply-template replaces behaviour but never touches enabled/dry-run", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const a = await makeServer(base, auth, "source");
    const b = await makeServer(base, auth, "target");

    await jf(`${base}/api/servers/${a}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "America/Chicago",
      profiles: [{ name: "seeding", spec: { playersBelow: 40 }, settings: { maxQueuedPlayers: 6 }, nextMap: "carentan_warfare" }],
    }) });
    await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Seed kit", serverId: a }) });

    // Target is armed live with different behaviour; applying must swap behaviour, keep the switches.
    await jf(`${base}/api/servers/${b}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, dryRun: false, timezone: "UTC", profiles: [{ name: "old", settings: {} }] }) });
    const applied = await jf(`${base}/api/servers/${b}/autosettings/apply-template`, { method: "POST", headers: auth, body: JSON.stringify({ name: "seed KIT" }) }); // case-insensitive lookup
    assert.equal(applied.status, 200);
    assert.equal(applied.body.config.enabled, true);
    assert.equal(applied.body.config.dryRun, false);
    assert.equal(applied.body.config.timezone, "America/Chicago");
    assert.equal(applied.body.config.profiles.length, 1);
    assert.equal(applied.body.config.profiles[0].name, "seeding");
    assert.equal(applied.body.config.profiles[0].nextMap, "carentan_warfare");

    assert.equal((await jf(`${base}/api/servers/${b}/autosettings/apply-template`, { method: "POST", headers: auth, body: JSON.stringify({ name: "ghost" }) })).status, 404);
    assert.equal((await jf(`${base}/api/servers/${b}/autosettings/apply-template`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 400);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "autosettings.template"));
  });
});

/*
 * A profile that applies a saved setup answers to that setup's own keys (the Auto settings save asks
 * for them). Applying a template copies its profiles wholesale and asked for none of it: someone
 * with Auto settings alone could put a broadcast, seeding or rules setup on the server's schedule,
 * one they could never apply by hand. A template's choices are now asked for as a save's are.
 */
test("apply-template asks for the keys of the setups its profiles apply, as a save does", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const a = await makeServer(base, auth, "kit-source");
    const b = await makeServer(base, auth, "kit-target");
    await jf(`${base}/api/servers/${a}/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify({ messages: ["House line"] }) });
    const setup = `lines-${a.slice(0, 8)}`;
    assert.equal((await jf(`${base}/api/presets/broadcast`, { method: "POST", headers: auth, body: JSON.stringify({ name: setup, serverId: a }) })).status, 200);
    const kit = `kit-${a.slice(0, 8)}`;
    assert.equal((await jf(`${base}/api/servers/${a}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [{ name: "evening", settings: { [`preset:broadcast`]: setup } }] }) })).status, 200);
    assert.equal((await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: kit, serverId: a }) })).status, 200);

    // Auto settings on the target, and no broadcast key there.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: `profiler-${a.slice(0, 8)}`, password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "autosettings.profiles", level: "write", scopeType: "server", scopeId: b }] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: `profiler-${a.slice(0, 8)}`, password: "pw" }) });
    const profiler = { authorization: `Bearer ${l.body.token as string}` };

    const byHand = await jf(`${base}/api/servers/${b}/autosettings`, { method: "PUT", headers: profiler, body: JSON.stringify({ profiles: [{ name: "evening", settings: { [`preset:broadcast`]: setup } }] }) });
    assertAsked(byHand, "putting the setup on the schedule by hand is asked for");
    const viaKit = await jf(`${base}/api/servers/${b}/autosettings/apply-template`, { method: "POST", headers: profiler, body: JSON.stringify({ name: kit }) });
    assertAsked(viaKit, "and so is putting it there with a template");
    const profiles = ((await jf(`${base}/api/servers/${b}/autosettings`, { headers: auth })).body.config.profiles ?? []) as { settings: Record<string, unknown> }[];
    assert.ok(!profiles.some((pr) => "preset:broadcast" in pr.settings), "nothing was applied on the asking");

    // With the key on the target as well, the template goes on as before.
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "autosettings.profiles", level: "write", scopeType: "server", scopeId: b },
      { capability: "broadcast.config", level: "write", scopeType: "server", scopeId: b },
    ] }) });
    const applied = await jf(`${base}/api/servers/${b}/autosettings/apply-template`, { method: "POST", headers: profiler, body: JSON.stringify({ name: kit }) });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.config.profiles[0].settings["preset:broadcast"], setup);
  });
});

test("templates require autosettings.config", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/autosettings/templates`, { headers: plain })).status, 403);
    // A WRITE without the permission is filed for approval (202), not refused and not done — the
    // read half beside it still refuses. See docs/approvals.md.
    assertAsked(await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: plain, body: JSON.stringify({ name: "x", serverId: id }) }));
    assertAsked(await jf(`${base}/api/autosettings/templates/xyz`, { method: "DELETE", headers: plain }));
    assert.deepEqual((await jf(`${base}/api/autosettings/templates`, { headers: auth })).body.templates, [], "nothing was saved");
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings/apply-template`, { method: "POST", headers: plain, body: JSON.stringify({ name: "x" }) })).status, 202);
    assert.equal((await jf(`${base}/api/autosettings/templates`)).status, 401);
  });
});
