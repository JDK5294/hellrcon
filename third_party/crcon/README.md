# CRCON source, vendored verbatim

Unmodified files from **Hell Let Loose Community RCON** (CRCON), copied from
[github.com/MarechJ/hll_rcon_tool](https://github.com/MarechJ/hll_rcon_tool).

Copyright (c) 2020 Julien Marechal. Licensed **MIT** — the full text is in `LICENSE`
beside this file, which is the notice MIT requires travel with any copy.

**Revision: `v12.1.1`** (released 2026-08-21). Every file here was re-fetched at that tag, so the
whole set is coherent at one upstream version and a citation can be checked against it directly.
Update the tag on this line whenever you re-fetch.

## Why they are here

We serve CRCON's public HTTP API byte-for-byte so a streamer's existing overlay tool works
against us unchanged (see `docs/streamer-mode.md`). That contract is settled by reading CRCON's
source, not by remembering it — every parity claim in that document cites one of these files.
Keeping them in-tree means a claim can be checked at the commit it was made, instead of against
whatever `master` says today.

| File | Upstream path | What it settles |
|---|---|---|
| `urls.py` | `rconweb/api/urls.py` | which endpoints are registered, and how |
| `views.py` | `rconweb/api/views.py` | `ENDPOINT_PERMISSIONS` — what is gated and what is not |
| `auth.py` | `rconweb/api/auth.py` | `stats_login_required` / `lock_stats_api` — the public set |
| `scoreboards.py` | `rconweb/api/scoreboards.py` | the six scoreboard endpoints' shapes |
| `maps.py` | `rcon/maps.py` | the map catalogue, and `Team.from_hllrcon`'s allies/axis rule |
| `multi_servers.py` | `rconweb/api/multi_servers.py` | cross-server forwarding (why `forwards_results` exists) |

## Rules

- **Never edit these.** They are evidence. A local change makes every citation that points at
  them a lie. Re-fetch from upstream to update, and say which revision in the commit.
- **Nothing in the build imports them.** They are reference material for humans (and for the
  extractor in `docs/crcon-api/`, which reads a full CRCON checkout, not these copies).
- Our own reimplementations live in `apps/api/src/streamer.ts` and `packages/maps/`. Those are
  ours, under this repository's licence; these are not.
