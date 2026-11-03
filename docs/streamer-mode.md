# Streamer mode — serving CRCON's public API

Established Hell Let Loose streamers already run overlay tools built against CRCON's public HTTP
API. Streamer mode makes a server answer those same calls, under the same names, with the same
JSON — so a streamer points their existing tool at us and it works, with no special build and no
credentials.

**Per server, off by default.** It is the only thing in this app that serves data to an
unauthenticated caller, so it is opt-in per server rather than a global switch, and the enabled
set is exactly the endpoints below — nothing else becomes reachable.

## What CRCON actually exposes publicly

Verified by reading CRCON v12.3.0 (`rconweb/api/urls.py`, `views.py`, `scoreboards.py`,
`auth.py`), not from the endpoint catalogue: `docs/crcon-api/` lists all 304 endpoints but records
*permissions*, not *authentication*, and its extractor misses these two entirely — `get_version`
and `get_public_info` are registered through `views.commands`, which is neither
`ENDPOINT_PERMISSIONS` nor the literal `endpoints` list in `urls.py`. **That is a gap in our own
tooling** (`docs/crcon-api/extract.py`), noted at the bottom.

Of 304 endpoints, exactly **eight** answer without a login. Everything else is
`@login_required()` or `@permission_required(...)`.

### Unconditionally public

| Endpoint | What it is |
|---|---|
| `get_version` | The installed release, `v` and its version, as a bare string |
| `get_public_info` | The overlay workhorse: map, score, players, time remaining |

### Public unless the operator sets `lock_stats_api`

CRCON's `stats_login_required` decorator (`rconweb/api/auth.py`) reads
`RconServerSettingsUserConfig.lock_stats_api`. It is **false by default**, so on a stock CRCON
these six are public too:

| Endpoint | What it is |
|---|---|
| `get_live_scoreboard` | Stats for everyone currently connected |
| `get_live_game_stats` | Stats for the match in progress |
| `get_scoreboard_maps` | Paged list of past matches |
| `get_map_scoreboard` | One past match: player stats + kill encounters |
| `get_map_history` | Raw map history list (`?pretty` reformats it) |
| `get_previous_map` | The map before this one |

None of the eight carries a rate limit at v12.3.0 (earlier releases had `@ratelimit` on some).

`run_raw_command` looks unauthenticated at a glance — it carries no `login_required` — but it is
guarded by `@permission_required("api.can_run_raw_commands", raise_exception=True)`. It is **not**
public and must never be in our enabled set.

## The envelope

Every CRCON response, success or failure, is the same wrapper (`api_response` → `RconResponse`):

```json
{
  "result": null,
  "command": "get_public_info",
  "arguments": {},
  "failed": false,
  "error": null,
  "forwards_results": null,
  "version": "v12.3.0"
}
```

**A 200 does not mean success — `failed` does.** Tools check `failed`, then read `result`.
Failures are 200s too: `get_map_scoreboard` answers an id with no round (or another server's
round) with `failed: true`, `result: null` and CRCON's own `"No map for this ID"`.

`arguments` is whatever CRCON's view hands `api_response` (scoreboards.py): `get_map_scoreboard`
echoes the request's own query as `_get_data` reads it (rconweb/api/utils.py) — every key in the
order it first came, its value a string, or the list of all its values when the key was sent more
than once (`{"map_id": "13767"}`, `{"map_id": ["1", "2"]}`), decoded as Python's `parse_qsl`
decodes. `get_map_history` passes `{}`; `get_scoreboard_maps`, `get_previous_map` and the live
endpoints pass nothing, so `null`.

Two quirks that exact parity obliges us to copy, because a client may key off them:

- `get_live_scoreboard` reports `"command": "live_scoreboard"` — without the `get_` prefix. Every
  other endpoint echoes its own name.
- On the success path `get_live_scoreboard` sets `error = (None,)` — a Python one-tuple, which
  serialises as `[null]`, not `null`. It is a typo in CRCON that has been there for years. We
  emit `[null]` there and `null` everywhere else. (Flagged as a decision below: it is the one
  place where "exact parity" and "correct" disagree.)

### Where CRCON answers without its envelope

Some answers never reach `api_response`, and those are Django's (4.2.30, CRCON's lock file's),
copied byte for byte (`crcon-http.ts`):

- **A view that raises.** `get_public_info`, `get_scoreboard_maps` and `get_map_history` catch
  nothing, so whatever fails under them is Django's stock "Server Error (500)" page, in
  `text/html`. For `get_scoreboard_maps` that includes a `limit` or `page` Python's `int()`
  refuses (a repeated key is a list, which it refuses too), a `server_number` Postgres 12 cannot
  read as an integer, a negative `limit`, an offset past bigint, and a page number past 64 bits,
  which orjson will not write. For `get_public_info` it includes a v2 server's `serverconfig`
  answer missing one of the five fields CRCON reads by name, and a failed read of the map history
  or the vote's status. The other views catch, and answer their own envelope with `failed` set:
  `get_map_scoreboard` with the arguments echoed, `get_previous_map` and `get_live_game_stats`
  plainly, `get_live_scoreboard` as `{}` with an empty error. (CRCON's error text there is a Python
  exception's `repr()`, which has no counterpart here; ours says `command failed`.)
- **A query of more than a thousand fields**, counted as `parse_qsl` counts them (one more than
  the `&`s), is Django's "Bad Request (400)" page — for the three views that read their arguments
  (`get_scoreboard_maps`, `get_map_scoreboard`, `get_map_history`). The rest never look.
- **GET alone.** Any other method, HEAD included, is the empty 405 of Django's
  `require_http_methods(["GET"])`, with `Allow: GET`. A CORS preflight is django-cors-headers'
  empty 200. Neither looks the server up, so neither says which servers exist.
- **The live boards keep their last pass.** CRCON's loop writes its cache only when a pass
  succeeds, so a pass whose roster read fails, or whose roster has players but none with an id,
  leaves the last snapshot standing. Ours does the same.

## Field-by-field: what we have, what we must derive, what is missing

### `get_public_info`

CRCON v12.3.0's view (`rconweb/api/views.py`) builds the answer in this order, and we build it the
same way (`buildPublicInfo`, pinned byte for byte by a test):

| CRCON field | Source there | Ours |
|---|---|---|
| `current_map` | `{map: gamestate.current_map, start: newest map-history entry's start}` | the session's layer id through CRCON's catalogue; the newest round's start, ended or not |
| `next_map` | `{map: the map sequence's next entry, start: null}` | the rotation's next entry; `unknown` when there is none |
| `player_count`, `max_player_count` | `get_slots` | the session |
| `player_count_by_team`, `score` | `gamestate` | the session |
| `allied_morale`, `axis_morale`, `initial_morale` | `gamestate` (new in v12.3.0) | the session |
| `morale_history`, `cap_flips`, `match_time` | the newest map-history entry, as the map recorder kept it | the newest round's recorded timeline (`apps/workers/src/cap-flips.ts`, CRCON's recorder ported); `cap_flips` null and `match_time` 0 with no round on record |
| `time_remaining` | `timedelta.total_seconds()`: a **float** (`1800.0`) | the same |
| `vote_status` | `VoteMap.get_status` | `buildVoteStatus` |
| `name` | `get_name`, `short_name`, CRCON's own stats ports | the session's name, `servers.public_name`, null ports |
| `config` | the game's `serverconfig` answer untouched, plus `game` | the same |

The recorder runs every 2 seconds, as CRCON's does: on the worker's 10-second poll and on the
score check between polls (`apps/workers/src/score-check.ts`), so a flip's `ts` falls within 2
seconds of CRCON's; everything else about which samples become flips is CRCON's
rule for rule.

### `LayerType` — the map object, used by several endpoints

What CRCON v12.3.0 actually sends is its `Layer` pydantic model dumped, not the `LayerType`
TypedDict beside it, and the two differ: the model has no `image_url` at all.

```
{ id, map: { id, name, tag, pretty_name, shortname, allies: {name, team}, axis: {name, team},
             orientation }, game_mode, attackers, environment, pretty_name, image_name }
```

`pretty_name` and `image_name` are computed: the map's pretty name plus ` Off. <ATTACKER FACTION>`,
` Skirmish` or ` <Mode>`, plus ` (<Environment>)` when it is not day; and
`<map id>-<environment>.webp`, lowercased. Which Layer an id becomes is CRCON's own catalogue and
parser, ported in `@app/maps` (`crcon-layers.ts`, with the data in `crcon-layer-data.ts`,
generated by `packages/maps/scripts/extract-crcon-catalogue.py` from `rcon/maps.py` at v12.3.0 and
from hllrcon 2.0.0.6 for Vietnam). An id the catalogue does not know is parsed the way CRCON parses
it, quirks included. Staff-set map names are ours and stay on our own pages: the CRCON wire says
what CRCON says.

### `get_live_scoreboard` / `get_live_game_stats` / `get_map_scoreboard`

All three now run CRCON's own statistics over our game log (crcon-stats.ts, crcon-logs.ts,
crcon-live.ts; the rules are in docs/public-stats.md), with CRCON's per-round player cache
(crcon-players.ts) laid over the live rows and filed into the stored ones. The table and notes
below are the field map this work started from, kept for its reasoning.

CRCON's `PlayerStatsType` is ~40 fields. Ours, mapped:

| Group | CRCON | Us | Verdict |
|---|---|---|---|
| identity | `player_id`, `player`, `platform`, `level` | roster + players | **have** |
| basic | `kills`, `deaths`, `teamkills`, `deaths_by_tk` | per-match stats | **have** |
| score buckets | `combat`, `offense`, `defense`, `support` | per-match stats | **have** |
| derived | `kills_per_minute`, `deaths_per_minute`, `kill_death_ratio` | computable | **derive** |
| time | `time_seconds` | session/roster clocks | **have** |
| weapons | `weapons`, `death_by_weapons` | kill events carry the weapon | **have** |
| weapons | `kills_by_type`, `deaths_by_type` | — | **CRCON never sends these** — see below |
| nemesis | `most_killed`, `death_by` | `player-combat.ts` `mostKilled` | **have** |
| streaks | `kills_streak`, `teamkills_streak`, `deaths_without_kill_streak`, `deaths_by_tk_streak` | ordered kill stream | **have** — folded in `foldKillWindow` |
| lifespan | `longest_life_secs`, `shortest_life_secs`, `last_spawn` | ordered kill stream | **have** — death-to-death, same fold |
| votes | `nb_vote_started`, `nb_voted_yes`, `nb_voted_no` | the GAME's VOTESYS ballots | **have** — `foldVoteWindow` |
| team | `team` (`PlayerTeamAssociation`) | the roster's own side | **have** — and stronger than CRCON's, which infers it from weapons |
| units | `units` (`UnitHistoryEntry[]`) | the sampler's (team, squad, role) per player | **have** — appended on change, like CRCON's; its live endpoints drop the key, so ours do too |
| game counters | `kills_and_assists`, `deaths_and_redeploys` | the game's own per-player counters | **have** — the same RCON fields CRCON reads |
| profile | `steaminfo` | — | `null` — the one field that is not RCON at all: CRCON fills it from a Steam Web API key and returns null without one |

### What reading CRCON's source changed here

The four rows above that are not plain "have" were all settled by reading
`rcon/player_stats.py`, `rcon/utils.py` and `rcon/models.py` rather than by reasoning about what
we hold. Three corrections came out of it, and two of them were bugs in our output:

- **`kills_by_type` / `deaths_by_type` are not on CRCON's wire at all.** They are declared in its
  `PlayerStatsType` and written by nothing: absent from `get_default_player_stats()`, absent from
  the `player_stats` table, and computed nowhere in the codebase. We were emitting them as `null`,
  which put two keys in front of a client that a real CRCON never shows it. They are gone.
- **The vote counters are the game's vote-kick system, not our map vote.** CRCON counts them off
  `VOTESYS` log lines we already ingest — `PV_Favour` yes, `PV_Against` no, `PV_Ignored` neither.
  They had been null on the true-but-irrelevant grounds that our Discord map vote has no per-round
  in-game counts. Same class of mistake as the lifespans.
- **`team.ratio` is a percentage.** CRCON's `detect_team` infers the side from which faction's
  weapons a player used and returns the winner's share as 0–100 with confidence `mixed`. We read
  the side straight off the roster — that is CRCON's `strong` — but we were sending `ratio: 1`,
  which in CRCON's units reads as "1% of the evidence agreed". It is now 100.

### `shortest_life_secs` is CRCON's, quirk and all

CRCON initialises `shortest_life_secs` to `0` and then computes `min(life, shortest)`, so on a
real CRCON a player's shortest life is 0 — or below it, for a death before the time CRCON guessed
the player's first spawn. We used to emit the true minimum here; every endpoint now reports
CRCON's figure, because the brief is CRCON's output exactly.

`get_map_scoreboard` additionally attaches `encounters`: per player, the ordered kill/death list
with `{action, player_id, player_name, ts, weapon}` where `ts` is seconds since match start. We
hold every kill event with a timestamp, so this is a **derive**, not a gap. Two details come
straight from CRCON's `scoreboards.py`: `action` is `"KILL"` for the killer and `"DEATH"` for the
victim, in capitals, and team kills are in nobody's list, because CRCON reads only its `KILL` log
lines (`exact_action=True` leaves `TEAM KILL` out). The team kill still counts in the streak and
`deaths_by_tk` fields, as it does on CRCON.

### `get_scoreboard_maps` / `get_map_history` / `get_previous_map`

Paged match list and map history. We have all of it, with one shape problem:

**The layer a round is filed under.** CRCON stores a layer id for every round — its `map_name`,
the `name` in its map history, and what the round's `map` object is parsed from — decided once as
the round starts (`handle_new_match_start`): the LIVE layer when the MATCH START line is under five
minutes old and the live layer is on the map the line names, otherwise a guess from the line's
display text (`guess_map_from_log`: the map name matched NFKC-casefolded, then mode, attacker and
environment). The worker makes the same decision on its first pass over a new round
(`apps/workers/src/round-start.ts`, migration 140), and the in-match recorder compares the live
layer with it, as CRCON's does. A round recorded before that, or imported from CRCON, is read from
what it stores (`crconMapNameFromRecord` in `@app/maps`): CRCON's own id is kept, and our stored
MATCH START text is guessed from the way CRCON guesses from an old line.

**The map history.** CRCON's is a list of the newest 500 rounds kept in Redis, each the MapInfo
its match-start hook wrote: `name, start, end, guessed, game_layout, cap_flips, morale_history,
initial_morale, match_time`, with `player_stats` left out of the public endpoint, epoch seconds
throughout (`?pretty` keeps just name, start and end, in ISO). Two of its habits shape the bytes,
and both are kept:

- Its stats job clears `cap_flips` and `morale_history` from a round's entry once it has filed
  the round's scoreboard, which it does as the next round starts. So only the newest entry shows
  a timeline; the scoreboard keeps it.
- A MATCH ENDED line read within a minute ends the round only when the live layer is on the map
  the line names; otherwise the end stays unset until the next MATCH START sets it to its own
  time. The worker records that verdict (`apps/workers/src/round-end.ts`, migration 141), and the
  recorder makes the one extra pass CRCON makes over a round it has just seen end
  (`apps/workers/src/crcon-round.ts`).

Every round CRCON saw start is in its history, however short. Ours drops a round under five
minutes from its own records (it was never a game), so a copy of what CRCON publishes for it is
kept in `crcon_short_rounds` (migration 142), read only by these endpoints.

**GAP 6 — map ids.** CRCON's `Maps.id` is an autoincrement integer, and `get_scoreboard_maps`
hands those ids to the client which passes them back to `get_map_scoreboard?map_id=<int>`. Our
matches are UUIDs. A tool that does `parseInt(map_id)` on ours gets `NaN`. This needs a stable
per-server integer alias for a match — a sequence column, not a reinterpretation of the UUID.

## HLL: Vietnam

CRCON reads a Vietnam round against Vietnam's own catalogue, never WW2's (`parse_recorded_layer`,
v12.1.1): its maps and layers are built at startup from hllrcon (2.0.0.6 for v12.3.0), so
`map.name` is `HUẾ OUTSKIRTS`, the factions are `us` (allies) and `nva` (axis), and orientation
follows the allied attack direction. A Vietnam id hllrcon does not list keeps its id on Vietnam's
own "unknown" map as a Domination layer, factions named "unknown". We do exactly the same.

Vietnam keeps the allies/axis vocabulary: `Team.from_hllrcon` folds the game's stable side ids
(1, 2) to allies/axis for both games, so `score.allied` / `score.axis` and `player_count_by_team`
need no Vietnam special case.

## The gaps, collected

| # | Gap | Status |
|---|---|---|
| 1 | ~~`cap_flips` — no per-round score timeline is recorded~~ | **CLOSED** — the worker runs CRCON's map recorder (`cap-flips.ts`) and stores each round's flips, Conquest morale and match_time on the round (migration 139). |
| 2 | ~~No `GetServerConfig` read~~ | **CLOSED** — `GetServerInformation("serverconfig")` is read on the same connection as the session (`getServerConfig` in the HLL command table) and mapped into CRCON's `config` block. On a v2 server the answer must hold the five fields CRCON reads by name, or `get_public_info` is CRCON's server error page; a legacy or bridged server, which has no such read and which CRCON v12.3.0 cannot run against, keeps the empty shape. |
| 3 | ~~No per-server short name~~ | **CLOSED** — `servers.public_name` carries CRCON's `short_name`. |
| 4 | ~~Map `tag` / `shortname` / `orientation`, and WW2's per-map armies~~ | **CLOSED** — CRCON v12.3.0's whole catalogue and parser, WW2 and Vietnam, in `@app/maps` (`crcon-layers.ts`). |
| 5 | ~~Lifespans (`longest`/`shortest_life_secs`)~~ | **CLOSED** — and the reasoning that closed it as impossible was wrong. A life *is* bounded by a spawn, but HLL's log carries no spawn line for CRCON either: CRCON marks a respawn by the death that caused it, which is why its own `PlayerStatsType` carries `last_spawn` beside the two. Same source, same derivation. `foldKillWindow` is a transcription of CRCON's `_process_death_time`: seed at the player's first appearance, close a life on every death (including the first), move the marker to that death, and never count the life still running at the whistle. `last_spawn` is emitted too — as the absolute timestamp CRCON emits, not the seconds-from-kickoff the fold counts in. |
| 6 | ~~No integer match id~~ | **CLOSED** — `matches.seq`. |
| 7 | ~~Vietnam mode/time-of-day inferred from the id~~ | **CLOSED** — the CRCON wire reads Vietnam layers from CRCON's own Vietnam catalogue (hllrcon's data), as CRCON does. |
| 8 | `next_map` was hardcoded empty | **CLOSED** — read from the rotation (`currentIndex + 1`, wrapping), by the entry's `iD` rather than its display `name` so the layer grammar parses. |
| 9 | ~~`vote_status`~~ | **CLOSED** — `buildVoteStatus` is CRCON's `VoteMapStatus`: its fixed disabled answer when off; on, each option as `{voters, map, votes_count}` and `next_map` as the pretty name of the map the vote puts next. CRCON's is whatever its vote last applied, and it applies its default pick the moment a vote opens; ours is a staff override, else what the round's end would apply now (the leader, the earliest of a tie, or with no votes the default pick), so both name a map before anybody votes. `voters` lists the in-game ballots — see below. |

| 10 | ~~Player-row nulls: vote counters, `team` shape, `last_spawn` type, `kills_by_type`~~ | **CLOSED** — by reading `rcon/player_stats.py`, `rcon/utils.py` and `rcon/models.py` instead of reasoning about what we hold. The vote counters are the game's vote-kick system and fold out of the VOTESYS lines we already ingest; `team.ratio` is a 0–100 percentage, not a 0–1 fraction; `last_spawn` is a datetime, not an offset; and `kills_by_type`/`deaths_by_type` are keys CRCON never sends at all. See "What reading CRCON's source changed here". |

### The last three were never CRCON's data to have

`kills_and_assists`, `deaths_and_redeploys` and `units` were written off as "CRCON reads these off
the game's stats payload and we do not carry them". That was wrong in the most avoidable way: our
own `V2PlayerStats` decodes `infantryKills` and `deaths`, and `V2PlayerInfo` decodes
`platoonIndex`. The sampler read `stats.vehicleKills` and `stats.vehiclesDestroyed` out of that
object and stepped over the other two. Nothing was missing from RCON; three fields were being
dropped between the game read and the database.

- **`kills_and_assists` = the game's kill counter**, exactly as CRCON has it
  (`loop.py`: `kills_and_assists=current["kills"]`). It is NOT our `kills`, which counts kill-log
  lines: the game's counter also moves on an assist. CRCON keeps both numbers for that reason and
  so do we, in separate columns.
- **`deaths_and_redeploys` = the game's death counter**, same story with redeploys.
- **`units`** is the (team, squad, role) triple appended whenever it changes — CRCON diffs against
  a cached `p_unit`, we diff against the stored array's last element.

The counters carry a `_prev` column each, because the game RESETS a player's counters when they
reconnect mid-round. A sample that reports a smaller number is a new session, not a correction:
the old total is banked and the published figure is prev + current. That is what CRCON's `p_`
fields do. Both stores implement it and `postgres.test.ts` walks a reconnect to prove it.

**One gap remains** — gap 7, Vietnam's mode/time-of-day inferred from the layer id rather than read
from the protocol. It is cosmetic: the inference agrees with the protocol on every layer we have
seen, so no field a consumer reads differs.

**Every other field a CRCON client reads now carries the value CRCON would carry**, with two
documented exceptions: `steaminfo`, which needs a Steam Web API key and is null on a keyless CRCON
too, and `shortest_life_secs`, where CRCON's own published value is always 0.

### How the last two of these got missed, and the guard against a third

Both `cap_flips` and these three passed a green test suite while writing nothing. The mechanism is
the same each time: `InMemoryRepository` stores samples with `{ ...input }`, so a field added to a
repo input type round-trips in memory whether or not EITHER store was taught to persist it. A
memory-backed test then proves nothing about the SQL store.

The rule that follows: **anything the public API publishes is checked against real Postgres, in
`postgres.test.ts`, or it does not count as wired.** The reconnect/unit-history test there exists
for that reason, and `repo.test.ts` carries the same scenario so the two stores cannot drift.

### How `vote_status` lists voters, and the fields that stay empty

- **`voters`: the in-game ballots.** CRCON lists the in-game players who voted, as `{player_id,
  player_name, count}`, in the order they voted. Ours lists the votes typed in game (`!vm 3`), as
  the worker counted them on its last pass (kept with the vote they were counted for, so a new
  ballot never shows the last one's): the name typed under, the game's own player id where the
  server publishes ids (null on a names-only server, and for a ballot the log gave no id for), and
  a count of 1, since no vote here weighs more than another. Oldest standing ballot first.
- **Discord votes are counted, never listed.** This endpoint answers anyone on the internet with
  no authentication, and publishing a community's Discord identities there is a different act
  from publishing the game names CRCON publishes. Rule 3 of this module ("no personal data beyond
  what CRCON publishes") decides it. `votes_count` stays the whole tally, so the listed voters can
  number fewer than the count.
- **`player_choice: null`.** CRCON's is its `!vm add` slot: a player adds a map to the ballot and
  CRCON keeps `{player_name, player_id}` for every caller to see (`rcon/vote_map/state.py`). We
  have no player-added ballot entry, so there is never one to name. (This said CRCON filled it per
  requesting player; its source says otherwise.)
- **`last_reminder: null`.** CRCON stamps when it last reminded players to vote; we keep no such
  time.

## Decisions taken

1. **Off by default, per server.** CRCON ships public stats *on*; we do not. This is the only
   unauthenticated surface in the app and it should be a deliberate act.
2. **Read-only, always.** The enabled set is a fixed whitelist of the eight names above. No write
   endpoint is reachable through streamer mode regardless of engagement mode.
3. **No personal data beyond what CRCON publishes.** These endpoints already expose player names
   and platform ids — that is what the streamer tools consume. Nothing we hold and CRCON does not
   (IP history, watchlist reasons, notes, audit, Discord identities, VIP status) is served here.
4. **Copy the `live_scoreboard` command-name quirk and the `[null]` error tuple.** Parity beats
   tidiness: a client that string-matches either would break on a "corrected" response. Both are
   confined to one endpoint and commented at the site.
5. **A per-address budget CRCON v12.3.0 does not have.** Its views carry no rate limit. Ours allows
   600 calls a minute per address per endpoint, far past any tool's polling, and answers past it
   with a 429 envelope: a guard for the game server behind the one unauthenticated surface.
6. **Absent data is CRCON's own empty value, never a fabrication.** Where a value can be derived
   it is derived; where it genuinely cannot, the answer is the one CRCON gives in the same
   situation — `cap_flips: null` when no round is on record, `[]` when a round is open but has no
   samples yet. A plausible-looking invented timeline would be worse than the honest null. This
   cuts the other way too: "we don't hold it" has to be checked against CRCON's own derivation
   before it is written down. Gap 5 sat closed-as-impossible on that mistake — CRCON derives
   lifespans from the same kill stream we already had. A read that fails is the same: the answer
   is CRCON's failure for that endpoint, not a payload with the gap filled in.

## Fixing our CRCON documentation tooling

`docs/crcon-api/extract.py` reads `ENDPOINT_PERMISSIONS` and the literal `endpoints` list in
`urls.py`. Endpoints registered via `views.commands` — including both unconditionally public ones
— are invisible to it, and it records no authentication information at all. Two changes make the
catalogue able to answer "is this public?":

- parse `views.commands` as a third source, and
- record each endpoint's decorators, so `login_required` / `permission_required` /
  `stats_login_required` / none is a field rather than something to re-derive by hand.
