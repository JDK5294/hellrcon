#!/usr/bin/env bash
# Install the panel on a Linux VM (Ubuntu or Debian) with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/JDK5294/hellrcon/main/install.sh | sudo bash
#
# or, from a copy of the code:  sudo ./install.sh
#
# It installs Docker and git when they are missing, adds a swap file on a small VM that has none,
# puts the code in /opt/hellrcon, turns on the HTTPS proxy for your own domain, opens the server's
# own firewall for the panel, starts everything with start.sh, and prints the address of the setup
# page with its one-time code. Run it again at any time: it updates the code and restarts, keeping
# your settings.
set -euo pipefail

REPO_URL="${HELLRCON_REPO:-https://github.com/JDK5294/hellrcon.git}"
REPO_BRANCH="${HELLRCON_BRANCH:-main}"
DIR="${HELLRCON_DIR:-/opt/hellrcon}"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[X] %s\n' "$*" >&2; exit 1; }

# The whole script in a function bash reads in full first, so `curl … | bash` cannot run half of it.
main() {
  [ "$(id -u)" -eq 0 ] || die "Run it as root: put sudo in front (curl … | sudo bash, or sudo ./install.sh)."

  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "This installer knows Ubuntu and Debian. On ${PRETTY_NAME:-this system}, install Docker (with its compose plugin) and git yourself, clone the code, and run ./start.sh in it." ;;
  esac

  step "Tools the panel needs: git, curl and openssl"
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl openssl ca-certificates >/dev/null
  fi
  say "[OK] git, curl and openssl are installed."

  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    say "[i] Installing Docker Engine with Docker's own install script (get.docker.com)..."
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker is installed but its compose plugin is not. Install docker-compose-plugin, then run this again."
  say "[OK] $(docker --version)"

  step "Memory"
  # An update rebuilds the images, which takes about a gigabyte more for a minute or two: on a
  # small VM without swap that build is what runs out of memory.
  local mem_kb swap_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  swap_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  if [ "${mem_kb:-0}" -lt 3000000 ] && [ "${swap_kb:-0}" -eq 0 ] && [ ! -e /swapfile ]; then
    # Some VMs (container-based ones especially) do not allow swap at all: that is a warning, not a
    # reason to stop, and nothing is left behind half-made.
    if { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none 2>/dev/null; } \
      && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      say "[OK] Added a 2 GB swap file (/swapfile): this VM has under 3 GB of memory and had none."
    else
      rm -f /swapfile
      say "[!] This VM would not take a swap file. The panel still runs, but with under 3 GB of memory"
      say "    an update can run out of it while it builds: give the VM more memory if that happens."
    fi
  else
    say "[OK] $(( ${mem_kb:-0} / 1024 )) MB of memory$([ "${swap_kb:-0}" -gt 0 ] && echo ", with swap") - enough."
  fi

  step "The code"
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/start.sh" ] && [ -d "$here/.git" ]; then
    DIR="$here"
    say "[i] Using the copy this installer is in: $DIR"
  elif [ -d "$DIR/.git" ]; then
    say "[i] Already in $DIR - start.sh updates it."
  else
    git clone -b "$REPO_BRANCH" "$REPO_URL" "$DIR"
  fi
  cd "$DIR"

  step "Settings for a VM"
  [ -f infra/.env ] || { cp infra/.env.example infra/.env; say "[i] Created infra/.env from the template."; }
  # The panel says it runs on a VM, and the HTTPS proxy for your own domain runs with the stack.
  grep -Eq '^DEPLOY_ROUTE=' infra/.env || printf '\nDEPLOY_ROUTE=vm\n' >> infra/.env
  grep -Eq '^COMPOSE_PROFILES=' infra/.env || printf 'COMPOSE_PROFILES=domain\n' >> infra/.env
  chmod 600 infra/.env
  say "[OK] infra/.env is ready (DEPLOY_ROUTE=vm, the HTTPS proxy on)."

  step "This server's firewall"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 8080/tcp >/dev/null
    say "[OK] ufw allows SSH, 80 and 443 (your own domain) and 8080 (the first setup)."
  else
    say "[i] No active ufw firewall here - nothing to open on the server itself."
  fi
  say "    Your VM provider's firewall (security group, network rules) must allow 8080 for the first"
  say "    setup, and 80 and 443 if you will use your own domain."

  step "Starting the panel"
  ./start.sh
}

main "$@"
