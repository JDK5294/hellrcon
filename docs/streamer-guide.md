# Streamer & overlay handoff — the stats API

The guide to hand a streamer, caster or overlay developer. Everything public, nothing to sign up
for: the stats site and a CRCON-compatible API, per server, no login and no API key.

Community-facing copy of this guide: published from this file — keep the two in step. Internal
references: `docs/streamer-mode.md` (the verified CRCON contract), `docs/public-stats.md` (field
mapping and deliberate divergences).

## The one-paragraph version

Each published server has a stats page at `https://stats.example.com/<slug>` and a
CRCON-compatible API under `https://stats.example.com/stats/<slug>/api/<command>`. If
your tool already speaks CRCON's public API (`get_live_game_stats` and friends), point it at that
base URL and it works unchanged — same endpoint names, same JSON, no auth. The exact link to copy
is on each server's card in the panel (Administration → Connections); ask staff if you don't have
panel access.

## Addresses

| URL | What it serves |
|---|---|
| `https://stats.example.com/` | index of published servers |
| `…/<slug>` | that server's live page |
| `…/<slug>/games` and `…/<slug>/games/<id>` | past rounds; one round in full |
| `…/stats/<slug>/api/<command>` | the CRCON-compatible API |

Rules of the road:

- **No auth, ever.** If an endpoint asks you to log in, you have the wrong URL.
- **GET only.** Arguments go in the query string.
- **404 means "not for you":** an unpublished/unknown server or a command outside the list below
  is indistinguishable from nonexistent. Nothing here ever answers 403.
- **No CORS headers (today).** Call the API from your tool's backend or a desktop app. A purely
  browser-based overlay hosted on another origin will be blocked by the browser — if that's your
  setup, tell staff and CORS can be enabled.

## The endpoints (the complete list)

These eight CRCON public endpoints are the whole surface — the same eight a stock CRCON answers
without login. Budgets are per IP address, per minute, per server.

| Endpoint | Budget | Answers |
|---|---|---|
| `get_public_info` | 600/min | server name, player counts, current/next map, time remaining |
| `get_live_scoreboard` | 600/min | stats for everyone **currently connected** |
| `get_live_game_stats` | 600/min | stats for everyone **who took part in the round in progress** |
| `get_scoreboard_maps` | 600/min | past rounds, paged (`?page=1&limit=25`, CRCON's own parameters) |
| `get_map_scoreboard` | 600/min | one round's full scoreboard (`?map_id=<integer from get_scoreboard_maps>`) |
| `get_map_history` | 600/min | the newest 500 rounds, newest first, as CRCON's map history (`?pretty`: name/start/end) |
| `get_previous_map` | 600/min | the last finished round |
| `get_version` | 600/min | the CRCON release whose bytes these endpoints match (`v12.3.0`) |

Over budget → HTTP 429 with a `Retry-After: 60` header. Live data is refreshed at most once
every ~5 seconds server-side no matter how hard you poll, so **poll live endpoints every 10
seconds or slower** — faster buys nothing.

## The response envelope

Every reply, success or failure, is CRCON's wrapper:

```json
{
  "result": { "...": "the payload" },
  "command": "get_live_game_stats",
  "arguments": null,
  "failed": false,
  "error": null,
  "forwards_results": null,
  "version": "v12.3.0"
}
```

**A 200 does not mean success — `failed` does.** Branch on `failed`, then read `result`. This is
CRCON's own contract, kept so existing tools work unchanged.

## Quick start

The quickest way in is the stats site itself: every screen has an **APIs** button at its top
right. It lists the endpoints that screen is built from, each with the exact link to copy and
what it answers right now, so you can find the data you want on the page and take its link.

```sh
# Who's playing right now, what map, how long left
curl -s 'https://stats.example.com/stats/<slug>/api/get_public_info'

# Live per-player stats for the round in progress
curl -s 'https://stats.example.com/stats/<slug>/api/get_live_game_stats'

# Recent rounds (grab a map_id from here)…
curl -s 'https://stats.example.com/stats/<slug>/api/get_scoreboard_maps?page=1&limit=10'

# …then that round's complete scoreboard
curl -s 'https://stats.example.com/stats/<slug>/api/get_map_scoreboard?map_id=123'
```

## What's in a player line

`get_live_scoreboard`, `get_live_game_stats` and `get_map_scoreboard` return CRCON's
`PlayerStatsType` per player:

- **identity** — `player` (display name), `player_id` (Steam64 on WW2, per-game EOS id on
  Vietnam — may be `null` on a server staff switched to names-only), `platform`.
- **combat** — `kills`, `deaths`, `teamkills`, `kill_death_ratio`, `kills_per_minute`,
  `deaths_per_minute`, `vehicle_kills`, `vehicles_destroyed`.
- **score buckets** — `combat`, `offense`, `defense`, `support`.
- **team** — `team.side` (`allies`/`axis`), `level` (live roster only), online marker on live
  endpoints.
- **per-round extras** on `get_map_scoreboard` — weapon breakdowns and per-opponent encounter
  dicts where the kill record carries them.

Fields we genuinely don't track come back as CRCON's own empty value (`null`, `{}`, `0`) — never
invented. The full field-by-field mapping, including the handful of deliberate divergences, is
`docs/public-stats.md`.

## Timestamps, ids, and paging

- Round history timestamps are **epoch seconds** (CRCON's shape); the stats page's own JSON uses
  ISO — don't mix the two up.
- `map_id` is a stable integer per round, unique across the whole community — but one server's
  address only answers its **own** rounds; a valid id from the other server is "not found" here.
- `get_scoreboard_maps` pages with `page` (1-based) and `limit` (100 by default, at most 1000),
  as CRCON does; the reply carries `{page, page_size, total, maps}`. The round in progress is
  not listed until the next one starts, as CRCON files it.

## Etiquette & operational notes

- One poller per tool, please — fan the data out to your own views rather than having every
  browser source poll us independently.
- Cache `get_public_info` for 10 s and round history for minutes; past rounds never change.
- The budgets exist so one tool can't starve another. If yours legitimately needs more, ask —
  don't rotate IPs.
- Uptime tracks the game servers themselves; if the server is down, `failed: true` with an error
  is the honest answer you'll get.

## FAQ

**Do I need an API key?** No. Published means public.

**My CRCON tool expects `/api/get_status` or an RCON passthrough.** Only the eight endpoints
above exist; anything else 404s. Notably there is no `run_raw_command` here and never will be.

**Player ids are null?** Staff switched that server to names-only. The rest of the line is
unaffected.

**Can I get historical data older than the site shows?** The API serves what the community
database holds — which includes the imported CRCON-era history. `get_scoreboard_maps` pages all
the way back.

**Something looks wrong or missing.** Tell staff which endpoint, which server, and the
`version` string from the envelope — that triple pins the report to a build.
