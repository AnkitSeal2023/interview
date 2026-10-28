
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SWE Mock Interview — Docker Compose launcher (plug & play, Ubuntu/Debian/Arch)
#
#   ./scripts/compose.sh              # install docker if missing, ask for the
#                                     #   Groq key ONCE, generate secrets into
#                                     #   .env, build images, start everything
#   ./scripts/compose.sh --voice      # also build/start the local TTS voice
#   ./scripts/compose.sh stop         # stop all services (containers remain)
#   ./scripts/compose.sh down         # stop + remove containers (data volumes kept)
#   ./scripts/compose.sh status       # what's running
#   ./scripts/compose.sh logs         # combined service logs
#
# Requirements: bash, curl. The script installs Docker itself when missing.
# Secrets (DB/TTS passwords, AUTH_SECRET) are generated fresh and stored only
# in .env (chmod 600, gitignored) — never printed, never committed.
#
# Everything runs in containers → no Python/Node/postgres on the host, no sudo
# beyond the one-time Docker install.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVF="$ROOT/.env"
RT_DOCKER_LOG="$ROOT/.runtime/docker-install.log"
mkdir -p "$ROOT/.runtime"

MODE="up"; WANT_TTS=false
for a in "$@"; do
  case "$a" in
    --voice) WANT_TTS=true ;;
    up|stop|down|status|logs|restart) MODE="$a" ;;
    *) echo "unknown arg: $a"
       echo "usage: compose.sh [--voice] [up|stop|down|restart|status|logs]"; exit 1 ;;
  esac
done

grn="\033[32m"; ylw="\033[33m"; red="\033[31m"; dim="\033[2m"; bld="\033[1m"; rst="\033[0m"
say()  { printf "  ${grn}▸${rst} %s\n" "$*"; }
warn() { printf "  ${ylw}▸${rst} %s\n" "$*"; }
fail() { printf "${red}error:${rst} %s\n" "$*" >&2; exit 1; }
hdr()  { printf "\n${bld}== %s ==${rst}\n" "$*"; }

http_ok()    { curl -sf -m 3 "$1" >/dev/null 2>&1; }
wait_http()  { local i; for ((i = 0; i < "$2"; i++)); do http_ok "$1" && return 0; sleep 1; done; return 1; }
port_busy()  { [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]; }
rand_secret(){ openssl rand -hex 24 2>/dev/null \
  || head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | cut -c1-48; }

run_root()  { if [[ $(id -u) -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
run_in_bg() { # start the docker daemon (systemd → sysv init script → bare dockerd)
  if [[ -d /run/systemd/system ]]; then
    run_root systemctl enable --now docker >/dev/null 2>&1 || run_root service docker start >/dev/null 2>&1 || true
  else
    run_root service docker start >/dev/null 2>&1 || true
  fi
  if ! dc info >/dev/null 2>&1; then
    say "init script failed — launching dockerd directly"
    run_root rm -f /var/run/docker.pid /var/run/docker.sock
    run_root sh -c 'nohup dockerd > /var/log/dockerd-manual.log 2>&1 &'
  fi
}
# docker client command (sudo-prefixed when the user cannot reach the socket)
DC=""
dc() { ${DC:+$DC }docker "$@"; }
dcp() { ${DC:+$DC }docker compose "$@"; }

# ── status/logs/down work without installing anything ────────────────────────
if [[ ! -x "$(command -v docker)" ]]; then
  [[ "$MODE" == status || "$MODE" == stop || "$MODE" == down || "$MODE" == logs ]] \
    && fail "docker is not installed here (it was never installed by this script)"
fi

[[ "$MODE" == "stop" ]] && {
  say "stopping containers (data volumes preserved)"
  dcp --profile voice down --remove-orphans 2>/dev/null || dcp down --remove-orphans
  exit 0
}
[[ "$MODE" == "down" ]] && {
  say "removing containers (data volumes preserved)"
  dcp --profile voice down --remove-orphans 2>/dev/null || dcp down --remove-orphans
  exit 0
}
[[ "$MODE" == "logs" ]] && {
  exec dcp logs -f "${COMPOSE_SERVICES:-}"
}
[[ "$MODE" == "status" ]] && {
  hdr "compose services"
  if dc info >/dev/null 2>&1; then
    dcp ps; else warn "docker is not running"; fi
  exit 0
}

hdr "SWE Mock Interview — docker launcher"
echo "  repo: ${ROOT/$HOME/~}"

# ── 1. sudo probe (needed only if docker has to be installed / daemon started) ─
if [[ $(id -u) -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    fail "you are not root and 'sudo' is not installed. Run as root (su -c) or in a root container."
  fi
  sudo -v 2>/dev/null || fail "user '$(id -un)' cannot run sudo. Run as root (su -c 'bash scripts/compose.sh')."
fi

# ── 2. docker presence / installation ────────────────────────────────────────
. /etc/os-release 2>/dev/null || true

# curl is required below (docker installer + groq key check); install it first
if ! command -v curl >/dev/null 2>&1; then
  say "installing curl (needed for the docker installer)"
  case "${ID_LIKE:-$ID}" in
    *debian*|*ubuntu*)  run_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates ;;
    *arch*)             run_root pacman -Sy --noconfirm --needed curl ;;
    *)                  fail "no curl and unsupported distro '${ID:-?}' — install curl, then re-run" ;;
  esac
  command -v curl >/dev/null 2>&1 || fail "curl still missing — install it and re-run"
fi

NEED_DOCKER=false
if [[ -z "$(command -v docker || true)" ]]; then
  NEED_DOCKER=true
elif ! dc info >/dev/null 2>&1; then
  case "$(${DC}docker info 2>&1 || true)" in
    *"permission denied"*|*"/var/run/docker.sock"*) DC="sudo"; warn "docker socket needs sudo here — running docker via sudo" ;;
    *) NEED_DOCKER=true ;;
  esac
fi

dcinfo() { dc info >/dev/null 2>&1; }
if ! ${DC:+$DC }docker compose version >/dev/null 2>&1; then
  warn "docker compose plugin not found"
fi

if [[ $NEED_DOCKER == true ]]; then
  hdr "installing docker"
  case "${ID_LIKE:-$ID}" in
    *debian*|*ubuntu*)
      say "get.docker.com official installer (installing docker + compose plugin)"
      if ! curl -fsSL https://get.docker.com | run_root sh >"$RT_DOCKER_LOG" 2>&1; then
        warn "get.docker.com exited nonzero — see $RT_DOCKER_LOG"
      fi
      command -v docker >/dev/null 2>&1 || fail "docker install failed — see $RT_DOCKER_LOG (https://docs.docker.com/engine/install/)"
      ;;
    *arch*)
      say "installing docker + compose via pacman"
      run_root pacman -Sy --noconfirm --needed docker docker-compose
      ;;
    *)
      fail "unsupported distro '${ID:-?}' — install docker manually, then re-run"
      ;;
  esac
fi

if ! dc info >/dev/null 2>&1; then
  say "docker daemon not running — starting it"
  run_in_bg
  local_i=""
  for local_i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    dc info >/dev/null 2>&1 && break
    sleep 1
  done
  dc info >/dev/null 2>&1 || fail "docker daemon did not start. Try: sudo systemctl start docker"
fi
say "docker $(dc --version | cut -d' ' -f3 | head -1) ready"
if ! dcp version >/dev/null 2>&1; then
  say "docker compose plugin not found — installing it"
  case "${ID_LIKE:-$ID}" in
    *debian*|*ubuntu*)
      run_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin \
        || run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 \
        || true ;;
    *arch*) run_root pacman -Sy --noconfirm --needed docker-compose ;;
  esac
  dcp version >/dev/null 2>&1 || fail \
    "the 'docker compose' plugin is missing — install docker-compose-plugin (get.docker.com includes it)"
fi

# non-root docker permission catch-all (first run after manual package install)
if [[ -z "$DC" && $(id -u) -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  case "$(docker info 2>&1 || true)" in
    *"permission denied"*|*"docker.sock"*)
      DC="sudo"
      warn "your user cannot reach the docker socket — using sudo for docker commands"
      run_root usermod -aG docker "$(id -un)" 2>/dev/null || true
      warn "tip: after 'log out / log in' docker works without sudo"
      ;;
  esac
fi

# ── 3. host port conflicts (dev servers may already bind 3000/8000) ───────────
hdr "port check (:3000 :8000)"
BUSY_PORTS=()
port_busy 8000 && BUSY_PORTS+=(8000)
port_busy 3000 && BUSY_PORTS+=(3000)
if [[ ${#BUSY_PORTS[@]} -gt 0 ]]; then
  warn "host ports already bound: ${BUSY_PORTS[*]} (likely your local dev servers)"
  if [[ -x "$ROOT/scripts/quickstart.sh" && -t 0 ]]; then
    read -r -p "  stop the local dev services now via ./scripts/quickstart.sh stop? [y/N] " ANS
    if [[ "${ANS:-n}" == [yY]* ]]; then
      "$ROOT/scripts/quickstart.sh" stop
    else
      warn "docker will then fail to publish those ports — run compose.sh stop first next time"
    fi
  else
    warn "run ./scripts/quickstart.sh stop (or free :3000/:8000) before starting containers"
  fi
else
  say "ports 3000 and 8000 are free"
fi

# ── 4. Groq API key (required; asked once, stored in .env) ────────────────────
hdr "Groq API key (required — free key at console.groq.com/keys)"
GROQ_KEY="${GROQ_API_KEY:-}"
if [[ -z "$GROQ_KEY" && -f "$ENVF" ]]; then
  GROQ_KEY="$(grep -m1 '^GROQ_API_KEY=' "$ENVF" 2>/dev/null | cut -d= -f2- || true)"
  GROQ_KEY="${GROQ_KEY//\"/}"
  GROQ_KEY="${GROQ_KEY%%[[:space:]]*}"
  GROQ_KEY="${GROQ_KEY//[[:space:]]/}"
fi
if [[ -n "$GROQ_KEY" ]]; then
  say "GROQ_API_KEY already available — reusing it"
fi
if [[ -z "$GROQ_KEY" ]]; then
  if [[ ! -t 0 ]]; then
    fail "GROQ_API_KEY required and stdin is not interactive. Export GROQ_API_KEY=<key> \
(free at console.groq.com/keys) or run interactively."
  fi
  TYPED=""
  read -r -p "  paste your Groq API key: " TYPED || TYPED=""
  TYPED="${TYPED//[[:space:]]/}"
  if [[ -z "$TYPED" ]]; then
    fail "a Groq API key is required (LLMs power every interview round). \
Get a free one at https://console.groq.com/keys and re-run."
  fi
  if curl -sf -m 8 -o /dev/null https://api.groq.com/openai/v1/models \
       -H "Authorization: Bearer $TYPED"; then
    say "key verified against the Groq API"
  else
    warn "could not verify the key right now — continuing; if interviews fail, \
fix GROQ_API_KEY in $ENVF"
  fi
  GROQ_KEY="$TYPED"
fi

# ── 5. .env (fresh file only; secrets generated, never printed) ───────────────
hdr "environment file (.env)"
if [[ -f "$ENVF" ]]; then
  say "keeping existing $ENVF"
else
  cat > "$ENVF" <<ENV
GROQ_API_KEY=$GROQ_KEY
GROQ_MODEL=openai/gpt-oss-120b
POSTGRES_PASSWORD=$(rand_secret)
AUTH_SECRET=$(rand_secret)
STT_MODEL=base
TTS_INTERNAL_KEY=$(rand_secret)
MAX_RESUME_MB=15
ENV
  chmod 600 "$ENVF"
  say "wrote $ENVF with generated secrets (db password, auth secret, tts key)"
fi
if [[ -n "$GROQ_KEY" ]] && ! grep -q '^GROQ_API_KEY=.' "$ENVF" 2>/dev/null; then
  echo "GROQ_API_KEY=$GROQ_KEY" >> "$ENVF"
  say "appended GROQ_API_KEY to .env"
fi
if ! grep -q '^POSTGRES_PASSWORD=.' "$ENVF" 2>/dev/null; then
  echo "POSTGRES_PASSWORD=$(rand_secret)" >> "$ENVF"
  warn "generated POSTGRES_PASSWORD into .env"
fi
if ! grep -q '^AUTH_SECRET=.' "$ENVF" 2>/dev/null; then
  echo "AUTH_SECRET=$(rand_secret)" >> "$ENVF"
  warn "generated AUTH_SECRET into .env (login sessions reset)"
fi
if ! grep -q '^TTS_INTERNAL_KEY=.' "$ENVF" 2>/dev/null; then
  echo "TTS_INTERNAL_KEY=$(rand_secret)" >> "$ENVF"
  warn "generated TTS_INTERNAL_KEY into .env"
fi
chmod 600 "$ENVF" 2>/dev/null || true
grep -q '^GROQ_MODEL=' "$ENVF" || echo "GROQ_MODEL=openai/gpt-oss-120b" >> "$ENVF"

# ── 6. voice profile choice (once) ────────────────────────────────────────────
PROFILE_ARGS=()
if [[ $WANT_TTS != true && -t 0 && -z "${CI:-}" ]]; then
  read -r -p "  install the local interviewer TTS voice? (~2 GB build; browser voice works without) [y/N] " ANS
  [[ "${ANS:-n}" == [yY]* ]] && WANT_TTS=true
fi
[[ $WANT_TTS == true ]] && PROFILE_ARGS=(--profile voice)

# ── 7. build + launch ─────────────────────────────────────────────────────────
hdr "building images (cached after the first run)"
dcp "${PROFILE_ARGS[@]}" build

say "starting containers"
dcp "${PROFILE_ARGS[@]}" up -d
PROFILE_HINT=""
[[ $WANT_TTS == true ]] && PROFILE_HINT=" (voice profile on)"

say "waiting for health checks…"
if wait_http http://localhost:8000/api/health 90; then
  printf "  backend  :8000  ${grn}up${rst}\n"
else
  warn "backend did not answer — logs: ./scripts/compose.sh logs backend"
fi
if wait_http http://localhost:3000 120; then
  printf "  frontend :3000  ${grn}up${rst}\n"
else
  warn "frontend did not answer — logs: ./scripts/compose.sh logs frontend"
fi
if [[ $WANT_TTS == true ]]; then
  if [[ -n "$(dcp ps --status running -q tts 2>/dev/null || true)" ]]; then
    printf "  tts      internal  ${grn}up${rst} (first synthesis may load the ~110 MB voice model)\n"
  else
    warn "tts container not running yet — browser voice fallback applies; check: ./scripts/compose.sh logs tts"
  fi
fi

echo
printf "${grn}  open ${bld}http://localhost:3000${rst} in your browser and upload a resume (PDF)${rst}\n"
printf "  ${dim}status:  ./scripts/compose.sh status${rst}\n"
printf "  ${dim}logs:    ./scripts/compose.sh logs [backend|frontend|db${PROFILE_HINT:+|tts}]${rst}\n"
printf "  ${dim}stop:    ./scripts/compose.sh stop        (data volumes are always kept)${rst}\n"
