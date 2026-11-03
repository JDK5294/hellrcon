/**
 * Example first-party plugin — a "kill feed". Demonstrates the authoring flow every
 * third-party plugin follows: declare capabilities in the manifest, then use only the
 * matching host namespaces.
 *
 * It declares exactly `ui:widget` + `events:subscribe` — so the host gives it those and
 * nothing else (it cannot touch RCON, storage, or Discord). It contributes a real widget
 * UI purely as data (a `view`): a server-side "total kills" stat backed by a data provider,
 * plus a live feed the panel streams over SSE. No browser code crosses the boundary.
 */
import { definePlugin, HOST_API_VERSION } from "@app/plugin-sdk";

export let killCount = 0; // exported for the test to observe

export default definePlugin({
  manifest: {
    id: "killfeed",
    name: "Kill Feed",
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["ui:widget", "events:subscribe"],
  },
  activate(host) {
    host.ui!.registerWidget({
      // The host namespaces this by plugin id, so the registered widget is `killfeed:feed`.
      id: "feed",
      title: "Kill Feed",
      surface: "admin",
      defaultOrder: 45,
      defaultVisible: true,
      view: {
        blocks: [
          { type: "stat", label: "Total kills observed", source: { kind: "plugin", key: "summary", refreshMs: 5000 } },
          { type: "feed", kinds: ["evt.kill"], emptyText: "Waiting for kills…", max: 40 },
        ],
      },
    });
    // Server-side aggregate that backs the stat block (survives browser reloads).
    host.ui!.provideData("summary", () => killCount);

    host.events!.on("evt.kill", () => {
      killCount += 1;
      host.log.debug("kill observed", { total: killCount });
    });
    host.log.info("kill feed activated");
  },
  deactivate() {
    killCount = 0;
  },
});
