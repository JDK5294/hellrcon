/**
 * What a plugin can carry now: its own API (routes and live streams), its own permissions in Roles,
 * pages for the panel, held reads of the game servers, the stored game log, the staff trail, sealed
 * values and host commands. One probe plugin declares all of it, and each test drives the real
 * handler the way the panel and a browser's EventSource would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedRepository, type Repository } from "@app/db";
import { definePlugin, HOST_API_VERSION, type PluginModule } from "@app/plugin-sdk";
import { createHandler, createAppContext } from "../dist/app.js";
import { setPluginStreamHeartbeat } from "../dist/plugin-http.js";
import { fakeGameServer } from "./fake-hll-server.ts";
import { jf, ownerAuth } from "./harness.ts";

type Ctx = Awaited<ReturnType<typeof createAppContext>>;

/** What the probe saw, for the assertions that look from the plugin's side. */
const seen = { closes: 0, allow: true };

const probe = definePlugin({
  manifest: {
    id: "probe", name: "Probe", version: "1.0.0", apiVersion: HOST_API_VERSION,
    capabilities: ["api:routes", "ui:page", "game:live", "events:read", "audit", "secrets", "commands"],
    permissions: [
      { key: "view", label: "View the probe", description: "Open the probe page.", outright: true, levels: ["read"] },
      { key: "edit", label: "Edit the probe", description: "Change what the probe holds." },
    ],
  },
  activate(host) {
    const r = host.routes!;
    r.route("GET", "/whoami", (req, res) => res.json(200, {
      userId: req.viewer.userId, name: req.viewer.name, owner: req.viewer.owner,
      view: req.viewer.holds("view"), edit: req.viewer.holds("edit", "write"), ghost: req.viewer.holds("ghost"),
    }));
    r.route("POST", "/echo/:thing", async (req, res) => res.json(200, { thing: req.params.thing, body: await req.body(), q: req.query.get("q") }));
    r.route("PUT", "/cookie", (req, res) => { res.cookie("ok", "a.b-c_d~1", 60); res.json(200, { https: req.https }); });
    r.route("GET", "/cookie", (req, res) => res.json(200, { ok: req.cookie("ok") }));
    r.route("GET", "/silent", () => {});
    r.route("GET", "/boom", () => { throw new Error("kaboom"); });
    r.route("GET", "/bad-header", (_req, res) => { res.header("Set-Cookie", "x=1"); res.json(200, {}); });
    r.route("DELETE", "/gone", (_req, res) => res.notFound());
    r.route("PUT", "/allow", async (req, res) => { seen.allow = (await req.body()).allow === true; res.json(200, { allow: seen.allow }); });
    r.route("GET", "/live", (req, res) => {
      const s = res.stream({ recheck: (v) => seen.allow && v.holds("view") });
      s.onClose(() => { seen.closes += 1; });
      s.send({ hello: req.viewer.name });
    }, { stream: true });
    r.route("GET", "/game/:serverId", async (req, res) => {
      const conn = await host.game!.open(req.params.serverId!);
      try {
        const { session, roster } = await conn.read();
        const hll = host.game!.knowledge("hll")!;
        const teams = new Map<number, number>();
        for (const p of roster) teams.set(Number(p.team), (teams.get(Number(p.team)) ?? 0) + 1);
        res.json(200, {
          map: session.mapName, ids: roster.map((p) => hll.playerId(p)), sides: hll.sides.map((s) => s.id),
          sideOf: Object.fromEntries(hll.resolveTeamSides(teams, session)), servers: await host.game!.servers(),
          unknownGame: host.game!.knowledge("no-such-game"),
        });
      } finally {
        await conn.close();
      }
    });
    r.route("GET", "/kills/:serverId", async (req, res) => res.json(200, {
      rows: await host.history!.window({ serverId: req.params.serverId!, kinds: ["evt.kill"], from: req.query.get("from")!, limit: Number(req.query.get("limit") ?? 10) }),
    }));
    r.route("POST", "/audited", async (req, res) => {
      await host.audit!.record({ viewer: req.viewer, action: "thing.done", summary: "did a thing", data: { n: 1 } });
      res.json(200, {});
    });
    r.route("GET", "/sealed", (_req, res) => {
      const s = host.secrets!;
      const sealed = s.seal("hunter2");
      res.json(200, { sealed, open: s.open(sealed), plain: s.open("as-typed"), blank: s.seal(""), sig: s.sign("x") });
    });
    r.route("GET", "/open", (req, res) => res.json(200, { open: host.secrets!.open(req.query.get("v") ?? "") }));
    host.pages!.registerPage({ id: "probe-page", title: "Probe", section: "Monitor", blurb: "The probe.", permission: "view", script: () => "export default function P() { return null; }", style: () => ".probe{}" });
    host.pages!.registerPage({ id: "probe-owner", title: "Probe owner", section: "Admin", ownerOnly: true, script: () => "export default 1;" });
    host.pages!.registerPage({ id: "probe-open", title: "Probe open", section: "Monitor", script: () => "export default 2;" });
    host.commands!.register("hello", "Says hello.", () => "hello from the probe");
  },
});

/** Another plugin's routes and signatures are its own. */
const other = definePlugin({
  manifest: { id: "other", name: "Other", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["api:routes", "secrets"] },
  activate(host) {
    host.routes!.route("GET", "/whoami", (req, res) => res.json(200, { view: req.viewer.holds("view") }));
    host.routes!.route("GET", "/sealed", (_req, res) => res.json(200, { sig: host.secrets!.sign("x") }));
  },
});

/** Boots the app with these plugins on `repo`, which outlives it — a second boot on the same repo
 *  is the same install restarted. */
async function bootOn(repo: Repository, plugins: PluginModule[], fn: (base: string, repo: Repository, ctx: Ctx) => Promise<void>): Promise<void> {
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null }, plugins);
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, repo, ctx);
  } finally {
    server.closeAllConnections();
    server.close();
    await ctx.tunnel.stop();
  }
}

async function withPlugins(plugins: PluginModule[], fn: (base: string, repo: Repository, ctx: Ctx) => Promise<void>): Promise<void> {
  const { repo, cleanup } = await createIsolatedRepository();
  try {
    await bootOn(repo, plugins, fn);
  } finally {
    await cleanup();
  }
}

async function staff(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const created = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const userId = (created.body.user as { id: string }).id;
  if (grants.length) {
    const set = await jf(`${base}/api/users/${userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { userId, token: login.body.token as string, auth: { authorization: `Bearer ${login.body.token as string}` } };
}

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** An EventSource stand-in: the frames as they arrive, and whether the server has ended it. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events: unknown[] = [];
  let ended = false;
  void (async () => {
    if (!res.body) { ended = true; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          for (const line of buf.slice(0, i).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          buf = buf.slice(i + 2);
        }
      }
    } catch { /* aborted by the test */ }
    ended = true;
  })();
  return { res, events, ended: () => ended, close: () => ctrl.abort() };
}

test("plugin routes: signed in first, a miss is the API's own miss, and params, bodies and queries arrive as sent", async () => {
  await withPlugins([probe], async (base) => {
    for (const [method, path] of [["GET", "/api/plugins/probe/whoami"], ["GET", "/api/plugins/nope/whoami"], ["POST", "/api/plugins/probe/echo/x"], ["DELETE", "/api/plugins/probe/gone"]]) {
      assert.equal((await jf(`${base}${path}`, { method })).status, 401, `${method} ${path} turns a stranger away before anything else`);
    }
    const owner = await ownerAuth(base);
    const me = await jf(`${base}/api/plugins/probe/whoami`, { headers: owner });
    assert.equal(me.status, 200);
    assert.equal(me.body.owner, true);
    assert.deepEqual([me.body.view, me.body.edit, me.body.ghost], [true, true, false], "the owner holds every permission the plugin declared, and nothing it did not");
    assert.equal(me.body.name, "owner");

    const miss = await jf(`${base}/api/nowhere`, { headers: owner });
    for (const path of ["/api/plugins/probe/nothing", "/api/plugins/nope/whoami"]) {
      const r = await jf(`${base}${path}`, { headers: owner });
      assert.equal(r.status, 404);
      assert.equal(r.body.error.message, miss.body.error.message, `${path} reads like an address the API has no route for`);
    }
    const gone = await jf(`${base}/api/plugins/probe/gone`, { method: "DELETE", headers: owner });
    assert.deepEqual([gone.status, gone.body.error.message], [404, miss.body.error.message], "res.notFound() is the router's own miss");

    const echo = await jf(`${base}/api/plugins/probe/echo/a%20b%2Fc?q=1`, { method: "POST", headers: owner, body: JSON.stringify({ x: 1 }) });
    assert.deepEqual(echo.body, { thing: "a b/c", body: { x: 1 }, q: "1" }, "a parameter is decoded once, and an escaped slash stays inside it");

    assert.equal((await jf(`${base}/api/plugins/probe/silent`, { headers: owner, signal: AbortSignal.timeout(5000) })).status, 500, "a handler that answers nothing gets an answer sent for it");
    assert.equal((await jf(`${base}/api/plugins/probe/boom`, { headers: owner })).status, 500);
    assert.equal((await jf(`${base}/api/plugins/probe/bad-header`, { headers: owner })).status, 500, "a cookie goes through res.cookie, never a raw header");
    // The host's own widget-data endpoint is met before the plugin's routes.
    const data = await jf(`${base}/api/plugins/probe/data?key=x`, { headers: owner });
    assert.deepEqual([data.status, data.body.error.message], [404, "no data provider for plugin 'probe' key 'x'"]);
  });
});

test("a plugin's cookies are its own: HttpOnly, SameSite, sent only to its routes, Secure over HTTPS", async () => {
  await withPlugins([probe], async (base) => {
    const owner = await ownerAuth(base);
    const plain = await fetch(`${base}/api/plugins/probe/cookie`, { method: "PUT", headers: owner });
    const cookie = plain.headers.get("set-cookie") ?? "";
    assert.equal(cookie, "pl_probe_ok=a.b-c_d~1; HttpOnly; Path=/api/plugins/probe; SameSite=Strict; Max-Age=60");
    assert.equal(((await plain.json()) as { https: boolean }).https, false);
    const tls = await fetch(`${base}/api/plugins/probe/cookie`, { method: "PUT", headers: { ...owner, "x-forwarded-proto": "https" } });
    assert.match(tls.headers.get("set-cookie") ?? "", /; Secure$/);
    assert.equal(((await tls.json()) as { https: boolean }).https, true);
    const back = await jf(`${base}/api/plugins/probe/cookie`, { headers: { ...owner, cookie: "pl_other_ok=no; pl_probe_ok=a.b-c_d~1" } });
    assert.equal(back.body.ok, "a.b-c_d~1", "the plugin reads its own cookie by its own name");
    const none = await jf(`${base}/api/plugins/probe/cookie`, { headers: { ...owner, cookie: "pl_other_ok=no; ok=no" } });
    assert.equal(none.body.ok, "", "another plugin's cookie, or a bare one, is not its");
  });
});

test("a plugin's permissions are in Roles, granted by name, and held the way the plugin declared them", async () => {
  await withPlugins([probe, other], async (base) => {
    const owner = await ownerAuth(base);
    const caps = await jf(`${base}/api/capabilities`, { headers: owner });
    const view = (caps.body.capabilities as { key: string }[]).find((c) => c.key === "probe.view");
    assert.deepEqual(view, { key: "probe.view", label: "View the probe", description: "Open the probe page.", group: "Probe", scoped: false, levels: ["read"] });
    assert.ok((caps.body.capabilities as { key: string }[]).some((c) => c.key === "probe.edit"));
    assert.ok(!(caps.body.presets as { grants: { capability: string }[] }[]).some((p) => p.grants.some((g) => g.capability.startsWith("probe."))), "no role preset carries a plugin's permission");

    const viewer = await staff(base, owner, "viewer", [{ capability: "probe.view", level: "read" }]);
    const editor = await staff(base, owner, "editor", [{ capability: "probe.edit", level: "write" }]);
    const plain = await staff(base, owner, "plain", []);
    const ask = async (who: { auth: Record<string, string> }) => (await jf(`${base}/api/plugins/probe/whoami`, { headers: who.auth })).body;
    assert.deepEqual([(await ask(viewer)).view, (await ask(viewer)).edit], [true, false]);
    assert.deepEqual([(await ask(editor)).view, (await ask(editor)).edit], [false, true]);
    assert.deepEqual([(await ask(plain)).view, (await ask(plain)).edit, (await ask(plain)).owner], [false, false, false]);
    assert.equal((await jf(`${base}/api/plugins/other/whoami`, { headers: viewer.auth })).body.view, false, "another plugin cannot ask after this one's permission");

    const userId = viewer.userId;
    const unknown = await jf(`${base}/api/users/${userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "probe.nope", scopeType: "global", scopeId: null, level: "read" }] }) });
    assert.deepEqual([unknown.status, unknown.body.error.message], [400, "unknown capability: probe.nope"]);

    // An outright permission: a "*" confined to one server does not reach it, and only someone who
    // holds it outright can hand it out.
    const { fake, serverId } = await fakeGameServer(base, owner.authorization.slice(7));
    fake.close(); // only its row is needed: something to scope a grant to
    const oneServer = await staff(base, owner, "oneserver", [{ capability: "*", level: "write", scopeType: "server", scopeId: serverId }]);
    assert.equal((await ask(oneServer)).view, false, "a one-server wildcard does not hold an outright permission");
    assert.equal((await ask(oneServer)).edit, true, "…but does hold a plain one, like any community-wide permission checked anywhere");
    const scoped = await jf(`${base}/api/users/${plain.userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "probe.edit", scopeType: "server", scopeId: serverId, level: "write" }] }) });
    assert.deepEqual([scoped.status, scoped.body.error.message], [400, "probe.edit cannot be scoped per server"]);
    const userAdmin = await staff(base, owner, "useradmin", [{ capability: "admin.users", level: "write" }]);
    const handOut = await jf(`${base}/api/users/${plain.userId}/grants`, { method: "PUT", headers: userAdmin.auth, body: JSON.stringify({ grants: [{ capability: "probe.view", scopeType: "global", scopeId: null, level: "read" }] }) });
    assert.equal(handOut.status, 403, "a user admin who does not hold it cannot give it away");
    assert.match(String(handOut.body.error.message), /only someone who holds probe\.view on every server can grant it/);
    const plainEdit = await jf(`${base}/api/users/${plain.userId}/grants`, { method: "PUT", headers: userAdmin.auth, body: JSON.stringify({ grants: [{ capability: "probe.edit", scopeType: "global", scopeId: null, level: "write" }] }) });
    assert.equal(plainEdit.status, 200, "a plain plugin permission is handed out like any other");
    const role = await jf(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Probers", grants: [{ capability: "probe.view", level: "read" }, { capability: "probe.edit", level: "write" }] }) });
    assert.ok([200, 201].includes(role.status), `a role can carry a plugin's permissions: ${JSON.stringify(role.body)}`);
    const badRole = await jf(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Ghosts", grants: [{ capability: "probe.ghost", level: "read" }] }) });
    assert.deepEqual([badRole.status, badRole.body.error?.message], [400, "unknown capability: probe.ghost"]);
    const roleOut = await jf(`${base}/api/roles`, { method: "POST", headers: userAdmin.auth, body: JSON.stringify({ name: "Sneaky", grants: [{ capability: "probe.view", level: "read" }] }) });
    assert.equal(roleOut.status, 403, "nor can a user admin put an outright permission into a role");
  });
});

/*
 * A plugin that is not running — not installed yet, taken out, or refused at startup — leaves its
 * grant rows behind. They confer nothing then, and must still be there, as they were, when it is
 * back: the editor re-sends every row an account or role holds, so a save that carries them goes
 * through, nothing new may name them, and since nothing can tell whether the plugin made one
 * outright, a veto on one is lifted, and its holder's account changed, only by someone who holds it
 * everywhere.
 */
test("a permission whose plugin is not running is kept as it is: re-saved, never added, no veto lifted", async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  const grantsOf = async (base: string, owner: Record<string, string>, userId: string) =>
    ((await jf(`${base}/api/users/${userId}`, { headers: owner })).body.grants as { capability: string; scopeType: string; scopeId: string | null; level: string }[])
      .map(({ capability, scopeType, scopeId, level }) => ({ capability, scopeType, scopeId, level }));
  try {
    let owner: Record<string, string> = {};
    let holder = { userId: "" };
    let watcher = { userId: "", auth: {} as Record<string, string> };
    let oneServer = { userId: "", auth: {} as Record<string, string> };
    let reader = { userId: "", auth: {} as Record<string, string> };
    let auditors = "";
    await bootOn(repo, [probe], async (base) => {
      owner = await ownerAuth(base);
      const made = await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 1, password: "x", game: "hll" }) });
      oneServer = await staff(base, owner, "oneserver", [{ capability: "*", level: "write", scopeType: "server", scopeId: made.body.server.id as string }]);
      // A user admin who reads everything everywhere, kept out of the probe by a veto of their own.
      reader = await staff(base, owner, "reader", [{ capability: "*", level: "read" }, { capability: "admin.users", level: "write" }, { capability: "probe.view", level: "none" }]);
      holder = await staff(base, owner, "holder", [{ capability: "probe.view", level: "read" }, { capability: "server.view", level: "read" }]);
      const role = await jf(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Auditors", grants: [{ capability: "*", level: "read" }, { capability: "probe.view", level: "none" }] }) });
      auditors = role.body.role.id as string;
      watcher = await staff(base, owner, "watcher", []);
      assert.equal((await jf(`${base}/api/users/${watcher.userId}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: auditors, scopeId: null }] }) })).status, 200);
      assert.equal((await jf(`${base}/api/plugins/probe/whoami`, { headers: watcher.auth })).body.view, false, "the veto keeps the global reader out");
    });

    await bootOn(repo, [], async (base) => {
      // The editor's save: every row the account holds, plus the change being made.
      const rows = await grantsOf(base, owner, holder.userId);
      assert.ok(rows.some((g) => g.capability === "probe.view"), "the row is still there, conferring nothing");
      const save = await jf(`${base}/api/users/${holder.userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [...rows, { capability: "audit.trail", scopeType: "global", scopeId: null, level: "read" }] }) });
      assert.equal(save.status, 200, JSON.stringify(save.body));
      assert.deepEqual((await grantsOf(base, owner, holder.userId)).filter((g) => g.capability === "probe.view"), [{ capability: "probe.view", scopeType: "global", scopeId: null, level: "read" }], "kept exactly as it was");
      const changed = await jf(`${base}/api/users/${holder.userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "probe.view", scopeType: "global", scopeId: null, level: "write" }] }) });
      assert.deepEqual([changed.status, changed.body.error?.message], [400, "unknown capability: probe.view"], "but not changed");
      const added = await jf(`${base}/api/users/${watcher.userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "probe.view", scopeType: "global", scopeId: null, level: "read" }] }) });
      assert.deepEqual([added.status, added.body.error?.message], [400, "unknown capability: probe.view"], "nor given to someone new");

      // The role's save re-sends its veto; leaving the veto out is lifting it.
      const roleSave = await jf(`${base}/api/roles/${auditors}`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }, { capability: "probe.view", level: "none" }], description: "read-only" }) });
      assert.equal(roleSave.status, 200, JSON.stringify(roleSave.body));
      const lift = await jf(`${base}/api/roles/${auditors}`, { method: "PUT", headers: reader.auth, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) });
      assert.equal(lift.status, 403, `someone who does not hold it everywhere cannot lift it while the plugin is away: ${JSON.stringify(lift.body)}`);
      assert.match(String(lift.body.error?.message), /only someone who holds probe\.view on every server can grant it/);
      for (const who of [oneServer, reader]) {
        const reset = await jf(`${base}/api/users/${holder.userId}`, { method: "PATCH", headers: who.auth, body: JSON.stringify({ password: "mine" }) });
        assert.equal(reset.status, 403, "nor take over an account that holds it");
      }
    });

    await bootOn(repo, [probe], async (base) => {
      assert.equal((await jf(`${base}/api/plugins/probe/whoami`, { headers: watcher.auth })).body.view, false, "back with the plugin, the veto still holds");
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "holder", password: "pw" }) });
      assert.equal((await jf(`${base}/api/plugins/probe/whoami`, { headers: { authorization: `Bearer ${login.body.token as string}` } })).body.view, true, "and the holder holds it again");
    });
  } finally {
    await cleanup();
  }
});

test("a stream route: ?token= signs the EventSource in, and each heartbeat ends it when the viewer stops qualifying", async () => {
  setPluginStreamHeartbeat(60);
  try {
    await withPlugins([probe], async (base) => {
      const owner = await ownerAuth(base);
      const holder = await staff(base, owner, "holder", [{ capability: "probe.view", level: "read" }]);
      assert.equal((await jf(`${base}/api/plugins/probe/whoami?token=${holder.token}`)).status, 401, "only a stream route takes ?token=");
      assert.equal((await jf(`${base}/api/plugins/probe/live?token=nonsense`)).status, 401);

      // The plugin's own say: its recheck turns false.
      seen.allow = true;
      const closesBefore = seen.closes;
      const a = await openStream(`${base}/api/plugins/probe/live?token=${holder.token}`);
      assert.equal(a.res.status, 200);
      assert.match(a.res.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.ok(await until(() => a.events.length === 1));
      assert.deepEqual(a.events[0], { hello: "holder" });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(a.ended(), false, "a viewer who still qualifies keeps the stream across heartbeats");
      await jf(`${base}/api/plugins/probe/allow`, { method: "PUT", headers: owner, body: JSON.stringify({ allow: false }) });
      assert.ok(await until(() => a.ended()), "the stream ends at the next heartbeat once the plugin says no");
      assert.ok(await until(() => seen.closes === closesBefore + 1), "and the plugin hears it close");
      seen.allow = true;

      // The permission taken away: the heartbeat reads the grants again.
      const b = await openStream(`${base}/api/plugins/probe/live?token=${holder.token}`);
      assert.ok(await until(() => b.events.length === 1));
      const revoke = await jf(`${base}/api/users/${holder.userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [] }) });
      assert.equal(revoke.status, 200);
      assert.ok(await until(() => b.ended()), "a revoked permission ends an open stream within a beat");

      // The session ended: a revoked API token signs nobody in on the next beat.
      const minted = await jf(`${base}/api/tokens`, { method: "POST", headers: owner, body: JSON.stringify({ name: "stream" }) });
      const c = await openStream(`${base}/api/plugins/probe/live?token=${minted.body.token as string}`);
      assert.ok(await until(() => c.events.length === 1));
      assert.equal((await jf(`${base}/api/tokens/${minted.body.id as string}`, { method: "DELETE", headers: owner })).status, 200);
      assert.ok(await until(() => c.ended()), "a session that ended ends the stream");

      // The browser leaving is heard at once — not at a heartbeat, which is now too far off to help.
      setPluginStreamHeartbeat(60_000);
      const before = seen.closes;
      const d = await openStream(`${base}/api/plugins/probe/live`, owner);
      assert.ok(await until(() => d.events.length === 1), "a stream route signs in by header as well");
      d.close();
      assert.ok(await until(() => seen.closes === before + 1), "the plugin hears a viewer leave");
    });
  } finally {
    setPluginStreamHeartbeat(25_000);
    seen.allow = true;
  }
});

test("plugin pages are listed, and their code served, only to the viewers who may open them", async () => {
  await withPlugins([probe], async (base) => {
    const owner = await ownerAuth(base);
    const holder = await staff(base, owner, "holder", [{ capability: "probe.view", level: "read" }]);
    const nobody = await staff(base, owner, "nobody", []);
    const ids = async (auth: Record<string, string>) => ((await jf(`${base}/api/plugin-pages`, { headers: auth })).body.pages as { id: string }[]).map((p) => p.id).sort();
    assert.deepEqual(await ids(owner), ["probe-open", "probe-owner", "probe-page"]);
    assert.deepEqual(await ids(holder.auth), ["probe-open", "probe-page"]);
    assert.deepEqual(await ids(nobody.auth), ["probe-open"], "a need-to-know page is not even named to anyone else");
    const listed = ((await jf(`${base}/api/plugin-pages`, { headers: holder.auth })).body.pages as Record<string, unknown>[]).find((p) => p.id === "probe-page");
    assert.deepEqual(listed, { plugin: "probe", id: "probe-page", title: "Probe", section: "Monitor", blurb: "The probe.", permission: "probe.view", outright: true, ownerOnly: false });
    assert.equal((await jf(`${base}/api/plugin-pages`)).status, 401);

    const code = await jf(`${base}/api/plugin-pages/probe/probe-page`, { headers: holder.auth });
    assert.deepEqual(code.body, { script: "export default function P() { return null; }", style: ".probe{}" });
    const missing = await jf(`${base}/api/plugin-pages/probe/no-such-page`, { headers: nobody.auth });
    for (const [who, page] of [[nobody, "probe-page"], [holder, "probe-owner"]] as const) {
      const r = await jf(`${base}/api/plugin-pages/probe/${page}`, { headers: who.auth });
      assert.deepEqual([r.status, r.body.error.message], [404, missing.body.error.message], `${page} reads as missing to someone who may not open it`);
    }
    assert.deepEqual((await jf(`${base}/api/plugin-pages/probe/probe-open`, { headers: nobody.auth })).body, { script: "export default 2;", style: "" });
  });
});

test("game:live, events:read, audit and secrets: held reads, the stored log, the staff trail, sealed values", async () => {
  const savedKey = process.env.ENCRYPTION_KEY;
  try {
    await withPlugins([probe, other], async (base, repo) => {
      const owner = await ownerAuth(base);
      const { fake, serverId } = await fakeGameServer(base, owner.authorization.slice(7), "Probe server");
      // The session in the wire's own casing, normalized by the host. Teams 1 and 3 both read as
      // Allies by the static mapping (a console build's encoding); only the session's headcounts
      // tell them apart, so the plugin gets the same answer the Live view would.
      fake.session = { MapName: "Carentan", AlliedPlayerCount: 1, AxisPlayerCount: 2 };
      fake.players = [
        { iD: "p1", name: "Able", team: 1, worldPosition: { x: 10, y: 20 } },
        { iD: "p2", name: "Baker", team: 1 },
        { iD: "p3", name: "Charlie", team: 3 },
      ];
      const game = await jf(`${base}/api/plugins/probe/game/${serverId}`, { headers: owner });
      assert.equal(game.status, 200, JSON.stringify(game.body));
      assert.equal(game.body.map, "Carentan");
      assert.deepEqual(game.body.ids, ["p1", "p2", "p3"]);
      assert.deepEqual(game.body.sides, ["allies", "axis"]);
      assert.deepEqual(game.body.sideOf, { 1: "axis", 3: "allies" }, "the headcounts decide what the static mapping could not");
      assert.deepEqual(game.body.servers, [{ id: serverId, name: "Probe server", game: "hll" }]);
      assert.equal(game.body.unknownGame, null);
      assert.equal((await jf(`${base}/api/plugins/probe/game/no-such-server`, { headers: owner })).status, 404, "an unknown server is refused, not dialled");

      const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
      await repo.events.insert([
        { serverId, ts: at(1), kind: "evt.kill", actorName: "Able", victimName: "Charlie", weapon: "M1 GARAND", dedupeKey: "k1" },
        { serverId, ts: at(2), kind: "evt.chat", actorName: "Able", dedupeKey: "c1" },
        { serverId, ts: at(3), kind: "evt.kill", actorName: "Charlie", victimName: "Baker", weapon: "KAR98K", dedupeKey: "k2" },
        { serverId, ts: at(4), kind: "evt.kill", actorName: "Baker", victimName: "Charlie", weapon: "M1 GARAND", dedupeKey: "k3" },
      ]);
      const kills = await jf(`${base}/api/plugins/probe/kills/${serverId}?from=${encodeURIComponent(at(0))}&limit=2`, { headers: owner });
      assert.deepEqual(kills.body.rows, [
        { kind: "evt.kill", ts: at(3), actorName: "Charlie", victimName: "Baker", weapon: "KAR98K" },
        { kind: "evt.kill", ts: at(4), actorName: "Baker", victimName: "Charlie", weapon: "M1 GARAND" },
      ], "the kinds asked for, oldest first, and the newest of them when the window holds more");

      assert.equal((await jf(`${base}/api/plugins/probe/audited`, { method: "POST", headers: owner })).status, 200);
      const row = (await repo.audit.list({ limit: 50 })).find((a) => a.action === "probe.thing.done");
      assert.ok(row, "the action is filed under the plugin's id");
      assert.deepEqual([row.actorName, row.targetType, row.targetId, row.summary, row.data], ["owner", "system", "probe", "did a thing", { n: 1 }]);

      process.env.ENCRYPTION_KEY = "k".repeat(64);
      const sealed = (await jf(`${base}/api/plugins/probe/sealed`, { headers: owner })).body;
      assert.match(sealed.sealed as string, /^enc:v1:/);
      assert.deepEqual([sealed.open, sealed.plain, sealed.blank], ["hunter2", "as-typed", ""], "sealed values open again, plain ones pass through, a blank stays blank");
      assert.match(sealed.sig as string, /^[0-9a-f]{64}$/);
      assert.equal((await jf(`${base}/api/plugins/probe/sealed`, { headers: owner })).body.sig, sealed.sig, "a signature is stable");
      assert.notEqual((await jf(`${base}/api/plugins/other/sealed`, { headers: owner })).body.sig, sealed.sig, "and each plugin's key is its own");
      delete process.env.ENCRYPTION_KEY;
      const bare = (await jf(`${base}/api/plugins/probe/sealed`, { headers: owner })).body;
      assert.equal(bare.sealed, "hunter2", "an install without a key keeps values as typed, like the RCON passwords");
      process.env.ENCRYPTION_KEY = "z".repeat(64);
      const lost = await jf(`${base}/api/plugins/probe/open?v=${encodeURIComponent(sealed.sealed as string)}`, { headers: owner });
      assert.equal(lost.body.open, null, "a value sealed under a key the install no longer holds opens to null, never a throw");
      fake.close();
    });
  } finally {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  }
});

test("a plugin that clashes is refused and leaves nothing behind; an unlisted one is not named to staff", async () => {
  const clash = definePlugin({
    manifest: { id: "admin", name: "Clash", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["api:routes"], permissions: [{ key: "users", label: "Users", description: "Clashes with the panel's own." }] },
    activate(host) { host.routes!.route("GET", "/x", (_req, res) => res.json(200, {})); },
  });
  const halfway = definePlugin({
    manifest: { id: "halfway", name: "Halfway", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["api:routes"], permissions: [{ key: "view", label: "View", description: "Gone again." }] },
    activate(host) {
      host.routes!.route("GET", "/x", (_req, res) => res.json(200, {}));
      throw new Error("failed part-way");
    },
  });
  const hidden = definePlugin({
    manifest: { id: "hidden", name: "Hidden", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: [], unlisted: true },
    activate() {},
  });
  await withPlugins([probe, clash, halfway, hidden], async (base) => {
    const owner = await ownerAuth(base);
    const listed = ((await jf(`${base}/api/plugins`, { headers: owner })).body.plugins as { id: string }[]).map((p) => p.id);
    assert.deepEqual(listed, ["probe"], "only the plugins that loaded, and not the unlisted one");
    const keys = ((await jf(`${base}/api/capabilities`, { headers: owner })).body.capabilities as { key: string; label: string }[]);
    assert.equal(keys.filter((c) => c.key === "admin.users").length, 1, "the panel's own permission is still its own");
    assert.ok(!keys.some((c) => c.key === "halfway.view"), "a plugin that failed part-way leaves no permission behind");
    assert.equal((await jf(`${base}/api/plugins/admin/x`, { headers: owner })).status, 404);
    assert.equal((await jf(`${base}/api/plugins/halfway/x`, { headers: owner })).status, 404, "…and no route");
  });
});

/*
 * An unlisted plugin is named in Loaded plugins only to someone who may open one of its pages — it
 * is in their menu already — and the System page's count of loaded plugins follows the same list.
 * The two never disagree, and the count gives nobody else an unlisted plugin as a number.
 */
test("an unlisted plugin is listed, and counted, only for those who may open one of its pages", async () => {
  const quiet = definePlugin({
    manifest: {
      id: "quiet", name: "Quiet", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:page"],
      permissions: [{ key: "view", label: "View the quiet page", description: "Open the quiet page.", outright: true, levels: ["read"] }],
      unlisted: true,
    },
    activate(host) {
      host.pages!.registerPage({ id: "quiet-page", title: "Quiet", section: "Monitor", permission: "view", script: () => "export default 1;" });
    },
  });
  await withPlugins([probe, quiet], async (base) => {
    const owner = await ownerAuth(base);
    const looks = [{ capability: "server.view", level: "read" }, { capability: "audit.trail", level: "read" }];
    const cleared = await staff(base, owner, "cleared", [...looks, { capability: "quiet.view", level: "read" }]);
    const others = await staff(base, owner, "others", looks);
    const listed = async (auth: Record<string, string>) =>
      ((await jf(`${base}/api/plugins`, { headers: auth })).body.plugins as { id: string; unlisted?: boolean }[]).map((p) => [p.id, p.unlisted ?? false]);
    const counted = async (auth: Record<string, string>) =>
      ((await jf(`${base}/api/health/services`, { headers: auth })).body.services as { name: string; detail: { loaded?: number } }[]).find((x) => x.name === "plugins")?.detail.loaded;
    assert.deepEqual(await listed(others.auth), [["probe", false]], "not named to someone who may not open its page");
    assert.equal(await counted(others.auth), 1, "nor counted for them");
    for (const who of [cleared.auth, owner]) {
      assert.deepEqual(await listed(who), [["probe", false], ["quiet", true]], "named, and marked unlisted, to someone who may open its page");
      assert.equal(await counted(who), 2, "and counted as the list names them");
    }
  });
});

/*
 * A plugin's event handler is often async: anything that stores, reads or calls out is. The bus
 * catches a handler that throws, and nothing caught one that rejected. With the crash handlers on,
 * an unhandled rejection ends the API, so one plugin meeting a database blink on a kill took the
 * panel down for everyone. A failing handler is logged, and the next event arrives as usual.
 */
test("a plugin's event handler that fails, at once or later, is logged and the next event still arrives", async () => {
  const got: string[] = [];
  const listener = definePlugin({
    manifest: { id: "listener", name: "Listener", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["events:subscribe"] },
    activate(host) {
      host.events!.on("evt.kill", async (e) => {
        const name = (e as { actorName?: string }).actorName ?? "";
        if (name === "bad") throw new Error("the plugin's handler failed");
        got.push(name);
      });
      host.events!.on("evt.kill", (e) => { if ((e as { actorName?: string }).actorName === "bad") throw new Error("so did this one, at once"); });
    },
  });
  const escaped: unknown[] = [];
  const spy = (reason: unknown) => { escaped.push(reason); };
  process.on("unhandledRejection", spy);
  try {
    await withPlugins([listener], async (_base, _repo, ctx) => {
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: "s", ts: new Date().toISOString(), actorName: "bad" });
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: "s", ts: new Date().toISOString(), actorName: "good" });
      assert.ok(await until(() => got.includes("good")), "the next event arrives");
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    process.off("unhandledRejection", spy);
  }
  assert.deepEqual(escaped, [], "nothing escaped as an unhandled rejection");
});

test("a host command runs from the server console, against the install's own database and plugins folder", { skip: !process.env.DATABASE_URL && "needs DATABASE_URL" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "plugins-"));
  writeFileSync(join(dir, "console.mjs"), [
    "export default {",
    "  manifest: { id: 'console', name: 'Console', version: '1.0.0', apiVersion: 1, capabilities: ['commands', 'storage'] },",
    "  activate(host) {",
    "    host.commands.register('stamp', 'Stores a mark and says so.', async () => { await host.storage.set('mark', 'set'); return 'Mark stored: ' + (await host.storage.get('mark')); });",
    "    host.commands.register('quiet', 'Says nothing much.', () => 'ok');",
    "  },",
    "};",
  ].join("\n"));
  const api = join(dirname(fileURLToPath(import.meta.url)), "..");
  const run = (...args: string[]) => spawnSync(process.execPath, ["dist/plugin-command.js", ...args], { cwd: api, env: { ...process.env, PLUGINS_DIR: dir }, encoding: "utf8", timeout: 60_000 });
  const stamp = run("console", "stamp");
  assert.equal(stamp.status, 0, stamp.stderr);
  assert.match(stamp.stdout, /Mark stored: set/);
  const list = run("console");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /stamp {2}Stores a mark and says so\.\n {2}quiet {2}Says nothing much\./);
  const wrong = run("console", "nope");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /has no command "nope"/);
  const ghost = run("ghost", "stamp");
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /No plugin "ghost" is loaded/);
  assert.equal(run().status, 2);
  const noDb = spawnSync(process.execPath, ["dist/plugin-command.js", "console", "stamp"], { cwd: api, env: { ...process.env, PLUGINS_DIR: dir, DATABASE_URL: "" }, encoding: "utf8" });
  assert.equal(noDb.status, 1);
  assert.match(noDb.stderr, /DATABASE_URL is not set/);
});
