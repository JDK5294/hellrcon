/**
 * Wires the plugin host into the API with real capability providers:
 *  - events  → the event bus (Redis-backed when configured, so the always-on worker's live
 *              events reach these plugins; in-process otherwise),
 *  - ui      → a WidgetRegistry (seeded with first-party admin widgets; plugins add more),
 *  - storage → the DB (namespaced per plugin, via repo.pluginKv),
 *  - rcon    → rcon-core (engagement-mode still applies: observe servers stay read-only),
 *  - routes, pages, permissions, commands → tables the API's own routes answer from
 *              (routes/plugins.ts, plugin-permissions.ts, plugin-command.ts),
 *  - game    → held connections to the game servers, and the games' own knowledge,
 *  - history, audit, secrets → the event store, the staff activity trail, the encryption key.
 *
 * Built-in first-party plugins load at startup, then anything discovered under PLUGINS_DIR
 * (self-hosted operators drop plugins there); the contract is identical for both.
 */
import { createHmac, randomBytes } from "node:crypto";
import { PluginHost, type HostProviders, type PluginModule, type SecretsApi } from "@app/plugin-sdk";
import { WidgetRegistry, defaultWidgets } from "@app/widgets";
import { createServerClient, normalizeSession } from "@app/rcon-core";
import { getGame, resolveTeamSides, rosterPlayerId, teamSidesConfident } from "@app/games";
import type { StateKind } from "@app/rcon-core";
import { isSealed, openSecret, sealSecret } from "@app/access";
import { background, createLogger, errors } from "@app/shared";
import { createEventBus, type EventBus } from "@app/bus";
import type { Repository } from "@app/db";
import { DiscordModuleRegistry, registerBuiltinModules } from "./discord-modules.js";
import { PublicModuleRegistry, registerPublicModules } from "./discord-public.js";
import { discoverPlugins } from "./plugin-discovery.js";
import { PluginPageTable, PluginRouteTable } from "./plugin-http.js";
import { registerPluginPermissions, resetPluginPermissions, unregisterPluginPermissions } from "./plugin-permissions.js";
// Value import, and safe: kit imports only the TYPE of AppContext, never this module.
import { connectGameClient, gameClientFor } from "./routes/kit.js";

// Re-exported so the rest of the API imports the bus type from one place.
export type { EventBus } from "@app/bus";

export interface PluginRuntime {
  host: PluginHost;
  registry: WidgetRegistry;
  /** The /staff panel's modules (docs/discord-modules.md) — first-party + plugin-registered. */
  discordModules: DiscordModuleRegistry;
  /** The public VIP panel's modules — no staff account behind them, gated by linking. */
  publicModules: PublicModuleRegistry;
  bus: EventBus;
  /** Invoke a plugin's registered data provider (backs widget `plugin` data sources). Returns
   *  `{ found: false }` when no provider is registered for that plugin+key. */
  getPluginData(pluginId: string, key: string): Promise<{ found: boolean; data?: unknown }>;
  /** What plugins answer under `/api/plugins/<id>/…`. */
  routes: PluginRouteTable;
  /** The panel pages plugins add. */
  pages: PluginPageTable;
  /** The commands plugins run on the host (plugin-command.ts). */
  commands: PluginCommandTable;
}

/** A registered plugin data provider (namespaced key → function returning JSON). */
type DataProvider = () => unknown | Promise<unknown>;

export class PluginCommandTable {
  private byPlugin = new Map<string, Map<string, { description: string; run: () => string | Promise<string> }>>();

  register(pluginId: string, name: string, description: string, run: () => string | Promise<string>): void {
    const mine = this.byPlugin.get(pluginId) ?? new Map();
    if (mine.has(name)) throw new Error(`plugin ${pluginId}: the command ${name} is registered twice`);
    mine.set(name, { description, run });
    this.byPlugin.set(pluginId, mine);
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  get(pluginId: string, name: string): { description: string; run: () => string | Promise<string> } | undefined {
    return this.byPlugin.get(pluginId)?.get(name);
  }

  list(pluginId: string): { name: string; description: string }[] {
    return [...(this.byPlugin.get(pluginId) ?? new Map()).entries()].map(([name, c]) => ({ name, description: c.description }));
  }
}

/** Stands in for the encryption key on an install without one: signatures then last one process. */
const processSecret = randomBytes(32).toString("hex");

/**
 * One plugin's sealing and signing, under the same key and policy as the servers' RCON passwords:
 * sealed when the install has an ENCRYPTION_KEY, kept as typed when it has none. The plugin never
 * sees the key, and its signatures are its own — another plugin's key differs.
 */
function pluginSecrets(pluginId: string): SecretsApi {
  const key = () => process.env.ENCRYPTION_KEY ?? "";
  return {
    seal: (plain) => (plain && key() ? sealSecret(plain, key()) : plain),
    open: (stored) => {
      if (!stored || !isSealed(stored)) return stored;
      try {
        return openSecret(stored, key());
      } catch {
        return null; // sealed under a key this install no longer holds
      }
    },
    sign: (data) => createHmac("sha256", `${key() || processSecret}|plugin:${pluginId}`).update(data).digest("hex"),
  };
}

/**
 * Built-in first-party plugins loaded on startup. Currently none: the killfeed example no
 * longer ships as a page — the Live view's whole-round feed and the "Live kills" dashboard
 * tile cover it with more context. The package (`plugins/example-killfeed`) remains the SDK
 * authoring example and test fixture, and an operator can still load it via PLUGINS_DIR.
 */
const BUILTIN_PLUGINS: PluginModule[] = [];

async function withClient<T>(repo: Repository, serverId: string, fn: (c: ReturnType<typeof createServerClient>) => Promise<T>): Promise<T> {
  const server = await repo.servers.findById(serverId);
  if (!server) throw errors.notFound("server not found");
  const client = createServerClient({ protocol: server.protocol, engagementMode: server.engagementMode, commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey });
  try {
    await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined });
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Build the plugin runtime. When `plugins` is omitted, the built-in first-party plugins load
 * plus any discovered under `PLUGINS_DIR` (self-hosted operators drop plugins there). Tests
 * pass an explicit list to load exactly that and nothing else.
 */
export async function buildPluginRuntime(repo: Repository, plugins?: PluginModule[]): Promise<PluginRuntime> {
  const log = createLogger("plugins");
  const registry = new WidgetRegistry();
  for (const w of defaultWidgets("admin")) registry.register(w); // nav pages
  for (const w of defaultWidgets("dashboard")) registry.register(w); // glassy dashboard tiles
  // Redis-backed when REDIS_URL is set, so events published by the always-on worker reach the
  // plugins loaded here; falls back to an in-process bus otherwise.
  const bus = createEventBus({ component: "api-bus" });

  const toLoad = plugins ?? [...BUILTIN_PLUGINS, ...(await discoverPlugins(process.env.PLUGINS_DIR, log))];

  // The /staff panel's modules: first-party first (stable launcher order), plugins after.
  const discordModules = new DiscordModuleRegistry();
  registerBuiltinModules(discordModules, repo);
  const publicModules = new PublicModuleRegistry();
  registerPublicModules(publicModules, repo);

  // Plugin data providers, keyed by the plugin-id-namespaced key the scoped host produces.
  const dataProviders = new Map<string, DataProvider>();
  const routes = new PluginRouteTable();
  const pages = new PluginPageTable();
  const commands = new PluginCommandTable();
  // This runtime's plugins, and nobody else's, are what Roles offers from here on.
  resetPluginPermissions();

  const providers: HostProviders = {
    logger: (c) => createLogger(c),
    // A plugin's handler may be async, and the bus only catches one that throws: a rejection it
    // never sees would end the API process (process-guards). Background work, like every core
    // subscriber's.
    events: { on: (kind, handler) => bus.on(kind, (evt) => background(log, `a plugin's ${kind} handler`, async () => handler(evt))) },
    ui: {
      registerWidget: (d) => {
        // Refused means something already owns this id. Ids are namespaced by plugin id upstream,
        // so this is a plugin registering the same widget twice or being loaded twice — either way
        // the operator needs to see it, because the widget they are missing is the one that lost.
        if (!registry.register(d)) log.warn("widget id already registered — ignoring", { widgetId: d.id, plugin: d.pluginId });
      },
      provideData: (namespacedKey, provider) => dataProviders.set(namespacedKey, provider),
    },
    storage: { get: (ns, key) => repo.pluginKv.get(ns, key), set: (ns, key, val) => repo.pluginKv.set(ns, key, val) },
    rconRead: { readState: (serverId, kind) => withClient(repo, serverId, (c) => c.readState(kind as StateKind)) },
    rcon: { execute: (serverId, command, params) => withClient(repo, serverId, (c) => c.execute(command, params)) },
    // The SDK's scoped host namespaces plugin module ids and unregisters them on unload.
    discord: {
      registerModule: (d) => discordModules.register(d),
      unregisterModule: (id) => discordModules.unregister(id),
    },
    permissions: { register: (m) => registerPluginPermissions(m), unregister: (id) => unregisterPluginPermissions(id) },
    routes: {
      register: (id, method, path, handler, opts) => routes.register(id, method, path, handler, opts),
      unregister: (id) => routes.unregister(id),
    },
    pages: { register: (id, def) => pages.register(id, def), unregister: (id) => pages.unregister(id) },
    game: {
      servers: async () => (await repo.servers.list()).map((s) => ({ id: s.id, name: s.name, game: s.game })),
      // One connection held for as long as the plugin keeps it: a live view reads every second or
      // two, and a dial per read would be a login per read. Reads only — the session and the roster
      // every roster poll reads — so an observe server is as safe as ever.
      open: async (serverId) => {
        const server = await repo.servers.findById(serverId);
        if (!server) throw errors.notFound("server not found");
        const client = gameClientFor(server);
        await connectGameClient(client, server);
        return {
          read: async () => {
            const [rawSession, rawPlayers] = await Promise.all([client.readState("session"), client.readState("players")]);
            const roster = Array.isArray(rawPlayers)
              ? (rawPlayers as Record<string, unknown>[])
              : Array.isArray((rawPlayers as { players?: unknown[] })?.players)
                ? ((rawPlayers as { players: unknown[] }).players as Record<string, unknown>[])
                : [];
            return { session: normalizeSession(rawSession), roster };
          },
          close: () => client.disconnect().catch(() => {}),
        };
      },
      knowledge: (gameId) => {
        const sides = getGame(gameId)?.descriptor.sides;
        if (!sides) return null;
        return {
          sides: sides.map((s) => ({ id: s.id, label: s.label })),
          resolveTeamSides: (counts, heads) => resolveTeamSides(sides, counts, heads),
          teamSidesConfident: (counts, heads) => teamSidesConfident(sides, counts, heads),
          playerId: (row) => rosterPlayerId(row),
        };
      },
    },
    history: {
      window: async (q) => (await repo.events.window({ serverId: q.serverId, kinds: q.kinds, from: q.from, limit: q.limit }))
        .map((r) => ({ kind: r.kind, ts: r.ts, actorName: r.actorName, victimName: r.victimName, weapon: r.weapon })),
    },
    audit: {
      record: async (pluginId, e) => {
        await repo.audit.create({
          actorUserId: e.viewer?.userId ?? null,
          actorName: e.viewer?.name ?? "server console",
          action: `${pluginId}.${e.action}`,
          targetType: "system",
          targetId: pluginId,
          summary: e.summary,
          data: e.data,
        });
      },
    },
    secrets: { forPlugin: (id) => pluginSecrets(id) },
    commands: {
      register: (id, name, description, run) => commands.register(id, name, description, run),
      unregister: (id) => commands.unregister(id),
    },
  };

  const host = new PluginHost(providers);
  for (const p of toLoad) {
    try {
      await host.load(p);
      log.info("plugin loaded", { plugin: p.manifest.id, capabilities: p.manifest.capabilities });
    } catch (err) {
      log.error("plugin failed to load", { err, plugin: p?.manifest?.id });
    }
  }

  const getPluginData = async (pluginId: string, key: string): Promise<{ found: boolean; data?: unknown }> => {
    const provider = dataProviders.get(`${pluginId}:${key}`);
    if (!provider) return { found: false };
    return { found: true, data: await provider() };
  };

  return { host, registry, discordModules, publicModules, bus, getPluginData, routes, pages, commands };
}
