import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { withIsolatedServer as withServer, jsonFetch, assertAsked, askedFor } from "./harness.ts";

async function ownerToken(base: string): Promise<string> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return (login.body as any).token as string;
}


test("full flow: bootstrap owner, login, create + list server, secret hidden", async () => {
  await withServer(async (base) => {
    const reg = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "hunter2" }) });
    assert.equal(reg.status, 201);
    assert.equal((reg.body as any).owner, true);

    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "hunter2" }) });
    assert.equal(login.status, 200);
    const token = (login.body as any).token as string;
    assert.ok(token);

    const auth = { authorization: `Bearer ${token}` };
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "S1", host: "1.2.3.4", port: 28865, password: "secret" }) });
    assert.equal(created.status, 201);
    assert.equal((created.body as any).server.engagementMode, "observe");
    assert.equal((created.body as any).server.password, undefined); // secret never returned

    const list = await jsonFetch(`${base}/api/servers`, { headers: auth });
    assert.equal((list.body as any).servers.length, 1);
    assert.equal((list.body as any).servers[0].password, undefined);

    // Per-automation switches: the staged path off CRCON. Everything defaults ON; turning two off
    // stores only the exceptions and reads back on the public row; an unknown switch is refused so
    // a typo cannot silently disable nothing.
    const id = (created.body as any).server.id as string;
    assert.deepEqual((created.body as any).server.automation, {}, "a new server runs everything");
    const staged = await jsonFetch(`${base}/api/servers/${id}/automation`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ automation: { mapvote: true, broadcast: false, seeding: false, autosettings: true, vipSweep: true, consoleAdminSweep: true } }),
    });
    assert.equal(staged.status, 200);
    assert.deepEqual((staged.body as any).server.automation, { broadcast: false, seeding: false }, "exceptions-only: enabled switches are not stored");
    const reread = await jsonFetch(`${base}/api/servers`, { headers: auth });
    assert.deepEqual((reread.body as any).servers[0].automation, { broadcast: false, seeding: false });
    assert.equal((await jsonFetch(`${base}/api/servers/${id}/automation`, { method: "PUT", headers: auth, body: JSON.stringify({ automation: { vipsweep: false } }) })).status, 400, "unknown switch (wrong case) must 400");
    assert.equal((await jsonFetch(`${base}/api/servers/${id}/automation`, { method: "PUT", headers: auth, body: JSON.stringify({ automation: { mapvote: "no" } }) })).status, 400);
    assert.equal((await jsonFetch(`${base}/api/servers/${id}/automation`, { method: "PUT", headers: auth, body: JSON.stringify({ automation: [] }) })).status, 400);
  });
});

test("reconciler fixes: per server, off until switched on, stored only when on, and audited by name", async () => {
  await withServer(async (base, repo) => {
    const auth = { authorization: `Bearer ${await ownerToken(base)}` };
    const mk = async (name: string) => ((await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "1.2.3.4", port: 28865, password: "secret" }) })).body as any).server.id as string;
    const a = await mk("Alpha");
    const b = await mk("Bravo");
    const put = (id: string, automation: Record<string, unknown>) =>
      jsonFetch(`${base}/api/servers/${id}/automation`, { method: "PUT", headers: auth, body: JSON.stringify({ automation }) });
    const summaries = async (id: string) => (await repo.audit.list({ targetId: id, action: "server.automation" })).map((e) => e.summary);

    // The fixes were the worker's BAN_RECONCILE_APPLY / VIP_RECONCILE_APPLY: one deploy flag for
    // every server, so a console admin without shell access could never arm them. They are
    // automation switches now — and the only ones that are OFF until someone turns them on.
    const armed = await put(a, { banSync: true, vipSync: true, banSyncApply: true, vipSyncApply: false });
    assert.equal(armed.status, 200);
    assert.deepEqual((armed.body as any).server.automation, { banSyncApply: true }, "a fix that is on is the exception stored; one left off is the default and is not");
    const list = (await jsonFetch(`${base}/api/servers`, { headers: auth })).body as any;
    assert.deepEqual(list.servers.find((s: any) => s.id === b).automation, {}, "arming one server arms nothing anywhere else");
    assert.match((await summaries(a))[0]!, /fixing automatically: ban list fixes/, "arming is named in the trail, not folded into 'everything on'");

    // Off again: back to the default, so nothing is stored, and the trail says the fix stopped.
    const disarmed = await put(a, { banSyncApply: false });
    assert.deepEqual((disarmed.body as any).server.automation, {});
    assert.match((await summaries(a))[0]!, /report only again: ban list fixes/);

    // The rest keep their rules: off is the stored exception for a switch that defaults on.
    const both = await put(a, { vipSync: false, vipSyncApply: true, banSyncApply: true });
    assert.deepEqual((both.body as any).server.automation, { vipSync: false, vipSyncApply: true, banSyncApply: true });
    assert.equal((await put(a, { banSyncApply: "yes" })).status, 400, "a fix switch takes a boolean like every other");
  });
});

test("API JSON says no-store — a cached /api/me is how a permission grant takes ten minutes to appear", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    // The live-state answer, the unauthenticated answer, and the error path all ride sendJson;
    // without the header, browsers cache heuristically and replay stale grants after a restart.
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.headers.get("cache-control"), "no-store");
    const status = await fetch(`${base}/api/auth/status`);
    assert.equal(status.headers.get("cache-control"), "no-store");
    const denied = await fetch(`${base}/api/servers`);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "no-store");
  });
});

/*
 * Node hands a request's address over as written, so one that is not a URL at all ("GET http://["
 * from anyone who can reach the port) arrives here intact. It was parsed outside the handler's error
 * handling: the handler rejected, and an unhandled rejection ends the API process, so a single
 * such request restarted the panel for everyone.
 */
test("a request whose address is not a URL gets a 400, and the API keeps serving", async () => {
  await withServer(async (base) => {
    const { hostname, port } = new URL(base);
    for (const target of ["http://[", "//[::1", "http://%zz/"]) {
      const statusLine = await new Promise<string>((resolve, reject) => {
        const s = connect(Number(port), hostname, () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let out = "";
        s.setTimeout(3000, () => { s.destroy(); resolve("no answer"); });
        s.on("data", (d) => (out += d));
        s.on("close", () => resolve(out.split("\r\n")[0] ?? ""));
        s.on("error", reject);
      });
      assert.match(statusLine, /^HTTP\/1\.1 400/, `${target} answered: ${statusLine}`);
    }
    assert.equal((await jsonFetch(`${base}/api/auth/status`)).status, 200, "and the next request is served as usual");
  });
});

/*
 * An address that parses can still carry an escape that does not decode ("%E0%A4%A", "%ZZ"). The
 * route's parameters were decoded with nothing to catch the URIError, so it answered 500 and logged
 * an error with its stack — for anyone, signed in or not. Five handlers decoded their parameter a
 * second time, where an escape that decodes once ("%25ZZ" is "%ZZ") failed the same way.
 */
test("a path whose escapes do not decode is a bad request, not a server error", async () => {
  await withServer(async (base) => {
    const auth = { authorization: `Bearer ${await ownerToken(base)}` };
    for (const path of ["/api/players/%E0%A4%A", "/api/players/%ZZ/events", "/s/%ZZ/api/get_version", "/stats/%ZZ/api/get_version"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 400, `${path}, signed out`);
      assert.equal((await fetch(`${base}${path}`, { headers: auth })).status, 400, `${path}, signed in`);
    }
    const server = (await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "S1", host: "127.0.0.1", port: 1, password: "secret" }) })).body.server;
    const group = (await jsonFetch(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "G" }) })).body.group;
    const once = [
      ["DELETE", `/api/player-groups/${group.id}/members/%25ZZ`, 404],
      ["GET", "/api/player-groups/for/%25ZZ", 200],
      ["DELETE", `/api/servers/${server.id}/admins/%25ZZ`, 409],
      ["PUT", `/api/servers/${server.id}/maps/%25ZZ/name`, 200],
      ["PUT", `/api/servers/${server.id}/maps/%25ZZ/family`, 200],
    ] as const;
    for (const [method, path, status] of once) {
      const r = await jsonFetch(`${base}${path}`, { method, headers: auth, ...(method === "PUT" ? { body: JSON.stringify({}) } : {}) });
      assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await jsonFetch(`${base}/api/players/${encodeURIComponent("76561198000000001")}/events`, { headers: auth })).status, 404, "an id that decodes still reaches its route");
  });
});

/*
 * Names a request picks from a fixed list (an action, a category, a source, a public command) were
 * looked up in plain objects, where "constructor", "toString" and "__proto__" are found too: an
 * action of "constructor" answered 500 to any signed-in account, a trim of the "toString" category
 * likewise, and the public stats mount answered such a command as unimplemented rather than unknown.
 * Each now answers exactly as a name that is not on the list.
 */
test("a name that is a built-in object property is an unknown name like any other", async () => {
  await withServer(async (base, repo) => {
    const auth = { authorization: `Bearer ${await ownerToken(base)}` };
    const server = (await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "S1", host: "127.0.0.1", port: 1, password: "secret" }) })).body.server;
    await repo.servers.setStreamerMode(server.id, true);
    const group = (await jsonFetch(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "G" }) })).body.group;
    // A member, so a group action gets as far as its members rather than stopping at an empty group.
    assert.equal((await jsonFetch(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000001", playerName: "Able" }) })).status, 201);
    const post = (path: string, body: unknown) => jsonFetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const asks = (name: string) => [
      post(`/api/servers/${server.id}/actions`, { action: name, playerId: "76561198000000001" }),
      post(`/api/servers/${server.id}/actions/bulk`, { action: name, players: [{ playerId: "76561198000000001" }] }),
      post(`/api/player-groups/${group.id}/apply`, { action: name, serverId: server.id }),
      post("/api/trim/preview", { categories: [name], olderThanDays: 30 }),
      jsonFetch(`${base}/api/economy/activity?kind=${name}`, { headers: auth }),
      jsonFetch(`${base}/api/automation/history?sources=${name}`, { headers: auth }),
      jsonFetch(`${base}/api/mapvote/${name}/x/versions`, { headers: auth }),
      jsonFetch(`${base}/api/mapvote/${name}/deleted`, { headers: auth }),
      jsonFetch(`${base}/s/${server.id}/api/${name}`),
      jsonFetch(`${base}/s/${server.id}/api/${name}`, { method: "POST" }),
    ];
    const answer = async (name: string) => (await Promise.all(asks(name))).map((r) => `${r.status} ${typeof r.body.error === "string" ? r.body.error : r.body.error?.code ?? ""}`);
    const unknown = await answer("nosuch");
    assert.ok(unknown.every((a) => /^4\d\d /.test(a)), `an unknown name is refused everywhere: ${unknown.join(" | ")}`);
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.deepEqual(await answer(name), unknown, `"${name}" is answered like "nosuch"`);
    }
  });
});

test("auth status reports first-run then initialized", async () => {
  await withServer(async (base) => {
    const before = await jsonFetch(`${base}/api/auth/status`);
    assert.equal(before.status, 200);
    assert.equal((before.body as any).hasUsers, false); // fresh instance -> create owner
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "a", password: "p" }) });
    const after = await jsonFetch(`${base}/api/auth/status`);
    assert.equal((after.body as any).hasUsers, true); // now initialized -> log in
  });
});

test("second owner registration without auth is forbidden", async () => {
  await withServer(async (base) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "a", password: "p" }) });
    const second = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "b", password: "p" }) });
    assert.equal(second.status, 403);
  });
});

test("auth is required and wrong credentials rejected", async () => {
  await withServer(async (base) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "a", password: "p" }) });
    assert.equal((await jsonFetch(`${base}/api/servers`)).status, 401);
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "a", password: "nope" }) })).status, 401);
  });
});

test("second registration without owner auth is forbidden", async () => {
  await withServer(async (base) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "p" }) });
    const second = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "intruder", password: "p" }) });
    assert.equal(second.status, 403);
  });
});

test("trim endpoints: catalog, per-type preview, then delete only the matched slices", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    // A real server row — events and snapshots reference the server by uuid on Postgres.
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "T", host: "127.0.0.1", port: 1, password: "x" }) });
    const sid = (created.body as any).server.id as string;

    // seed events + one dataset (an old and a new roster snapshot) directly in the store
    await repo.events.insert([
      { serverId: sid, ts: "2024-01-01T00:00:00.000Z", kind: "evt.kill", actorName: "a", victimName: "b" },
      { serverId: sid, ts: new Date().toISOString(), kind: "evt.kill", actorName: "c", victimName: "d" },
      { serverId: sid, ts: "2024-01-01T00:00:00.000Z", kind: "evt.player.connected", actorName: "e" },
    ]);
    await repo.rosterSnapshots.record({ serverId: sid, ts: "2024-01-01T00:00:00.000Z", playerCount: 3, composition: {} });
    await repo.rosterSnapshots.record({ serverId: sid, ts: new Date().toISOString(), playerCount: 9, composition: {} });

    // the catalog the panel renders: categories and datasets from the same source the stores use
    const options = await jsonFetch(`${base}/api/trim/options`, { headers: auth });
    assert.equal(options.status, 200);
    assert.ok((options.body as any).categories.some((c: any) => c.id === "kills" && c.label));
    assert.ok((options.body as any).datasets.some((d: any) => d.id === "rosterSnapshots" && d.label));

    const preview = await jsonFetch(`${base}/api/trim/preview`, { method: "POST", headers: auth, body: JSON.stringify({ categories: ["kills"], datasets: ["rosterSnapshots"], olderThanDays: 365 }) });
    assert.equal(preview.status, 200);
    assert.equal((preview.body as any).perCategory.kills, 1); // only the old kill
    assert.equal((preview.body as any).datasets.rosterSnapshots, 1); // only the old snapshot
    assert.equal((preview.body as any).total, 2);

    const trim = await jsonFetch(`${base}/api/trim`, { method: "POST", headers: auth, body: JSON.stringify({ categories: ["kills"], datasets: ["rosterSnapshots"], olderThanDays: 365 }) });
    assert.equal((trim.body as any).events.deleted, 1);
    assert.equal((trim.body as any).datasets.rosterSnapshots.deleted, 1);
    assert.equal((trim.body as any).total, 2);

    // remaining: recent kill + old connection (different category) + the recent snapshot
    const events = await jsonFetch(`${base}/api/servers/${sid}/events`, { headers: auth });
    assert.equal((events.body as any).events.length, 2);
    assert.equal((await repo.rosterSnapshots.latest(sid))?.playerCount, 9);

    // events-only and datasets-only both remain valid requests
    const evOnly = await jsonFetch(`${base}/api/trim`, { method: "POST", headers: auth, body: JSON.stringify({ categories: ["connections"], olderThanDays: 365 }) });
    assert.equal((evOnly.body as any).events.deleted, 1);
    const dsOnly = await jsonFetch(`${base}/api/trim`, { method: "POST", headers: auth, body: JSON.stringify({ datasets: ["rosterSnapshots"], olderThanDays: 0 }) });
    assert.equal((dsOnly.body as any).events, null, "no categories picked, so no event slice ran");
    assert.equal((dsOnly.body as any).datasets.rosterSnapshots.deleted, 1);

    // a typo'd dataset id is refused by name — it must not read as "already clean"
    const bogus = await jsonFetch(`${base}/api/trim/preview`, { method: "POST", headers: auth, body: JSON.stringify({ datasets: ["rosterSnapshotz"], olderThanDays: 1 }) });
    assert.equal(bogus.status, 400);

    /*
     * A cutoff that was not SAID is not zero. Zero is legitimate ("everything older than now") and
     * is therefore the most destructive value there is, so every non-number must be refused rather
     * than coerced into it: `Number(null)`, `Number("")` and `Number([])` are all 0, and the
     * panel's days box is free text — a cleared field or a typo arrived as JSON null and asked to
     * delete the lot.
     */
    for (const bad of [null, "", "  ", [], {}, true, "abc", undefined]) {
      const r = await jsonFetch(`${base}/api/trim/preview`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ datasets: ["rosterSnapshots"], olderThanDays: bad }),
      });
      assert.equal(r.status, 400, `olderThanDays: ${JSON.stringify(bad)} must be refused, not read as 0`);
    }
    // …and a number, or a string that is one, still is a cutoff.
    for (const good of [0, 7, "30"]) {
      const r = await jsonFetch(`${base}/api/trim/preview`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ datasets: ["rosterSnapshots"], olderThanDays: good }),
      });
      assert.equal(r.status, 200, `olderThanDays: ${JSON.stringify(good)} is a cutoff`);
    }
  });
});

test("staff announcements: reading requires a session; posting requires community.edit", async () => {
  await withServer(async (base, _repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // create a draft and a posted notice (owner has community.edit via wildcard)
    await jsonFetch(`${base}/api/community/announcements`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Draft", body: "x", published: false }) });
    const pub = await jsonFetch(`${base}/api/community/announcements`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Live", body: "y", published: true }) });
    assert.equal(pub.status, 201);

    // NOT public any more: no session → 401 (the public site lives on its own domain now).
    assert.equal((await jsonFetch(`${base}/api/community/announcements`)).status, 401);

    // any logged-in staff member reads posted notices only
    const authedList = await jsonFetch(`${base}/api/community/announcements`, { headers: auth });
    assert.equal(authedList.status, 200);
    assert.equal((authedList.body as any).announcements.length, 1);
    assert.equal((authedList.body as any).announcements[0].title, "Live");

    // editor listAll shows both (draft included)
    const all = await jsonFetch(`${base}/api/community/announcements/all`, { headers: auth });
    assert.equal((all.body as any).announcements.length, 2);

    // a non-editor can read posted notices; creating one is asked for, not done
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mod", password: "p" }) });
    const modLogin = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "mod", password: "p" }) });
    const modAuth = { authorization: `Bearer ${(modLogin.body as any).token}` };
    assert.equal((await jsonFetch(`${base}/api/community/announcements`, { headers: modAuth })).status, 200);
    const denied = await jsonFetch(`${base}/api/community/announcements`, { method: "POST", headers: modAuth, body: JSON.stringify({ title: "no", body: "no" }) });
    assertAsked(denied);
    assert.equal(((await jsonFetch(`${base}/api/community/announcements/all`, { headers: auth })).body as any).announcements.length, 2, "nothing was posted");
  });
});

test("layout: defaults, per-user save/resolve, and instance-scope permission", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // defaults from the registry
    const def = await jsonFetch(`${base}/api/layout/admin`, { headers: auth });
    assert.equal(def.status, 200);
    assert.equal((def.body as any).source, "default");
    const ids = (def.body as any).widgets.map((w: any) => w.id);
    assert.ok(ids.includes("servers") && ids.includes("trim"));

    // save a per-user layout: hide "trim", move "leaderboard" first
    const config = { items: [
      { widgetId: "leaderboard", visible: true, order: 0 },
      { widgetId: "trim", visible: false, order: 999 },
    ]};
    const saved = await jsonFetch(`${base}/api/layout/admin`, { method: "PUT", headers: auth, body: JSON.stringify({ config, scope: "user" }) });
    assert.equal((saved.body as any).saved, true);

    const resolved = await jsonFetch(`${base}/api/layout/admin`, { headers: auth });
    assert.equal((resolved.body as any).source, "user");
    const widgets = (resolved.body as any).widgets;
    assert.equal(widgets[0].id, "leaderboard"); // reordered to first
    assert.equal(widgets.find((w: any) => w.id === "trim").visible, false); // hidden
    // widgets the saved config doesn't mention fall back to their registry default — "players" is
    // default-visible, "servers" is registered-but-hidden since it became a Config tab.
    assert.equal(widgets.find((w: any) => w.id === "players").visible, true);
    assert.equal(widgets.find((w: any) => w.id === "servers").visible, false);

    // unknown surface 404
    assert.equal((await jsonFetch(`${base}/api/layout/bogus`, { headers: auth })).status, 404);

    // a malformed widget config is refused, not stored verbatim for every future load to trip on
    for (const bad of [
      { items: [{ widgetId: "trim" }] },                                     // missing fields
      { items: [{ widgetId: "trim", visible: true, order: 1, size: { w: 99, h: 1 } }] }, // size out of range
      { items: "nope" },                                                     // wrong container
    ]) {
      const r = await jsonFetch(`${base}/api/layout/admin`, { method: "PUT", headers: auth, body: JSON.stringify({ config: bad, scope: "user" }) });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });
});

test("layout: instance scope requires layout.edit (mod is forbidden)", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    // owner can save instance default
    const ok = await jsonFetch(`${base}/api/layout/admin`, { method: "PUT", headers: auth, body: JSON.stringify({ config: { items: [] }, scope: "instance" }) });
    assert.equal((ok.body as any).scope, "instance");

    // a grantless mod cannot — the change is asked for, not made
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mod", password: "p" }) });
    const modLogin = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "mod", password: "p" }) });
    const modAuth = { authorization: `Bearer ${(modLogin.body as any).token}` };
    const denied = await jsonFetch(`${base}/api/layout/admin`, { method: "PUT", headers: modAuth, body: JSON.stringify({ config: { items: [] }, scope: "instance" }) });
    assertAsked(denied);
    assert.equal((await repo.audit.list({ actions: ["layout.instance"], limit: 10 })).length, 1, "only the owner's default was saved");
    // ...but the mod CAN save their own user layout
    const own = await jsonFetch(`${base}/api/layout/admin`, { method: "PUT", headers: modAuth, body: JSON.stringify({ config: { items: [] }, scope: "user" }) });
    assert.equal(own.status, 200);
  });
});

test("layout: panel surfaces — strict config, per-user + instance resolution, reset via DELETE", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // nothing saved: the client falls back to its own defaults
    const def = await jsonFetch(`${base}/api/layout/panel:enforcer`, { headers: auth });
    assert.equal(def.status, 200);
    assert.equal((def.body as any).source, "default");
    assert.equal((def.body as any).config, null);

    // save an arrangement; unknown keys are dropped, known ones come back verbatim
    const config = { order: ["rules", "ladder"], collapsed: ["ladder"], hidden: ["legend"], widths: { rules: 6 }, touched: true, reordered: true, junk: "nope" };
    const saved = await jsonFetch(`${base}/api/layout/panel:enforcer`, { method: "PUT", headers: auth, body: JSON.stringify({ config, scope: "user" }) });
    assert.equal(saved.status, 200);
    const mine = await jsonFetch(`${base}/api/layout/panel:enforcer`, { headers: auth });
    assert.equal((mine.body as any).source, "user");
    assert.deepEqual((mine.body as any).config, { order: ["rules", "ladder"], collapsed: ["ladder"], hidden: ["legend"], widths: { rules: 6 }, touched: true, reordered: true });

    // malformed configs are refused, not stored for every future page load to trip on
    for (const bad of [
      { order: [42] },                     // non-string id
      { widths: { rules: 40 } },           // width out of range
      { widths: ["rules"] },               // wrong container
      { hidden: Array.from({ length: 201 }, (_, i) => `p${i}`) }, // unbounded list
    ]) {
      const r = await jsonFetch(`${base}/api/layout/panel:enforcer`, { method: "PUT", headers: auth, body: JSON.stringify({ config: bad, scope: "user" }) });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }

    // instance scope: owner may set a team default; a grantless mod may only ask, but SEES it once
    // their own layout is out of the way — unchanged by the ask
    const inst = await jsonFetch(`${base}/api/layout/panel:enforcer`, { method: "PUT", headers: auth, body: JSON.stringify({ config: { order: ["ladder", "rules"] }, scope: "instance" }) });
    assert.equal((inst.body as any).scope, "instance");
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mod2", password: "p" }) });
    const modLogin = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "mod2", password: "p" }) });
    const modAuth = { authorization: `Bearer ${(modLogin.body as any).token}` };
    assertAsked(await jsonFetch(`${base}/api/layout/panel:enforcer`, { method: "PUT", headers: modAuth, body: JSON.stringify({ config: {}, scope: "instance" }) }));
    const forMod = await jsonFetch(`${base}/api/layout/panel:enforcer`, { headers: modAuth });
    assert.equal((forMod.body as any).source, "instance");
    assert.deepEqual((forMod.body as any).config.order, ["ladder", "rules"]);

    // DELETE forgets the caller's OWN layout only — the owner falls back to the instance default
    const del = await jsonFetch(`${base}/api/layout/panel:enforcer`, { method: "DELETE", headers: auth });
    assert.equal((del.body as any).removed, true);
    const after = await jsonFetch(`${base}/api/layout/panel:enforcer`, { headers: auth });
    assert.equal((after.body as any).source, "instance");

    // a surface that is neither a registered widget surface nor a well-formed panel id stays 404
    assert.equal((await jsonFetch(`${base}/api/layout/panel:`, { headers: auth })).status, 404);
    assert.equal((await jsonFetch(`${base}/api/layout/panel:bad!id`, { headers: auth })).status, 404);
  });
});

test("layout: panel surface names are capped per account (new names blocked, upkeep allowed)", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    // Panel surface names are minted by the caller, so a signed-in account could otherwise grow
    // the layouts table without bound. Fill until the cap answers rather than counting to it —
    // on a shared database the earlier tests' layout rows already count against this account.
    let refusedAt = -1;
    for (let i = 0; i <= 300; i++) {
      const r = await jsonFetch(`${base}/api/layout/panel:view${i}`, { method: "PUT", headers: auth, body: JSON.stringify({ config: {}, scope: "user" }) });
      if (r.status === 400) { refusedAt = i; break; }
      assert.equal(r.status, 200, `save ${i} within the allowance`);
    }
    assert.ok(refusedAt > 250, `a real screenful of pages fits before the cap refuses (refused at ${refusedAt})`);
    // …but an existing surface still re-saves: the cap blocks new names, not upkeep of old ones.
    const upkeep = await jsonFetch(`${base}/api/layout/panel:view0`, { method: "PUT", headers: auth, body: JSON.stringify({ config: { hidden: ["x"] }, scope: "user" }) });
    assert.equal(upkeep.status, 200);
  });
});

test("plugins: none ship by default — the retired killfeed page stays gone", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // No built-ins and no PLUGINS_DIR in tests → an empty plugin listing, exactly as production
    // runs since the killfeed example page was retired (the Live view's feed replaced it).
    const plugins = await jsonFetch(`${base}/api/plugins`, { headers: auth });
    assert.equal(plugins.status, 200);
    assert.deepEqual((plugins.body as any).plugins, []);

    // ...so the admin layout carries only first-party widgets, and no killfeed page.
    const layout = await jsonFetch(`${base}/api/layout/admin`, { headers: auth });
    const widgets = (layout.body as any).widgets as any[];
    assert.ok(widgets.length > 0, "first-party admin widgets are still there");
    assert.ok(!widgets.some((w) => w.id === "killfeed:feed"), "the killfeed page is gone");
  });
});

test("leaderboard reflects accumulated stats", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const srv = await repo.servers.create({ name: "Board", host: "1.1.1.1", port: 28950, password: "p" });
    const p1 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Ace" });
    const p2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "222", name: "Rook" });
    await repo.stats.bump(p1.id, srv.id, { kills: 10, deaths: 2 });
    await repo.stats.bump(p2.id, srv.id, { kills: 3, deaths: 3 });

    const lb = await jsonFetch(`${base}/api/leaderboard?sort=kills`, { headers: auth });
    assert.equal(lb.status, 200);
    const board = (lb.body as any).leaderboard;
    assert.equal(board[0].name, "Ace"); // most kills first
    assert.equal(board[0].kd, 5); // 10/2

    // Scoped to the one server these stats were earned on: the same board.
    const scoped = await jsonFetch(`${base}/api/leaderboard?sort=kills&serverId=${srv.id}`, { headers: auth });
    assert.equal((scoped.body as any).leaderboard[0].name, "Ace");
    assert.equal((scoped.body as any).serverId, srv.id, "the response says which server it is for");
    // Scoped to a server nobody played on: empty, rather than the merged board it used to return.
    const other = await repo.servers.create({ name: "Quiet", host: "1.1.1.2", port: 28951, password: "p" });
    const empty = await jsonFetch(`${base}/api/leaderboard?sort=kills&serverId=${other.id}`, { headers: auth });
    assert.deepEqual((empty.body as any).leaderboard, []);
    assert.equal((empty.body as any).total, 0);
  });
});

/*
 * The standings a page at a time, with how many players they rank: the board stopped at the top
 * fifty, and a player below them could not be found on it.
 */
test("the leaderboard comes a page at a time, places down from the top, with how many it ranks", async () => {
  await withServer(async (base, repo) => {
    const auth = { authorization: `Bearer ${await ownerToken(base)}` };
    const srv = await repo.servers.create({ name: "Paged board", host: "1.1.1.3", port: 28952, password: "p" });
    for (let i = 1; i <= 7; i++) {
      const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `9${i}`, name: `Place ${i}` });
      await repo.stats.bump(p.id, srv.id, { kills: 100 - i, deaths: 1 });
    }
    const page = async (q: string) => (await jsonFetch(`${base}/api/leaderboard?sort=kills&serverId=${srv.id}${q}`, { headers: auth })).body as any;
    const names = (b: any) => b.leaderboard.map((e: { name: string }) => e.name);
    assert.deepEqual(names(await page("&limit=3")), ["Place 1", "Place 2", "Place 3"]);
    const second = await page("&offset=3&limit=3");
    assert.deepEqual(names(second), ["Place 4", "Place 5", "Place 6"], "three places down");
    assert.equal(second.total, 7, "and how many players the board ranks");
    assert.deepEqual(names(await page("&offset=6&limit=3")), ["Place 7"]);
  });
});

test("player profile surfaces alias history (past names + clan tags)", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const t1 = "2026-01-01T00:00:00.000Z", t2 = "2026-02-01T00:00:00.000Z";
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "999", name: "Ghost", clanTag: "OLD", ts: t1 });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "999", name: "Phantom", clanTag: "NEW", ts: t2 });

    const prof = await jsonFetch(`${base}/api/players/${p.id}`, { headers: auth });
    assert.equal(prof.status, 200);
    const body = prof.body as any;
    // "Phantom" is the current name, so past names is just ["Ghost"]; both clan tags are history.
    assert.deepEqual(body.pastNames.map((a: any) => a.value), ["Ghost"]);
    assert.deepEqual(body.clanTags.map((a: any) => a.value).sort(), ["NEW", "OLD"]);
    assert.equal(body.currentClan, "NEW");

    // The profile is also reachable by the game platform id, so a name clicked in a live read (which
    // only carries the platform id) opens the right profile.
    const byPlatform = await jsonFetch(`${base}/api/players/999`, { headers: auth });
    assert.equal(byPlatform.status, 200);
    assert.equal((byPlatform.body as any).player.id, p.id);
  });
});

test("player profile: sessions show for all; moderation history is gated by moderation.bans", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerToken(base);
    const ownerAuth = { authorization: `Bearer ${owner}` };
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "555", name: "Rowdy" });
    // one completed session, on a real server row (sessions reference the server by uuid)
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ name: "T", host: "127.0.0.1", port: 1, password: "x" }) });
    const sid = (created.body as any).server.id as string;
    await repo.sessions.open(player.id, sid, "2026-03-01T10:00:00.000Z");
    await repo.sessions.close(player.id, sid, "2026-03-01T10:45:00.000Z");
    // a manual kick (audited by the game player id = platformId) and an auto-mod action (by our id)
    await repo.audit.create({ actorName: "admin", action: "player.kick", targetType: "player", targetId: player.platformId, targetName: "Rowdy", summary: "admin ran kick on Rowdy" });
    await repo.audit.create({ actorName: "system", action: "enforcer.tempban", targetType: "player", targetId: player.id, targetName: "Rowdy", summary: "auto tempban" });

    // owner (superuser) sees both moderation entries and the session
    const asOwner = await jsonFetch(`${base}/api/players/${player.id}`, { headers: ownerAuth });
    assert.equal(asOwner.status, 200);
    const ob = asOwner.body as any;
    assert.equal(ob.canViewModeration, true);
    assert.deepEqual(ob.moderation.map((m: any) => m.action).sort(), ["enforcer.tempban", "player.kick"]);
    assert.equal(ob.sessions.length, 1);
    assert.equal(ob.sessions[0].durationSec, 2700);

    // a user with server.view but NOT moderation.bans: sessions visible, moderation withheld
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ username: "viewer", password: "pw" }) });
    const u = await repo.users.findByUsername("viewer");
    await repo.grants.create({ userId: u!.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "viewer", password: "pw" }) });
    const viewerAuth = { authorization: `Bearer ${(login.body as any).token}` };

    const asViewer = await jsonFetch(`${base}/api/players/${player.id}`, { headers: viewerAuth });
    assert.equal(asViewer.status, 200);
    const vb = asViewer.body as any;
    assert.equal(vb.canViewModeration, false);
    assert.equal(vb.moderation, undefined);
    assert.equal(vb.sessions.length, 1); // sessions aren't gated
  });
});

// The blacklist routes are gone — the ban record (player_ban decisions, /api/bans) replaced them.
// docs/ban-model.md tells that story; ban-record.test.ts covers the successor end to end.

test("server create: game must be a registered module; games list feeds the form", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // registered games are listable (id + label)
    const games = await jsonFetch(`${base}/api/games`, { headers: auth });
    assert.equal(games.status, 200);
    assert.ok((games.body as any).games.some((g: any) => g.id === "hll"));

    // creating with an unregistered game is rejected with the known list
    const bad = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "1.2.3.4", port: 1, password: "x", game: "quake" }) });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /unknown game/);

    // explicit game sticks on the created server
    const ok = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "1.2.3.4", port: 2, password: "x", game: "hll" }) });
    assert.equal(ok.status, 201);
    assert.equal((ok.body as any).server.game, "hll");

    // HLL: Vietnam is a first-class game: listable, creatable over the shared v2 protocol, and
    // its descriptor (US/NVA, platoons, Vietnam weapon buckets) is served to the panel.
    assert.ok((games.body as any).games.some((g: any) => g.id === "hllv"), "hllv offered on the Add Server form");
    const viet = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "1.2.3.4", port: 3, password: "x", game: "hllv", protocol: "binary-v2" }) });
    assert.equal(viet.status, 201);
    assert.equal((viet.body as any).server.game, "hllv");
    const desc = await jsonFetch(`${base}/api/games/hllv/descriptor`, { headers: auth });
    assert.equal(desc.status, 200);
    const d = (desc.body as any).descriptor;
    assert.deepEqual(d.sides.map((s: any) => s.label), ["US", "NVA"]);
    assert.equal(d.squadLabel, "Platoon");
    assert.ok(d.weaponClasses.some((c: any) => c.id === "mortar"), "Vietnam's mortar bucket reaches the panel");
    // A protocol the game does not support is refused with the supported list, not stored.
    const badProto = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "1.2.3.4", port: 4, password: "x", game: "hllv", protocol: "crcon-bridge", crconBaseUrl: "http://x" }) });
    assert.equal(badProto.status, 400);
    assert.match(JSON.stringify(badProto.body), /not supported by Hell Let Loose: Vietnam/);
  });
});

/**
 * Correcting a server's game after the fact.
 *
 * The game could be set wrong at creation — env discovery had no way to name one — and was then
 * permanent, which for a Vietnam server labelled HLL means every read of it is misinterpreted
 * while nothing ever errors. This is the repair, and it has to be as guarded as creation is.
 */
test("a server's game can be corrected, validated the same way creation is", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "10.9.9.9", port: 28865, password: "x" }) });
    const id = (created.body as any).server.id;
    assert.equal((created.body as any).server.game, "hll");

    // Unknown games are refused with the list that would work — nothing is written.
    const bad = await jsonFetch(`${base}/api/servers/${id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "quake" }) });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /unknown game/);

    // A protocol the new game cannot speak is refused too.
    const badProto = await jsonFetch(`${base}/api/servers/${id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "hllv", protocol: "crcon-bridge" }) });
    assert.equal(badProto.status, 400);
    assert.match(JSON.stringify(badProto.body), /not supported by Hell Let Loose: Vietnam/);

    // The correction itself: the game changes, the shared protocol is kept, and it is recorded.
    const fixed = await jsonFetch(`${base}/api/servers/${id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "hllv" }) });
    assert.equal(fixed.status, 200);
    assert.equal((fixed.body as any).server.game, "hllv");
    assert.equal((fixed.body as any).server.protocol, "binary-v2", "both games speak it, so it stands");
    assert.equal((fixed.body as any).changed, true);

    const trail = await jsonFetch(`${base}/api/audit?limit=50`, { headers: auth });
    const entry = (trail.body as any).entries.find((a: any) => a.action === "server.game");
    assert.ok(entry, "the relabel is in the staff trail");
    assert.match(entry.summary, /Hell Let Loose: Vietnam/);
    assert.match(entry.summary, /was hll/, "the summary says what it used to be");

    // Setting the same game again is a no-op rather than a second audit row.
    const again = await jsonFetch(`${base}/api/servers/${id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "hllv" }) });
    assert.equal((again.body as any).changed, false);
    const trail2 = await jsonFetch(`${base}/api/audit?limit=50`, { headers: auth });
    assert.equal((trail2.body as any).entries.filter((a: any) => a.action === "server.game").length, 1);
  });
});

test("correcting a server's game needs server.manage write, not merely a login", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ host: "10.9.9.8", port: 28865, password: "x" }) });
    const id = (created.body as any).server.id;

    // A signed-in account with only read access cannot relabel a server: it is asked for, not done.
    const viewer = await jsonFetch(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "viewer-game", password: "pw-viewer-1234" }) });
    assert.equal(viewer.status, 201);
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer-game", password: "pw-viewer-1234" }) });
    const viewerAuth = { authorization: `Bearer ${(login.body as any).token}`, "content-type": "application/json" };
    const denied = await jsonFetch(`${base}/api/servers/${id}/game`, { method: "POST", headers: viewerAuth, body: JSON.stringify({ game: "hllv" }) });
    assert.equal((await askedFor(base, auth, denied)).capability, "server.manage");
    const servers = await jsonFetch(`${base}/api/servers`, { headers: auth });
    assert.equal(servers.status, 200);
    assert.equal(((servers.body as any).servers as any[]).find((s) => s.id === id).game, "hll", "the game was not changed");
  });
});

test("trim requires admin (unknown category rejected, no auth rejected)", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await jsonFetch(`${base}/api/trim/preview`, { method: "POST", body: JSON.stringify({ categories: ["kills"], olderThanDays: 1 }) })).status, 401);
    assert.equal((await jsonFetch(`${base}/api/trim/preview`, { method: "POST", headers: auth, body: JSON.stringify({ categories: ["bogus"], olderThanDays: 1 }) })).status, 400);
  });
});

test("api tokens: create returns the secret once, list hides the hash, revoke works", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // create
    const created = await jsonFetch(`${base}/api/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ name: "bot" }) });
    assert.equal(created.status, 201);
    assert.ok((created.body as any).token, "secret returned on create");
    const id = (created.body as any).id as string;

    // list — never exposes the hash, includes our token
    const list = await jsonFetch(`${base}/api/tokens`, { headers: auth });
    assert.equal(list.status, 200);
    const rows = (list.body as any).tokens as any[];
    assert.ok(rows.find((t) => t.id === id && t.name === "bot"));
    assert.ok(rows.every((t) => t.tokenHash === undefined && t.token === undefined), "no secret material in list");

    // the created token actually authenticates
    const me = await jsonFetch(`${base}/api/me`, { headers: { authorization: `Bearer ${(created.body as any).token}` } });
    assert.equal(me.status, 200);

    // revoke, then it's gone
    assert.equal((await jsonFetch(`${base}/api/tokens/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jsonFetch(`${base}/api/tokens/${id}`, { method: "DELETE", headers: auth })).status, 404);
    const after = await jsonFetch(`${base}/api/tokens`, { headers: auth });
    assert.equal(((after.body as any).tokens as any[]).length, 0);
  });
});

test("plugins list requires auth and returns manifests", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonFetch(`${base}/api/plugins`)).status, 401);
    const token = await ownerToken(base);
    const r = await jsonFetch(`${base}/api/plugins`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((r.body as any).plugins));
  });
});

test("host metrics: requires auth and returns cpu/memory shape", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonFetch(`${base}/api/health/metrics`)).status, 401);
    const token = await ownerToken(base);
    const r = await jsonFetch(`${base}/api/health/metrics`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    const b = r.body as any;
    assert.equal(b.online, true);
    assert.equal(typeof b.cpuPct, "number");
    assert.ok(b.memory && typeof b.memory.pct === "number" && b.memory.totalBytes > 0);
    assert.ok(typeof b.uptimeSec === "number");

    // The build stamp: the commit baked into the image by the start scripts. An empty string is
    // what a manual `docker compose` build bakes — that must read as "no stamp", never as v"".
    const prev = process.env.APP_COMMIT;
    try {
      process.env.APP_COMMIT = "20f49d9";
      const stamped = await jsonFetch(`${base}/api/health/metrics`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((stamped.body as any).appCommit, "20f49d9", "the baked commit is reported");
      process.env.APP_COMMIT = "";
      const blank = await jsonFetch(`${base}/api/health/metrics`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((blank.body as any).appCommit, null, "an unstamped build reports null, not an empty string");
    } finally {
      if (prev === undefined) delete process.env.APP_COMMIT; else process.env.APP_COMMIT = prev;
    }
  });
});

test("services health: gated by staff.analytics; reports in-process + missing worker as down", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonFetch(`${base}/api/health/services`)).status, 401);
    const token = await ownerToken(base);
    const r = await jsonFetch(`${base}/api/health/services`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    const b = r.body as any;
    const names = (b.services as any[]).map((s) => s.name);
    assert.ok(names.includes("api") && names.includes("database") && names.includes("event_bus"));
    // worker never ran in this test → ingestion shows down
    const ingestion = (b.services as any[]).find((s) => s.name === "ingestion");
    assert.equal(ingestion.status, "down");
    assert.ok(typeof b.summary.running === "number");
  });
});

test("services health: a fresh heartbeat shows the worker running", async () => {
  await withServer(async (base, repo) => {
    await repo.heartbeats.upsert({ name: "ingestion", status: "running", detail: { servers: 2 } });
    const token = await ownerToken(base);
    const r = await jsonFetch(`${base}/api/health/services`, { headers: { authorization: `Bearer ${token}` } });
    const ingestion = (r.body as any).services.find((s: any) => s.name === "ingestion");
    assert.equal(ingestion.status, "running");
    assert.equal(ingestion.detail.servers, 2);
  });
});

test("capability-gated dashboard widgets are filtered by grant", async () => {
  await withServer(async (base) => {
    const owner = await ownerToken(base);
    const ownerAuth = { authorization: `Bearer ${owner}` };
    // owner ("*") sees the gated Team activity widget
    const forOwner = await jsonFetch(`${base}/api/layout/dashboard`, { headers: ownerAuth });
    const ownerIds = (forOwner.body as any).widgets.map((w: any) => w.id);
    assert.ok(ownerIds.includes("dash-team-activity"), "owner sees gated widget");

    // a plain user (no staff.analytics) does NOT
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ username: "plainw", password: "pw" }) });
    const plain = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plainw", password: "pw" }) });
    const plainAuth = { authorization: `Bearer ${(plain.body as any).token}` };
    const forPlain = await jsonFetch(`${base}/api/layout/dashboard`, { headers: plainAuth });
    const plainIds = (forPlain.body as any).widgets.map((w: any) => w.id);
    assert.ok(!plainIds.includes("dash-team-activity"), "plain user does not see gated widget");
    assert.ok(plainIds.includes("dash-recent"), "but still sees ungated widgets");
  });
});

test("literal paths win over the :param routes that would otherwise swallow them", async () => {
  // Route matching is first-declared-wins, so `/api/players/flagged` only reaches the watchlist
  // because it is registered before `/api/players/:id` — otherwise "flagged" is read as a player id
  // and the watchlist 404s. Two such pairs exist and nothing in the type system protects them, so
  // any reordering of the route table (a split into modules, an alphabetise, a merge) has to keep
  // passing this.
  await withServer(async (base) => {
    const owner = { authorization: `Bearer ${await ownerToken(base)}` };

    const flagged = await jsonFetch(`${base}/api/players/flagged`, { headers: owner });
    assert.equal(flagged.status, 200, "the watchlist answers");
    assert.ok(Array.isArray((flagged.body as any).flags), `it is the watchlist, not one player: ${JSON.stringify(flagged.body).slice(0, 120)}`);
    assert.equal((flagged.body as any).player, undefined, "a player profile here means :id matched first");

  });
});

/*
 * The server NUMBER is a fact about the community, not about who is reading.
 *
 * It used to be the panel's own index into the list it was handed — and that list is filtered to
 * the servers the reader may see. A staff member granted the third server alone received a
 * one-server list and was shown "Server 1", so two people looking at the same machine called it
 * by different numbers, and the number in a screenshot meant nothing without knowing whose screen
 * it was.
 */
test("the server number counts across every server, not just the ones you can see", async () => {
  await withServer(async (base, repo) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "hunter2" }) });
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "hunter2" }) });
    const ownerAuth = { authorization: `Bearer ${(login.body as any).token}` };

    // Three servers, created in order — so their numbers are 1, 2, 3 for everybody. Created
    // through the store rather than POST /servers: that route blocks on an RCON name lookup per
    // server, and what is under test is how the GET route numbers them, not how they got there.
    const made: string[] = [];
    for (const name of ["Alpha", "Bravo", "Charlie"]) {
      const s = await repo.servers.create({ name, host: "10.0.0.1", port: 28000 + made.length, password: "x" });
      made.push(s.id);
    }
    const asOwner = (await jsonFetch(`${base}/api/servers`, { headers: ownerAuth })).body as any;
    assert.deepEqual(asOwner.servers.map((s: any) => s.no), [1, 2, 3], "the owner sees them numbered in creation order");

    // A viewer granted ONLY the third server.
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ username: "third", password: "pw" }) });
    const u = await repo.users.findByUsername("third");
    await repo.grants.create({ userId: u!.id, capability: "server.view", scopeType: "server", scopeId: made[2]!, level: "read" });
    const vlogin = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "third", password: "pw" }) });
    const viewerAuth = { authorization: `Bearer ${(vlogin.body as any).token}` };

    const asViewer = (await jsonFetch(`${base}/api/servers`, { headers: viewerAuth })).body as any;
    assert.equal(asViewer.servers.length, 1, "they only see the one they were granted");
    assert.equal(asViewer.servers[0].id, made[2], "and it is the third one");
    assert.equal(asViewer.servers[0].no, 3, "which is Server 3 to them exactly as it is to the owner");
  });
});

/**
 * Changing your own password. The properties, in the order they can hurt: a stolen session
 * cannot use this route as a quiet brute-force door (the login throttle covers it) nor mint a
 * credential for a Discord-only account; a wrong current password changes nothing; a right one
 * signs every OTHER session out while the caller keeps working on the returned token.
 */
test("self-service password change: proves the current password, rotates every other session, keeps this one", async () => {
  await withServer(async (base) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "rotator", password: "old-pw" }) });
    const login = async () => (await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rotator", password: "old-pw" }) })).body.token as string;
    const phone = await login();   // the device being kept
    const laptop = await login();  // the device that was lost

    // Wrong current password: refused, and nothing changed.
    const wrong = await jsonFetch(`${base}/api/me/password`, { method: "PUT", headers: { authorization: `Bearer ${phone}` },
      body: JSON.stringify({ currentPassword: "not-it", newPassword: "new-pw" }) });
    assert.equal(wrong.status, 403);
    assert.equal((await jsonFetch(`${base}/api/me`, { headers: { authorization: `Bearer ${laptop}` } })).status, 200, "a failed attempt must not sign anyone out");

    // Right current password: changed, and the answer carries this session's replacement token.
    const ok = await jsonFetch(`${base}/api/me/password`, { method: "PUT", headers: { authorization: `Bearer ${phone}` },
      body: JSON.stringify({ currentPassword: "old-pw", newPassword: "new-pw" }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const freshToken = ok.body.token as string;

    assert.equal((await jsonFetch(`${base}/api/me`, { headers: { authorization: `Bearer ${laptop}` } })).status, 401, "the lost device is out");
    assert.equal((await jsonFetch(`${base}/api/me`, { headers: { authorization: `Bearer ${phone}` } })).status, 401, "the old token died with the epoch — the replacement is the session now");
    assert.equal((await jsonFetch(`${base}/api/me`, { headers: { authorization: `Bearer ${freshToken}` } })).status, 200, "the caller continues without re-logging in");

    // The new password is the password; the old one is not.
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rotator", password: "old-pw" }) })).status, 401);
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rotator", password: "new-pw" }) })).status, 200);
  });
});

test("the password-change door shares the login throttle — five wrong guesses lock it", async () => {
  await withServer(async (base) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "guessy", password: "right-pw" }) });
    const token = (await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "guessy", password: "right-pw" }) })).body.token as string;
    const attempt = (pw: string) => jsonFetch(`${base}/api/me/password`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword: pw, newPassword: "x" }) });
    for (let i = 0; i < 5; i++) assert.equal((await attempt("wrong")).status, 403);
    assert.equal((await attempt("wrong")).status, 429, "past the budget the answer costs no bcrypt time");
    // And the SAME budget guards the login front door — this route is not a separate allowance.
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "guessy", password: "right-pw" }) })).status, 429);
  });
});
