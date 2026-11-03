/**
 * A plugin with one permission granted outright, for the suites that pin how outright powers are
 * guarded: what is only ever held outright — a global "*", and a plugin's outright permission —
 * must not reach anyone else through a side door. Its routes answer the way a need-to-know screen
 * does: `status` is 200 to a holder of vault.view and 404 to everyone else, `owner` is 200 to an
 * owner and 404 to everyone else.
 */
import { definePlugin, HOST_API_VERSION } from "@app/plugin-sdk";

export const vault = definePlugin({
  manifest: {
    id: "vault", name: "Vault", version: "1.0.0", apiVersion: HOST_API_VERSION,
    capabilities: ["api:routes"],
    permissions: [{ key: "view", label: "Open the vault", description: "Open the vault. Granted by name only.", levels: ["read"], outright: true }],
  },
  activate(host) {
    host.routes!.route("GET", "/status", (req, res) => (req.viewer.holds("view") ? res.json(200, { open: true }) : res.notFound()));
    host.routes!.route("GET", "/owner", (req, res) => (req.viewer.owner ? res.json(200, { owner: true }) : res.notFound()));
  },
});
