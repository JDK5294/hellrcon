import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@app/shared";
import { createRepository } from "@app/db";
import { discoverPlugins } from "../dist/plugin-discovery.js";
import { buildPluginRuntime } from "../dist/plugin-host.js";

const log = createLogger("test");

const pluginSource = (id: string) =>
  `export default {
     manifest: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, version: "1.0.0", apiVersion: 1, capabilities: ["events:subscribe"] },
     activate(host) { host.log.debug("activated"); },
   };`;

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "app-plugins-"));
  // 1) a bare .mjs plugin file
  await writeFile(join(dir, "alpha.mjs"), pluginSource("alpha"));
  // 2) a folder plugin resolved via package.json "main"
  const beta = join(dir, "beta");
  await mkdir(beta);
  await writeFile(join(beta, "package.json"), JSON.stringify({ name: "beta", main: "entry.mjs" }));
  await writeFile(join(beta, "entry.mjs"), pluginSource("beta"));
  // 3) a non-plugin JS file — must be skipped, not crash discovery
  await writeFile(join(dir, "notaplugin.mjs"), "export const hello = 1;");
  // 4) a non-JS file — ignored entirely
  await writeFile(join(dir, "README.md"), "# not code");
  return dir;
}

test("discovers file- and folder-based plugins, skips non-plugins", async () => {
  const dir = await fixture();
  const found = await discoverPlugins(dir, log);
  const ids = found.map((p) => p.manifest.id).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
});

test("missing or undefined directory yields no plugins", async () => {
  assert.deepEqual(await discoverPlugins(undefined, log), []);
  assert.deepEqual(await discoverPlugins(join(tmpdir(), "app-does-not-exist-xyz"), log), []);
});

test("buildPluginRuntime loads discovered plugins, and only those by default", async () => {
  const dir = await fixture();
  const prev = process.env.PLUGINS_DIR;
  process.env.PLUGINS_DIR = dir;
  try {
    const repo = await createRepository();
    const runtime = await buildPluginRuntime(repo); // no explicit list → built-ins + discovered
    const ids = runtime.host.list().map((m) => m.id).sort();
    // The killfeed example was retired from the built-in list (the Live view covers it), so a
    // default build carries exactly what discovery found under PLUGINS_DIR.
    assert.deepEqual(ids, ["alpha", "beta"], "only discovered plugins load by default");
    await runtime.bus.close();
  } finally {
    if (prev === undefined) delete process.env.PLUGINS_DIR;
    else process.env.PLUGINS_DIR = prev;
  }
});
