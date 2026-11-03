import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginHost, type HostProviders } from "@app/plugin-sdk";
import { WidgetRegistry } from "@app/widgets";
import { createLogger } from "@app/shared";
import plugin from "../dist/index.js";

test("killfeed plugin loads via the host, registers its widget, and counts kills", async () => {
  const ui = new WidgetRegistry();
  const data = new Map<string, () => unknown | Promise<unknown>>();
  const handlers = new Map<string, Array<(e: unknown) => void>>();
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
    storage: { get: async () => undefined, set: async () => {} },
  };
  const host = new PluginHost(providers);

  await host.load(plugin);
  assert.equal(plugin.manifest.id, "killfeed");
  const widget = ui.list("admin").find((w) => w.id === "killfeed:feed");
  assert.ok(widget); // widget registered into the shared registry
  assert.ok(widget!.view?.blocks?.some((b) => b.type === "feed")); // ships a declarative view
  assert.ok(data.has("killfeed:summary")); // registered a data provider for the stat block

  (handlers.get("evt.kill") ?? []).forEach((h) => h({}));
  (handlers.get("evt.kill") ?? []).forEach((h) => h({}));
  // killCount is a live binding exported from the plugin module
  const { killCount: count } = await import("../dist/index.js");
  assert.equal(count, 2);
});
