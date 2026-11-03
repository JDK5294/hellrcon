# Plugins

A plugin adds to the panel without changing it: a screen of its own, API routes and live streams,
permissions in Roles, dashboard tiles, buttons on the Discord staff panel, and commands run on the
host. Plugins live in the `installed-plugins` folder and load when the panel starts.

A plugin runs inside the panel with the same access the panel has (see [Trust](#trust)), so only
install plugins you trust.

## Installing one

In the panel's folder (on a Windows PC `%USERPROFILE%\hellrcon`; on a VM `/opt/hellrcon`, with
`sudo` in front), clone the plugin into the plugins folder, then run the start script:

```sh
git clone <the plugin's address> installed-plugins/<a name for it>
```

From then on `start.bat` (or `start.sh`) updates every plugin there that is a git clone along with
the panel, and restarts the panel when one changes. A private repository asks you to sign in to
GitHub the first time. To remove a plugin, delete its folder and run the start script again.

A plugin can also be a plain folder of files, copied in. The start script notices when one is added
or removed, but not when its files change; after editing one, restart the panel's API:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml restart api
```

## Making one

### The smallest useful plugin

Three files in a folder of their own. This one adds a permission to Roles, an API route that
counts visits, a screen that shows it, and a command that resets the count on the host.

**`hello/package.json`**

```json
{
  "name": "hello",
  "version": "1.0.0",
  "type": "module",
  "main": "plugin.js"
}
```

**`hello/plugin.js`**

```js
// The plugin: one ES module whose default export is { manifest, activate }. It may import Node's
// own modules and its own files, and nothing else.
import { readFile } from "node:fs/promises";

export default {
  manifest: {
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    capabilities: ["api:routes", "ui:page", "storage", "commands"],
    permissions: [
      { key: "view", label: "View Hello", description: "Open the Hello screen." },
    ],
  },

  activate(host) {
    // GET /api/plugins/hello/greeting. Only signed-in staff get this far; the plugin decides the rest.
    host.routes.route("GET", "/greeting", async (req, res) => {
      if (!req.viewer.holds("view")) return res.notFound();
      const visits = Number((await host.storage.get("visits")) ?? 0) + 1;
      await host.storage.set("visits", visits);
      res.json(200, { text: `Hello, ${req.viewer.name}!`, visits });
    });

    // The screen, at #/hello under Monitor in the sidebar, for holders of the permission only.
    host.pages.registerPage({
      id: "hello",
      title: "Hello",
      section: "Monitor",
      blurb: "Says hello, and counts the visits.",
      permission: "view",
      script: () => readFile(new URL("./page.js", import.meta.url), "utf8"),
    });

    // Run on the host: node apps/api/dist/plugin-command.js hello reset
    host.commands.register("reset", "Sets the visit count back to zero.", async () => {
      await host.storage.set("visits", 0);
      return "The visit count is back at zero.";
    });
  },
};
```

**`hello/page.js`**

```js
// The screen: one module with nothing to import. The panel hands it its own React and tools.
const { React, api, ui } = globalThis.__hellrconPageKit;
const h = React.createElement;

export default function Hello() {
  const [greeting, setGreeting] = React.useState(null);
  React.useEffect(() => {
    api("/plugins/hello/greeting").then(setGreeting);
  }, []);
  return h("div", null,
    h(ui.PageHeader, { routeId: "hello" }),
    h("div", { className: "card" },
      greeting ? `${greeting.text} Visit ${greeting.visits}.` : h(ui.ScreenLoading)));
}
```

Put the `hello` folder in `installed-plugins` and run the start script. The screen appears under
Monitor for owners straight away; anyone else needs the permission, which Roles lists under "Hello".

The rules every plugin follows:

- **One module.** A folder with a `package.json` whose `main` names the entry, or a single `.mjs`
  file. Its default export is `{ manifest, activate }`.
- **Nothing to install.** A plugin can import Node's own modules (`node:fs`, `node:crypto`, …) and
  its own files. The panel's own packages cannot be imported from it, and nothing is installed for
  it, so a plugin that needs a library bundles it into its own files.
- **Built before it ships.** The panel runs a plugin as it is in the folder; nothing is built on
  install. A plugin written in TypeScript commits its built JavaScript (see
  [Building with TypeScript](#building-with-typescript)).

### The manifest

| Field | What it is |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, starting with a letter, up to 32. It is the plugin's address (`/api/plugins/<id>/…`), the first half of its permissions (`<id>.<key>`) and the name of its storage. Never change it once people use the plugin: their grants and stored settings are filed under it. |
| `name` | Shown under Loaded plugins on the System page and, by default, as the heading of its permissions in Roles. |
| `version` | Your plugin's own version. |
| `apiVersion` | `1`. A plugin built for another version is refused. |
| `capabilities` | What the plugin uses, from the table below. It is handed those and nothing else. |
| `permissions` | Permissions it adds to Roles (see [Permissions](#permissions)). |
| `unlisted` | `true` leaves it out of Loaded plugins, a list every member of staff can read, and out of the System page's count of plugins. Those who may open one of its pages still see it, by its name. |

### What each capability gives

The plugin's `activate(host)` is handed a `host` with one entry per capability it declared; the
rest are absent. `host.log` (`info`, `warn`, `error`, `debug`) is always there.

| Capability | On `host` | For |
| --- | --- | --- |
| `api:routes` | `routes.route(method, path, handler, opts)` | API routes and live streams of its own |
| `ui:page` | `pages.registerPage(def)` | A screen in the panel |
| `storage` | `storage.get(key)`, `storage.set(key, value)` | Its own saved settings and data, as JSON |
| `commands` | `commands.register(name, description, run)` | Commands run on the host, never from the panel |
| `audit` | `audit.record({ viewer, action, summary, data })` | A row in Staff activity, filed as `<id>.<action>` |
| `secrets` | `secrets.seal(text)`, `secrets.open(stored)`, `secrets.sign(data)` | Encrypting what it stores, under the install's key, and signing |
| `game:live` | `game.servers()`, `game.open(serverId)`, `game.knowledge(game)` | Reading a game server: the session and the player list |
| `events:read` | `history.window({ serverId, kinds, from, limit })` | The stored game log |
| `events:subscribe` | `events.on(kind, handler)` | Game events as they happen |
| `ui:widget` | `ui.registerWidget(def)`, `ui.provideData(key, fn)` | Tiles on the dashboard |
| `rcon:read` | `rconRead.readState(serverId, kind)` | One read: `players`, `session`, `objectives` or `maprotation` |
| `rcon:action` | `rcon.execute(serverId, command, params)` | Commands to a game server (refused on a server in observe mode) |
| `discord` | `discord.registerModule(def)` | A module on the Discord staff panel ([docs/discord-modules.md](discord-modules.md)) |

The full definitions, with every field explained, are in
[`packages/plugin-sdk/src/index.ts`](../packages/plugin-sdk/src/index.ts).

### API routes

`host.routes.route(method, path, handler)` answers `GET`, `POST`, `PUT` or `DELETE` at
`/api/plugins/<id><path>`. A path is made of plain segments and `:params`
(`/players/:playerId`); a first segment of `data` is the panel's own.

Every caller is signed in before the handler runs, so a route never sees a stranger. Who they are
is `req.viewer`: `userId`, `name`, `owner` (true for an owner of the install) and
`holds(key, level)` for the plugin's own permissions (`level` is `"read"` unless you say
`"write"`). A route that must not admit it exists answers `res.notFound()`, exactly what the API
answers an address with nothing at it.

- **The request:** `req.params`, `req.query` (a `URLSearchParams`), `await req.body()` (JSON, `{}`
  when there is none), `req.cookie(name)` and `req.https`.
- **The response:** `res.json(status, body)`, `res.error(status, message)`, `res.notFound()`,
  `res.header(name, value)` and `res.cookie(name, value, maxAgeSecs)`. A plugin's cookies are its
  own: HttpOnly, sent only to its routes, and Secure over HTTPS.
- **Live streams:** a `GET` route registered with `{ stream: true }` can answer with
  `res.stream({ recheck })`, which sends server-sent events: `send(data)`, `onClose(fn)`, `end()`.
  A browser's `EventSource` signs in with `?token=` (a screen gets the token from the kit's
  `getToken()`). Every 25 seconds the panel signs the viewer in again and calls `recheck(viewer)`;
  answer `false` and the stream ends, so a revoked permission takes effect within half a minute.

From a screen, `api("/plugins/<id>/<path>")` calls a route with the viewer's sign-in; for a write,
`api(path, { method: "PUT", body })`.

### Permissions

Each permission in the manifest appears in Roles as `<id>.<key>`, under the plugin's name (or the
`group` you give it), with your `label` and `description`. It is granted like any other, and never
by a role preset. `levels` limits it to `["read"]`, `["write"]` or both (the default).

`outright: true` makes it count only when it is held on the account itself or through a role held
everywhere: a role confined to one server does not give it, and only someone who holds it that way
can give it to anyone else. Use it for a screen only named people should see.

If the plugin is removed, or does not start, people's grants of its permissions stay as they were,
and mean what they meant again when it is back.

### A screen of its own

`host.pages.registerPage(def)` adds a screen:

- `id`: lowercase letters, digits and dashes, 2 to 32. The screen's address is `#/<id>`.
- `title`, and `blurb`: one plain sentence saying what it is for, shown in search and under the
  title (`ui.PageHeader` with the screen's id as `routeId`, as in the example).
- `section`: the sidebar section it is listed in: Monitor, Community, Servers, Automation,
  Integrations or Admin, after the panel's own screens there. Any other value lists it under More.
- `permission`: one of the plugin's permission keys. Only its holders are told the screen exists,
  and only they can fetch its code. `ownerOnly: true` limits it to owners of the install.
- `script()`: returns the screen's code as text. `style()`, when given, returns its CSS.

The code is one ES module whose default export is a React component, with nothing to import. It
runs inside the panel's own page, on the panel's own React, and reads everything it needs from
`globalThis.__hellrconPageKit`:

| Kit | What it is |
| --- | --- |
| `version` | `1` |
| `React` | The panel's React: hooks, `createElement`, `Fragment` |
| `jsxRuntime` | The JSX runtime, for compiled JSX |
| `api(path, opts)` | Calls the panel's API as the viewer; throws an `ApiError` with a `status` |
| `getToken()` | The viewer's sign-in token, for an `EventSource`'s `?token=` |
| `access` | `hasCap`, `canOnServer`, `holdsOutright`, `isOwner`, for showing only what the viewer may use |
| `nav.useAppNav()` | The address: `view`, `tab`, `setTab(tab)` (`#/<id>/<tab>`), `go(view)` |
| `prefs` | `recallTab`, `rememberTab`: the tab a viewer last had open |
| `ui` | The panel's own components: `PageHeader`, `TabBar`, `Toggle`, `NumField`, `Callout`, `EmptyState`, `Explanation`, `ActionResult`, `ScreenLoading` |
| `gameAssets` | Map images and role icons for both games, and world-to-map coordinates |
| `viz.seriesVar(i)` | The colour the panel draws its i-th series in |

The panel's own classes (`card`, `row`, `muted`, `hint`) style a screen like the rest of the
panel. To write JSX instead of `createElement`, compile it with the automatic runtime and turn
the one import it produces into a read of the kit:

```js
const { jsx, jsxs, Fragment } = globalThis.__hellrconPageKit.jsxRuntime;
```

Help never lists a plugin's screen, and it is never offered as the page the panel opens on.

### Storing things

`host.storage` keeps JSON values under keys of your choosing, separate from every other plugin's.
A data trim in Administration can remove rows not written for a while, except:

- keys starting `keep:` are never removed: settings, and anything that must not be lost;
- keys starting `keep:viewer:` are one person's own settings (`keep:viewer:<their user id>`). They
  are never removed either, and are left out of data exports, so an archive never shows who uses
  the plugin.

### Commands on the host

A command does what must never be done from the panel, like clearing a forgotten password. Run it
in the panel's folder:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml exec api node apps/api/dist/plugin-command.js <plugin id> <command>
```

Without a command name it lists the plugin's commands. What `run` returns is printed.

### Staff activity, encrypted values and the game

- `host.audit.record({ viewer: req.viewer, action: "thing.done", summary: "…" })` adds a row to
  Staff activity, filed as `<id>.thing.done`. With `viewer: null` it is filed as the server console.
- `host.secrets.seal(text)` encrypts a value for storage under the install's encryption key, and
  `open(stored)` decrypts it (null if it was sealed under a key the install no longer has).
  `sign(data)` gives a signature only this install and this plugin can make.
- `const conn = await host.game.open(serverId)` holds a connection to a game server.
  `await conn.read()` gives `{ session, roster }` (the map, mode, scores and player counts, and
  the player list as the game sent it); `await conn.close()` when done. `host.game.knowledge(game)`
  says which side each team is on and reads a player's id, the same way the panel's Live screen
  does, for both games.

### Dashboard tiles

A tile is described as data, so no code reaches the browser:

```js
host.ui.registerWidget({
  id: "visits", title: "Visits", surface: "dashboard", defaultOrder: 90, defaultVisible: true,
  view: { blocks: [{ type: "stat", label: "Visits", format: "number", source: { kind: "plugin", key: "visits", refreshMs: 30000 } }] },
});
host.ui.provideData("visits", async () => Number((await host.storage.get("visits")) ?? 0));
```

Blocks: `markdown`, `note`, `stat`, `stats` (a grid of figures), `table`, `bars`, `split` and `feed`
(live game events). A block's `source` is `{ kind: "plugin", key }` (backed by `provideData`),
`{ kind: "api", path, pick }` (any panel API, as the viewer) or `{ kind: "static", value }`. The
block types are in [`packages/widgets/src/index.ts`](../packages/widgets/src/index.ts).

### Game events

`host.events.on(kind, handler)` calls `handler` with each event of that kind as it happens, on every
server: `evt.kill`, `evt.teamkill`, `evt.chat.team`, `evt.chat.squad`, `evt.player.connected`,
`evt.player.disconnected`, `evt.match.started`, `evt.match.ended`, `evt.player.kicked`,
`evt.player.banned`, `evt.player.punished` and the rest listed in
[`packages/events/src/index.ts`](../packages/events/src/index.ts). Each carries `kind`, `serverId`,
`ts` and, where it has them, `playerId`, `playerName`, `victimId`, `victimName` and `weapon`.

### Building with TypeScript

The plugin toolkit is not published as a package. To write a plugin in TypeScript, keep it next to
a copy of the panel's repository, built (`pnpm install`, then `pnpm build`), and point your
`tsconfig.json` at its types:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "baseUrl": ".",
    "paths": {
      "@app/plugin-sdk": ["../hellrcon/packages/plugin-sdk/dist/index.d.ts"],
      "@app/shared": ["../hellrcon/packages/shared/dist/index.d.ts"],
      "@app/widgets": ["../hellrcon/packages/widgets/dist/index.d.ts"]
    },
    "typeRoots": ["../hellrcon/apps/api/node_modules/@types"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

The paths assume the copy is in a folder named `hellrcon` beside your plugin's folder; change
them to match yours. Build with that copy's TypeScript (`../hellrcon/node_modules/.bin/tsc -p .`).
Import from the toolkit with `import type` only, so the built file imports nothing, and commit the
built `dist/` with the change.

## Trying it, and finding problems

Put the plugin in `installed-plugins` and run the start script. The API says what it made of it:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml logs api
```

Look for `plugin loaded` with your plugin's id. Otherwise the reason is on a line saying
`plugin failed to load`, `failed to import discovered plugin` or `skipped: not a plugin module`. A
plugin that fails part-way leaves nothing behind (no permissions, routes or screens), and the panel
carries on without it.

For tests of your own, the panel's repository boots the real API with a plugin in
[`apps/api/test/plugin-capabilities.test.ts`](../apps/api/test/plugin-capabilities.test.ts), and a
plugin kept next to a copy of the repository can do the same. The example on this page is loaded
and used by the repository's tests, so it stays correct.

## Trust

Capabilities decide what the panel hands a plugin; they are not a wall around it. A plugin's code
runs inside the panel's API with the same access the panel has, and its screen runs in the panel's
page signed in as whoever is viewing it. Install only plugins you trust, and read the code of any
you did not write.
