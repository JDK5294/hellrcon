#!/usr/bin/env bash
# One-click local startup + updater for macOS/Linux (parity with start.bat).
# On each run it pulls the latest code (if this is a git clone), then rebuilds and
# restarts the whole local stack (Postgres + Redis + API + worker) via Docker.
set -euo pipefail
cd "$(dirname "$0")"
# Under pipefail, `x="$(a | b)"` takes the status of the first command in it that fails, and set -e
# then stops the script there, silently: a grep that finds nothing, a curl that times out. Every
# such assignment below ends `|| true` (or another fallback) and its caller judges the empty value.

# The whole script lives in a function that bash parses up front, with a single call at
# the bottom. Without this, the `git pull` below overwriting THIS file mid-run would make
# bash resume reading the new file at the wrong offset (same hazard start.bat guards
# against by re-executing from a temp copy).
main() {

echo "============================================"
echo "  starting local stack"
echo "============================================"

if ! command -v docker >/dev/null 2>&1; then
  echo "[X] Docker is not installed. Install Docker, then run this again."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  # macOS: start Docker Desktop and wait for its engine rather than asking for a second run.
  # Linux: Docker is a system service; starting it needs root, so this says how instead.
  if [ "$(uname -s)" = "Darwin" ] && open -a Docker >/dev/null 2>&1; then
    echo "[i] Docker Desktop is not running - starting it. This can take a minute or two..."
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && break
      sleep 3
    done
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "[!] Docker is installed but not running. Start it (on Linux: sudo systemctl start docker)"
    echo "    and run this again."
    exit 1
  fi
fi

if [ ! -f infra/.env ]; then
  cp infra/.env.example infra/.env
  echo "[i] Created infra/.env from the template."
fi

# Pull the latest code (only if this is a git clone and git is installed). infra/.env is
# git-ignored, so the update never touches it. If it can't fast-forward, keep the current code.
if [ -d .git ]; then
  if command -v git >/dev/null 2>&1; then
    echo "[i] Checking for updates..."
    if git pull --ff-only; then
      echo "[OK] Code is up to date."
    else
      echo ""
      echo "[!] ============================================================"
      echo "[!]  UPDATE FAILED - the latest code could NOT be pulled."
      echo "[!]  The stack will start from the OLD code already on disk."
      echo "[!]  Fix: resolve the git conflict shown above, then rerun."
      echo "[!] ============================================================"
      echo ""
    fi
    # Exported (not just echoed): compose passes it into the image build, and the panel's
    # sidebar then shows which commit the running install was built from.
    GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"
    export GIT_COMMIT
    echo "[i] Running code at commit ${GIT_COMMIT:-unknown}"
    # Where this code came from, for the panel's "update available" check (apps/api/src/updates.ts):
    # the branch the clone follows, and the GitHub repository as owner/name only - never the clone's
    # address itself, which can carry a sign-in.
    GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ "$GIT_BRANCH" = HEAD ]; then GIT_BRANCH=""; fi
    origin="$(git remote get-url origin 2>/dev/null || true)"
    GIT_REPO=""
    case "$origin" in
      *github.com/*|*github.com:*) GIT_REPO="${origin#*github.com[/:]}"; GIT_REPO="${GIT_REPO%/}"; GIT_REPO="${GIT_REPO%.git}" ;;
    esac
    if ! [[ "$GIT_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then GIT_REPO=""; fi
    export GIT_BRANCH GIT_REPO
  else
    echo "[i] git not found - skipping update, using the code already here."
  fi
else
  echo "[i] Not a git clone - skipping update. (Clone with git to enable one-click updates.)"
fi

# Plugins (installed-plugins/README.md): each one that is a git clone updates with the panel. What is
# there, at which commit, goes to compose as PLUGINS_STATE, a setting of the api container, so a
# plugin added, removed or updated recreates the api - and plugins are only read when it starts.
PLUGINS_STATE=""
for dir in installed-plugins/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  at=""
  if [ -d "${dir}.git" ] && command -v git >/dev/null 2>&1; then
    if git -C "$dir" pull --ff-only; then
      echo "[OK] Plugin $name is up to date."
    else
      echo "[!] Plugin $name could not be updated - it starts as it was."
    fi
    at="@$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  PLUGINS_STATE="${PLUGINS_STATE}${name}${at};"
done
export PLUGINS_STATE

# Generate the at-rest encryption key on first run. It encrypts stored RCON passwords;
# infra/.env is git-ignored, so the key survives updates but must not be lost (see .env.example).
if ! grep -Eq '^ENCRYPTION_KEY=.' infra/.env; then
  KEY="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n')"
  if [ -n "$KEY" ]; then
    printf '\nENCRYPTION_KEY=%s\n' "$KEY" >> infra/.env
    echo "[i] Generated ENCRYPTION_KEY in infra/.env - it encrypts stored RCON passwords; keep the file safe."
  fi
fi

# The database password. A brand-new install gets a random one. An install whose database already
# exists keeps the one that database was made with - the old template's `app` - because changing it
# here does not change the database's, and the app could no longer connect.
if ! grep -Eq '^POSTGRES_PASSWORD=.' infra/.env; then
  if docker volume inspect app_pgdata >/dev/null 2>&1; then
    printf '\nPOSTGRES_PASSWORD=app\n' >> infra/.env
    echo "[i] Kept the existing database's password in infra/.env."
  else
    PASS="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -v -tx1 | tr -d ' \n')"
    printf '\nPOSTGRES_PASSWORD=%s\n' "$PASS" >> infra/.env
    echo "[i] Generated a database password in infra/.env."
  fi
fi

# Cloudflare tunnel: the panel runs it itself now (Administration → Online access), and a token an
# older infra/.env carries is moved into the panel on its first start. The separate tunnel container
# older installs ran is no longer started with the stack: once the panel is up it is removed when
# the panel's own tunnel connects, or started as a fallback when it cannot (see below). The
# pattern requires a non-empty value at the start of a line, so a commented-out or blank token
# counts as none.
LEGACY_TUNNEL=""
if grep -Eq '^CLOUDFLARE_TUNNEL_TOKEN=.' infra/.env 2>/dev/null; then
  LEGACY_TUNNEL=1
  echo "[i] Cloudflare tunnel token found in infra/.env - the panel takes it over and runs the tunnel itself."
fi

# CRCON import: if a backup's db_data has been pasted in, bring its database up alongside the
# stack. PG_VERSION exists in every PostgreSQL data directory, so its presence proves the paste
# landed correctly rather than one folder too deep.
CRCON_PROFILE=()
if [ -f crcon-db-data/PG_VERSION ]; then
  CRCON_PROFILE=(--profile crcon-import)
  echo "[i] CRCON backup found in crcon-db-data - starting its database too."
  echo "    First start copies it into a container volume and can take several minutes."
elif [ -d crcon-db-data ]; then
  echo "[!] crcon-db-data exists but has no PG_VERSION file - paste the CONTENTS of the backup's db_data folder into it."
fi

# The panel's host port: API_PORT in infra/.env overrides the 8080 default (compose reads
# the same variable, so the mapping and this script always agree).
#
# The value is then checked to be nothing but digits. A .env saved on Windows carries CRLF line
# endings, so `cut` hands back "8080\r" — pasted into a URL that produces a request which can never
# connect, and the only symptom is a two-minute wait ending in "did not become healthy" while the
# API log plainly says it is listening. `tr -d` takes the carriage return and any stray spaces; the
# test catches whatever is left.
API_PORT="$(grep -E '^API_PORT=' infra/.env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '\r[:space:]' || true)"
if [ -n "$API_PORT" ] && ! printf '%s' "$API_PORT" | grep -qE '^[0-9]+$'; then
  echo "[!] API_PORT in infra/.env is not a plain number - ignoring it and using 8080."
  API_PORT=""
fi
API_PORT="${API_PORT:-8080}"

# Something else already on that port (another web server, another app's container) makes Docker
# refuse to start the panel with an error about the port. Ask instead: the next free port, or one
# typed in, saved as API_PORT in infra/.env. The panel's own container holding it is not "something
# else": an update restarts the panel on the same port. With no terminal to ask on (a scheduled run,
# or the VM installer piped from curl with no tty), the next free port is taken and the line says so.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null || true)" ]
    return
  fi
  # A Mac has lsof instead. Its listing is read for the port rather than trusting its exit status
  # (some lsofs answer 0 to anything), and a connection is tried as well: without root, lsof shows
  # only this user's own sockets.
  local listed=""
  if command -v lsof >/dev/null 2>&1; then listed="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"; fi
  case "$listed" in *":$1 (LISTEN)"*) return 0 ;; esac
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}
next_free_port() {
  local p=$(( $1 + 1 ))
  while [ "$p" -le 65535 ] && port_busy "$p"; do p=$(( p + 1 )); done
  if [ "$p" -le 65535 ]; then echo "$p"; fi
}
# Into infra/.env in place: its other lines are kept exactly, and writing into the same file keeps
# its mode (600 on a VM).
save_api_port() {
  local tmp
  tmp="$(mktemp)"
  if grep -qE '^API_PORT=' infra/.env; then
    sed -E "s/^API_PORT=.*/API_PORT=$1/" infra/.env > "$tmp"
  else
    cat infra/.env > "$tmp"
    if [ -n "$(tail -c1 infra/.env)" ]; then echo >> "$tmp"; fi
    echo "API_PORT=$1" >> "$tmp"
  fi
  cat "$tmp" > infra/.env
  rm -f "$tmp"
}
own_port="$(docker compose --env-file infra/.env -f infra/docker-compose.yml port api 8080 2>/dev/null || true)"
if ! grep -qE ":${API_PORT}\$" <<< "$own_port" && port_busy "$API_PORT"; then
  echo ""
  echo "[!] Port ${API_PORT} is already in use by another program, so the panel cannot start on it."
  new_port=""
  if (exec 4<>/dev/tty) 2>/dev/null; then
    exec 4<>/dev/tty
    echo "    1) Find the next free port for me"
    echo "    2) Let me type a port"
    echo "    3) Stop here"
    while [ -z "$new_port" ]; do
      printf '    Choose 1, 2 or 3: '
      read -r choice <&4 || choice=3
      case "$choice" in
        1)
          new_port="$(next_free_port "$API_PORT" || true)"
          if [ -z "$new_port" ]; then echo "    No free port above ${API_PORT} - type one instead."; fi
          ;;
        2)
          printf '    Port to use (1024-65535): '
          read -r typed <&4 || typed=""
          if ! printf '%s' "$typed" | grep -qE '^[1-9][0-9]{3,4}$' || [ "$typed" -lt 1024 ] || [ "$typed" -gt 65535 ]; then
            echo "    Use a whole number from 1024 to 65535."
          elif port_busy "$typed"; then
            echo "    Port ${typed} is in use too - try another."
          else
            new_port="$typed"
          fi
          ;;
        3)
          echo "[i] Stopped. Free port ${API_PORT}, or run ./start.sh again to pick another port."
          exit 1
          ;;
      esac
    done
    exec 4>&-
  else
    new_port="$(next_free_port "$API_PORT" || true)"
    if [ -z "$new_port" ]; then echo "[X] No free port above ${API_PORT}. Set API_PORT in infra/.env, then run this again."; exit 1; fi
    echo "    No terminal to ask on, so the next free port is used."
  fi
  save_api_port "$new_port"
  API_PORT="$new_port"
  echo "[OK] The panel will use port ${API_PORT} - saved as API_PORT in infra/.env."
fi

# --build rebuilds images from the current source so any pulled code takes effect; Docker's
# layer cache keeps it fast when nothing changed.
echo "[i] Building and starting containers (first run downloads images)..."
# ${a[@]+"${a[@]}"}, not "${a[@]}": macOS still runs bash 3.2, where an empty array is an unbound
# variable under set -u, and start.sh stopped here on every Mac without a CRCON backup.
docker compose --env-file infra/.env -f infra/docker-compose.yml ${CRCON_PROFILE[@]+"${CRCON_PROFILE[@]}"} up -d --build

# Don't declare victory until the panel actually answers. While booting, the API serves a
# "starting" page; /api/health returns {"status":"ok",...} once it is ready.
#
# The probe keeps the HTTP STATUS rather than grepping the body for a word. Grepping cannot tell
# "nothing is listening on that port" from "the API answered 503, still migrating" from "curl is
# not installed" — all three are just "no match", and all three ended in the same unhelpful "did
# not become healthy" beside an API log that says it is listening. The code says which.
HEALTH_URL="http://localhost:${API_PORT}/api/health"
HEALTH_BODY="$(mktemp)"
trap 'rm -f "$HEALTH_BODY"' EXIT
no_curl=""
command -v curl >/dev/null 2>&1 || {
  no_curl=1
  echo "[!] curl is not installed, so this script cannot reach the panel itself."
  echo "    Falling back to Docker's own health report for the api container."
}

echo "[i] Waiting for the panel to come up at ${HEALTH_URL} ..."
healthy=""
result="no answer"
for _ in $(seq 1 40); do
  if [ -n "$no_curl" ]; then
    # The container's own healthcheck (see the compose file). It proves the app is up but says
    # nothing about whether this host can reach it.
    result="$(docker compose --env-file infra/.env -f infra/docker-compose.yml ps --format '{{.Health}}' api 2>/dev/null | head -1 || true)"
    [ "$result" = "healthy" ] && { healthy=1; break; }
  else
    result="$(curl -s -o "$HEALTH_BODY" -w '%{http_code}' -m 3 "$HEALTH_URL" 2>/dev/null || true)"
    [ "$result" = "200" ] && { healthy=1; break; }
  fi
  sleep 3
done

if [ -z "$healthy" ]; then
  echo ""
  echo "[X] The containers started but the panel did not answer within 2 minutes."
  echo ""
  echo "    Probed:      ${HEALTH_URL}"
  echo "    Last result: ${result}"
  echo ""
  # Name the likely cause instead of leaving a status code on screen. These are the only outcomes
  # the probe can produce, and each one points somewhere different.
  case "$result" in
    000) echo "    > Nothing accepted a connection on port ${API_PORT}. The app itself may be fine:"
         echo "      check API_PORT in infra/.env matches the mapping in the container list below,"
         echo "      and that nothing else already holds that port." ;;
    503) echo "    > The API answered, but it is still booting - almost always the database."
         echo "      The API log below names the phase it is stuck in." ;;
    404) echo "    > Something answered on that port, but it is not this panel." ;;
  esac
  echo ""
  echo "    Container status (the api container reports its own health now):"
  docker compose --env-file infra/.env -f infra/docker-compose.yml ps
  if [ -s "$HEALTH_BODY" ]; then
    echo ""
    echo "    What the panel actually replied:"
    cat "$HEALTH_BODY"
    echo ""
  fi
  echo ""
  echo "    Last API log lines:"
  docker compose --env-file infra/.env -f infra/docker-compose.yml logs --no-log-prefix --tail=30 api
  echo ""
  echo "    More detail: docker compose --env-file infra/.env -f infra/docker-compose.yml logs --tail=200"
  exit 1
fi

# A brand-new install opens on its setup page with the one-time setup code filled in: the panel
# wrote the code inside its own container, so it is read from there and handed over in the link.
# On a VM (the installer sets DEPLOY_ROUTE=vm) the panel is opened from another computer, so the
# links name this server's address: its public one when Cloudflare's trace page can say what that
# is, else the first address the server has.
PANEL_HOST="localhost"
if grep -Eq '^DEPLOY_ROUTE=vm' infra/.env 2>/dev/null; then
  PANEL_HOST="$(curl -fsS -4 -m 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)"
  [ -n "$PANEL_HOST" ] || PANEL_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$PANEL_HOST" ] || PANEL_HOST="localhost"
fi
OPEN_URL="http://${PANEL_HOST}:${API_PORT}"
SETUP_CODE=""
if [ -z "$no_curl" ] && curl -s -m 3 "http://localhost:${API_PORT}/api/setup/status" 2>/dev/null | grep -q '"needed":true'; then
  SETUP_CODE="$(docker compose --env-file infra/.env -f infra/docker-compose.yml exec -T api cat /tmp/setup-code 2>/dev/null | tr -d '\r\n[:space:]' || true)"
  [ -n "$SETUP_CODE" ] && OPEN_URL="http://${PANEL_HOST}:${API_PORT}/#/setup?code=${SETUP_CODE}"
fi

# The tunnel: the panel's own, or the container older installs ran. The panel's public status says
# where its tunnel stands. "connected" retires the old container; "off" means the tunnel was
# switched off in the panel, so the old one goes too; anything else after a minute keeps the old
# container running, or starts it, while infra/.env still holds its token.
TUNNEL_NOTE=""
TUNNEL_CONTAINER="$(docker compose --env-file infra/.env -f infra/docker-compose.yml --profile tunnel ps -q cloudflared 2>/dev/null || true)"
if [ -n "$TUNNEL_CONTAINER" ] || [ -n "$LEGACY_TUNNEL" ]; then
  tunnel_state=""
  if [ -z "$no_curl" ]; then
    echo "[i] Waiting up to a minute for the panel's own Cloudflare tunnel to connect..."
    for _ in $(seq 1 30); do
      tunnel_state="$(curl -s -m 3 "http://localhost:${API_PORT}/api/setup/status" 2>/dev/null | sed -n 's/.*"tunnel":"\([a-z]*\)".*/\1/p' || true)"
      if [ "$tunnel_state" = connected ] || [ "$tunnel_state" = off ]; then break; fi
      sleep 2
    done
  fi
  if [ "$tunnel_state" = connected ] || [ "$tunnel_state" = off ]; then
    if [ -n "$TUNNEL_CONTAINER" ]; then
      docker compose --env-file infra/.env -f infra/docker-compose.yml --profile tunnel rm -sf cloudflared >/dev/null 2>&1 || true
      TUNNEL_NOTE="retired-$tunnel_state"
    fi
  elif [ -n "$LEGACY_TUNNEL" ]; then
    docker compose --env-file infra/.env -f infra/docker-compose.yml --profile tunnel up -d cloudflared >/dev/null 2>&1 || true
    TUNNEL_NOTE=fallback
  fi
fi

echo "[OK] Panel is healthy."
echo "  Panel:   http://${PANEL_HOST}:${API_PORT}"
if [ -n "$SETUP_CODE" ]; then
  echo ""
  echo "  First-time setup: open ${OPEN_URL}"
  echo "  Setup code:       ${SETUP_CODE}   (the setup page asks for it before the owner account is made)"
  echo ""
fi
[ "$TUNNEL_NOTE" = retired-connected ] && echo "  Tunnel:  the panel runs it now - the separate tunnel container was removed"
[ "$TUNNEL_NOTE" = retired-off ] && echo "  Tunnel:  switched off in the panel - the separate tunnel container was removed"
[ "$TUNNEL_NOTE" = fallback ] && echo "  Tunnel:  the panel's own tunnel has not connected - the separate container runs meanwhile. See Administration → Online access."
[ ${#CRCON_PROFILE[@]} -gt 0 ] && echo "  CRCON:   backup database up - see docs/crcon-db-import.md to import it"
echo "  Stop it: docker compose -f infra/docker-compose.yml --profile tunnel down"

if command -v open >/dev/null 2>&1; then open "$OPEN_URL" || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$OPEN_URL" >/dev/null 2>&1 || true
fi

}

main "$@"; exit
