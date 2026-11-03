import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, assertAsked } from "./harness.ts";

// This harness hands the repo back too — the status tests need to plant roster snapshots,
// which have no write API (only the worker's sampler writes them).
async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "mc", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("the Then catalog serves both families: game fields and app automation switches", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const r = await jf(`${base}/api/servers/${id}/autosettings`, { headers: auth });
    assert.equal(r.status, 200);
    const fields = r.body.fields as { field: string; label: string; kind: string; group: string }[];
    const game = fields.find((f) => f.field === "autoBalanceEnabled");
    assert.equal(game?.group, "Server settings");
    for (const key of ["app:broadcast.enabled", "app:mapvote.enabled", "app:seeding.enabled", "app:discordRelay.enabled"]) {
      const f = fields.find((x) => x.field === key);
      assert.ok(f, `catalog offers ${key}`);
      assert.equal(f!.group, "App automation");
      assert.equal(f!.kind, "bool");
    }
  });
});

test("profiles accept app settings; junk app keys are refused", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (profiles: unknown) => jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles }) });

    const ok = await put([{ name: "night", settings: { "app:mapvote.enabled": false, "app:broadcast.enabled": "true", autoBalanceEnabled: true } }]);
    assert.equal(ok.status, 200);
    const s = ok.body.config.profiles[0].settings;
    assert.equal(s["app:mapvote.enabled"], false);
    assert.equal(s["app:broadcast.enabled"], true, `"true" coerces to boolean`);
    assert.equal(s.autoBalanceEnabled, true);

    assert.equal((await put([{ name: "x", settings: { "app:not.a.thing": true } }])).status, 400);
  });
});

test("feature presets: snapshot, list, apply (switches untouched), delete; profiles reference them", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Give broadcast some behaviour + arm it, then snapshot. The preset must carry the messages
    // but never the switches.
    await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, intervalSec: 600, randomize: true, messages: ["seed msg 1", "seed msg 2"],
    }) });
    const saved = await jf(`${base}/api/presets/broadcast`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Seed talk", serverId: id }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.preset.name, "Seed talk");
    // The save answers with the LISTING shape — a preset's config body never travels to a
    // browser (the snapshot may hold fields its saver isn't cleared to read back). That the
    // snapshot carried the messages and never the switches is proven by the apply below.
    assert.ok(!("config" in (saved.body.preset as object)), "no config body in the save response");

    // Combined listing groups by feature.
    const list = await jf(`${base}/api/presets`, { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.body.presets.broadcast.length, 1);
    assert.equal(list.body.presets.broadcast[0].name, "Seed talk");

    // Change the live config, then apply the preset back: behaviour restored, switches kept.
    await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: false, dryRun: true, intervalSec: 120, randomize: false, messages: ["other"],
    }) });
    const applied = await jf(`${base}/api/servers/${id}/presets/broadcast/apply`, { method: "POST", headers: auth, body: JSON.stringify({ name: "seed TALK" }) }); // case-insensitive
    assert.equal(applied.status, 200);
    const after = await jf(`${base}/api/servers/${id}/broadcast`, { headers: auth });
    assert.deepEqual(after.body.config.messages, ["seed msg 1", "seed msg 2"]);
    assert.equal(after.body.config.intervalSec, 600);
    assert.equal(after.body.config.enabled, false, "apply must not arm the feature");
    assert.equal(after.body.config.dryRun, true);

    // Profiles: the Then catalog offers preset fields, and validation accepts/rejects them.
    const cfg = await jf(`${base}/api/servers/${id}/autosettings`, { headers: auth });
    const presetField = (cfg.body.fields as { field: string; group: string }[]).find((x) => x.field === "preset:broadcast");
    assert.equal(presetField?.group, "Apply presets");
    const put = (profiles: unknown) => jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles }) });
    const okPut = await put([{ name: "seeding", settings: { "preset:broadcast": "Seed talk" } }]);
    assert.equal(okPut.status, 200);
    assert.equal(okPut.body.config.profiles[0].settings["preset:broadcast"], "Seed talk");
    assert.equal((await put([{ name: "x", settings: { "preset:nonsense": "y" } }])).status, 400);
    assert.equal((await put([{ name: "x", settings: { "preset:broadcast": "  " } }])).status, 400);

    // Delete; unknown apply 404s.
    const pid = list.body.presets.broadcast[0].id as string;
    assert.equal((await jf(`${base}/api/presets/broadcast/${pid}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/servers/${id}/presets/broadcast/apply`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Seed talk" }) })).status, 404);

    // Permission surface: a plain user sees an empty grouped listing, and a write is asked for, not made.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const plainList = await jf(`${base}/api/presets`, { headers: plain });
    assert.equal(plainList.status, 200);
    assert.equal(Object.keys(plainList.body.presets).length, 0);
    const savedBefore = (await jf(`${base}/api/presets`, { headers: auth })).body.presets.broadcast?.length ?? 0;
    assertAsked(await jf(`${base}/api/presets/broadcast`, { method: "POST", headers: plain, body: JSON.stringify({ name: "x", serverId: id }) }));
    assert.equal((await jf(`${base}/api/presets`, { headers: auth })).body.presets.broadcast?.length ?? 0, savedBefore, "nothing was saved");
  });
});

test("saving a preset from a server needs that feature on that server, not just somewhere", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string, port: number) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const mine = await mk("preset-mine", 21);
    const theirs = await mk("preset-theirs", 22);
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "broadcast-one-server", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [{ capability: "broadcast.config", level: "write", scopeType: "server", scopeId: mine }] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "broadcast-one-server", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };
    const save = (serverId: string, name: string) => jf(`${base}/api/presets/broadcast`, { method: "POST", headers: scoped, body: JSON.stringify({ name, serverId }) });
    assert.equal((await save(theirs, "copied from theirs")).status, 403, "another server's settings are not theirs to snapshot");
    assert.equal((await save(mine, "from mine")).status, 200, "their own server's are");
  });
});

test("status resolves the active profile from the latest roster snapshot", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const status = () => jf(`${base}/api/servers/${id}/autosettings/status`, { headers: auth });

    // Nothing configured: off, nothing active, no sample.
    let st = await status();
    assert.equal(st.status, 200);
    assert.equal(st.body.enabled, false);
    assert.equal(st.body.active, null);
    assert.equal(st.body.playerCount, null);

    // A count-conditioned profile over a conditionless default.
    await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true,
      profiles: [
        { name: "seeding", spec: { playersBelow: 40 }, settings: {} },
        { name: "normal", settings: {} },
      ],
    }) });

    // No snapshot yet: the count condition can't match (unknown never matches), default wins.
    st = await status();
    assert.equal(st.body.enabled, true);
    assert.equal(st.body.active, "normal");
    assert.equal(st.body.sampledAt, null);

    // A quiet-server sample flips the match to the seeding profile, with side counts attached.
    await repo.rosterSnapshots.record({
      serverId: id, ts: new Date().toISOString(), playerCount: 18,
      composition: { bySide: { allies: { players: 10 }, axis: { players: 8 } } },
    });
    st = await status();
    assert.equal(st.body.active, "seeding");
    assert.equal(st.body.playerCount, 18);
    assert.equal(st.body.alliedCount, 10);
    assert.equal(st.body.axisCount, 8);
    assert.ok(st.body.sampledAt);

    // A fuller, later sample flips it back.
    await repo.rosterSnapshots.record({
      serverId: id, ts: new Date(Date.now() + 1000).toISOString(), playerCount: 70,
      composition: { bySide: { allies: { players: 36 }, axis: { players: 34 } } },
    });
    st = await status();
    assert.equal(st.body.active, "normal");
    assert.equal(st.body.playerCount, 70);
  });
});

/*
 * Cross-game preset safety. A seeding preset is raw role numbers and per-game weapon names; a
 * map-vote preset is one game's map ids. Community-wide presets applied to any server means an
 * HLL preset could land on a Vietnam server, where role 13 stops meaning Commander and starts
 * meaning Mortar Support — the automod would enforce a policy nobody wrote. The preset remembers
 * its source game, and game-scoped features refuse a cross-game apply; broadcast is just text and
 * still travels freely. (The worker's profile `preset:` path runs the same presetGameMismatch
 * guard — one rule, two doors.)
 */
test("a game-scoped preset refuses to cross games; broadcast presets still travel", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const hllId = await makeServer(base, auth);
    const viet = await jf(`${base}/api/servers`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "vn", host: "127.0.0.1", port: 2, password: "x", game: "hllv", protocol: "binary-v2" }) });
    const vietId = viet.body.server.id as string;

    // Give the HLL server a seeding config worth snapshotting, then snapshot it.
    await jf(`${base}/api/servers/${hllId}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedRoles: [13], disallowedCommanderAbilities: ["BOMBING RUN"] }) });
    const saved = await jf(`${base}/api/presets/seeding`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Quiet seed", serverId: hllId }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.preset.game, "hll", "the preset remembers the game it was saved from");

    // Same game: applies. Other game: refused with a message that says why, and changes nothing.
    assert.equal((await jf(`${base}/api/servers/${hllId}/presets/seeding/apply`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Quiet seed" }) })).status, 200);
    const refused = await jf(`${base}/api/servers/${vietId}/presets/seeding/apply`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Quiet seed" }) });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error?.message ?? refused.body.error ?? ""), /saved from a hll server/);
    const vietCfg = await jf(`${base}/api/servers/${vietId}/seeding`, { headers: auth });
    assert.deepEqual(vietCfg.body.config.disallowedRoles, [], "the refusal changed nothing");

    // Broadcast is not game-scoped: the same cross-game apply is fine.
    await jf(`${base}/api/servers/${hllId}/broadcast`, { method: "PUT", headers: auth,
      body: JSON.stringify({ messages: ["Welcome!"] }) });
    await jf(`${base}/api/presets/broadcast`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "House lines", serverId: hllId }) });
    assert.equal((await jf(`${base}/api/servers/${vietId}/presets/broadcast/apply`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "House lines" }) })).status, 200);

    // A legacy preset with no recorded game (saved before the column) still applies anywhere:
    // refusing it would brick every pre-existing preset, and single-game installs were never at
    // risk. Planted through the repo because the API now always stamps the game.
    await repo.featurePresets.save({ feature: "seeding", name: "Old preset", config: { minPlayers: 2 }, createdByName: "t" });
    assert.equal((await jf(`${base}/api/servers/${vietId}/presets/seeding/apply`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Old preset" }) })).status, 200);
  });
});
