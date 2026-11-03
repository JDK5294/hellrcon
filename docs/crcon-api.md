# CRCON's HTTP API

**CRCON is reference and import only.** Day-to-day operations run through direct RCON — see
`docs/rcon-503.md` for what the game server itself exposes. This file exists for two jobs: pulling
a community's history out of an existing CRCON install, and answering "how did they solve X?"
without re-reading their source.

Everything below was extracted from the CRCON source by parsing it, not by hand. **Current as of
CRCON v11.12.0** (2026-08-10); see `docs/crcon-releases.md` for what each release changed and what
we took from it. The whole chain is committed so it can be re-run against a newer release:

| File | What it is |
|---|---|
| `docs/crcon-api/endpoints.md` | All 304 endpoints — verbs, permission, signature, return type |
| `docs/crcon-api/response-types.md` | The 93 response shapes and enums from `rcon/types.py` |
| `docs/crcon-api/catalogue.json` | The same data, machine-readable (grep this) |
| `docs/crcon-api/extract.py` | Source → JSON: `python3 extract.py <path-to-hll_rcon_tool> > catalogue.json` |
| `docs/crcon-api/render.py` | JSON → the two tables: `python3 render.py` |

To refresh: clone or unpack the release somewhere, run the two scripts in that order, and read the
diff. Both are dependency-free and deterministic, so an unchanged release produces an empty diff
and anything that does show up is a real change.

## Calling it

Every endpoint is `/<base>/api/<name>` — one flat namespace, no REST nesting. Auth is a bearer
token (`authorization: Bearer <api key>`); a session cookie from `login` also works. Arguments go
as query parameters on `GET` and as a JSON body on `POST`. Our client is
`packages/rcon-core/src/protocol/crcon-bridge/client.ts`.

Every response is the same envelope, whether it succeeded or not — **a 200 does not mean the
command worked**, `failed` does:

```json
{
  "result": null,
  "command": "get_detailed_players",
  "arguments": {},
  "failed": false,
  "error": null,
  "forwards_results": null,
  "version": "v11.1.2"
}
```

`result` holds the payload; its shape is the endpoint's return type in the table.
`forwards_results` is populated only when a write was forwarded to other servers in a multi-server
install. `version` is `git describe --tags` of the install, or the literal `"unknown"` when the
container has no git metadata — don't parse it for feature detection.

## How the endpoint list is built

Two mechanisms, which is why the table has a `manual` / `auto` split:

- **auto** — `rconweb/api/views.py` holds `ENDPOINT_PERMISSIONS`, a dict of *function object* →
  permission string. At import time every key is wrapped and registered under its `__name__`.
  Those functions are methods on `ServerCtl` → `Rcon` → `RconAPI` (each subclasses the last), so
  they carry real type annotations, which is where the signatures in the table come from.
- **manual** — `rconweb/api/urls.py` lists plain Django views by hand: `login`, `logout`, the
  scoreboards, audit log, services, VIP upload/download, and the `describe_*_config` family.
  These take the raw `request`, so there is no signature to read and the table gives the defining
  module instead.

CRCON also serves its own introspection at `/api/get_api_documentation`, which returns roughly
what our table holds. Useful against a live install; useless when you only have the source, which
is why this is extracted statically.

## Permissions

Django permissions, all namespaced `api.can_*` (e.g. `api.can_view_detailed_players`,
`api.can_kick_players`). They gate one endpoint each, with no notion of scope — a permission is
global to the install, not per-server. That flatness is exactly what our own per-server RBAC
(`packages/access`) exists to replace, so treat the permission column as "what this touches",
not as a model to copy.

## The endpoints we actually use

The import path reads history and never writes. `get_players_history`, `get_player_profile`,
`get_bans`, `get_blacklists`, `get_blacklist_records`, `get_vip_ids`, `get_map_history`,
`get_scoreboard_maps` (each round's final score plus its full per-player stats — the score
buckets and round playtime no log line carries, applied AFTER the kill logs so the totals
reconcile by max rather than double-count), `get_historical_logs`, `get_recent_logs`, and the
three `get_standard_*_messages`. Nothing else in
the 298 is on our critical path — the rest is catalogued so a question about CRCON's behaviour can
be answered from here rather than from a re-upload.

## Two findings worth keeping at the top

**No reader for the active objective layout.** `get_objective_rows` returns each sector row's
*choices* (what fills the dropdown), and `set_game_layout` writes. There is no endpoint that says
which layout a round is running. This matches the game's own RCON — see the objectives section of
`docs/rcon-503.md`, which is the authority.

**`worldPosition` is always present, never absent.** `get_detailed_players` →
`GetDetailedPlayers` → per-player `world_position`, and CRCON defaults it to `{x: 0, y: 0, z: 0}`
rather than omitting the key when the game gives nothing. So a player at the origin and a player
with no position read identically, and any consumer has to treat all-zero as "unknown".
