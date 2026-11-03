# Database export & import (the data port)

Admin → Backup. Export any combination of data groups to one archive; import archives into any
install. The point is a **clean-slate migration that keeps only what you choose**: export
"servers + players + vip + bans" from the old install, stand up a fresh database (migrations run
on boot), upload the archive, import.

## Full backups (Create full backup now)

The same machinery, pointed at everything: one press exports **every** group to a timestamped
`full-backup-*.ndjson.gz` in the backup folder — bind-mounted to a `backups` folder on the host
in the compose stack, so the file is visible and copyable the moment it finishes. The file is
written as `.partial` and renamed only on success, so a crashed or failed backup never appears
in the list as a restorable archive. CRCON-imported history needs no special casing: those rows
live in the same tables and ride along.

**Restore** (per stored backup, on the same page) is the counterpart, and it is NOT an import:
it reads and verifies the **entire archive first** — a real data-port header stamped as a full
backup, every line a row of a known table — and refuses before touching anything if the file is
partial, truncated, or corrupt. Only then does it empty every catalogued table and import the
archive. That wipe is what makes a
fresh install come back *identical* — a fresh install is not empty (migrations seed the singleton
config rows and factory presets, boot seeds the preset roles), and under import's
existing-rows-win rule those seeds would beat the archive on exactly the rows that matter most:
your settings (same fixed primary key), your roles (unique names collide, so the staff
assignments pointing at archived role ids fail as orphans). Restore is deliberately its own route
and its own button — "add these rows" and "replace the install with this archive" must never be
one mistyped field apart. Live state (open sessions, the poll in flight) and the migration ledger
are never touched.

Restoring onto a RUNNING stack is safe: the restore arms a marker file in the shared backups
folder before it wipes, and the worker stands its server runners down while it is fresh — its
ingest pauses within one poll, everything else at the next rescan — then comes back against the
restored rows. Without that, live log lines landing mid-restore would take player ids with fresh
uuids and orphan the archive's rows. The marker is refreshed while the import runs and expires on
its own, so a crashed restore cannot silence ingestion for good.

## The archive format

One gzipped NDJSON file:

```
{"header":{"format":"data-port","version":1,"exportedAt":"…","groups":["servers","vip"]}}
{"table":"servers","row":{"id":"…","name":"…", …}}
{"table":"vips","row":{…}}
```

- `row` is the Postgres row verbatim (`SELECT *`), snake_case columns, ids included — foreign
  keys survive because ids are never rewritten.
- Lines are written **parents-first** (the catalog's order), and the importer inserts in file
  order — that ordering IS the foreign-key story.
- The trim backups write the same `{table, row}` line shape, so the two archives read alike.

## The catalog

`DATA_EXPORT_GROUPS` in `packages/db/src/types.ts` is the single source of truth: every group's
label/hint (rendered verbatim by the panel), its tables in dependency order, and `needs` — the
groups its foreign keys point at (the panel auto-selects them). `DATA_EXPORT_EXCLUDED` names
every table that is deliberately NOT exportable, with the reason (live state, runtime health,
partition aliases). A coverage test walks the schema: a new table must be placed in a group or
excluded by name, so nothing can silently become unmigratable.

## Import semantics

- **Existing rows always win** — `ON CONFLICT DO NOTHING`; importing is additive and safe to
  repeat.
- Rows the database refuses (usually a missing parent when a dependency group wasn't exported)
  are **counted and reported per table**, never fatal, and never take the batch down with them
  (a refused batch retries row-by-row).
- Serial sequences are resynced after import so organic inserts don't collide with imported ids.
- Postgres only. The memory store answers `supported: false` and the panel says so.

## Security

The archive carries selected tables **verbatim** — server RCON credentials (sealed), user
password hashes, API token hashes. Export/download/upload/import all gate on `admin.data` at
write level. Treat archive files like password files.

An archive is also a file anyone can write by hand, and importing a row inserts it as it stands —
a `grants` line is a grant, a `users` line with a known hash is an account. `admin.data` is not
ownership (a server's `*` passes its scope-blind gate, and the Administrator preset carries it), so
for anyone short of an owner (the global `*` at write) the tables that decide who signs in and what
they may do — `users`, `api_tokens`, `roles`, `user_roles`, `grants`, `user_limits` and
`discord_role_map` (`DATA_PORT_ACCESS_TABLES`) — are refused row by row and reported, while the
rest of the archive imports as usual. A **restore** replaces those tables wholesale, so it is
owner-only.

## The CRCON-database importer seam

The importer consumes `{table, row}` NDJSON — it does not care who wrote the file. Importing a
real CRCON **database** (as opposed to the CRCON API pull that already exists under
Connections) means one new piece: an adapter that reads their Postgres dump and emits our
`{table, row}` lines (their `steam_id_64`/player records → our `players` rows, their vip rows →
our `vips`, and so on), parents first. Everything downstream — upload, batching, conflict
skipping, FK reporting, sequence resync — is already built and tested. Write the adapter when
the real CRCON database is in hand; guessing their current schema without it would be the same
mistake the streamer-mode work avoided.
