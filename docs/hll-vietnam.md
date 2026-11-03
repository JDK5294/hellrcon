# Hell Let Loose: Vietnam

HLL: Vietnam is a **separate game**, not a patch. It launches Thursday 2026-08-13 and our first community will
run it *alongside* the existing Hell Let Loose servers — so the app has to hold both at once, in
the same panel, with the same staff and the same permission model.

Everything the app has been built against so far is one game. This document is the reference for
making that no longer true: what HLL:V's RCON actually is, where it differs from HLL, which of our
assumptions break, and in what order to fix them.

Sources, all in `docs/hll-vietnam/`:

| File | What it is |
| --- | --- |
| `rcon-v2.pdf` | Team 17's official HLL:V RCON document, as published |
| `rcon-v2.txt` | the same, extracted to text so it greps |
| `announcement.md` | the developer announcement — ID scheme, changelog, and one undocumented difference |

Page references below are to the PDF.

---

## 1. The protocol is unchanged

This is the good news, and it is most of the work. HLL:V speaks the same RCON v2 our `binary-v2`
adapter already speaks:

- 12-byte fixed header, magic first — `0xDE450508` (p2), the same constant as
  `MAGIC_HEADER_VALUE` in `packages/rcon-core/src/protocol/binary-v2/frame.ts`.
- Same handshake: `ServerConnect` unencrypted, returns a Base64 XOR key; every later frame is
  XOR'd with it; `Login` with the password returns an `AuthToken` carried on all subsequent
  requests (p4–5).
- Same envelope: `{AuthToken, Version, Name, ContentBody}` in, `{StatusCode, StatusMessage,
  Version, Name, ContentBody}` out; 200/400/401/500 (p1, p3).

**Two protocol limits the document states and our adapter does not enforce** (p2):

- A request whose content exceeds **4 KB** is a protocol violation, and a violation "will cause the
  server to reject the connection" — not merely fail the command. We cap *incoming* bodies
  (`MAX_BODY_BYTES`, 32 MB) but never check outgoing size. A long banned-words list, a large
  sector-layout write or a pasted broadcast could drop the socket. Worth a guard regardless of
  game; HLL almost certainly has the same rule undocumented.
- Server-side throttling: per tick, at most 16 KB of command data, 1 ms of processing, and 64
  commands; the rest defers to later ticks. Our bulk-action path (one connection, many players)
  should expect latency rather than errors, which is what it already does.

---

## 2. Command-table delta

Our HLL table is `packages/games/src/hll/commands.ts`. An HLL:V module gets its own table; this is
what would change in a copy of ours.

### 2.1 New in HLL:V — no equivalent in our table

| HLL:V command | Arguments | Why it matters |
| --- | --- | --- |
| `GetSectorLayout` | — | Read back the stored layouts (`Entries[]`, each `MapId` + `Sectors[]`). We have only ever been able to write them (p11). |
| `RemoveSectorLayout` | `MapId` | Undo a stored layout (p11). |
| `AddMapToSequence` | `MapName`, `Index` | The **sequence** is a second, separate list from the rotation (p13). |
| `RemoveMapFromSequence` | `Index` | " |
| `MoveMapInSequence` | `CurrentIndex`, `NewIndex` | " |
| `SetMapShuffleEnabled` | `Enable` | We have `toggleMapShuffle` as legacy-text only, because HLL v2 had no setter. HLL:V does. |
| `SetMatchTimer` / `RemoveMatchTimer` | `GameMode`, `MatchLength` | Per-mode match length. Ranges are enforced: Warfare 30–180, Offensive 10–60, Skirmish 10–60 minutes (p31–32). |
| `SetWarmupTimer` / `RemoveWarmupTimer` | `GameMode`, `WarmupLength` | 1–10 minutes, Warfare and Skirmish only (p32). |
| `SetDynamicWeatherEnabled` | `MapId`, `Enable` | Per-map, and only on maps that use the system (p32). |
| `GetServerChangelist` | — | Build changelist number — a real version signal, better than what we infer today (p33). |
| `RemovePlayerFromPlatoon` | `PlayerId`, `Reason` | Pull one player out of a squad. A moderation action we have never had. |
| `DisbandPlatoon` | `TeamIndex`, `SquadIndex`, `Reason` | Break up a whole squad. Same. |

The last two are worth calling out to staff: "disband that squad" is a thing the game can now do
and our moderation vocabulary has no word for yet.

### 2.2 Changed shape

| Command | Change |
| --- | --- |
| `SetSectorLayout` | Now takes a **`MapId`** first argument, and **no longer restarts the match**. Ours sends only `Sector_1..5`. This is the difference between "set the layout for tonight's Kursk" and "set it right now, blowing up the current round". |
| `GetServerInformation` → `players` | `eosId` **removed**, `steamId` **added**. Per-player `Id` is now the EOS ID. See §4. |
| `Platform` / `SupportedPlatforms` | Enum *formatting* changed. Not in the PDF — see `announcement.md`. This is the dangerous kind of change: it type-checks and produces wrong labels. |

### 2.3 Ours with no documented HLL:V counterpart

**All three are now handled** in `packages/games/src/hllv/commands.ts` — see §2.6.

| Ours | Note |
| --- | --- |
| `getObjectives` (`GetServerInformation` name `objectives`) | Not in HLL:V's documented info-request list (p19–20). The sector layout is now read with `GetSectorLayout` instead. Probe before assuming it is gone. |
| `setWelcomeMessage` → `SetWelcomeMessage` | HLL:V's list names `SetNoticeMessage` (p7), and p18 documents both "Send Notice Message" and "Send Server Message". The welcome/notice command is probably renamed. |
| `getPlayerInfo` | We only have a legacy-text wire. HLL:V documents `GetServerInformation` with name `player` and the id as `Value` (p19) — so it has a v2 form, and probably HLL does too. |

### 2.4 Things HLL:V exposes that we currently read the slow way

`GetServerInformation` gained info requests we handle via legacy text or not at all (p19–20):

- `Vipplayers` → the VIP list with comments (we have `getVipIds`, legacy-only).
- `bannedwords` → the custom profanity list (we have `getProfanity`, legacy-only).
- `mapsequence` → the sequence, with `CurrentIndex`.
- `serverconfig` → `ServerName`, `BuildNumber`, `BuildRevision`, `SupportedPlatforms`,
  `PasswordProtected`.

Still no standalone getter for max queued players or VIP slot count — but `session` now reports
`MaxQueueCount` and `MaxVipQueueCount`, which is the same information by another road.

### 2.5 Two naming inconsistencies inside the document

Both are in Team 17's PDF, not in our reading of it, and both need a live probe:

- The command list spells the auto-balance getter `GetAutoBalancedEnabled` (p8, with a D) while its
  own detail heading says "Get Auto Balance Enabled" (p28). We send `GetAutoBalanceEnabled`.
- The request examples use `"Name": "ServerInformation"` (p19) and `"Name": "ClientReferenceData"`
  (p25), while the command tables call them `GetServerInformation` and `GetClientReferenceData`.
  The `Get…` form is what works against live HLL.

Both were left as HLL spells them. Each is a READ, so the cost of being wrong is a blank field
rather than a command that misfires, and changing one on the strength of a probable typo would be
the worse trade — a live probe settles them (§8).

### 2.6 What the module actually sends now

`packages/games/src/hllv/commands.ts` holds Vietnam's table: HLL's, with one named override per
divergence above. It used to be `commands: HLL_BINARY_V2` outright, which meant every row of §2.2
and §2.3 was a command sent to a Vietnam server in HLL's spelling.

**That failure mode is silent.** A v2 server handed a body it does not recognise applies it to
nothing and answers 200 — so these did not surface as errors, they surfaced as features that did
nothing. The overrides now in place:

| Logical | Was (HLL's) | Now (Vietnam's) | Page |
| --- | --- | --- | --- |
| `setWelcomeMessage` | `SetWelcomeMessage` | `SetNoticeMessage` | p7, p18 |
| `banProfanity` / `unbanProfanity` | `BannedWords` as an array | `BannedWords` as a comma-separated string | p30 |
| `setSectorLayout` | `Sector_1..5` as option strings | `MapId` + `Sector_1..5` as Int32 indices | p11 |
| `getObjectives` | `GetServerInformation {Name:"objectives"}` | `GetSectorLayout` | p11, p19–20 |
| `toggleMapShuffle` | legacy-text only (throws on binary-v2) | `SetMapShuffleEnabled {Enable}` | p6, p13 |
| `getVipIds` | legacy-text only | `GetServerInformation {Name:"Vipplayers"}` | p20 |
| `getProfanity` | legacy-text only | `GetServerInformation {Name:"bannedwords"}` | p20 |
| `getPlayerInfo` | legacy-text only | `GetServerInformation {Name:"player", Value:id}` | p19 |

Everything else is HLL's definition by identity, not by copy — `packages/games/test/hllv-commands.test.ts`
asserts that, so a later fix to a shared wire lands on both games at once and cannot drift.

**The ban commands are NOT among the deltas.** `TemporaryBanPlayer`, `PermanentBanPlayer`,
`RemoveTemporaryBan`, `RemovePermanentBan` and both ban getters are documented identically (p16,
p27–28), and the test pins that too. Vietnam ban trouble is an identity problem, not a wire one —
see §4 and the unban guard in `apps/api/src/routes/kit.ts`.

---

## 3. Payload deltas

### Player (p20–21)

Gains `SteamId`, `Platoon` (a string — the squad name), `WorldPosition` (a vector),
`Loadout`, and `Stats.VehiclesDestroyed`. Loses `eosId` as a separate field; `Id` **is** the EOS ID.

Score buckets are documented as `Combat` / `Offense` / `Defense` / `Support`. Our HLL descriptor
carries `cOMBAT` for the first, which is a live quirk of the HLL server rather than a choice —
**do not carry it over**; a fresh descriptor is exactly the right place for that to differ.

### Session (p22)

Gains `MapId`, `AlliedFaction` / `AxisFaction` (indices), `MaxQueueCount`, `MaxVipQueueCount`,
`VipQueueCount`, and three **Conquest** fields: `InitialMorale`, `AlliedMorale`, `AxisMorale`.

Conquest is a game mode we have never modelled. The match header and the Discord board both assume
a score pair; morale is a third axis and will need its own treatment rather than being squeezed
into the existing bars.

### Map entry (p21)

`Name`, `GameMode`, `TimeOfDay`, `Id`, `Position` — the server now *tells* us the mode and time of
day. `packages/maps/src/hll-maps.ts` infers both from substrings in the raw id
(`inferMode`, the `_warfare` / `_offensive` / `_skirmish` markers). For HLL:V, prefer the reported
fields and keep inference only as a fallback.

---

## 4. Identity — the part that actually hurts

This is the change with consequences beyond a command table.

**HLL** identifies a player by a Steam64 (`76561…`, 17 digits) or an XPlay/Team17 ID (32 hex chars).
**HLL:V** identifies everyone by an HLL:V EOS ID: 32 hex chars, always starting `0002`. A person's
HLL EOS ID and HLL:V EOS ID are different values — EOS IDs are per-game.

Steam players carry a bridge: HLL:V's player payload includes `SteamId`. Non-Steam players carry
none — Team 17 say outright that tools "will be forced to treat them as two distinct players
(until manually linked)".

### What that means for us

`players.platform_id` is **globally unique with no game dimension**
(`players_platform_id_key`, migrations.ts:179). That was deliberate: making platform part of the
key forked one human into twin rows (#157). It now has three consequences:

1. **A Steam player will fork across the two games unless we bridge on `SteamId`.** HLL stores them
   under `76561…`; HLL:V would store them under `00021a2b…`. Keying HLL:V players on the reported
   `SteamId` when it is present — and on the EOS ID only when it is not — keeps one human, one
   profile, and one career. This is the single highest-value decision in the whole migration and it
   has to be made *before* the first HLL:V roster poll writes rows.
2. **Non-Steam players will fork, and we currently have no way to link them.** This corrects an
   earlier version of this document, which said profile merge covers it. It does not: profile merge
   was built and then **withdrawn in full** (`d3ed260`) — repo methods, redirect table, API route,
   `player.merge` capability, profile UI, and a migration that drops the table. It was removed
   because the duplicates it was built for turned out to come from CRCON's own database holding two
   records for one person, not from anything our import did, so the merge was solving a problem at
   the wrong layer.

   Vietnam is a different case and a permanent one: the two ids are genuinely different and no
   amount of import hygiene will join them. So either the Steam bridge in point 1 carries the load
   and console players stay legitimately separate, or profile merge comes back deliberately for
   this reason. That is an open decision, not a solved problem — do not plan around a merge feature
   that is not there.
3. **Two 32-hex namespaces now share one unique index.** An HLL XPlay ID and an HLL:V EOS ID are
   both 32 hex characters. A genuine collision is vanishingly unlikely, but `platform` stops being
   pure display metadata and starts being the only thing that says which namespace a raw id lives
   in. It should be written accurately for HLL:V rows (`eos`), and `external_links` (already
   `(provider, external_id)`, with `eos` as a named provider) is the right home for the second id
   rather than a second `players` row.

### Bans and VIPs do not transfer

Stated explicitly in the announcement, and it follows from the IDs. A ban issued on an HLL server
is keyed to a Steam64 or XPlay ID that the HLL:V server has never heard of.

**This is a live hazard in the multi-server ban fan-out shipped in `ec61aa4`.** The
`serverIds` picker (`apps/panel/components/ServerScopePicker.tsx`) filters candidate servers by
*capability* only. Once an HLL:V server exists, "ban on all servers" would send an HLL platform id
to it, which will at best no-op and at worst report success. **The picker and the API's
`FANOUT_ACTIONS` handling must also require the target server's `game` to match the game the player
id came from.** That is the one item on this page that is a bug the day HLL:V is added, rather than
a feature we lack.

---

## 5. What the architecture already handles

Worth stating plainly, because it is most of the surface:

- `servers.game` exists and defaults to `hll` (migrations.ts:109); the Add Server form already has
  a game field.
- `@app/games` is a registry: `registerGame`, `getGame`, `requireGame`, `stateReaderFor`, with an
  unknown game degrading to empty answers rather than throwing.
- The panel renders domain vocabulary — factions, roles, score columns, config fields — from the
  descriptor the API serves for the pinned server's game (`apps/panel/lib/game.tsx`), with neutral
  fallbacks ("Team 3", "Role 7") when there is no descriptor.
- The rules engine already declares `games` per roster-state trigger
  (`packages/rules/src/state-triggers.ts`, enforced by `stateTriggerAppliesTo`), so nothing
  auto-mod runs against HLL will silently run against HLL:V.
- `map_names` is keyed `(game, map_id)` (migrations.ts:704–708).
- Observe-mode write blocking comes from the command table's `access` flags, so it works for any
  module without changes.

Adding HLL:V is genuinely "write one module and register it" — the seam holds. What follows is the
list of places it does not.

## 6. What it does not handle

| Gap | Where | Severity |
| --- | --- | --- |
| ~~The module sends HLL's command spellings~~ | ~~`hllv.ts` set `commands: HLL_BINARY_V2`~~ | **Closed** — `hllv/commands.ts`, see §2.6 |
| ~~An unban of an id the server does not hold reports success~~ | ~~`routes/servers.ts` actions + bulk~~ | **Closed** — `unbanTargetMissing` asks the ban list first |
| ~~Ban/unban fan-out can target a server of a different game~~ | ~~`FANOUT_ACTIONS`~~ | **Closed** — `crossGameIdError` refuses a foreign-game id on the single path AND per-target inside the fan-out loop (unbans exempt on purpose: lifting is safe anywhere the id appears) |
| ~~Player identity has no game/namespace dimension; Steam bridge undecided~~ | ~~`players_platform_id_key`~~ | **Closed** — decided in migration 076: `players.game` records which game's namespace an id belongs to, and `platform_id` stays the sole key deliberately (the two games' id namespaces cannot collide, and keying on (game, id) would re-fork the twins 041 merged) |
| ~~Map artwork path is hardcoded to `/game/hll`~~ | ~~`gameAssets.ts`, `map-art.ts`~~ | **Closed** — both halves now take the game and answer only for `hll` (`e0d446b` worker, sweep #8 panel) |
| ~~Map name/mode/environment inference is HLL-specific~~ | ~~`packages/maps/src/hll-maps.ts`~~ | **Closed** — `inferMode` knows Vietnam's conquest and domination |
| ~~No Conquest support (morale)~~ CLOSED (Update 21 made Conquest a WW2 mode): the session read carries `initialMorale`/`alliedMorale`/`axisMorale`, the worker samples them onto the open round (migration 094), and the live header, Discord status board and match detail all show the drain when `initialMorale > 0` | — | done |
| ~~Ingest defaults `game = "hll"`~~ | ~~`packages/ingest/src/index.ts`~~ | **Closed** — verified both callers (worker poll, one-shot API route) pass `server.game` |
| Outgoing 4 KB request cap unenforced | `packages/rcon-core/src/protocol/binary-v2/connection.ts` | Medium — violation drops the connection |
| ~~Panel Add Server form defaults `game: "hll"` with no other option~~ | ~~`Servers.tsx`~~ | **Closed** — the form fetches `/games` and renders a real picker |
| `docs/game-modules.md` claims one profile per human across games | that file | Low, but actively misleading — corrected there |

---

## 6a. The plan: wait for CRCON, then verify against it

**Decided 2026-08-11, two days before launch.** We are not writing `hllv.ts` from this PDF. We wait
for CRCON to ship HLL:V support, read what they landed, and use it as the verified baseline — then
improve from there.

The reason is §8. Nine things on this page cannot be known without a live server, and the cost of
guessing them has already been measured on the game we DO run: HLL's role table was derived from
live captures, looked complete, and was wrong twice in a row — first missing the recon and armour
squad leaders, then the three artillery roles. Both were settled in minutes by reading the table
CRCON resolves names through (`hllrcon`'s `Role.by_id`). A document is a good starting point and a
poor authority; a maintained implementation running against the real game is the better one.

**Nothing is at risk while we wait**, which is what makes this cheap rather than merely patient:

- A server for an unregistered game **cannot be created** — `POST /api/servers` rejects it with a
  400 naming the known games (`routes/servers.ts`, the `getGame(game)` guard). So no HLL:V roster
  poll can run, and the identity decision in §4 cannot be made wrongly by accident. That is the one
  irreversible failure on this page, and it is closed by construction.
- The three day-one hazards are already fixed (`aad0713`): cross-game ban fan-out, the identity
  hook, and the outgoing 4 KB cap. See §5.

**What to do when CRCON ships it** — the same three checks `docs/crcon-releases.md` lists, applied
to the new game:

1. Diff their command table against §2. Their names are wire-tested; ours are read off a PDF.
2. Find how they key an HLL:V player — whether they bridge on `SteamId`, and what they do with
   console players who have no bridge. That answers §4, the decision that has to be right before
   the first row is written.
3. Re-run `docs/crcon-api/extract.py` + `render.py`; new endpoints and response types show up in
   the diff, and their HLL:V payload types settle §3.

Then write `hllv.ts` against a verified shape rather than a guessed one, and probe §8 to confirm.

## 7. Suggested order

*Superseded by §6a for the module itself — this remains the order once the baseline exists.*

1. **Guard the cross-game hazards first**, before any HLL:V server can be added: game-match on the
   ban fan-out, and a decision (with a test) on how an HLL:V player is keyed.
2. **Stand up `packages/games/src/hllv.ts`** — its own command table, descriptor, log parser and
   state reader. Copy HLL's and apply §2; do not share the table, because "mostly identical" is how
   two games end up wedged into one set of conditionals.
3. **Un-hardcode the artwork root** to `/game/<gameId>` with an HLL fallback, so an unknown game
   degrades to no image rather than the wrong one.
4. **Generalise map inference**: prefer the `GameMode` / `TimeOfDay` the map entry now reports, and
   move HLL's substring inference behind a per-game hook.
5. **Probe against a live HLL:V server on launch day** and fill in §8 — the document is good but it
   is not a capture, and the one difference the author volunteered was not in it.
6. **Conquest and the new commands** (`DisbandPlatoon`, `RemovePlayerFromPlatoon`, match/warmup
   timers, dynamic weather, the map sequence) as ordinary features, once the game is running.

## 8. To confirm with a live capture

**Confirmed 2026-08-15, via the panel's own raw console:** `GetServerInformation` with
`ContentBody {Name:"vipplayers"}` (lowercase) answers 200 with a structured `{"vipPlayers":[...]}`.
That settles the VIP-list read — both games' tables now carry it on `getVipIds`, and the VIP
reconciler reads through it. The same probe found the list EMPTY while the panel held dozens of
live grants, which is the incident `docs`' reconciler entries describe.

Nothing else here should be treated as known until a real server answers:

- Does `GetServerInformation` accept the `Get…` name, or only `ServerInformation`? Same for
  `GetClientReferenceData`.
- Is the auto-balance getter `GetAutoBalanceEnabled` or `GetAutoBalancedEnabled`?
- What exactly does the new `Platform` / `SupportedPlatforms` enum encoding look like?
- Is the welcome/notice command `SetNoticeMessage`, `SetWelcomeMessage`, or both?
- Does the `objectives` info request still exist?
- The bundled art for Vietnam's six maps prints all fifteen objective NAMES with their circled
  positions (vantuong.webp names An Cường (1)/(2), Phase Line Apple, LZ Blue Perimeter, …). Turning
  that into pre-taught names needs one fact only a live walk can give: how the wire's five rows and
  three indices map onto the art's five columns of three circles (west→east? top→bottom?). Guessed
  wrong it would caption every sector confidently and wrongly, so the taught layer starts empty
  until a live server confirms the ordering — after that, seeding is transcription, not invention.
- Do the p11 layout commands behave as written? `GetSectorLayout` answering
  `{Entries:[{MapId, Sectors}]}` in those spellings (our parser tolerates casing on purpose),
  `SetSectorLayout {MapId, Sector_1..5}` really persisting across map changes without a round
  restart, and `RemoveSectorLayout {MapId}` really forgetting it. The panel's saved-layout line
  and its clear buttons — web and Discord — all hang off p11's word.
- What are the real score-bucket key spellings on the wire — `Combat` or another quirk?
- What do HLL:V map ids look like, and does `TimeOfDay` use the same vocabulary as HLL's `_night`
  / `_dusk` markers?
- Does `SteamId` come back populated for Steam players, and empty or absent for the rest?
- Is the admin log line format unchanged? Our whole ingest pipeline hangs off `normalizeLine`.
