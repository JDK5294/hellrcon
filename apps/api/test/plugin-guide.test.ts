/**
 * The plugin guide (docs/plugins.md) shows a whole plugin for anyone to copy. This loads it the way
 * an install does — its files written into a plugins folder that PLUGINS_DIR names — and uses all
 * of it: the route and its permission, the stored count, the screen's listing and code, and the host
 * command. The guide's dashboard-tile snippet runs inside a single-file plugin of its own. When the
 * guide's code stops working against the panel, this fails, so the guide cannot quietly go stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonFetch as jf, ownerAuth, withIsolatedServer } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const GUIDE = readFileSync(join(here, "..", "..", "..", "docs", "plugins.md"), "utf8");

/** The example's files: each `**`hello/<file>`**` label and the code block under it. */
function exampleFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of GUIDE.matchAll(/^\*\*`(hello\/[\w.-]+)`\*\*\n\n```\w*\n([\s\S]*?)\n```$/gm)) files.set(m[1]!, `${m[2]!}\n`);
  return files;
}

/** The dashboard-tile snippet, as the body of a plugin's activate(host). */
function tileSnippet(): string {
  const m = /^### Dashboard tiles\n[\s\S]*?```js\n([\s\S]*?)\n```/m.exec(GUIDE);
  assert.ok(m, "the guide has its dashboard-tile snippet");
  return m[1]!;
}

async function staff(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string }[]) {
  const made = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const id = made.body.user.id as string;
  if (grants.length) {
    const set = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ ...g, scopeType: "global", scopeId: null })) }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token as string}` };
}

test("the guide's example plugin loads from a plugins folder and does everything the guide says", async () => {
  const files = exampleFiles();
  assert.deepEqual([...files.keys()].sort(), ["hello/package.json", "hello/page.js", "hello/plugin.js"]);
  const dir = mkdtempSync(join(tmpdir(), "plugin-guide-"));
  mkdirSync(join(dir, "hello"));
  for (const [path, text] of files) writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, "tiles.mjs"), [
    "export default {",
    "  manifest: { id: \"tiles\", name: \"Tiles\", version: \"1.0.0\", apiVersion: 1, capabilities: [\"ui:widget\", \"storage\"] },",
    "  async activate(host) {",
    tileSnippet(),
    "  },",
    "};",
    "",
  ].join("\n"));

  // The screen's code is one module with nothing to import, and its default export is a component.
  const page = files.get("hello/page.js")!;
  assert.ok(!/^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m.test(page), "the screen imports nothing");
  (globalThis as Record<string, unknown>).__hellrconPageKit = { React: { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }, api: async () => ({}), ui: {} };
  try {
    const mod = await import(pathToFileURL(join(dir, "hello", "page.js")).href);
    assert.equal(typeof mod.default, "function", "the screen's default export is a component");
  } finally {
    delete (globalThis as Record<string, unknown>).__hellrconPageKit;
  }

  const before = process.env.PLUGINS_DIR;
  process.env.PLUGINS_DIR = dir;
  try {
    await withIsolatedServer(async (base, _repo, ctx) => {
      const owner = await ownerAuth(base);
      const listed = ((await jf(`${base}/api/plugins`, { headers: owner })).body.plugins as { id: string }[]).map((p) => p.id);
      assert.ok(listed.includes("hello") && listed.includes("tiles"), `both load from the folder: ${listed.join(", ")}`);

      // The permission is in Roles, under the plugin's name.
      const caps = (await jf(`${base}/api/capabilities`, { headers: owner })).body.capabilities as { key: string; group: string; label: string }[];
      assert.deepEqual(caps.filter((c) => c.key === "hello.view").map(({ key, group, label }) => ({ key, group, label })), [{ key: "hello.view", group: "Hello", label: "View Hello" }]);

      // The route: the owner straight away, counting visits in the plugin's storage.
      const greet = (auth: Record<string, string>) => jf(`${base}/api/plugins/hello/greeting`, { headers: auth });
      assert.deepEqual((await greet(owner)).body, { text: "Hello, owner!", visits: 1 });
      assert.deepEqual((await greet(owner)).body, { text: "Hello, owner!", visits: 2 });
      const outsider = await staff(base, owner, "outsider", [{ capability: "server.view", level: "read" }]);
      const holder = await staff(base, owner, "holder", [{ capability: "hello.view", level: "read" }]);
      assert.equal((await greet(outsider)).status, 404, "without the permission the route does not admit to existing");
      assert.deepEqual((await greet(holder)).body, { text: "Hello, holder!", visits: 3 });

      // The screen: listed under Monitor to holders only, its code served as written.
      const pagesFor = async (auth: Record<string, string>) => (await jf(`${base}/api/plugin-pages`, { headers: auth })).body.pages as Record<string, unknown>[];
      assert.deepEqual((await pagesFor(holder)).map(({ plugin, id, title, section, permission }) => ({ plugin, id, title, section, permission })),
        [{ plugin: "hello", id: "hello", title: "Hello", section: "Monitor", permission: "hello.view" }]);
      assert.deepEqual(await pagesFor(outsider), []);
      assert.equal((await jf(`${base}/api/plugin-pages/hello/hello`, { headers: holder })).body.script, page);

      // The host command, as plugin-command.js runs it.
      const reset = ctx.pluginRuntime.commands.get("hello", "reset");
      assert.ok(reset, "the command is registered");
      assert.equal(await reset.run(), "The visit count is back at zero.");
      assert.equal((await greet(owner)).body.visits, 1, "the count starts again");

      // The dashboard tile, backed by its data provider.
      const dashboard = (await jf(`${base}/api/layout/dashboard`, { headers: owner })).body.widgets as { id: string; visible: boolean }[];
      assert.ok(dashboard.some((w) => w.id === "tiles:visits" && w.visible), `the tile is on the dashboard: ${dashboard.map((w) => w.id).join(", ")}`);
      assert.deepEqual((await jf(`${base}/api/plugins/tiles/data?key=visits`, { headers: owner })).body, { data: 0 });
    });
  } finally {
    if (before === undefined) delete process.env.PLUGINS_DIR;
    else process.env.PLUGINS_DIR = before;
  }
});
