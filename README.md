# hellrcon

A self-hosted RCON management platform for **Hell Let Loose** and **Hell Let Loose: Vietnam**. A web
panel for live moderation, automation, player records and statistics, a public stats site, and an
optional Discord bot, all built on a capability-scoped plugin system.

> **License:** AGPL-3.0-only — free forever (see `LICENSE`). Outside code it carries is credited in
> [`NOTICE.md`](NOTICE.md).
> **Status:** pre-1.0 and under active development, already running community servers in
> production on both games.

## What it does

- **Both games, every server separately.** Hell Let Loose (WW2) and Hell Let Loose: Vietnam over the
  game's RCON v2 protocol. Permissions, settings and automation are all per server. A new server
  starts in read-only **observe** mode, so it can run beside an existing tool (CRCON included)
  without touching anything until you switch it to active.
- **Live view and moderation.** The roster with squads and roles, messages, kicks, punishments, team
  switches, temporary and permanent bans (one ban book, imported CRCON bans included), a watchlist,
  player notes, flags and tags, console admins, an RCON console, and staff requests that need a
  second person's sign-off.
- **Automation.** Auto settings profiles that change server settings by time, day and player count;
  a rules engine (roster, chat and stat triggers with message, kick, VIP, tag and points actions);
  a chat filter; seeding that follows CRCON's seeding rules, with seeding rewards; match-end game
  rewards; broadcasts and timed messages.
- **Maps.** Rotation, a map vote (a Discord poll plus in-game chat ballots), map sets, vote
  schedules, and map shuffle.
- **VIP and economy.** VIP grants and presets, with safeguards that stop automation from shortening
  or removing VIP; a points economy with a VIP shop; events with payouts; bulk payouts.
- **Records and analytics.** Game log, matches with each player's score over the round,
  leaderboards, player profiles and clans; server analytics (population, platforms, VIPs over
  time, combat, team composition, map votes) and staff activity.
- **Public stats, CRCON-compatible.** A public stats site (live scoreboard, past rounds, player
  stats) for the servers you choose to publish, served on CRCON's public API endpoints with
  CRCON v12.3.0's responses, so tools built for CRCON work unchanged. Streamer mode included.
- **Discord, optional.** Relay and alerts, sign in with Discord and role sync, map-vote polls, a
  `/staff` panel, and player self-registration. The panel works with no Discord at all.
- **Your data.** Import a CRCON history (from a CRCON database backup or its API); full backups,
  nightly automatic backups and one-click restore; a data trim tool that removes old events by
  category and age, with an archive first. Career stats survive trimming.
- **Extensible.** A plugin SDK where a plugin declares what it needs and gets only that: tiles on
  the dashboard, screens of its own, API routes and live streams, permissions in Roles. Plugins
  in the `installed-plugins` folder load at startup and update with the panel, and the panel is
  built from widgets on saved layouts. [docs/plugins.md](docs/plugins.md) says how to make and
  install one.

## Quick start

**A Windows PC:** download **[`install.bat`](https://github.com/JDK5294/hellrcon/blob/main/install.bat)** (the page's download button) and double-click it.
**A Linux VM:** `curl -fsSL https://raw.githubusercontent.com/JDK5294/hellrcon/main/install.sh | sudo bash`

Each installer offers or installs what is missing (Git and Docker), gets the code and starts the
panel on its setup page. The full guide, with both routes and how to put the panel online, is
[docs/install.md](docs/install.md).

Already have the code? **Windows:** double-click **`start.bat`**  ·  **macOS/Linux:** run
**`./start.sh`**. It checks Docker, creates `infra/.env` on first run (with a key that encrypts
stored RCON passwords), **pulls the latest code**, **rebuilds**, starts the stack and opens the
panel at <http://localhost:8080>. Run it again to **update**: your `infra/.env` is git-ignored and
never touched. Stop with `stop.bat`, or `docker compose -f infra/docker-compose.yml --profile tunnel down`.

Run by hand, it needs Docker ([Docker Desktop](https://www.docker.com/products/docker-desktop/) on
Windows and macOS; Docker Engine with the Compose plugin on Linux) and `git` for updates (a
downloaded ZIP still runs, it just won't update itself).

First run: the panel opens on its setup page with the one-time setup code from the start window
filled in. Create the **owner** account, pick the community's time zone and add your first server
(it starts in observe mode). Everything else is configured in the panel, including Discord, the
public stats site and putting the panel online (**Administration → Online access**). `infra/.env`
only holds what the deployment itself needs: the database password, the encryption key and ports.

## Hardware requirements

One worker process watches every game server, so a second or third server adds little CPU or
memory. What grows is the database: it follows how busy your servers are and how much history you
keep, so size the disk first.

Suggested machines for busy servers (about 55 players on average, around the clock) and a year of
history:

| Servers | vCPU | Memory | Disk |
|---|---|---|---|
| 1 | 2 | 4 GB | 45 GB |
| 2–3 | 4 | 8 GB | 70–90 GB |
| 4–5 | 4–6 | 12 GB | 115–135 GB |

Past five, add about 2 GB of memory and 25 GB of disk a year for each busy server, and a vCPU for
every two or three. Quieter servers need less disk.

It runs on less: 2 vCPU up to three servers and 4 beyond; 2 GB of memory for one server (with a
swap file, or an update can run out of memory), 4 GB for two or three, 6 GB for four or five. Disk
is the one to plan: about 15–20 GB for the system and Docker, plus 20–25 GB per busy server per
year, and more if you import CRCON history.

### How these were measured

- **CPU.** A simulated full 100-player server cost under 3% of one core. The CPU only works hard
  in bursts: analytics over long windows, the nightly backup (one core for some minutes on a large
  database), and updates.
- **Memory.** The whole stack (API, worker, Discord bot, Postgres, Redis) idles at about 250 MB.
  The rest goes to the update build (about 1 GB extra for a minute or two) and to caching the
  database, which is what keeps long analytics windows fast.
- **Database.** About 1.2 GB per busy server per month (14 GB a year), from a production install
  running one WW2 and one Vietnam server. The game log is most of it.
- **Backups.** A nightly backup is compressed to about a tenth of the database's size on disk. The
  disk figures above assume 3 of them kept on the same disk; keep copies elsewhere too.
- **Imported CRCON history.** About 0.55 GB on disk per million imported game-log lines (kills,
  joins, team switches, messages).

### Running it

- Linux with Docker Engine and the Compose plugin (for example Ubuntu 24.04 LTS), on an SSD.
  Tested on x86-64. Windows and macOS run it through Docker Desktop, whose VM needs memory of its
  own on top of the figures above.
- The start script builds the app on the machine; there are no prebuilt images. Each update
  leaves the previous image (about 1 GB) behind, and `docker image prune -f` removes it.
- Trim old events under **Administration → Data trim** to cap growth, and keep fewer backups
  under **Administration → Backup** to save space.
- To move an install, download a full backup from **Administration → Backup**, copy it into the
  new install's `backups` folder, and press **Restore** there.

## Project structure (monorepo)

```
packages/
  shared       config, structured logger, typed error taxonomy
  events       evt.* event taxonomy
  games        game modules: Hell Let Loose and Hell Let Loose: Vietnam (command tables, log
               parsing, maps, roles)
  rcon-core    protocol adapters (binary-v2 / legacy-text / crcon-bridge) + the observe-mode guard
  access       passwords, API tokens, sessions, per-server permissions
  db           data model + repository (Postgres; in-memory for tests) + migrations
  ingest       log lines -> players + events + stat rollups
  bus          live event distribution (Redis pub/sub with an in-process fallback)
  schedule     "is this active now?" windows: time, days, dates, player counts
  maps         map and layer catalogue, rotation placement, map vote
  rules        the roster triggers behind the rules engine
  payout       the bulk payout engine
  widgets      widget model + registry + layout resolution
  plugin-sdk   plugin contract + capability-scoped host runtime
apps/
  api          REST API, CRCON-compatible public API, panel host, plugin runtime
  workers      the always-on per-server work: log ingestion, seeding, map vote, automation, rewards,
               backups
  panel        the web panel and public stats site (Next.js, static-exported, served by the API)
  discord      Discord bot (relay, alerts, map-vote polls, the /staff panel, registration)
plugins/
  example-killfeed   a first-party plugin (dogfoods the SDK)
third_party/   licences and reference copies of outside code (see NOTICE.md)
```

See **`docs/architecture.md`** for how it fits together.

## Development

```bash
pnpm install       # install workspace deps
pnpm build         # build all packages/apps
pnpm typecheck     # type-check
pnpm lint          # lint
pnpm test          # tests (set DATABASE_URL to run the Postgres-backed ones against a real database)
pnpm check:naming  # source checks: no raw control characters, credit for outside code (also
                   # runs in CI)
```

To try the read-only observe harness against a real server without the full stack, fill
`SERVER_1_HOST`/`PORT`/`PASSWORD` in `infra/.env` and run `observe.bat` (Windows) or
`node scripts/observe.mjs 1`.

## Docs

- `docs/architecture.md` — system overview, data flow, key invariants.
- `docs/game-modules.md`, `docs/hll-vietnam.md` — how a game plugs in, and where Vietnam differs.
- `docs/rcon-503.md` — **what the game server actually exposes** (from the official 5.03 RCON
  package). The authority for "can RCON do X?"; sources in `docs/rcon-503/`.
- `docs/public-stats.md`, `docs/streamer-mode.md`, `docs/streamer-guide.md` — the public stats site
  and the CRCON-compatible API behind it.
- `docs/crcon-parity.md`, `docs/crcon-api.md` — CRCON compatibility, and CRCON's HTTP API (all 298
  endpoints and their response shapes are catalogued in `docs/crcon-api/`).
- `docs/crcon-db-import.md`, `docs/data-port.md` — importing CRCON history; backups, restore and
  moving an install.
- `docs/vip-module.md`, `docs/ban-model.md`, `docs/approvals.md`, `docs/bulk-payout.md` — VIP,
  bans, staff requests and payouts.
- `docs/discord-modules.md`, `docs/permissions-map.md` — the Discord side, and who can do what.
- `docs/observability.md` — logging, errors, request tracing (read before adding endpoints).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) first. The project is
**AGPL-3.0-only and intended to stay free forever** — we use a DCO (`git commit -s`), not a CLA, so no
one can take it proprietary. Your contributions remain under AGPL, same as everyone's.

## Credits

This project serves CRCON's public API, and doing that carries parts of CRCON itself (MIT, Julien
Marechal), game data from hllrcon (MIT, Tim Raaymakers), and Django's stock error page (BSD).
[`NOTICE.md`](NOTICE.md) lists every file involved and where each licence lives. Game assets are
© Team17 / Black Matter and are not covered by this repository's licence.
