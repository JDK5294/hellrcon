/**
 * @app/plugin-sdk — the contract third-party modules build against, and the host
 * runtime that loads them.
 *
 * Core guarantee (same discipline as our RBAC + engagement guard): a plugin declares the
 * **capabilities** it needs in its manifest, and the host hands it a `host` object that
 * exposes ONLY those. Undeclared namespaces are simply absent — a plugin cannot reach a
 * power it didn't ask for, and is never handed a raw socket. First-party features are built
 * on this exact contract (dogfooding).
 *
 * Capabilities scope what the host HANDS a plugin; they are not a sandbox. A plugin runs inside
 * the API's own process, and a plugin page runs inside the panel's own page, so installing one
 * is trusting it — the operator decides what goes in the plugins folder.
 */
import type { Logger } from "@app/shared";
import type { WidgetDef } from "@app/widgets";

/** The host API version. A plugin's manifest must target the same major. */
export const HOST_API_VERSION = 1;

export type Capability =
  | "events:subscribe" | "ui:widget" | "storage" | "rcon:read" | "rcon:action" | "discord"
  | "api:routes" | "ui:page" | "game:live" | "events:read" | "audit" | "secrets" | "commands";

const KNOWN_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "events:subscribe",
  "ui:widget",
  "storage",
  "rcon:read",
  "rcon:action",
  "discord",
  "api:routes",
  "ui:page",
  "game:live",
  "events:read",
  "audit",
  "secrets",
  "commands",
]);

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** major host-API version this plugin targets (must equal HOST_API_VERSION). */
  apiVersion: number;
  capabilities: Capability[];
  /** Permissions this plugin adds to Roles, granted to staff like any other. Each one is
   *  `<plugin id>.<key>` in a grant. Declaring them confers nothing on the plugin itself. */
  permissions?: PluginPermissionDef[];
  /**
   * Left out of the panel's list of running plugins, and of its count, for everyone but those who
   * may open one of the plugin's pages. For a need-to-know plugin: that list is open to all staff,
   * and the plugin's name alone would tell them what is installed.
   */
  unlisted?: boolean;
}

/** One permission a plugin adds to Roles. */
export interface PluginPermissionDef {
  /** `[a-z][a-z0-9_-]{0,31}`; the permission is `<plugin id>.<key>`. */
  key: string;
  label: string;
  description: string;
  /** The heading it is listed under in the role editor. Default: the plugin's name. */
  group?: string;
  /** The levels it can be granted at. Default: read and write. */
  levels?: ("read" | "write")[];
  /**
   * Counts only when held OUTRIGHT: granted on the account itself or by a role held everywhere —
   * never by a grant confined to one server, never by the read an open request draft lends. And
   * only someone who holds it outright can hand it to anyone else.
   */
  outright?: boolean;
}

// --- Capability namespaces (what each capability grants) ---
export interface EventsApi {
  on(kind: string, handler: (evt: unknown) => void): () => void;
}
export interface UiApi {
  registerWidget(def: WidgetDef): void;
  /**
   * Back a widget's `{ source: { kind: "plugin", key } }` blocks with live data. The provider
   * runs server-side on demand (the panel fetches it via the API); return any JSON-serializable
   * value. Keys are namespaced per plugin, so plugins can't read each other's data.
   */
  provideData(key: string, provider: () => unknown | Promise<unknown>): void;
}
/** The plugin's own key-value store. A data trim can remove a row not written for a while, but
 *  never one keyed under `keep:`; one under `keep:viewer:` (a person's own setting) also stays out
 *  of every archive. */
export interface StorageApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
export interface RconReadApi {
  readState(serverId: string, kind: string): Promise<unknown>;
}
export interface RconActionApi {
  execute(serverId: string, command: string, params?: Record<string, unknown>): Promise<unknown>;
}
// --- Discord modules (the /staff panel — docs/discord-modules.md) ---

/** One button row cell on a Discord view. `customId` is the ACTION+STATE half only — the host
 *  prefixes the module routing (`sp:<moduleId>:`), so a module can never press outside itself. */
export interface DiscordButton {
  label: string;
  /** "<action>" or "<action>:<state>" — becomes `sp:<moduleId>:<action>:<state>`. */
  customId: string;
  style?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
  /** Address ANOTHER module instead of this one — a hub's door into its sub-panels. The press is
   *  gated by the TARGET module's capability, exactly as if it were opened from the launcher. */
  moduleId?: string;
}

/** A declarative, ephemeral screen. The host renders it, enforces Discord's component limits,
 *  and appends its own Back row — modules never draw the launcher's chrome. */
export interface DiscordView {
  content: string;
  rows?: DiscordButton[][];
  /** At most one user-select row (rendered after the buttons): "pick a person" screens — the
   *  gift flows. The interaction comes back with the picked user ids in `selected`. */
  userSelect?: { customId: string; placeholder?: string };
  /** A string-choice dropdown (Discord's select menu). One row, up to 25 options — the right
   *  control for picking one name out of a long list, where buttons would eat every row. The
   *  picked value arrives as `selected[0]`. */
  select?: { customId: string; placeholder?: string; options: { label: string; value: string; description?: string }[] };
}

/**
 * A pop-up form. Discord only accepts one as the FIRST response to an interaction, which is the
 * single rule that shapes every flow using them: the action that OPENS a modal must never be
 * deferred, and the submit comes back as its own interaction routed by `action`/`state`.
 */
export interface DiscordModal {
  title: string;
  /** Routes the submit back: becomes `<prefix>:<moduleId>:<action>:<state>`. */
  action: string;
  state?: string;
  fields: { id: string; label: string; placeholder?: string; maxLength?: number }[];
}

/** A handler either draws a screen or opens a form. */
export type DiscordModuleResult = DiscordView | { modal: DiscordModal };

/** What a press carries: who pressed, and the action/state the custom_id encoded. */
export interface DiscordModuleEvent {
  discordUserId: string;
  discordUserName: string;
  action: string;
  state: string;
  /** Present on modal submits: field id → what the user typed. */
  values?: Record<string, string>;
  /** Present on select interactions: the picked values (user ids from a user select, option
   *  values from a string select). */
  selected?: string[];
  /** User-select only: picked id → the display name Discord resolved for it, in the same payload.
   *  A module acting on somebody it did not press as has no other way to learn their name, and a
   *  member recorded without one is unfindable by name for good. */
  selectedNames?: Record<string, string>;
  /** The guild roles Discord says the presser holds, resolved at press time. Empty in a DM, and
   *  empty is never "unrestricted" — a role-gated feature refuses when it cannot see the roles. */
  roleIds?: string[];
  /** The interaction's own id — Discord's natural idempotency key for anything that must not
   *  happen twice when a press is retried. */
  interactionId?: string;
  /** The channel the panel was opened in. Empty when Discord did not send one (a DM). A module
   *  that posts something public needs this — the panel itself is ephemeral, so "here" is the
   *  only channel it knows. */
  channelId?: string;
  /** That channel's name, as Discord sent it. For the audit trail: "#testing" is answerable,
   *  a bare snowflake is a lookup nobody does. */
  channelName?: string;
  /** The PANEL account behind the press, resolved from the Discord id before the module ran.
   *  A module that writes anything must attribute it to this, not to the Discord id — the trail
   *  answers "which staff member", and Discord ids are not staff accounts. */
  staffUserId?: string;
  staffName?: string;
}

export interface DiscordModuleDef {
  /** `[a-z0-9_-]{1,32}` — it lands inside custom_ids. Plugin modules are namespaced to
   *  `<pluginId>.<id>` by the host. */
  id: string;
  /** The launcher button's text. */
  label: string;
  description?: string;
  /** The panel capability required to open it — re-checked on EVERY interaction. */
  capability: string;
  capabilityLevel?: "read" | "write";
  /** Kept off the launcher — reachable only through another module's jump buttons (still
   *  capability-gated per press). How a hub absorbs sub-panels without orphaning their code. */
  hidden?: boolean;
  /** Where the host's Back row leads (default: the launcher). A sub-panel names its hub here so
   *  leaving it lands where the user came from, not two levels up. */
  backTo?: string;
  /** Set when handlers do slow work (RCON, network): the host defers within Discord's 3-second
   *  budget and follows up through the interaction webhook when the handler resolves. Whole-module,
   *  so it cannot be combined with modals — use `deferActions` when only some steps are slow. */
  defer?: boolean;
  /** The slow actions, named one by one. Actions that RETURN A MODAL must not be listed: a modal
   *  can only be the first response, and a deferred one arrives too late to be accepted. */
  deferActions?: string[];
  /** The module's root view (the launcher button, or an `open` action with empty state). */
  open(ev: DiscordModuleEvent): Promise<DiscordModuleResult> | DiscordModuleResult;
  /** Any other action pressed inside the module's views. Absent = only `open` exists. */
  action?(ev: DiscordModuleEvent): Promise<DiscordModuleResult> | DiscordModuleResult;
}

export interface DiscordApi {
  /** Add a module to the /staff panel. Plugin module ids are namespaced by plugin id, and the
   *  module is removed when the plugin unloads. */
  registerModule(def: DiscordModuleDef): void;
}

// --- API routes (`api:routes`) ---

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Who is asking, as the host resolved them for this request. */
export interface PluginViewer {
  userId: string;
  name: string;
  /** Holds the global "*" at write outright: an owner of this install. */
  owner: boolean;
  /** Whether they hold one of THIS plugin's permissions (its key as declared) at `level`, read by
   *  default. An outright permission is asked the outright question. An undeclared key: never. */
  holds(permission: string, level?: "read" | "write"): boolean;
}

export interface PluginRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly viewer: PluginViewer;
  /** Whether the viewer reached the panel over HTTPS, directly or through a tunnel that says so. */
  readonly https: boolean;
  /** The body as JSON; {} when there is none. */
  body(): Promise<Record<string, unknown>>;
  /** One of this plugin's cookies (set with `res.cookie`); "" when the browser sent none. */
  cookie(name: string): string;
}

export interface PluginResponse {
  json(status: number, body: unknown): void;
  /** `{ error }` with the status: the body every other route sends. */
  error(status: number, message: string): void;
  /** Exactly what the API answers an address it has no route for — for a route that must not
   *  confirm it exists. */
  notFound(): void;
  /** A response header. Cookies go through `cookie`. */
  header(name: string, value: string): void;
  /** Sets one of this plugin's cookies: HttpOnly, SameSite=Strict, sent only to this plugin's
   *  routes, Secure over HTTPS. A max age of 0 clears it. */
  cookie(name: string, value: string, maxAgeSecs: number): void;
  /** Turns the response into a live stream (server-sent events). Only on a `stream` route. */
  stream(opts?: StreamOptions): PluginStream;
}

export interface StreamOptions {
  /**
   * Run on every heartbeat with the viewer as they are NOW, signed in and their permissions read
   * again; false ends the stream. A viewer who is no longer signed in is ended without asking.
   */
  recheck?(viewer: PluginViewer): boolean | Promise<boolean>;
}

export interface PluginStream {
  /** Sends one message. False when nothing was sent: the stream had ended, or the viewer had
   *  fallen so far behind that the host ended it. */
  send(data: unknown): boolean;
  readonly closed: boolean;
  /** Called once when the stream ends, for whatever reason. */
  onClose(cb: () => void): void;
  end(): void;
}

export type PluginRouteHandler = (req: PluginRequest, res: PluginResponse) => void | Promise<void>;

export interface RoutesApi {
  /**
   * Answers `method` at `/api/plugins/<plugin id>/<path>`; `path` may name `:params`. Every route
   * is behind the panel's sign-in: an anonymous request is turned away before the handler runs.
   * `stream` (GET only) also signs the browser in by `?token=`, the only way an EventSource can.
   */
  route(method: HttpMethod, path: string, handler: PluginRouteHandler, opts?: { stream?: boolean }): void;
}

// --- Panel pages (`ui:page`) ---

export interface PluginPageDef {
  /** `[a-z][a-z0-9-]{1,31}`, and the page's address in the panel: `#/<id>`. */
  id: string;
  title: string;
  /** The sidebar section it is listed in: Monitor, Community, Servers, Automation, Integrations
   *  or Admin. */
  section: string;
  /** One plain sentence: what the page is for. */
  blurb?: string;
  /** One of this plugin's permission keys: only its holders see the page or can fetch its code. */
  permission?: string;
  /** Owners only (the global "*" at write), whatever else is held. */
  ownerOnly?: boolean;
  /**
   * The page's code: an ES module whose default export is a React component, drawn in the panel
   * with the panel's own React and kit (see the panel's lib/pluginKit.ts). Read on demand, and only
   * for a viewer who may open the page.
   */
  script(): string | Promise<string>;
  /** The page's stylesheet, when it has one. */
  style?(): string | Promise<string>;
}

export interface PagesApi {
  registerPage(def: PluginPageDef): void;
}

// --- Game servers, live (`game:live`) ---

export interface GameServerInfo {
  id: string;
  name: string;
  game: string;
}

/** The session read, normalized: the same shape for every game. */
export interface GameSession {
  mapName?: string;
  mapId?: string;
  gameMode?: string;
  remainingMatchTime?: number;
  alliedScore?: number;
  axisScore?: number;
  playerCount?: number;
  alliedPlayerCount?: number;
  axisPlayerCount?: number;
}

export interface GameConnection {
  /** The session and the roster, read together; the roster rows are the game's own, as read. */
  read(): Promise<{ session: GameSession; roster: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

export interface SessionHeadcounts {
  alliedPlayerCount?: number;
  axisPlayerCount?: number;
}

/** What the host knows about a game, so a plugin never carries a copy that goes stale. */
export interface GameKnowledge {
  sides: { id: string; label: string }[];
  /** Every team value on a roster to its side (null: on no team), from the same evidence the
   *  panel's Live view uses. */
  resolveTeamSides(teamCounts: Map<number, number>, heads?: SessionHeadcounts): Map<number, string | null>;
  /** Whether that answer rests on evidence rather than on the last-resort guess. */
  teamSidesConfident(teamCounts: Map<number, number>, heads?: SessionHeadcounts): boolean;
  /** A roster row's player id. */
  playerId(row: Record<string, unknown>): string;
}

export interface GameLiveApi {
  servers(): Promise<GameServerInfo[]>;
  /** A connection held open until closed, for reads. Rejects for a server that does not exist. */
  open(serverId: string): Promise<GameConnection>;
  /** Null for a game the host does not know. */
  knowledge(gameId: string): GameKnowledge | null;
}

// --- Stored game events (`events:read`) ---

export interface StoredEvent {
  kind: string;
  ts: string;
  actorName: string | null;
  victimName: string | null;
  weapon: string | null;
}

export interface EventHistoryApi {
  /** One server's stored events of `kinds` from `from` (ISO), oldest first; when the window holds
   *  more than `limit`, the newest `limit` of them. */
  window(q: { serverId: string; kinds: string[]; from: string; limit: number }): Promise<StoredEvent[]>;
}

// --- Staff activity (`audit`) ---

export interface AuditApi {
  /** One row in the staff activity trail, filed as `<plugin id>.<action>`. A null viewer is the
   *  server console: a host command. */
  record(entry: { viewer: PluginViewer | null; action: string; summary: string; data?: Record<string, unknown> }): Promise<void>;
}

// --- Sealed values (`secrets`) ---

export interface SecretsApi {
  /** Seals a value for storage under the install's encryption key; as it is when there is none. */
  seal(plain: string): string;
  /** Opens a stored value: as it is when it was never sealed; null when it was sealed under a key
   *  this install no longer holds. */
  open(stored: string): string | null;
  /** HMAC-SHA256 of `data`, hex, under a key only this install and this plugin hold. It survives
   *  restarts when the install has an encryption key, and lasts one process when it has none. */
  sign(data: string): string;
}

// --- Host commands (`commands`) ---

export interface CommandsApi {
  /**
   * A command run on the host, never from the panel:
   * `node apps/api/dist/plugin-command.js <plugin id> <name>` in the api container. What it
   * returns is printed.
   */
  register(name: string, description: string, run: () => string | Promise<string>): void;
}

/** The host object a plugin receives. Only declared-capability namespaces are present. */
export interface PluginHostApi {
  /** always available: a logger tagged with the plugin id. */
  log: Logger;
  events?: EventsApi;
  ui?: UiApi;
  storage?: StorageApi;
  rconRead?: RconReadApi;
  rcon?: RconActionApi;
  discord?: DiscordApi;
  routes?: RoutesApi;
  pages?: PagesApi;
  game?: GameLiveApi;
  history?: EventHistoryApi;
  audit?: AuditApi;
  secrets?: SecretsApi;
  commands?: CommandsApi;
}

export interface PluginModule {
  manifest: PluginManifest;
  activate(host: PluginHostApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Author a plugin. (Identity helper that also anchors types.) */
export function definePlugin(mod: PluginModule): PluginModule {
  return mod;
}

/**
 * The concrete implementations the host wires in. Namespaced storage keeps plugins from
 * reading each other's data. rcon/discord are optional — a host that doesn't provide them
 * will reject plugins that declare those capabilities (fail-closed).
 */
export interface HostProviders {
  logger: (component: string) => Logger;
  events: EventsApi;
  ui: UiApi;
  storage: { get(namespace: string, key: string): Promise<unknown>; set(namespace: string, key: string, value: unknown): Promise<void> };
  rconRead?: RconReadApi;
  rcon?: RconActionApi;
  /** Richer than the plugin-facing DiscordApi: unregister exists so unload removes modules. */
  discord?: { registerModule(def: DiscordModuleDef): void; unregisterModule(id: string): void };
  /** Adds a manifest's permissions to Roles. Throws when one clashes with a permission that
   *  already exists, which refuses the plugin. */
  permissions?: { register(manifest: PluginManifest): void; unregister(pluginId: string): void };
  routes?: { register(pluginId: string, method: HttpMethod, path: string, handler: PluginRouteHandler, opts: { stream: boolean }): void; unregister(pluginId: string): void };
  pages?: { register(pluginId: string, def: PluginPageDef): void; unregister(pluginId: string): void };
  game?: GameLiveApi;
  history?: EventHistoryApi;
  audit?: { record(pluginId: string, entry: Parameters<AuditApi["record"]>[0]): Promise<void> };
  secrets?: { forPlugin(pluginId: string): SecretsApi };
  commands?: { register(pluginId: string, name: string, description: string, run: () => string | Promise<string>): void; unregister(pluginId: string): void };
}

export class PluginError extends Error {}

interface Loaded {
  module: PluginModule;
  cleanups: Array<() => void>;
}

/** A plugin id lands in addresses, permission keys and the storage namespace, so it is plain. */
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PERMISSION_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const PAGE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A route path under the plugin's prefix: literal segments and `:params`. */
const ROUTE_PATH = /^(?:\/(?:[a-z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*))+$/;
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE"]);
/** `/api/plugins/<id>/data` is the widget data endpoint every plugin already has. */
const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(["data"]);

function validatePermissions(m: PluginManifest): void {
  const seen = new Set<string>();
  for (const p of m.permissions ?? []) {
    if (!PERMISSION_KEY.test(p?.key ?? "")) throw new PluginError(`plugin ${m.id} declares a permission with a bad key: ${String(p?.key)}`);
    if (seen.has(p.key)) throw new PluginError(`plugin ${m.id} declares the permission ${p.key} twice`);
    seen.add(p.key);
    if (!p.label?.trim() || !p.description?.trim()) throw new PluginError(`plugin ${m.id}: permission ${p.key} needs a label and a description`);
    if (p.levels && (!p.levels.length || p.levels.some((l) => l !== "read" && l !== "write"))) {
      throw new PluginError(`plugin ${m.id}: permission ${p.key} levels must be read and/or write`);
    }
  }
}

export class PluginHost {
  private loaded = new Map<string, Loaded>();
  private readonly providers: HostProviders;

  constructor(providers: HostProviders) {
    this.providers = providers;
  }

  list(): PluginManifest[] {
    return [...this.loaded.values()].map((l) => l.module.manifest);
  }

  /** Validate the manifest, build the capability-scoped host, and activate the plugin. */
  async load(module: PluginModule): Promise<void> {
    const m = module.manifest;
    if (!m?.id) throw new PluginError("manifest.id is required");
    if (!PLUGIN_ID.test(m.id)) throw new PluginError(`plugin id must be lowercase letters, digits and dashes, starting with a letter: ${m.id}`);
    if (this.loaded.has(m.id)) throw new PluginError(`plugin already loaded: ${m.id}`);
    if (m.apiVersion !== HOST_API_VERSION) throw new PluginError(`plugin ${m.id} targets api v${m.apiVersion}, host is v${HOST_API_VERSION}`);
    for (const cap of m.capabilities) {
      if (!KNOWN_CAPABILITIES.has(cap)) throw new PluginError(`plugin ${m.id} declares unknown capability: ${cap}`);
    }
    validatePermissions(m);

    const cleanups: Array<() => void> = [];
    // A plugin that fails part-way must leave nothing behind: a permission in Roles, a route or a
    // page that answers for code that never finished starting.
    const undo = () => {
      for (const c of cleanups.splice(0)) {
        try { c(); } catch { /* the rest still go */ }
      }
    };
    try {
      if (m.permissions?.length) {
        const perms = this.providers.permissions;
        if (!perms) throw new PluginError(`host cannot add the permissions plugin ${m.id} declares`);
        perms.register(m);
        cleanups.push(() => perms.unregister(m.id));
      }
      const host = this.buildScopedHost(m, cleanups);
      await module.activate(host);
    } catch (err) {
      undo();
      throw err;
    }
    this.loaded.set(m.id, { module, cleanups });
  }

  async unload(id: string): Promise<void> {
    const l = this.loaded.get(id);
    if (!l) return;
    for (const c of l.cleanups) c();
    await l.module.deactivate?.();
    this.loaded.delete(id);
  }

  private buildScopedHost(m: PluginManifest, cleanups: Array<() => void>): PluginHostApi {
    const caps = new Set(m.capabilities);
    const host: PluginHostApi = { log: this.providers.logger(`plugin:${m.id}`) };

    const require = <T>(value: T | undefined, cap: Capability): T => {
      if (!value) throw new PluginError(`host cannot provide capability '${cap}' required by plugin ${m.id}`);
      return value;
    };

    if (caps.has("events:subscribe")) {
      const events = this.providers.events;
      host.events = {
        on: (kind, handler) => {
          const off = events.on(kind, handler);
          cleanups.push(off); // auto-unsubscribe on unload
          return off;
        },
      };
    }
    if (caps.has("ui:widget")) {
      const ui = this.providers.ui;
      host.ui = {
        // Namespace the widget id by plugin id, for the same reason the data keys below are: the
        // registry is one flat map, so an un-namespaced id let a plugin register `players` and
        // silently replace the first-party Players entry for everyone — or two plugins both
        // register `feed` and clobber each other. The plugin id is stamped on as well, so the
        // panel still knows which plugin backs the widget's data sources.
        registerWidget: (d) => ui.registerWidget({ ...d, id: `${m.id}:${d.id}`, pluginId: m.id }),
        // Namespace data keys by plugin id so a plugin can't serve (or shadow) another's data.
        provideData: (key, provider) => ui.provideData(`${m.id}:${key}`, provider),
      };
    }
    if (caps.has("storage")) {
      const store = this.providers.storage;
      host.storage = {
        get: (key) => store.get(m.id, key), // namespaced by plugin id
        set: (key, value) => store.set(m.id, key, value),
      };
    }
    if (caps.has("rcon:read")) host.rconRead = require(this.providers.rconRead, "rcon:read");
    if (caps.has("rcon:action")) host.rcon = require(this.providers.rcon, "rcon:action");
    if (caps.has("discord")) {
      const discord = require(this.providers.discord, "discord");
      host.discord = {
        // Namespaced like widgets (`<pluginId>.<id>` — a DOT, because the colon is the
        // custom_id's segment separator), and removed again when the plugin unloads so a stale
        // button can never dispatch into unloaded code.
        registerModule: (d) => {
          const id = `${m.id}.${d.id}`;
          discord.registerModule({ ...d, id });
          cleanups.push(() => discord.unregisterModule(id));
        },
      };
    }
    if (caps.has("api:routes")) {
      const routes = require(this.providers.routes, "api:routes");
      cleanups.push(() => routes.unregister(m.id));
      host.routes = {
        route: (method, path, handler, opts) => {
          if (!METHODS.has(method)) throw new PluginError(`plugin ${m.id}: unknown method ${method}`);
          if (!ROUTE_PATH.test(path)) throw new PluginError(`plugin ${m.id}: bad route path ${path}`);
          const first = path.split("/")[1]!;
          if (RESERVED_FIRST_SEGMENTS.has(first)) throw new PluginError(`plugin ${m.id}: /${first} is the host's own`);
          const stream = opts?.stream === true;
          if (stream && method !== "GET") throw new PluginError(`plugin ${m.id}: only a GET route can stream`);
          routes.register(m.id, method, path, handler, { stream });
        },
      };
    }
    if (caps.has("ui:page")) {
      const pages = require(this.providers.pages, "ui:page");
      cleanups.push(() => pages.unregister(m.id));
      const declared = new Set((m.permissions ?? []).map((p) => p.key));
      host.pages = {
        registerPage: (d) => {
          if (!PAGE_ID.test(d?.id ?? "")) throw new PluginError(`plugin ${m.id}: page id must be lowercase letters, digits and dashes: ${String(d?.id)}`);
          if (!d.title?.trim() || !d.section?.trim()) throw new PluginError(`plugin ${m.id}: page ${d.id} needs a title and a section`);
          if (typeof d.script !== "function") throw new PluginError(`plugin ${m.id}: page ${d.id} has no script`);
          if (d.permission !== undefined && !declared.has(d.permission)) {
            throw new PluginError(`plugin ${m.id}: page ${d.id} names a permission the plugin does not declare: ${d.permission}`);
          }
          pages.register(m.id, d);
        },
      };
    }
    if (caps.has("game:live")) host.game = require(this.providers.game, "game:live");
    if (caps.has("events:read")) host.history = require(this.providers.history, "events:read");
    if (caps.has("audit")) {
      const audit = require(this.providers.audit, "audit");
      host.audit = {
        record: (e) => {
          if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(e?.action ?? "")) throw new PluginError(`plugin ${m.id}: bad audit action ${String(e?.action)}`);
          return audit.record(m.id, e);
        },
      };
    }
    if (caps.has("secrets")) host.secrets = require(this.providers.secrets, "secrets").forPlugin(m.id);
    if (caps.has("commands")) {
      const commands = require(this.providers.commands, "commands");
      cleanups.push(() => commands.unregister(m.id));
      host.commands = {
        register: (name, description, run) => {
          if (!COMMAND_NAME.test(name)) throw new PluginError(`plugin ${m.id}: command name must be lowercase letters, digits and dashes: ${name}`);
          commands.register(m.id, name, description, run);
        },
      };
    }

    return host;
  }
}
