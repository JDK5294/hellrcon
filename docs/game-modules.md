# Adding a game

Core (db, api, panel, ingest, rcon-core) is game-agnostic. Everything game-specific lives in a
**game module** registered in `packages/games`. Adding a game means writing one module and — if the
game speaks a protocol we don't already have — one protocol adapter. No panel changes, no schema
changes, no API route changes.

## What a module provides (`GameModule` in `packages/games/src/types.ts`)

| Piece | What it is | Where HLL's lives |
| --- | --- | --- |
| `id`, `label` | stable id (`"hll"`) + display name | `packages/games/src/hll.ts` |
| `protocols` | which wire protocols its servers speak (drives the Add Server form + validation) | same |
| `commands` | logical→wire command table (`CommandTable` from rcon-core) | `packages/games/src/hll/commands.ts` |
| `normalizeLine` | raw admin-log line → canonical `evt.*` event | `packages/games/src/hll/log.ts` |
| `logLineKey` | **stable per-event identity across polls** — drives ingest dedup. If your log format embeds a timestamp, include it; a key that collides for two distinct events silently drops the second | `packages/games/src/hll/log.ts` |
| `descriptor` | JSON-safe domain data the panel renders from (below) | `packages/games/src/hll.ts` |

## The descriptor (all UI vocabulary)

- `sides` — factions: raw `team` numbers → id/label/color (`blue`/`red`/`neutral`), optional
  even/odd parity fallback. First two sides drive the Live view's team-stats columns.
- `roles` — numeric role id → label. `squadLeaderRoles` powers the "No SL" warning.
- `scoreFields` — keys inside each live player's `scoreData` + labels (scoreboard columns).
- `configFields` — editable server settings: field, label, kind (`bool`/`num`/`str`), read
  command+key, write command+param. The config editor renders these generically; the panel can add
  optional presentation "skins" per field name (sliders, icons) but works without them.

## Contracts your adapter must honor

1. **`readState("players")`** returns `NormalizedLivePlayer[]` (or `{ players: [...] }`) — see the
   type in `packages/games/src/types.ts`. All fields optional; keys are the contract. `iD` (the
   platform id) is what actions and profile links key on. `scoreData` keys must match the
   descriptor's `scoreFields`.
2. **`readState("session")`** is displayed opportunistically (`mapName`, `playerCount`,
   `maxPlayerCount`, `remainingMatchTime`… all optional; missing pieces simply don't render).
3. **`readLogLines(seconds)`** returns raw log lines; the module's `normalizeLine` parses them.
4. **Logical command names are the shared vocabulary.** Implement the ones the app drives:
   reads `getPlayers`, `getSession`, `getAdminLog`; actions `messagePlayer`, `kickPlayer`,
   `punishPlayer`, `tempBanPlayer`, `permaBanPlayer`, `removeTempBan`, `removePermaBan`,
   `switchTeamNow`, `switchTeamOnDeath`, `addVip`, `removeVip`. Anything missing from the table
   fails fast with "Unknown logical command" and the matching UI action errors cleanly — the rest
   of the app keeps working.

## Steps

1. `packages/games/src/<game>.ts` — build the `GameModule` (put the command table and log parser
   under `packages/games/src/<game>/` like HLL does).
2. Register it in `packages/games/src/index.ts` (`MODULES` map, or `registerGame` at startup).
3. If it needs a new protocol: add an adapter under `packages/rcon-core/src/protocol/<name>/`
   implementing `RconAdapter`, add the protocol string to `RconProtocol` (@app/shared) and a
   case in `createAdapter` (factory). Adapters receive the command table by injection — never
   import game data.
4. List the protocol in the module's `protocols`. Done — the game appears in the Add Server form,
   its descriptor drives the whole UI, and observe-mode write-blocking works from the command
   table's `access` flags.

## Known cross-game behaviors (by design)

- Players are keyed on `platformId` alone, **across games and platforms** — one human, one profile;
  career stats aggregate over every server they play on. Platform is display metadata, not
  identity: writers disagree about it for the same person, and letting it key identity forked
  players into twin rows.
- VIP expiry, blacklists, sessions, audit, and events are game-agnostic core features and work for
  any module.

## Where "one human, one profile" stops holding

A single id space only works while the games agree on ids, and they do not. Hell Let Loose keys
players by Steam64 or XPlay ID; **HLL: Vietnam keys everyone by a per-game EOS ID**, so the same
person has a different id in each game and nothing in the id itself connects them. Steam players
can be bridged (HLL:V reports a `SteamId` alongside), console players cannot — they simply become
two profiles, and there is currently no way to join them: profile merge was built and then
withdrawn (see `docs/hll-vietnam.md` §4). Bridging on a shared id at write time is therefore the
only mechanism there is, which is why the next point matters as much as it does.

Two consequences for anyone adding a game:

1. **Decide how your module keys a player before it writes its first row.** If the game reports an
   id that already exists in another game's namespace (a Steam64, say), key on that. A fork is
   cheap to create and expensive to unpick.
2. **A player id is only meaningful on servers of the game it came from.** Anything that fans an
   action out across servers — bans and unbans do — must match on `server.game`, not just on
   permissions.

See `docs/hll-vietnam.md` for the worked example.
