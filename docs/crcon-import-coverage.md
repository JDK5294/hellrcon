# CRCON import coverage — what lands, what's skipped, and why

The field-by-field audit of the backup import: every dataType the pull writes into the archive,
where the transform puts it, and — the part this file exists for — **everything CRCON stores that
we do NOT import**, each with the reason. Read this before trusting an import as "complete", and
update it whenever a stage or a transform case changes.

Pull: `apps/workers/src/crcon-import/runner.ts` (stage list = `STAGE_KEYS`).
Apply: `apps/api/src/crcon-transform.ts`.
Repo destinations: `packages/db/src/types.ts` (contract), `postgres.ts` / `memory.ts` (stores).
CRCON's side of the wire: `docs/crcon-api.md` + `docs/crcon-api/`.

## The archive

One NDJSON file per server (`data/crcon-archives/<serverId>.ndjson`), each line
`{"dataType", "entityKey", "raw"}` with `raw` = CRCON's row verbatim. The pull only ever APPENDS
what it fetched — nothing is reshaped on the way in — so anything listed below as "not
transformed" is still sitting in the archive, recoverable by a future transform without
re-pulling. Dedupe on `(dataType, entityKey)`; a fresh job truncates, a resume seeds the dedupe
from the existing file.

### Multi-server installs (the contamination rule)

A multi-server CRCON shares ONE database: `get_historical_logs` spans every server unless
`server_filter` is passed, and several row types carry which server they belong to. Since the
two-server fix, the pull:

- records `{"dataType":"meta","entityKey":"server_number"}` from `get_status` (first stage), and
- passes `server_filter` on all 12 log stages.

The transform reads the meta record in its pre-scan and drops any row naming a different server
(`server` on log rows, `server_number` on scoreboard rows) — counted as `skipped.otherServer`.
Archives from before the fix (no meta record) apply unguarded — that era is what the integrity
check (`GET …/import/crcon/integrity`, cross-server fingerprint = same `crcon:<id>` dedupe key on
two servers) and the reset (`POST …/import/crcon/reset`) exist to repair.

**Known hole — sessions:** CRCON's `PlayerSessionType` has NO server column; a profile's session
list is install-wide. On a shared install, profile-derived sessions (and the playtime folded from
them) cannot be attributed to one server and will count a player's hours on server A into their
server B career too. Log-derived sessions (connect/disconnect pairing) don't have this problem —
the log rows are server-filtered. There is nothing to fix on our side; the source data simply
doesn't say. Expect playtime from profile sessions to read high on multi-server installs.

## Coverage, dataType by dataType

Cutoff rule used throughout: `events.firstLocalTs(serverId)` — the first locally-ingested event.
Rows stamped at/after it are skipped (`skipped.afterCutoff`): the live tracker owns that era, and
importing it would double-count.

| dataType | CRCON source | What we take | Destination |
|---|---|---|---|
| `meta` | `get_status` | `server_number` | transform pre-scan only (never stored) |
| `vip` | `get_vip_ids` | player id, name→comment, expiration | `vips` upsert (real name looked up; CRCON's label kept as comment) |
| `ban` | `get_bans` | player, temp/perma, reason, author, banned-at | `crcon_bans` (history record, NOT the live ban list — the seed adopts live lists from the game itself) |
| `blacklist` / `blacklist_record` | `get_blacklists` + `get_blacklist_records` | pulled, archived, **not transformed** | — (every blacklisted player here carried a real perma ban alongside; the blacklist concept is retired — `docs/ban-model.md`) |
| `standard_message` | `get_standard_{broadcast,welcome,punishments}_messages` | text | `templates` (importer) |
| `map_history` | `get_map_history` | map, start/end, winner/result | `matches.importOne` — idempotent on (server, started_at), pre-cutoff only |
| `map_scoreboard` | `get_scoreboard_maps` | final score + per-player rows (see below) | `matches.importScoreboard`, second pass after kills flush |
| `watchlist` | `get_players_history?is_watched` | watch flag + reason/author/time | `player_flags` |
| `player` | `get_players_history` | id, names, last-seen | `players` upsert + name history |
| `player_detail` | `get_player_profile` per player | first/last seen, sessions, playtime, IPs, flags→tags, comments→notes, received_actions→moderation events, watch | `players`, `player_sessions`, `player_ips`, `player_tags`, `player_notes`, `evt` |
| `log_kill` / `log_teamkill` | `get_historical_logs` KILL / TEAM KILL | actor, victim, weapon, time | `evt` (`evt.kill`/`evt.teamkill`) + career bumps (kills/teamkills/deaths) + weapon breakdowns |
| `log_match` | MATCH | start/end lines | `evt.match.started/.ended`; round records come from map_history, not these |
| `log_connect` / `log_disconnect` | CONNECTED / DISCONNECTED | presence lines | `evt` + visits bump + **session pairing** (connect→next disconnect, >12 h pairs dropped, overlaps with stored sessions skipped) → career playtime |
| `log_teamswitch` | TEAMSWITCH | switch lines | `evt.player.teamSwitched` |
| `log_admin` | ADMIN (prefix: kicks, bans, misc) | kicked/banned + reason | `evt.player.kicked/.banned` |
| `log_message` | MESSAGE | admin→player messages | `evt.admin.message` |
| `log_vote` | VOTE (prefix: started/completed/ballots) | vote lines | `evt.vote.started/.completed/.cast` |
| `log_tkauto` | TK (auto-enforcement) | kick/ban lines | `evt.player.kicked/.banned` |
| `log_camera` | CAMERA | enter/exit + admin | `evt.admin.camera` + `admin_cam_sessions` |
| `log_chat` | CHAT (prefix: all four scopes) | chat lines | `evt.chat.*` |

### map_scoreboard per-player fields

Taken: `kills`, `deaths`, `teamkills`, `combat`, `offense`, `defense`, `support`,
`vehicle_kills`, `vehicles_destroyed`, `team.side`, `time_seconds`, name, player id.

- Applied by `matches.importScoreboard` with **GREATEST reconciliation**: the kill-log pass has
  already counted per-round kills, so scoreboard totals only ever widen a line, never stack on it.
  Order matters and is enforced — scoreboards apply in a dedicated second pass after the kill
  buffer flushes.
- `units` (the timestamped `{ts, team, squad, role}` history) collapses into REAL role clocks —
  the role ints are the game's own, the same space the live sampler stores, so imported rounds
  carry the same `role_seconds` shape live rounds do. Only when a line has no unit history does
  `time_seconds` fall back to `role_seconds["-1"]` — the "in the round this long, role unknown"
  sentinel that role-split charts filter out (`role >= 0`).
- Open rounds (`end` missing) are never imported — a torn snapshot, and the one-open-round
  arbiter must stay with the live tracker.

## Not imported — the complete list

Everything here is a deliberate skip. First table: fields present in archived rows that the
transform reads past. Second: CRCON data the pull never fetches at all.

### In the archive, not transformed

| Field(s) | Where | Why skipped |
|---|---|---|
| `kills_by_type`, `deaths_by_type` (infantry/armor/artillery/mg/commander split) | map_scoreboard rows | No per-round-per-category column on `player_match_stats`. Career-level weapon breakdowns come from the kill log's weapon field, which is finer-grained anyway. In the archive if ever wanted. |
| `weapons`, `death_by_weapons` (per-round weapon dicts) | map_scoreboard rows | Same information derived from `log_kill` rows at full fidelity (per-event, not per-round rollup). Importing both would double-represent. |
| `most_killed`, `death_by` (per-round nemesis dicts) | map_scoreboard rows | Derived data — our analytics compute nemeses from the kill events themselves. |
| `kills_streak`, `deaths_without_kill_streak`, `teamkills_streak`, `deaths_by_tk`, `deaths_by_tk_streak` | map_scoreboard rows | No streak columns in our model; derivable from ordered kill events if a feature ever needs them. |
| `longest_life_secs`, `shortest_life_secs` (lifespans) | map_scoreboard rows | No lifespan column; would need per-life tracking we don't do live either. Noted as a candidate if per-life analytics ever land. |
| `units` team/squad components | map_scoreboard rows | The ROLE component becomes real role clocks (above). Squad membership and team-over-time have no destination column; in the archive if a squad-history feature ever lands. |
| `kills_per_minute`, `deaths_per_minute`, `kill_death_ratio` | map_scoreboard rows | Ratios — always computed at read time from the stored counts, never stored. |
| `nb_vote_started`, `nb_voted_yes`, `nb_voted_no` | map_scoreboard rows | Vote analytics live on our own ballot records; CRCON's per-round tallies have no destination. Archived. |
| `penalty_count` (PUNISH/KICK/TEMPBAN/PERMABAN totals) | player profiles | The same actions arrive individually via `received_actions` → moderation events; a cached rollup would drift from the event-derived truth. |
| `blacklist` object on profiles | player profiles | Blacklist retired (`docs/ban-model.md`). |
| `sessions_count` | player profiles | Visits are counted from connect events (one owner for the +1 rule); a second counter would fight it. |
| `current_playtime_seconds` etc. (live-presence fields) | player profiles | Live-only readings, meaningless in a backup. |
| `steaminfo` (country, profile blob) | player profiles | No destination column; archived if ever wanted. |
| `vips` list nested on profiles | player profiles | VIPs come from the dedicated `vip` stage (authoritative endpoint). |

### Never pulled from CRCON

| CRCON data | Endpoint | Why not pulled |
|---|---|---|
| CRCON web-UI audit log (which CRCON admin clicked what) | `get_audit_logs` | Their panel's internal history, about their tool's users — not game history. Our own audit trail starts with this panel. |
| CRCON settings (autosettings, votemap config, broadcasts config, camera/welcome config…) | `get_*_config` family | We have our own, richer versions of each; importing config would overwrite deliberate setup. Standard messages are the one exception (imported as templates). |
| CRCON admin/user accounts + permissions | `get_online_mods` etc. | Staff onboard through Discord auth; CRCON accounts don't map onto ours. |
| Other games' log families (none currently: the 12 prefixes cover every action family CRCON v11–12 emits) | `get_historical_logs` | The prefix filters (`KILL`, `TEAM KILL`, `MATCH`, `CONNECTED`, `DISCONNECTED`, `TEAMSWITCH`, `ADMIN`, `MESSAGE`, `VOTE`, `TK`, `CAMERA`, `CHAT`) are prefix matches on CRCON's side, so each catches its whole family. If a future CRCON adds a new action family, it needs a new stage HERE — nothing will fail loudly. |
| Player-count / server-load time series | `get_server_stats` | Rolling live metric, not history; our own samplers record what we chart. |

## Cross-checks the import stands on

- **Idempotence**: every path is safe to re-run — events dedupe on `crcon:<id>`, matches on
  (server, started_at), sessions on the connect instant, notes on body, bans on
  (server, player, type), scoreboard lines by GREATEST. Re-applying an archive is a no-op.
- **Convergence, not one-shot**: the guarantee is a state re-runs converge to. The verify loop is:
  integrity check → (if contaminated) reset on EVERY affected server → fresh per-server pull →
  Apply → integrity + skip report again.
- **Reset recount caveat**: `resetImportedHistory` recounts careers
  (kills/teamkills/deaths/visits/playtime) from the events and sessions that REMAIN. If live
  events have been trimmed, the recount reflects the trimmed record. Buckets, role time and
  highest-level are live-sampled only and are deliberately untouched by both import and reset.
- **Skip visibility**: the transform reports `skipped.afterCutoff` / `.noTimestamp` /
  `.unrecognized` (with samples) / `.otherServer` — a healthy import explains every skipped row
  into one of those buckets.

## Database-import addenda (the `db_data` path)

The direct-database exporter (`apps/workers/src/crcon-import/from-database.ts`, runbook in
`docs/crcon-db-import.md`) changes three earlier caveats:

- **Sessions are per-server after all** — `player_sessions.server_number` is a real column that
  CRCON's API serializer drops. Database imports split playtime correctly between servers; the
  install-wide caveat above applies only to API-pulled archives.
- **Open rounds are excluded at both ends**: the exporter never writes a round without an end,
  and the transform refuses one from any archive (it would plant an OPEN match squatting on the
  live tracker's one-open-round arbiter).
- **Profile moderation actions (`players_actions`) are install-wide** — no server column exists,
  so each server importing a profile records the same action (`crcon:ra:` keys). The integrity
  fingerprint deliberately ignores these; they are missing attribution at CRCON's end, not
  log-store contamination.
- **The archive keeps EVERY field of the rows it exports.** Scoreboard per-player lines are the
  whole `player_stats` row serialized (`to_jsonb`), not a picked column list — so the "in the
  archive if ever wanted" entries above (kills_by_type, streaks, lifespans, per-round vote
  tallies, squad `units`) are genuinely in a database-path archive, and log rows already carry
  CRCON's original `raw` line. Once reconcile reads COMPLETE, the archive file is a full-fidelity
  stand-in for the backup folder: a future feature that wants a skipped field backfills by
  re-streaming the archive, never by resurrecting the backup. Exports made BEFORE this widening
  carry only the picked columns — re-run the export once if you want the full-fidelity copy.
  The panel's "Delete archive" button is the trim for this file when the space matters more.

And one semantic every consumer should know: **careers count kill events; round lines carry the
scoreboard** (GREATEST-reconciled). On an untrimmed log they agree; where CRCON pruned log lines,
the rounds keep the scoreboard's truth and career totals reflect the surviving event record.

### Gap detectors (run before trusting an import)

Two gap classes live in the DATA, not the code, so tooling detects them per install:

- **The coverage seam** (`reconcile`): if CRCON's last log line predates the overlap cutoff, the
  window between them was recorded by NEITHER system — CRCON had stopped before the panel
  started. Reported with the exact window so light careers are attributed to the seam, not
  blamed on the import. Nothing can recover that window; it does not exist anywhere.
- **Pruned logs** (`inventory`): round scoreboards attesting far more kills than the log holds
  KILL lines means CRCON trimmed old logs. Career kills derive from log events, so they will sit
  below the per-round record — flagged with both numbers before a single row imports.

One further boundary that is deliberate, not a gap: **career score buckets
(combat/offense/defense/support) and squad-lead time accrue from live sampling only.** Imported
rounds carry their buckets on the per-round lines (match detail shows them); folding them into
careers would break the reset's convergence guarantee (reset cannot un-mix them from live
samples). Career bucket totals therefore start at cutover.

Verification for all of the above: `packages/db/scripts/rehearse-crcon-db-import.mjs` — a
synthetic two-server CRCON database driven through export → the REAL Apply → reconciliation,
asserting COMPLETE, idempotence and server separation.
