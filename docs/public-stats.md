# Public stats — the site and the scoreboard endpoints

The public stats site is what a PLAYER sees: a live scoreboard, past rounds, and per-player
figures for any server staff chose to publish — no login, our look, CRCON's information. It is
built ON the streamer-mode surface (docs/streamer-mode.md): the same eight CRCON endpoint names,
now all implemented, feed both a streamer's overlay tool and our own page. The page eating the
same API it publishes is deliberate — it keeps the CRCON-compatible surface honest, because a
broken field shows up on our own screen first.

## Addresses

One base per server, chosen by staff (Administration → Connections → the server's card):

| URL | Serves |
|---|---|
| `/stats` | index of published servers |
| `/stats/<slug>` | that server's page (round in progress) |
| `/stats/<slug>/games`, `/stats/<slug>/games/<id>` | past rounds, one round in full |
| `/stats/<slug>/api/<crcon_command>` | the CRCON-compatible API — a tool's base URL is the page's URL |
| `/s/<serverId>/api/<crcon_command>` | the original mount, kept as an alias |

The slug is `servers.public_slug`: 1–40 chars of `[a-z0-9-]`, starting alphanumeric, unique,
`api` reserved. `servers.public_name` is what the page (and `get_public_info.name.short_name`)
calls the server; blank falls back to the staff-facing name. Both are set by the same permission
that publishes (server.engagement write) and both are audited. Beside them sits
`servers.public_player_ids` — on by default (CRCON parity), the switch that takes platform ids
off the public wire when a server should be names-only ("Player ids" below).

The site's own header comes from the community name set under Administration → Online access —
the COMMUNITY's name, since that is the only name the readers know. Unset falls back to the app name. The manifest carries it
as `site.name`.

### The dedicated hostname (keeping the admin address out of shared links)

A stats link gets pasted in Discord and forwarded; if it carries the panel's hostname, the
panel's login page is now public knowledge even though the login still protects it. Giving the
site its own address under Administration → Online access gives it its own domain with the admin
address nowhere in it:

- Requests on that hostname get ONLY the public surface. `/api/public/*` and the CRCON mounts
  pass; **every other `/api/*` path answers 404** — no login endpoint to find or brute-force on
  the hostname players hold. Assets pass by PREFIX only (`/_next/`, `/game/`): a file request
  outside those prefixes 404s, because `/index.html` is the panel's login shell and `/brand/*`
  its identity, and neither may be served on the players' hostname. Anything that would fall
  back to the panel shell serves the stats entry instead (`public-host.ts`, pure and tested).
- Short paths are folded under /stats server-side, so links are `stats.example.com/nam` and the
  bare host is the index. The page detects its base and builds links/fetches bare there.
- The Connections card shows the shareable link with the PUBLIC origin (the servers listing
  carries `publicStatsOrigin`), so staff copy the right address by default.
- The Host header is client-controlled, which is fine: this is a secrecy measure, not an authz
  boundary — sending the admin hostname to the same address yields the login-gated app the
  caller already knew existed. Every admin surface stays gated by login regardless.

Cloudflare side: one extra record pointing at the same origin (a proxied DNS entry, or a second
public hostname on the same tunnel with the panel's own service, `http://localhost:8080`). Unset, the site rides the panel host at
/stats only.

**Publishing** is the existing per-server streamerMode switch, still off by default. One switch
governs the page, the manifest and the API — CRCON has one `lock_stats_api` and matching that
shape means one thing for staff to reason about. Unpublished servers 404 indistinguishably from
nonexistent ones on every public route, including the manifest.

## What the four scoreboard endpoints answer

Shapes are the captured CRCON types (docs/crcon-api/response-types.md): the live endpoints'
cached dicts — `{snapshot_timestamp, refresh_interval_sec, stats}` for `get_live_scoreboard` and
`{snapshot_timestamp, stats, refresh_interval_sec}` for `get_live_game_stats`, each in the order
CRCON builds it, `snapshot_timestamp` an epoch float — `MapsType` for a round, `PlayerStatsType`
for a player line. The wrapper for `get_scoreboard_maps` is `{page, page_size, total, maps}`.

| Endpoint | Who is listed | Source |
|---|---|---|
| `get_live_scoreboard` | everyone currently connected, in the game's order | CRCON's LiveStats over each player's current session (crcon-stats.ts) |
| `get_live_game_stats` | everyone the current round's log names | CRCON's TimeWindowStats from the round's start to now |
| `get_scoreboard_maps` | — (paged past rounds) | `matches` (id = the integer `seq` alias) |
| `get_map_scoreboard?map_id=<int>` | the round's full scoreboard + per-player encounters | stat rows + the round's kill-event window |

`map_id` is `matches.seq` — the install-wide integer alias added for exactly this (CRCON's
`Maps.id` is an int its clients hand straight back; our UUIDs made `parseInt` clients get NaN —
former gap 6). A `map_id` belonging to a different server answers "not found": the alias is
install-wide, and one server's address must never be a window into another's rounds.

### PlayerStatsType, field by field

A stored round's rows (`get_map_scoreboard`) are CRCON's PlayerStats.to_dict, key for key, with
`encounters` on the end, filled the way CRCON's stats job filed them when the next round started
(workers._record_stats; crcon-live.ts `crconFiledRows`):

- **The game log's half** is TimeWindowStats over the round's log, from its start to its filed end
  (both included; the next round's start where CRCON deferred the whistle), with a hundred
  seconds' cooldown off a session still open at the end. Who has a row is who the log names:
  kills, deaths, teamkills, deaths_by_tk, the four streaks, the vote counters, time_seconds,
  longest/shortest_life_secs, weapons, death_by_weapons, most_killed and death_by (keyed by the
  other player's id), and player (the name the log last gave). The rates are its round(…, 2)
  figures, floats as CRCON's float columns return them.
- **The cache's half** is the round's player cache (crcon-players.ts) through
  _compute_temporary_stats: combat/offense/defense/support, vehicle_kills, vehicles_destroyed,
  kills_and_assists and deaths_and_redeploys add the totals banked across reconnects only where
  the last session's figure is not 0, as CRCON's do; level and units come straight from it. A
  player the cache never held files CRCON's defaults (zeros, no units). A round recorded before
  the worker kept the cache, or imported, stands its stat rows in for it (an imported round's
  hold the buckets CRCON itself filed).
- **CRCON's own derivations, ported**: kills_by_type / deaths_by_type (calc_weapon_type_usage
  over CRCON's WW2 weapon table, which it reads for Vietnam too — a Vietnam weapon has no type)
  and team (detect_team: the unit history's seconds per side, else the weapons' sides — CRCON
  gives the Canadian weapons none). The four dicts are in the order a Postgres jsonb column hands
  CRCON's back: shortest key first, then byte order.
- **encounters** are the view's: the round's KILL lines from start to end (no team kills),
  `{action, player_id, player_name, ts, weapon}`, `"KILL"` for the killer and `"DEATH"` for the
  victim, ts in whole seconds since the start.
- player_id is the platform id (Steam64 on a WW2 server, the per-game EOS id on a Vietnam one,
  exactly as CRCON keys it; **null on a server switched to names-only**, where nemeses are keyed
  by name — see below); platform is the game's own string, null where only our guess exists;
  steaminfo is null (CRCON fills it from a Steam key); **id** is the row's index in its list
  (CRCON's is a database pk — both only key a list).

### The live rows

Both live endpoints run CRCON's own statistics (rcon/player_stats.py, v12.3.0) over our game log
read back as CRCON's lines (crcon-logs.ts: only the lines its parser accepts, and the ids its log
loop fills in for lines that name a player without one):

- A row starts as get_default_player_stats, key for key. The rates stay the int `0` until a log
  line is read for the player, then are round(…, 2) floats; `kill_death_ratio` is rounded too.
- `most_killed` and `death_by` are keyed by the other player's id, first met first (by name on a
  server that keeps ids private).
- Lives run from the last spawn CRCON knows of (the session start or first sighting, a CONNECTED
  line, the previous death) to a death; `shortest_life_secs` starts at 0 and only takes min()
  from there, so it is 0 or below. VOTE STARTED counts for the target as well as the starter.
- `get_live_scoreboard`: a player's time is their newest session (any server, open or closed)
  up to now, 0 once it has ended; their lines are the ones inside it. `last_spawn` starts at the
  session's start. Players come in the game's roster order.
- `get_live_game_stats`: sessions are pieced together from the round's connects and disconnects;
  a player first named without a CONNECTED line is counted from three minutes in, and two
  connects without a disconnect leave a session CRCON gives up on (0).
- Then the round's player cache (crcon-players.ts, CRCON's MapInfo.player_stats) is laid over
  every row it holds: the score buckets with earlier sessions' totals added, level, `team` as
  "allies"/"axis", `faction` (read with CRCON's WWII parser whatever the game, as CRCON does) and
  `status`, while `id`, `map_id` and `units` leave the row. A player it does not hold keeps the
  defaults.

### Documented divergences from CRCON

1. `get_live_game_stats` and `get_map_scoreboard` list players in the order the round's log first
   names them. CRCON's order is a Python set's, which no two of its own processes share.
2. `refresh_interval_sec` reports OUR real cache interval (5s), not CRCON's configured one — a
   tool paces its polling by it, so it must be true rather than familiar.
3. `map` (the full layer object) is not ours: CRCON adds it to both scoreboard endpoints itself
   (scoreboards.py). The list's rows are CRCON's hand-written eight keys, `map, id,
   creation_time, start, end, server_number, player_stats, result`; `get_map_scoreboard` sends
   the whole Maps record in to_dict's order with `map` last. A round is listed once CRCON would
   have filed it, which is as the next round starts — so the round in progress is not, and
   `get_map_scoreboard` answers "No map for this ID" for it (live play is the live endpoints'
   job). `result` is the score in the round's MATCH ENDED line, or CRCON's 2 - 2 for a round
   that never had one; an imported round keeps the result CRCON filed. `creation_time` is when
   CRCON's stats job wrote the row: the next round's start stands for it (CRCON's adds the
   seconds its job took).
4. `game_layout` carries the five objectives staff set as both `requested` and `set`, which is
   what CRCON writes for a layout chosen by name. A row staff left to chance shows the objective
   that was drawn (CRCON's `requested` has null there), and the layout stays on the round it was
   set during, where CRCON attaches it to the next MATCH START.
5. `cap_flips` and `morale_history` come from the score timeline the worker records the way CRCON's map recorder does, checking the score every 2 seconds as CRCON's loop does.
6. The `live_scoreboard` command-name echo and its `[null]` error tuple are copied verbatim
   (docs/streamer-mode.md "The envelope").
7. `player_id` is null on a server that has been switched to names only (below) — CRCON's is
   never null. A tool that joins on the id must handle null; the manifest says up front which
   servers it can join.
8. A round recorded before the worker filed rounds the way CRCON does (migration 140) is named by
   CRCON's guess from its MATCH START line. That is CRCON's own answer for an old line; for a
   recent one CRCON files the live layer instead, which can be another layer of the same map (a
   line that does not name the environment guesses the day layer).
9. A MATCH ENDED line that names another map than the round in progress (a backfilled line from
   before a reconnect) is ignored here; CRCON ends whatever round is newest with it.
10. Rounds shorter than five minutes are dropped from our own records, but CRCON lists every
    round it saw start, so a copy of each stays for these endpoints (`crcon_short_rounds`). Every
    endpoint lists them, and a short round's scoreboard is worked out from its game log and player
    cache like any other's.
11. Our web server, not CRCON's gunicorn behind nginx, carries the requests. Where their transport
    limits differ, so do the answers: a request line with raw (unencoded) non-ASCII bytes is
    refused before it reaches the API, and a request line past gunicorn's 4094 bytes is not.
    Everything that reaches a view is answered as CRCON's view and Django answer it
    (docs/streamer-mode.md "Where CRCON answers without its envelope").

### Player ids: on by default, switchable off

`servers.public_player_ids` defaults to **true**: a published server carries the platform id
exactly as CRCON does, because that id is most of the reason to point a tool at the API at all,
and because a player active on any other community is already on someone's CRCON stats page —
CRCON publishes ids out of the box, so ours is not novel exposure.

It stays a separate switch rather than being wired to publishing, so ids can be pulled for one
server without taking its whole page down. It sits on the server's Connections card under the
same `server.engagement` write permission, and each flip is audited with a line naming the
direction.

When switched off, `player_id` is null everywhere it appears — the row AND every encounter
inside it — and nothing else changes: names, statistics, streaks and weapons publish in full.
The page keys its rows on the row index (`id`) rather than the id, so it renders identically
either way, minus the "Player id" block when a player is expanded. `GET /api/public/servers`
carries `playerIds: boolean` per server so a tool knows before it asks.

`buildPlayerStats` itself still defaults to withholding — that default guards a call site added
later that forgets to pass the server's setting, and it should fail toward publishing less.

### The internal/public id boundary

Stat rows and kill events carry our internal player UUIDs. The public surface speaks platform
ids only: every row is joined to `players` before publishing, a row whose internal id cannot be
resolved is WITHHELD (absent beats leaking or inventing an identity), and encounter ids pass
through the same translation (`mapEncounterIds`) with null for the unresolvable.

## The page

A second entry in the panel's static export (`apps/panel/app/stats/` →
`components/public/PublicStatsApp.tsx`), served by the API's static handler which falls every
/stats/* path back to the stats entry — a public deep link must never land on the panel's
sign-in shell. Path-routed (real URLs for Discord pastes), themed by the panel's own tokens.

It is laid out in the panel's own shell. The sidebar lists the open server's screens — Now
playing, Past games, Server stats — with the open screen's sub-screens under it (a round's
Players, Round report and Game log), the other published servers below, and the light/dark switch
at its foot; it folds to a rail, and on a phone it is the panel's drawer behind a burger, closed
by any navigation from it. A HUD heads each server screen, laid out like the game's top bar: the
map with its art, both sides' scores and head counts, the players in and the time left. The page
keeps its own accent, the panel's Amber preset: visitors never reach the panel's Settings, and the
default slate made an active tab read dimmer than the ones beside it. The brand is the community's
name and initial, never the admin software's mark (the public hostname serves no /brand files).

Saved to a phone's home screen, it is an app of its own that turns with the phone. Its manifest
(`GET /api/public/webmanifest`) says `orientation: "any"`; with none, a phone kept a saved
stats page upright, as it kept the installed panel before the panel had one. The API serves it,
since its start and scope are the whole host on the dedicated public hostname and /stats on the
panel's, never the panel's own start at the staff sign-in. Its name is the community name's. A page
saved before this has to be removed from the home screen and saved again to pick it up.

Game-agnostic by construction: the manifest (`GET /api/public/servers`) carries each published
server's side labels/colours and score-bucket columns from its game descriptor, so the page
hardcodes no faction and no column set — US/NVA on a Vietnam server, Allies/Axis on WW2, from
one code path. The wire keeps CRCON's allied/axis keys for scores either way (CRCON folds both
games onto that pair; see docs/streamer-mode.md "HLL: Vietnam").

A round's page shows only that round: its HUD carries the round's own final score, map, start
and length, never the live game's, because printing the running score over a past scoreboard is
how a reader ends up quoting the wrong one. The scoreboard has a name filter and a side filter — a
full round is ~100 rows and almost everyone opening the page is looking for one of them — and
carries a row's side as its colour (a bar down its edge, the name in that side's ink) rather than
as a column a phone cannot spare. A player's level has its own column after their name ("Lvl",
sortable), coloured on the panel's level scale, as the panel's live view shows it (the rows'
`level`; 0, never seen, is left blank; a board with no levels has no column). An expanded row's Most killed and Died to arrive keyed by player
id, as CRCON keys them; the page names each one from that player's row on the same board.

Past games lists the server's rounds newest first, 25 to a page. Its pager steps a page either way,
links the first and last pages and the two either side of the one showing, and takes any page by
its number; each page is its own address (`/games?page=N`), so one opens in a new tab or pastes
like any other. A phone shows the first, the showing and the last page between bare arrows, which
keeps the row on one line on a phone. A page past the end says where the list ends and links there.
A round's "← Past games" goes back to the page the list was last on in this visit, not the first.

Every screen has an APIs button at its top right (in the top bar on a phone), for streamers and
overlay builders. It opens a panel listing the public endpoints that screen is built from, the
CRCON ones marked as such: each with its full link (Copy, Open) and what it answers now, read when
the panel opens and again on Refresh. A reply is shown as it came, only re-indented, so its
numbers read as the wire writes them (CRCON's 1.0 stays 1.0). The links carry the site's public
address when one is set (the manifest's `site.origin`: the shareable address, or the public
hostname), so a link copied from the page opened on the panel's host never names the admin
hostname; the replies themselves are read from wherever the page is. The list is `apisFor` in
PublicStatsApp.tsx; on the live screen it adds `get_live_scoreboard`, which overlays read beside
`get_live_game_stats`. A browser test records each screen's own requests and fails if one of them
is missing from that screen's list.

### The round report (`GET /api/public/<slug>/report/<id>`)

The charts layer over a round's scoreboard: awards, the kills-per-minute flow, the weapon-class
split, duels, and each player's personal kill timeline in the expanded rows. This is OUR endpoint
beside the manifest, not a CRCON one — the CRCON mounts stay byte-for-byte, and anything they
never served rides under /api/public instead. `<id>` is the round's public integer alias (the
same `map_id` the scoreboard endpoints use), or `current` for the round in play; the live page
polls it once a minute, past rounds load it once. On the page the charts live on their own
screen — `/stats/<slug>/report` for the live round, `.../games/<id>/report` for a past one, real
paths so a report can be pasted as a link — while the player list (with the award emojis and the
expanded-row timelines the report also feeds) stays the main screen. Built by the same `buildMatchReport` the staff
match page uses, then re-keyed to display names (`publicMatchReport`): players, duels and awards
carry names only, so no internal id — and no platform id, whatever the toggle says — crosses this
wire. Same gate as every public route: published servers only, uniform 404, per-IP budget.

Two people can wear one name in a round, and a name-keyed map has no way to hold both. A shared
name therefore publishes NEITHER player's detail — a last-writer-wins map would put one player's
round under the other's scoreboard row, and nothing downstream could tell. Their scoreboard rows
are unaffected (those come from the game), they simply have no drill-in and no line in the kill
race. The staff match page, which has internal ids, still shows both in full.

Each player's line also carries `scores`: their combat, offense, defense and support through the
round, as `[secs, combat, offense, defense, support]` points. An expanded row draws them behind a
switch over the kill timeline (Kills, then the scoreboard's own score columns), on this page and on
the staff match page alike. The worker takes a point a minute off CRCON's player cache (the running
figure plus what a reconnect banked, the total the live board shows) and one more on the pass that
sees the round end, so a chart ends on the scoreboard's number; a point that repeats the last is
not stored (`match_score_series`). Only rounds played since the recorder exists have them: older
rounds, and rounds imported from CRCON, show the kill timeline alone.

The kill race on the round report has the same switch: Kills, then each score, raced the same way
(a line per player, the leaders named where they finish, search and side chips as before). A player
with nothing in the chosen score has no line, and the note under the chart counts them. A round
without scores races kills alone, with no switch.

### The round's game log (`GET /api/public/<slug>/log/<id>`)

What happened in a round, in order: its start and end, every kill and team kill with the weapon,
every connect and disconnect, every team switch (with the side swap the ingest worked out), and
every time an admin went into the admin camera or came out of it. The Game log tab beside Players
and Round report (`/stats/<slug>/log` for the live round, `.../games/<id>/log` for a past one)
shows it on the round's own clock with the wall-clock time on hover, filtered by kind (Kills, Team
kills, Connections, Team switches, Admin camera) and by a name, a few hundred lines at a time.
Its Download button saves the lines the log shows (filter and name search applied, every page) as
Excel, CSV or JSON — the panel's own download popup (`components/Download.tsx`, loaded with the
log), the file made in the browser from the log already loaded, so the API serves nothing new.
OUR endpoint, beside the report: the CRCON mounts stay byte-for-byte.

Read from the event store the ingest fills anyway (`public-log.ts`). Events carry no round id,
so a round is its time window on its server, the window the report reads; the start and end lines
come from the round itself. Names only, like every public wire: the stored rows carry internal ids
beside the names and none crosses. No chat, because what players say is not a stat, and of
moderation only the admin camera, so players can see who watched and when: the admin's name and
which way they went (`entered`), never the line's own words; a camera line that says neither way is
left out. At most 20,000 lines per round, and a round with more says so (`truncated`). The live
round's log is polled every 30 seconds and cached on the report's terms. Same gate as every public
route: published servers only, uniform 404, per-IP budget.

### The server profile (`GET /api/public/<slug>/stats`)

The Server stats tab's wire (`/stats/<slug>/server`): what the server is like to play on, from
its own recorded rounds. Per-map played counts, average lengths and side win leans (a lean only
once a map has five decided rounds); how rounds end by final-score gap (3–2 contested, 4–1
decisive, 5–0 stomp, 2–2 counted as the crash it almost always is); rounds per day for the last
four weeks; the best single-round records (kills, combat, support — each linking to its round by
the public integer alias); the regulars boards from the career rollups; and seeding health from
participant counts (a round's stat rows ARE its player count): seeded share (60+ players),
seeded-start hours (UTC on the wire, the visitor's clock on the page), seeding heroes (most
low-pop rounds played), and server-killer maps (what loaded after a seeded round and emptied it,
two drops minimum). Rounds without participant data measure nothing — the block is null rather
than a guess when history was imported without scoreboards.

Weapon boards ride the same wire, at two grains. `classRecords`: per weapon class, the best
single round (a SUM over that class's weapons for one player in one round, naming the weapon
that carried it) and the career leader — labelled by the game descriptor's own classifier, so a
Vietnam server shows Mortar and Helicopter where a WW2 server shows Artillery; "other" is never
drawn. `weaponRecords`: the server's most-used INDIVIDUAL weapons, each with its best single
round, career leader and total. Both are fed by the worker's weapon-rollup sweep, which folds
each FINISHED round's kill events through `classifyWeapon` exactly once (newest first, so fresh
records surface immediately while history backfills behind them) into
`player_match_weapon_kills` — the weapon is the unit of record, its class stored beside it —
stamping `matches.class_rollup_at` even for rounds with no kill log so nothing is re-scanned
forever. Each row carries BOTH directions — kills with the weapon and deaths to it, off the same
events (teamkills stay out of both sides) — so every class and weapon board also names who has
died to it the most, career. The rollup exports with the Match history group — the stamps travel
with the matches, and stamps without rows would leave the boards empty for good. The same rows
give career pages their per-player weapon totals and died-to lists, and the round report carries
its own live-derived `weaponSplit` (the round's top weapons per side) beside the class split. Aggregated from the
matches table and `matches.topStats`/`stats.leaderboard` — no kill-stream folds — over at most
the last 5,000 rounds (`truncated` says when history outgrew the cap), cached in-process for five
minutes so anonymous traffic cannot make it a table walk per visitor. Names only, never an id.

### Career pages (`GET /api/public/<slug>/player/<platform_id>`)

Where a scoreboard name lands (`/stats/<slug>/player/<platform_id>`): the player's career on THAT
server — kills/deaths, playtime and visits, rounds and win rate, squad-lead hours, highest level,
role time named by the game, career weapon totals and died-to lists from the weapon rollup, and
their recent rounds here, each linking to its round page. Three
privacy rules make it publishable: the route answers only on servers whose `publicPlayerIds`
toggle is on (the platform id IS the address, and a server that withholds ids has no public
address for a person — uniform 404 otherwise, and the page's name-links simply don't render); a
player who never played that server is the same 404, so the address cannot probe the player
directory; and the platform id from the URL is the only identifier echoed back — the internal id
never crosses, here or anywhere on the public wire.

### Where a round's score comes from

The MATCH ENDED log line is not a dependable source: HLL's carries `(2 - 3)`, HLL: Vietnam's
carries no score at all. So the worker samples the LIVE score — the same
`GetServerInformation` read that draws the panel's match header — onto the open round every tick
(`matches.recordScore`), and the last sample before the whistle stands as the final score.

`matches.close` therefore treats a null score as silence rather than as zero: it COALESCEs, and
derives the winner from whatever score survives. A scored log line still wins, being the
authoritative final. Without this every Vietnam round recorded `result: null` — "unknown" on the
site, and no `winner`, which is what every win count in the app is counted from.

A consequence worth knowing when reading `get_scoreboard_maps`: the OPEN round now carries a
`result` as well, because the score as it stands is a true fact about it. `end` is what says
whether that score is final — a null `result` means nobody scored the round, not that it is still
running. The page labels a running scoreline "live" for the same reason.

## Load & abuse posture

Same as streamer mode: per-IP per-endpoint budgets (600 a minute; CRCON v12.3.0 sets none), the shared 5s live
cache collapsing any number of viewers to one RCON read, a 5s cache on the open round's
assembly, a 20k cap on one round's kill-event window, and the fail-closed key cap on the rate
limiter. The page polls at 15–20s — a fraction of the per-IP budget.
