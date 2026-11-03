#!/bin/sh
# Bring up a CRCON backup's own database, from the db_data folder pasted next to start.bat.
#
# Why a copy instead of running Postgres straight off the pasted folder: Postgres refuses a data
# directory that is not owned by it with mode 0700, and a Windows bind mount cannot express Unix
# ownership at all. So the cluster runs from a Docker volume and the pasted folder is only ever
# READ — the backup on disk is never written to, never recovered into, never modified.
set -e

DATA=/var/lib/postgresql/data
SEED=/seed

if [ ! -f "$DATA/PG_VERSION" ]; then
  if [ ! -f "$SEED/PG_VERSION" ]; then
    echo "[crcon-db] ERROR: no PostgreSQL data found in the pasted folder."
    echo "[crcon-db] Expected a file named PG_VERSION directly inside it."
    echo "[crcon-db] Paste the backup's  db_data  folder (its CONTENTS, not a folder inside it)."
    exit 1
  fi

  # Version gate, with the fix spelled out. Without this, a mismatch surfaces as an opaque
  # "database files are incompatible with server" and the actual remedy is nowhere on screen.
  SEED_VER=$(cat "$SEED/PG_VERSION" | tr -d '[:space:]')
  if [ "$SEED_VER" != "$PG_MAJOR" ]; then
    echo "[crcon-db] ERROR: this backup was made by PostgreSQL $SEED_VER, but this container runs $PG_MAJOR."
    echo "[crcon-db] Fix: put this line in infra\\.env and start again —"
    echo "[crcon-db]     CRCON_DB_IMAGE=postgres:$SEED_VER-alpine"
    exit 1
  fi

  echo "[crcon-db] First start: copying the backup's database into a container volume."
  echo "[crcon-db] The pasted folder is only read — your backup is not modified."
  echo "[crcon-db] This is a one-time copy of a large directory; expect several minutes."
  cp -a "$SEED/." "$DATA/"
  chown -R postgres:postgres "$DATA"
  chmod 700 "$DATA"

  # Auth is replaced on the COPY: the original install's passwords live inside this cluster and
  # are usually long lost with the old host. This container is not published to the network —
  # only other containers in this stack can reach it — and it exists to be read for one import,
  # so local trust is the right trade against "the import is blocked on a forgotten password".
  printf 'local all all trust\nhost all all all trust\nhost all all ::0/0 trust\n' > "$DATA/pg_hba.conf"

  # A backup taken from a running server carries its stale lock file and, if it was copied hot,
  # needs crash recovery. Postgres does the recovery itself; the stale pid must go or it refuses.
  rm -f "$DATA/postmaster.pid"
  echo "[crcon-db] Copy complete."
fi

exec docker-entrypoint.sh postgres
