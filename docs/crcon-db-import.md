# Importing a CRCON `db_data` backup — the fire-once runbook

The procedure for importing a complete CRCON install from its raw Postgres data directory
(`db_data` inside the backup), with proof at every step. Nothing here writes to the panel's
database until step 6, and by then two read-only checks have already shown you the whole outcome.

The property this delivers is **no silent wrong data, ever**: every step either matches an
expectation exactly or names its own difference; every write is idempotent (a re-run converges,
never doubles); and the reset can remove an entire import wholesale if you want to start over.

Related: `docs/crcon-import-coverage.md` (what lands where, what's skipped and why),
`packages/db/scripts/rehearse-crcon-db-import.mjs` (this whole runbook as an automated rehearsal
against a synthetic CRCON — run it after changing any import code).

## 0. What you need

- The backup's `db_data` directory (CRCON pins `postgres:12-alpine`; database `rcon`, user `rcon`).
- The panel running with its own `DATABASE_URL` (the import writes through the normal repo).
- Do NOT copy `.env` / `backup.env-*` files anywhere — they hold live RCON and DB passwords and
  the import never needs them.

## 1. Boot the backup's database

### The easy way on your own machine: paste the folder, run start.bat

`start.bat` / `start.sh` bring the backup's database up with the stack, so a multi-gigabyte
history is imported by copying a folder — never by uploading it through the panel.

1. In the backup, find **`hll_rcon_tool/db_data`**. That folder IS the CRCON database.
2. Next to `start.bat`, make a folder called **`crcon-db-data`** and paste the *contents* of
   `db_data` into it. `crcon-db-data\PG_VERSION` must exist when you are done — that file is how
   the scripts (and Postgres) recognise a real data directory. If you see a warning about it,
   you pasted one folder too deep.
3. Run `start.bat`. It notices the folder and starts the backup's database alongside everything
   else. The **first** start copies the data into a container volume and can take several
   minutes; the pasted folder is mounted read-only and is never modified.
4. Check `db_data/PG_VERSION` if the container refuses to start: it prints the exact
   `CRCON_DB_IMAGE=postgres:<version>-alpine` line to add to `infra\.env`. CRCON's own default
   is 12, which is what this ships with.

Then run every command below **inside the worker container**, where the database URL and the
archive folder already live — no ports to open, no password needed (the copy is switched to
local trust, and nothing outside the stack can reach it):

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml exec worker \
  node apps/workers/dist/crcon-import/db-import-cli.js inventory --crcon postgres://rcon@crcon-db:5432/rcon
```

The user in that URL is CRCON's `HLL_DB_USER`, whose default is `rcon` — the cluster was created
with that role, and a `postgres` role usually does not exist in it. If you get
`role "rcon" does not exist`, read `HLL_DB_USER` out of the OLD install's `.env` (it is in the
backup) and use that name instead. No password is needed either way. In that case also put it in
`infra\.env` as `CRCON_DB_USER=<that name>` (and `CRCON_DB_NAME=` if the database is not `rcon`
either) so the container's health probe uses the same identity — otherwise the probe still
succeeds, but the backup's Postgres logs `FATAL: role "..." does not exist` once every ten seconds
for as long as it is up, which looks like a broken import and is not one.

`--server` takes the server's NAME as shown in the panel (the internal id is never displayed, so
it is not required); `servers` lists them if you want to check the spelling. A name matching more
than one server is refused rather than guessed. The export writes
into the same archive volume the panel's **Dry run** and **Apply** read, so the panel picks it
up with nothing further to move.

When the import is finished, take the folder away and the extra database stops coming up:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml --profile crcon-import down
docker volume rm app_crcondbdata      # the copy; your pasted folder is untouched
```

### The manual way (any host, or a backup you keep elsewhere)

If you would rather not paste the folder into the app, run the database yourself on the host
that has the backup:

```sh
docker run -d --name crcon-backup-db \
  -v /path/to/backup/db_data:/var/lib/postgresql/data:ro \
  -p 127.0.0.1:5433:5432 \
  postgres:12-alpine
```

The `:ro` mount is the belt-and-braces: our side only ever reads, but read-only at the mount
means even a bug cannot alter the backup. If PG12 refuses to start read-only on your setup, drop
`:ro` and keep a copy of `db_data` elsewhere — the copy IS the backup then.

Connection URL for everything below: `postgres://rcon:<HLL_DB_PASSWORD from the old install>@127.0.0.1:5433/rcon`.

## 2. Inventory — see what you actually have (read-only)

```sh
cd apps/workers
node dist/crcon-import/db-import-cli.js inventory --crcon postgres://rcon:PASS@127.0.0.1:5433/rcon
```

This prints every server in the database with its log-line/round/session counts and date ranges,
plus warnings for anything that would import wrong (non-numeric server values, missing tables).
**Expect your two servers as `1` and `2`.** Non-zero exit means a warning — read it before going on.

## 3. Export — one archive per server (reads CRCON, writes only the archive file)

```sh
node dist/crcon-import/db-import-cli.js export --crcon <url> --server-number 1 --server <panel server id 1>
node dist/crcon-import/db-import-cli.js export --crcon <url> --server-number 2 --server <panel server id 2>
```

The panel server id is in Administration → Connections. The export refuses a server number the
database doesn't contain (a typo cannot produce a silently-empty archive), writes a fresh archive
to the exact file the panel's Apply reads, and prints per-type counts when done.

Open rounds are excluded at the source (a round with no end is a torn snapshot), and each archive
is stamped with its server number so the transform's cross-server guard arms itself.

### The stamp is mandatory on a multi-server panel

Only the database export writes that stamp. An archive from the older **network-API pull** carries
none, and CRCON's log store is shared across the whole install — so its rows cannot be told apart
per server, and applying one would import the other servers' history onto this one. With more than
one server in the panel, **Apply refuses such an archive** and says so instead of writing.

The Backup screen labels each stored archive: `database export · CRCON server N`, or
`legacy archive — does not say which CRCON server it holds`. If you see the legacy label, use
**Delete archive** and re-export from the database with the command above; there is nothing to
salvage from the old file that a fresh export does not carry in full.

## 4. If this panel already holds an old, contaminated import — repair first

Administration → Backup, per server: **Check import integrity**. If it reports cross-server
duplicates (the unfiltered-era imports), run **Reset imported history** on BOTH servers before
applying the new archives. Careers recount from surviving live evidence; the new import rebuilds
the historical era cleanly.

## 5. Dry run — the whole import, zero writes

Administration → Backup → **Dry run (no writes)**, per server.

The entire archive goes through the real transform — every parser, every guard, the same overlap
cutoff — into a throwaway store. You get the full report: what would land, every skip with its
reason, every error, with samples for anything unrecognized. **Nothing is written.**

Do not proceed until the dry run reads clean: zero errors, zero unrecognized (or unrecognized
rows you have looked at and consciously accepted).

## 6. Apply — the real write

Administration → Backup → **Apply to panel**, per server. Same code path the dry run exercised;
the only difference is the destination. Safe to re-run at any time — every write is idempotent,
and rows already imported through the OLD network pull are converged with, not doubled (both
paths key events on CRCON's own log ids).

## 7. Reconcile — the proof

```sh
node dist/crcon-import/db-import-cli.js reconcile --crcon <url> --server-number 1 --server <panel server id 1>
node dist/crcon-import/db-import-cli.js reconcile --crcon <url> --server-number 2 --server <panel server id 2>
```

This counts BOTH databases under the same rules the import ran by and compares category by
category. The verdict is **COMPLETE** only when every line matches exactly and nothing is
unexplained; otherwise the failing category and the exact delta are named. Expected-and-explained
surpluses (sessions and round lines we additionally derive from the log; profile moderation
events with no log counterpart) are printed with their reasons — a green line always means
"verified equal", never "not checked".

Finish with **Check import integrity** in the panel: zero cross-server duplicates.

## 8. Afterwards

- The backup database container can be stopped: `docker stop crcon-backup-db`. The exported
  archive keeps every field of every exported row (including the ones the transform deliberately
  reads past — see the coverage doc), so it is the full-fidelity copy going forward; future
  backfills re-stream the archive, never the backup. Keeping `db_data` somewhere cold is still
  cheap insurance, but it is no longer the only copy of anything. The panel's "Delete archive"
  button trims the stored archive if the disk ever matters more.
- The API pull (Backup → pull job) remains the top-up path for anything CRCON recorded after
  this backup was taken, now server-filtered and converging with this import.

## Semantics worth knowing (also in the coverage doc)

- **Careers count events; rounds carry the scoreboard.** Career kills derive from kill-log
  events. A round's per-player line carries the scoreboard's totals (GREATEST-reconciled). On an
  untrimmed log the two agree; where CRCON pruned logs, rounds keep the scoreboard's truth and
  careers reflect the surviving event record.
- **Profile moderation actions are install-wide.** CRCON's `players_actions` has no server
  column, so each server importing a profile records the same action. The integrity fingerprint
  deliberately ignores these (`crcon:ra:` keys) — they are CRCON's missing attribution, not
  log-store contamination.
- **Sessions ARE per-server from the database** (unlike the API, whose serializer drops the
  server column) — the old "install-wide playtime" caveat no longer applies to database imports.
- **Open rounds never import.** The one-open-round arbiter belongs to the live tracker.
- **Timestamps are UTC by construction, on any host.** CRCON stores naive timestamps that mean
  UTC; the exporter casts every timestamp column to text in SQL and stamps zone-less strings UTC
  itself, so the Postgres driver never gets the chance to reinterpret them in the host's
  timezone. No TZ environment setup is required to run the CLI correctly.
