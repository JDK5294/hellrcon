# HLL RCON — the official 5.03 reference package

This is our **authority for what the game server actually exposes**. Day-to-day operations run
against RCON directly; CRCON is reference-and-import only and has no say in what is or isn't
available. When a question is "can RCON give us X?", the answer comes from here.

> **Verified current through RCON_504** (checked 2026-09-22 against the 5.04 client package).
> Everything this document is authority for is unchanged in 5.04: `Commands.xml` is
> byte-identical to `docs/rcon-503/commands.xml`, the assembly is still `RconClient` v2.0.0.0
> with an identical `get_*` property surface (same extraction recipe as
> `dll-property-names.txt`), the default port is still 27029, and a scan of the 5.04 binary's
> command-shaped strings surfaced nothing new. Nothing in the command tables (`packages/games/src/hll/commands.ts`) needed to
> change. If a future package differs, re-run these four comparisons before touching the tables.
>
> **The client package is the wrong place to look for a game update's additions.** The v2 verb
> list is served by the RUNNING game server (`GetDisplayableCommands`) and the client discovers
> it at login — so a new server build can add commands with nothing changing in this package at
> all. The panel now asks directly: **Administration → Connections → Command check** probes a
> live binary-v2 server and lists anything absent from the baseline
> (`V2_CATALOGUE_503`) as new. Run it against an updated server; that answer, not this archive,
> is what the update added.

The source is Team17's own external RCON client shipped with HLL update 5.03
(`RconClient` v2.0.0.0, `ExternalRconClientOutput/net9.0-windows`, built 2026-05-20). The
binaries are not vendored — everything text is in `docs/rcon-503/`, and everything the binaries
told us is written down below so the archive never needs re-reading:

| File | What it is |
|---|---|
| `docs/rcon-503/commands.xml` | Verbatim `Commands.xml` — the **complete** legacy-text (v1) command + getter catalogue |
| `docs/rcon-503/console-session.txt` | A real client session log; names every v2 command the official client issues |
| `docs/rcon-503/admin-log-sample.txt` | Two admin-log lines (player names made up), for the prefix format |
| `docs/rcon-503/dll-property-names.txt` | Every `get_*` property name in the client assembly (DTO field names, with WPF noise) |

## Transport

- Default RCON port **27029** (`RconClient.dll.config`).
- Two protocol versions live side by side — the assembly's `ERconVersion` enum is
  `Version_1` / `Version_2`, and the client picks per connection.
- v2 framing: `RCONHeaderData` carries `Magic`, `RequestId`, `ContentLength`, then a JSON body.
  This is what `packages/rcon-core/src/protocol/binary-v2/frame.ts` implements (magic
  `0xDE450508`, little-endian, with the legacy no-magic mode as a fallback).
- v2 handshake: `ServerConnect` → `Login` → `GetDisplayableCommands`. `AuthToken` /
  `ServerAuthToken` are held for the session. Status codes are HTTP-shaped: `200` ok,
  `400` bad data, `401` unauthorized, `500` server error.
- Requests can be batched (`RCONBatchRequestData` / `RCONBatchRequestEntryData`).

## v2 command surface

Every v2 command the official client issues, from the assembly and corroborated by
`console-session.txt`:

| Command | Purpose |
|---|---|
| `ServerConnect` | Open the session |
| `Login` | Authenticate, receive the auth token |
| `GetDisplayableCommands` | **The server's own catalogue of what it will accept** — ask the server, don't guess |
| `GetServerInformation` | The one read command; a `Name` selects the payload (below) |
| `GetClientReferenceData` | Per-command reference data (the option lists that populate dropdowns) |
| `GetAdminLog` | Poll the admin log |
| `GetMapShuffleEnabled` / `SetMapShuffleEnabled` | Rotation shuffle |
| `ChangeMap` | `{ MapName }` — e.g. `PHL_L_1944_Warfare_Night` |
| `RemoveMapFromRotation` / `RemoveMapFromSequence` / `MoveMapInSequence` | Rotation + sequence editing |
| `KickPlayer` / `PunishPlayer` / `MessagePlayer` | Player actions |
| `AddVip` | VIP grant |

`GetDisplayableCommands` is the important one: the full v2 verb list is whatever the *server*
returns, not whatever this client happens to call. The table above is a lower bound — the set the
official client exercises — not a ceiling.

### `GetServerInformation` names

Four, and only four, appear in the client: **`players`**, **`session`**, **`maprotation`**,
**`mapsequence`**.

There is no `objectives` name. See the objectives section below.

## What a v2 request and response actually look like

Every exchange is the same envelope, XOR'd with the negotiated key and prefixed by the 12-byte
header. Request:

```json
{ "authToken": "<from Login>", "version": 2, "name": "GetServerInformation",
  "contentBody": "{\"Name\":\"session\",\"Value\":\"\"}" }
```

Response:

```json
{ "name": "GetServerInformation", "version": 2, "statusCode": 200,
  "statusMessage": "Successfully performed request.", "contentBody": "{ ...the payload... }" }
```

Two things bite here, both of them ours to handle:

- **`contentBody` is a JSON *string*, not a nested object** — on the way out and on the way back.
  It gets serialized, embedded, and parsed again. Getters that take no argument send it as a bare
  string (`GetClientReferenceData` sends `"SetSectorLayout"`, not `{"Name":"SetSectorLayout"}`).
- **`statusCode` is HTTP-shaped but arrives inside a successful socket read.** A 500 is a
  well-formed response, not a transport failure, so the framing layer must surface it rather than
  throw. `connection.ts` does exactly this: parse first, then classify by `statusCode`.

Our end of this is `packages/rcon-core/src/protocol/binary-v2/connection.ts` (framing, handshake,
XOR) and `packages/games/src/hll/commands.ts` (the per-command `contentBody` schemas).

### The handshake

`ServerConnect` goes out in **plaintext** — it has to, since its response *is* the XOR key
(base64). Everything after it is XOR'd. `Login` then takes the RCON password as its `contentBody`
and returns the auth token that every later request carries.

### Response payloads

The `contentBody` of each `GetServerInformation` name parses to the shapes in
`packages/rcon-core/src/protocol/binary-v2/responses.ts` — typed from live captures and
corroborated field-for-field by the official client's DTOs (above). The wire keys are the
server's own and are not consistently camel-cased:

| Wire key | Where | Note |
|---|---|---|
| `iD` | player | the player id — not `id`, not `ID` |
| `cOMBAT` | `scoreData` | the other three buckets are normal (`offense`/`defense`/`support`) |
| `mAPS` | `maprotation` | the rotation array |
| `worldPosition` | player | `{x, y, z}`; always present |

The `cOMBAT` spelling is confirmed three ways over: our live captures, the official client's
`Combat` DTO property, and CRCON reading `raw["scoreData"]["cOMBAT"]` verbatim at
`rcon/utils.py:471`. It is the server's, and normalizing it away in the adapter would only hide it.

One more decode worth writing down: `platoon` is the squad letter (`"ABLE"`, `"BAKER"`), and the
squad index is `platoon[0] - 'A'`. Commander has no platoon; an empty `platoon` means unassigned.

## v2 payload shapes

The client's DTOs (`RCONPlayerData`, `RCONPlayerScoreData`, `RCONSessionData`, `RCONMapData`,
`RCONMapListData`, `RCONPlayerPositionData`, `RCONAdminLogResponseData`,
`RCONDisplayableCommandData`) carry exactly the fields we already model in
`packages/rcon-core/src/protocol/binary-v2/responses.ts`, which was written from live captures.
Two independent sources agreeing is the strongest confirmation we have that our typings are right.

- **player**: `Name` `ClanTag` `Id` `Platform` `EosId` `Level` `Team` `Role` `Platoon` `Loadout`
  `Position` `ScoreData` `Stats`
- **score**: `Combat` `Offense` `Defense` `Support`
- **stats**: `Deaths` `InfantryKills` `VehicleKills` `TeamKills` `VehiclesDestroyed`
- **session**: `ServerName` `MapName` `GameMode` `MatchTime` `RemainingMatchTime`
  `AlliedFaction` `AxisFaction` `AlliedScore` `AxisScore` `PlayerCount` `AlliedPlayerCount`
  `AxisPlayerCount` `MaxPlayerCount` `QueueCount` `MaxQueueCount` `VIPQueueCount` `MaxVIPQueueCount`
- **rotation**: `CurrentIndex` + `Maps`

Caveat on casing: these are the *client's* C# property names. The wire JSON keys are the
server's and are not always the obvious camel-case — the live capture gives `iD`, `cOMBAT`,
`mAPS`, `worldPosition`. Where the two disagree, `responses.ts` (from live traffic) wins.

Platforms seen in the assembly: `steam`, `winstore`, `epic` — plus PS5/Xbox icon assets, so
console platforms surface through the same field.

### Player position is real

`RCONPlayerPositionData`, a `Position` property on the player DTO, a `LogPlayersPosition`
setting, and a CSV writer with the header `timestamp, team_id, x, y, z`. The official client can
log every player's world position over time straight from v2 `players`. We read this field as
`worldPosition` already; capturing it is a product decision, not a protocol limitation.

## Objectives / sector layout — what is and isn't available

The question was whether we can record the **objective layout a match was actually played on**.
The 5.03 package answers it, and the answer is no — not read, only written:

- **v2 exposes nothing.** No sector or objective field on any DTO, no `objectives` name for
  `GetServerInformation`, no objective command.
- **v1 can set it.** `gamelayout {0} {1} {2} {3} {4}`, five quoted sector names, restricted to
  `IntenseWarfare,OffensiveWarfare` (`commands.xml`).
- **v1's `get objectiverow_0` … `objectiverow_4` are option lists, not state.** Each is declared
  `isarray="true"` and is wired as the `usegetter` for the corresponding *parameter* of the
  `gamelayout` setter — it populates that sector's dropdown. It returns the three choices
  available in row N on the current map, not the one currently in play.

So "layouts played" is not capturable. What *is* capturable is "layouts we chose": when staff set
a layout through our own route we know exactly what we sent, and can record it against the match.
That is the honest framing, and it is the half worth building — it just can't be labelled as
coverage of every round.

(This matches what CRCON does, for what it's worth: its `get_objective_rows` reads the same
option list and it has no reader for the active layout either. But the finding above rests on the
official 5.03 package, not on CRCON.)

## v1 (legacy text) catalogue

`docs/rcon-503/commands.xml` is complete and verbatim — 41 commands and 27 getters. Highlights we
don't reach through v2: `showlog`, `setkickidletime`, `sethighping`, `setautobalanceenabled` /
`setautobalancethreshold`, `setteamswitchcooldown`, `switchteamondeath` / `switchteamnow`,
`setmaxqueuedplayers`, `setnumvipslots`, `broadcast`, `adminadd` / `admindel`,
`banprofanity` / `unbanprofanity`, `setvotekickenabled` / `setvotekickthreshold`, `gamelayout`,
and `get gamestate`.

Note `gamemodifiers {damage} {speed}` is marked `hiddenInRelease="true"` — present in the
protocol, not exposed in the shipped UI.

## Admin log line format

```
[2026-05-28T13:24:39.314Z] [829 ms (1779974678)] MATCH START PURPLE HEART LANE Warfare
[2026-05-28T13:24:42.272Z] [152 ms (1779974682)] TEAMSWITCH AB_Moss EGS (None > Allies)
```

An ISO-8601 UTC timestamp, then an age-and-id bracket: a decimal number, a unit word, and the
server's monotonic event id in parentheses — then the event text. `PREFIX_RE` in
`packages/games/src/hll/log.ts` matches exactly that (`[\d.]+` plus the unit words); no colon
form appears in real output.
