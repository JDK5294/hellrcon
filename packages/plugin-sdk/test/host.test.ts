import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginHost, definePlugin, HOST_API_VERSION, type Capability, type HostProviders, type PluginHostApi } from "../src/index.ts";
import type { WidgetDef } from "@app/widgets";
import { WidgetRegistry } from "@app/widgets";
import { createLogger } from "@app/shared";

/** Minimal providers for tests. */
function makeProviders(overrides: Partial<HostProviders> = {}): { providers: HostProviders; ui: WidgetRegistry; data: Map<string, () => unknown | Promise<unknown>>; emit: (k: string, e: unknown) => void; store: Map<string, unknown> } {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const ui = new WidgetRegistry();
  const data = new Map<string, () => unknown | Promise<unknown>>();
  const store = new Map<string, unknown>();
  const providers: HostProviders = {
    logger: (c) => createLogger(c),
    events: {
      on: (kind, h) => {
        const list = handlers.get(kind) ?? [];
        list.push(h);
        handlers.set(kind, list);
        return () => handlers.set(kind, (handlers.get(kind) ?? []).filter((x) => x !== h));
      },
    },
    ui: { registerWidget: (d) => ui.register(d), provideData: (key, provider) => data.set(key, provider) },
    storage: {
      get: async (ns, key) => store.get(`${ns}:${key}`),
      set: async (ns, key, val) => void store.set(`${ns}:${key}`, val),
    },
    ...overrides,
  };
  const emit = (k: string, e: unknown) => (handlers.get(k) ?? []).forEach((h) => h(e));
  return { providers, ui, data, emit, store };
}

test("capability scoping: a plugin only receives declared namespaces", async () => {
  const { providers } = makeProviders();
  const host = new PluginHost(providers);
  let received: PluginHostApi | null = null;
  await host.load(definePlugin({
    manifest: { id: "ui-only", name: "UI Only", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:widget"] },
    activate: (h) => { received = h; },
  }));
  assert.ok(received!.ui); // declared
  assert.ok(received!.log); // always present
  assert.equal(received!.rcon, undefined); // NOT declared
  assert.equal(received!.events, undefined);
  assert.equal(received!.storage, undefined);
});

test("plugin widgets register into the shared widget registry, stamped with the plugin id", async () => {
  const { providers, ui } = makeProviders();
  const host = new PluginHost(providers);
  await host.load(definePlugin({
    manifest: { id: "w", name: "W", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:widget"] },
    activate: (h) => h.ui!.registerWidget({ id: "plug-widget", title: "Plug", surface: "admin", defaultOrder: 100, defaultVisible: true }),
  }));
  const widget = ui.list("admin").find((w) => w.id === "w:plug-widget"); // namespaced by plugin id
  assert.ok(widget);
  assert.equal(widget!.pluginId, "w"); // host stamps which plugin registered it
});

test("data providers are namespaced by plugin id", async () => {
  const { providers, data } = makeProviders();
  const host = new PluginHost(providers);
  await host.load(definePlugin({
    manifest: { id: "kf", name: "KF", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:widget"] },
    activate: (h) => h.ui!.provideData("summary", () => 42),
  }));
  // stored under `${pluginId}:${key}` so plugins can't shadow each other's data
  assert.ok(data.has("kf:summary"));
  assert.ok(!data.has("summary"));
  assert.equal(await data.get("kf:summary")!(), 42);
});

test("storage is namespaced per plugin (no cross-plugin collisions)", async () => {
  const { providers, store } = makeProviders();
  const host = new PluginHost(providers);
  const mk = (id: string) => definePlugin({
    manifest: { id, name: id, version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["storage"] },
    activate: async (h) => { await h.storage!.set("key", id); },
  });
  await host.load(mk("alpha"));
  await host.load(mk("beta"));
  assert.equal(store.get("alpha:key"), "alpha");
  assert.equal(store.get("beta:key"), "beta"); // did not overwrite alpha
});

test("event subscriptions fire and auto-clean up on unload", async () => {
  const { providers, emit } = makeProviders();
  const host = new PluginHost(providers);
  const seen: unknown[] = [];
  await host.load(definePlugin({
    manifest: { id: "ev", name: "ev", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["events:subscribe"] },
    activate: (h) => { h.events!.on("evt.kill", (e) => seen.push(e)); },
  }));
  emit("evt.kill", { a: 1 });
  assert.equal(seen.length, 1);
  await host.unload("ev");
  emit("evt.kill", { a: 2 }); // no longer subscribed
  assert.equal(seen.length, 1);
});

test("deactivate runs on unload", async () => {
  const { providers } = makeProviders();
  const host = new PluginHost(providers);
  let deactivated = false;
  await host.load(definePlugin({
    manifest: { id: "d", name: "d", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: [] },
    activate: () => {},
    deactivate: () => { deactivated = true; },
  }));
  await host.unload("d");
  assert.equal(deactivated, true);
});

test("validation: unknown capability, wrong api version, and missing provider are rejected", async () => {
  const { providers } = makeProviders(); // no rcon provider
  const host = new PluginHost(providers);
  await assert.rejects(() => host.load(definePlugin({
    manifest: { id: "x", name: "x", version: "1", apiVersion: HOST_API_VERSION, capabilities: ["bogus" as never] },
    activate: () => {},
  })), /unknown capability/);
  await assert.rejects(() => host.load(definePlugin({
    manifest: { id: "y", name: "y", version: "1", apiVersion: 999, capabilities: [] },
    activate: () => {},
  })), /targets api/);
  await assert.rejects(() => host.load(definePlugin({
    manifest: { id: "z", name: "z", version: "1", apiVersion: HOST_API_VERSION, capabilities: ["rcon:action"] },
    activate: () => {},
  })), /cannot provide capability 'rcon:action'/);
});

test("a plugin cannot shadow another plugin's widget, or a first-party one", async () => {
  const registered: WidgetDef[] = [];
  const providers: HostProviders = {
    logger: () => createLogger("test"),
    events: { on: () => () => {} },
    ui: { registerWidget: (d) => { registered.push(d); }, provideData: () => {} },
    storage: { get: async () => undefined, set: async () => {} },
  };
  const host = new PluginHost(providers);

  // Both plugins register a widget called "feed" — the collision that used to be silent.
  const mk = (id: string) => ({
    manifest: { id, name: id, version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:widget" as const] },
    activate: (h: PluginHostApi) => h.ui!.registerWidget({ id: "feed", title: "Feed", surface: "admin" as const, defaultOrder: 1, defaultVisible: true }),
  });
  await host.load(mk("alpha"));
  await host.load(mk("beta"));

  assert.deepEqual(registered.map((w) => w.id), ["alpha:feed", "beta:feed"], "ids are namespaced by plugin");
  assert.deepEqual(registered.map((w) => w.pluginId), ["alpha", "beta"], "attribution is kept");

  // And the first-party ids are out of reach: a plugin claiming "players" registers "gamma:players".
  await host.load({
    manifest: { id: "gamma", name: "gamma", version: "1.0.0", apiVersion: HOST_API_VERSION, capabilities: ["ui:widget"] },
    activate: (h) => h.ui!.registerWidget({ id: "players", title: "Impostor", surface: "admin", defaultOrder: 1, defaultVisible: true }),
  });
  assert.equal(registered.at(-1)!.id, "gamma:players");
});

/** Providers for the newer capabilities, recording what was registered and unregistered. */
function richProviders() {
  const log: string[] = [];
  const base = makeProviders().providers;
  const providers: HostProviders = {
    ...base,
    permissions: { register: (m) => log.push(`perm+ ${m.id}:${(m.permissions ?? []).map((p) => p.key).join(",")}`), unregister: (id) => log.push(`perm- ${id}`) },
    routes: { register: (id, method, path, _h, opts) => log.push(`route+ ${id} ${method} ${path}${opts.stream ? " stream" : ""}`), unregister: (id) => log.push(`route- ${id}`) },
    pages: { register: (id, def) => log.push(`page+ ${id} ${def.id}`), unregister: (id) => log.push(`page- ${id}`) },
    audit: { record: async (id, e) => { log.push(`audit ${id} ${e.action}`); } },
    secrets: { forPlugin: (id) => ({ seal: (v) => `sealed(${id}):${v}`, open: (v) => v, sign: (d) => `${id}:${d}` }) },
    commands: { register: (id, name) => log.push(`cmd+ ${id} ${name}`), unregister: (id) => log.push(`cmd- ${id}`) },
  };
  return { providers, log };
}

const page = { title: "P", section: "Monitor", script: () => "export default 1;" };

test("the newer capabilities: present only when declared, refused on a host that cannot provide them", async () => {
  const { providers, log } = richProviders();
  const host = new PluginHost(providers);
  let got: PluginHostApi | null = null;
  await host.load(definePlugin({
    manifest: { id: "rich", name: "Rich", version: "1", apiVersion: HOST_API_VERSION, capabilities: ["api:routes", "secrets"] },
    activate: (h) => { got = h; },
  }));
  assert.ok(got!.routes && got!.secrets);
  assert.equal(got!.pages, undefined);
  assert.equal(got!.game, undefined);
  assert.equal(got!.audit, undefined);
  assert.equal(got!.commands, undefined);
  assert.equal(got!.secrets!.seal("x"), "sealed(rich):x", "sealing is the plugin's own");
  assert.deepEqual(log, []);
  const bare = new PluginHost(makeProviders().providers);
  for (const cap of ["api:routes", "ui:page", "game:live", "events:read", "audit", "secrets", "commands"] as const) {
    await assert.rejects(() => bare.load(definePlugin({
      manifest: { id: `p-${cap.replace(":", "-")}`, name: "p", version: "1", apiVersion: HOST_API_VERSION, capabilities: [cap] },
      activate: () => {},
    })), new RegExp(`cannot provide capability '${cap}'`), `${cap} fails closed`);
  }
  await assert.rejects(() => bare.load(definePlugin({
    manifest: { id: "perms", name: "p", version: "1", apiVersion: HOST_API_VERSION, capabilities: [], permissions: [{ key: "view", label: "V", description: "D" }] },
    activate: () => {},
  })), /cannot add the permissions/);
});

test("a manifest is checked before anything is registered: its id and its permissions", async () => {
  const { providers, log } = richProviders();
  const host = new PluginHost(providers);
  const mk = (id: string, permissions?: unknown) => definePlugin({
    manifest: { id, name: "n", version: "1", apiVersion: HOST_API_VERSION, capabilities: [], permissions: permissions as never },
    activate: () => {},
  });
  for (const id of ["Bad", "with space", "a.b", "1st", "-dash", "x".repeat(33)]) {
    await assert.rejects(() => host.load(mk(id)), /plugin id must be/, `"${id}" is not a plugin id`);
  }
  await assert.rejects(() => host.load(mk("p1", [{ key: "Bad Key", label: "L", description: "D" }])), /bad key/);
  await assert.rejects(() => host.load(mk("p2", [{ key: "view", label: "L", description: "D" }, { key: "view", label: "L", description: "D" }])), /declares the permission view twice/);
  await assert.rejects(() => host.load(mk("p3", [{ key: "view", label: " ", description: "D" }])), /needs a label and a description/);
  await assert.rejects(() => host.load(mk("p4", [{ key: "view", label: "L", description: "D", levels: [] }])), /levels must be read and\/or write/);
  await assert.rejects(() => host.load(mk("p5", [{ key: "view", label: "L", description: "D", levels: ["admin"] }])), /levels must be read and\/or write/);
  assert.deepEqual(log, [], "nothing reached the host for a manifest that failed its checks");
  await host.load(mk("ok-1", [{ key: "view_all", label: "L", description: "D", levels: ["read"], outright: true }]));
  assert.deepEqual(log, ["perm+ ok-1:view_all"]);
});

test("routes, pages, audit actions and commands are checked as they are declared", async () => {
  const { providers, log } = richProviders();
  const host = new PluginHost(providers);
  const all = ["api:routes", "ui:page", "audit", "commands"] as const;
  const attempt = (id: string, fn: (h: PluginHostApi) => unknown) => host.load(definePlugin({
    manifest: { id, name: "n", version: "1", apiVersion: HOST_API_VERSION, capabilities: [...all], permissions: [{ key: "view", label: "V", description: "D" }] },
    activate: async (h) => { await fn(h); },
  }));
  const handler = () => {};
  await assert.rejects(() => attempt("r1", (h) => h.routes!.route("PATCH" as never, "/x", handler)), /unknown method PATCH/);
  for (const path of ["x", "/", "/a b", "/a/", "/A", "/a//b", "/:1x"]) {
    await assert.rejects(() => attempt("r2", (h) => h.routes!.route("GET", path, handler)), /bad route path/, `"${path}" is not a route path`);
  }
  await assert.rejects(() => attempt("r3", (h) => h.routes!.route("GET", "/data", handler)), /\/data is the host's own/);
  await assert.rejects(() => attempt("r4", (h) => h.routes!.route("POST", "/live", handler, { stream: true })), /only a GET route can stream/);
  await assert.rejects(() => attempt("g1", (h) => h.pages!.registerPage({ ...page, id: "Bad" })), /page id must be/);
  await assert.rejects(() => attempt("g2", (h) => h.pages!.registerPage({ ...page, id: "p", title: "" })), /page id must be/);
  await assert.rejects(() => attempt("g3", (h) => h.pages!.registerPage({ ...page, id: "pp", section: "" })), /needs a title and a section/);
  await assert.rejects(() => attempt("g4", (h) => h.pages!.registerPage({ ...page, id: "pp", script: undefined as never })), /has no script/);
  await assert.rejects(() => attempt("g5", (h) => h.pages!.registerPage({ ...page, id: "pp", permission: "edit" })), /names a permission the plugin does not declare: edit/);
  await assert.rejects(() => attempt("a1", (h) => h.audit!.record({ viewer: null, action: "Bad Action", summary: "s" })), /bad audit action/);
  await assert.rejects(() => attempt("c1", (h) => h.commands!.register("Reset!", "d", () => "")), /command name must be/);
  log.length = 0;
  await attempt("good", async (h) => {
    h.routes!.route("GET", "/status", handler);
    h.routes!.route("GET", "/live/:serverId", handler, { stream: true });
    h.routes!.route("PUT", "/viewer", handler);
    h.pages!.registerPage({ ...page, id: "good-page", permission: "view" });
    await h.audit!.record({ viewer: null, action: "config.set", summary: "s" });
    h.commands!.register("reset-password", "d", () => "");
  });
  assert.deepEqual(log, [
    "perm+ good:view",
    "route+ good GET /status", "route+ good GET /live/:serverId stream", "route+ good PUT /viewer",
    "page+ good good-page", "audit good config.set", "cmd+ good reset-password",
  ]);
});

test("a plugin that fails part-way leaves nothing behind, and unloading takes everything away", async () => {
  const { providers, log } = richProviders();
  const host = new PluginHost(providers);
  const manifest = { name: "n", version: "1", apiVersion: HOST_API_VERSION, capabilities: ["api:routes", "ui:page", "commands"] as Capability[], permissions: [{ key: "view", label: "V", description: "D" }] };
  await assert.rejects(() => host.load(definePlugin({
    manifest: { id: "broken", ...manifest },
    activate: (h) => {
      h.routes!.route("GET", "/x", () => {});
      h.pages!.registerPage({ ...page, id: "broken-page" });
      h.commands!.register("go", "d", () => "");
      throw new Error("failed part-way");
    },
  })), /failed part-way/);
  assert.deepEqual(log.filter((l) => /^\w+- /.test(l)).sort(), ["cmd- broken", "page- broken", "perm- broken", "route- broken"]);
  assert.deepEqual(host.list(), [], "and it is not counted as loaded");
  log.length = 0;
  await host.load(definePlugin({ manifest: { id: "fine", ...manifest }, activate: (h) => h.routes!.route("GET", "/x", () => {}) }));
  await host.unload("fine");
  assert.deepEqual(log.filter((l) => /^\w+- /.test(l)).sort(), ["cmd- fine", "page- fine", "perm- fine", "route- fine"]);
});
