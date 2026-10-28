#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SWE Mock Interview — one-shot setup + launcher  (Ubuntu/Debian & Arch)
#
#   ./scripts/quickstart.sh                 # installs deps, REQUIRES a Groq API
#                                           #   key, writes .env, sets up postgres,
#                                           #   migrates, launches everything
#   ./scripts/quickstart.sh -tts            # same, and install the local TTS voice
#   ./scripts/quickstart.sh stop            # stops backend / tts / frontend
#   ./scripts/quickstart.sh restart         # stop + up
#   ./scripts/quickstart.sh status          # service table
#
# Secrets policy: this script embeds NO credentials. Database and TTS-auth
# passwords are freshly generated when the script creates something, and are
# only ever written into .env (gitignored, chmod 600) — never printed, never
# committed. A Groq API key is required (free at console.groq.com/keys).
#
# Re-running is safe: every step is idempotent, running services are detected
# by port and left alone. Logs live in <repo>/.runtime/.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$ROOT/.runtime"; mkdir -p "$RT"
ENVF="$ROOT/.env"

MODE="up"; WANT_TTS=false
for a in "$@"; do
  case "$a" in
    -tts) WANT_TTS=true ;;
    up|stop|restart|status) MODE="$a" ;;
    *) echo "unknown arg: $a"
       echo "usage: quickstart.sh [-tts] [up|stop|restart|status]"; exit 1 ;;
  esac
done

grn="\033[32m"; ylw="\033[33m"; red="\033[31m"; dim="\033[2m"; bld="\033[1m"; rst="\033[0m"
say()    { printf "  ${grn}▸${rst} %s\n" "$*"; }
warn()   { printf "  ${ylw}▸${rst} %s\n" "$*"; }
fail()   { printf "${red}error:${rst} %s\n" "$*" >&2; exit 1; }
hdr()    { printf "\n${bld}== %s ==${rst}\n" "$*"; }

# run commands with privileges only when they are actually needed
SUDO=""
run_root() {
  if [[ $(id -u) -eq 0 ]]; then "$@"; else sudo "$@"; fi
}
run_as_pg() {  # run postgres commands as the postgres OS user
  if [[ $(id -u) -eq 0 ]]; then
    su -s /bin/sh postgres -c "$(printf '%q ' "$@")"
  else
    sudo -u postgres "$@"
  fi
}

tcp_open()   { ( : < /dev/tcp/127.0.0.1/"$1" ) 2>/dev/null; }
http_ok()    { curl -sf -m 3 "$1" >/dev/null 2>&1; }
wait_http()  { local i; for ((i = 0; i < "$2"; i++)); do http_ok "$1" && return 0; sleep 1; done; return 1; }
wait_tcp()   { local i; for ((i = 0; i < "$2"; i++)); do tcp_open "$1" && return 0; sleep 1; done; return 1; }
port_busy()  { [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]; }
port_owner() { ss -Htlnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
rand_secret(){ openssl rand -hex 24 2>/dev/null \
  || head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | cut -c1-48; }

# ── stop ──────────────────────────────────────────────────────────────────────
do_stop() {
  hdr "stopping services"
  for s in backend tts frontend; do
    local f="$RT/$s.pid"
    if [[ -f "$f" ]]; then
      kill "$(cat "$f" 2>/dev/null)" 2>/dev/null || true
      rm -f "$f"
    fi
  done
  for p in 8001 8000 3000; do
    local i unresolved="1"
    for ((i = 0; i < 6; i++)); do
      local pid; pid="$(port_owner "$p" || true)"
      if [[ -z "$pid" ]]; then unresolved="0"; break; fi
      kill "$pid" 2>/dev/null || true; sleep 1
    done
    if [[ "$unresolved" == 1 ]]; then echo "  :$p still busy — kill it manually"; else echo "  :$p free"; fi
  done
  echo "  stopped (logs kept in $RT)"
}

# ── status ────────────────────────────────────────────────────────────────────
do_status() {
  hdr "services"
  printf "  %-9s %-26s %-6s %s\n" SERVICE "PID/SUPERVISOR" PORT HEALTH
  local s pid health
  local -A urls=( [backend]=http://localhost:8000/api/health
                  [tts]=http://localhost:8001/health
                  [frontend]=http://localhost:3000 )
  local -A ports=( [backend]=8000 [tts]=8001 [frontend]=3000 )
  for s in backend tts frontend; do
    if [[ -f "$RT/$s.pid" ]] && kill -0 "$(cat "$RT/$s.pid" 2>/dev/null)" 2>/dev/null; then
      pid="running (pid $(cat "$RT/$s.pid"))"
    elif port_busy "${ports[$s]}"; then pid="up (not started here)"
    else pid="stopped"; fi
    if http_ok "${urls[$s]}"; then health="up"; else health="no response"; fi
    printf "  %-9s %-26s :%s %s\n" "$s" "$pid" "${ports[$s]}" "$health"
  done
  echo
  printf "%b  logs: %s/backend.log %s/tts.log %s/frontend.log%b\n" "$dim" "$RT" "$RT" "$RT" "$rst"
}

[[ "$MODE" == "stop" ]] && { do_stop; exit 0; }
[[ "$MODE" == "status" ]] && { do_status; exit 0; }
if [[ "$MODE" == "restart" ]]; then do_stop; fi

hdr "SWE Mock Interview — quickstart"
echo "  repo: ${ROOT/$HOME/~}"

# ── 1. distro detection ───────────────────────────────────────────────────────
. /etc/os-release 2>/dev/null || true
case "${ID_LIKE:-$ID}" in
  *debian*|*ubuntu*) PM=apt ;;
  *arch*)            PM=pacman ;;
  *) fail "unsupported distro '${ID:-?}' — add package commands for it in this script" ;;
esac

pkg() { if [[ $PM == apt ]]; then dpkg -l "$1" 2>/dev/null | grep -q '^ii'; else pacman -Q "$1" >/dev/null 2>&1; fi; }
install_missing_pkgs() {
  local missing=() p
  for p in "$@"; do pkg "$p" || missing+=("$p"); done
  if [[ ${#missing[@]} -eq 0 ]]; then return 0; fi
  printf "  ${dim}(installing: ${missing[*]})${rst}\n"
  if [[ $PM == apt ]]; then
    run_root apt-get update -qq
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  else
    run_root pacman -Sy --noconfirm --needed "${missing[@]}"
  fi
}

# ── 2. system dependencies (Node.js >= 20 + npm, curl) ───────────────────────
hdr "system dependencies"
if [[ $(id -u) -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    fail "you are not root and 'sudo' is not installed. Run this script as root \
(su - → bash scripts/quickstart.sh) or inside a Docker container (docker exec -u root)."
  fi
  if ! sudo -v 2>/dev/null; then
    fail "user '$(id -un)' cannot run sudo (not in the sudoers group, or no password set). \
Run as root instead:  su -c 'bash scripts/quickstart.sh'  — or in Docker: \
docker exec -u root -it <container> bash  →  ./scripts/quickstart.sh"
  fi
fi
install_missing_pkgs curl ca-certificates
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [[ $(node_major) -lt 20 ]]; then
  say "installing Node.js 20+ and npm"
  if [[ $PM == apt ]]; then
    if [[ $(id -u) -eq 0 ]]; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    else
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
    fi
    install_missing_pkgs nodejs
  else
    install_missing_pkgs nodejs npm
  fi
fi
say "node $(node -v), npm $(npm -v)"

# ── 3. postgres ───────────────────────────────────────────────────────────────
# No credentials are embedded here: when this script has to create the database
# it generates a random password and writes the connection URL into .env.
hdr "database (postgres :5432)"
DATABASE_URL=""
if [[ -f "$ENVF" ]]; then
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENVF" 2>/dev/null | cut -d= -f2- || true)"
fi
if tcp_open 5432; then
  say "a postgres is already listening on :5432 — leaving it alone"
  if [[ -z "$DATABASE_URL" ]]; then
    TYPED_URL=""
    read -r -p "  DATABASE_URL for that postgres (e.g. postgresql://postgres:YOUR_PW@localhost:5432/interview): " TYPED_URL
    DATABASE_URL="${TYPED_URL//[[:space:]]/}"
    [[ -n "$DATABASE_URL" ]] || fail "no DATABASE_URL provided — cannot continue"
    say "connection URL stored for .env (value not shown)"
  else
    say "DATABASE_URL already present in .env — reusing it"
  fi
else
  PG_PASS="$(rand_secret)"
  DATABASE_URL="postgresql://postgres:${PG_PASS}@localhost:5432/interview"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    say "no postgres found — starting one in docker (container: interview-pg, postgres:16)"
    if ! docker ps -a --format '{{.Names}}' | grep -qx 'interview-pg'; then
      docker run -d --name interview-pg \
        -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB=interview \
        -p 5432:5432 -v interview-pg-data:/var/lib/postgresql/data \
        postgres:16-alpine >/dev/null
    else
      warn "container interview-pg exists from an older run with its own (unknown) password"
      docker start interview-pg >/dev/null
      warn "if the DB check below fails: docker rm -f interview-pg && re-run, then confirm its URL in .env"
    fi
  else
    say "no docker — installing postgres natively (random password generated)"
    if [[ $PM == apt ]]; then
      install_missing_pkgs postgresql postgresql-contrib
    else
      install_missing_pkgs postgresql
      if [[ ! -s /var/lib/postgres/data/PG_VERSION ]]; then
        run_root mkdir -p /var/lib/postgres
        run_root chown -R postgres:postgres /var/lib/postgres
        run_as_pg initdb -D /var/lib/postgres/data \
          --auth-local=trust --auth-host=scram-sha-256 >/dev/null
      fi
    fi
    if [[ -d /run/systemd/system ]]; then
      run_root systemctl enable --now postgresql >/dev/null 2>&1 \
        || run_root service postgresql start >/dev/null 2>&1 \
        || true
    fi
    if ! tcp_open 5432; then
      run_root service postgresql start >/dev/null 2>&1 \
        || run_as_pg "pg_ctl -D /var/lib/postgres/data -l /var/lib/postgres/data/pg.log start" >/dev/null 2>&1 \
        || true
    fi
    wait_tcp 5432 30 || fail "postgres did not come up on :5432 — check the service"
    run_as_pg psql -tAc "ALTER USER postgres PASSWORD '$PG_PASS';" >/dev/null
    run_as_pg psql -tAc \
      "SELECT 1 FROM pg_database WHERE datname='interview'" | grep -q 1 \
      || run_as_pg createdb interview
  fi
  wait_tcp 5432 30 || fail "postgres did not come up on :5432 — check the container/service"
  say "postgres reachable on :5432 (credentials written to .env, not echoed)"
fi

# ── 4. uv ─────────────────────────────────────────────────────────────────────
hdr "uv (python toolchain)"
if ! command -v uv >/dev/null 2>&1; then
  say "installing uv (astral.sh installer)"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || fail "uv is still missing — add ~/.local/bin to PATH and re-run"
say "uv $(uv --version 2>/dev/null | cut -d' ' -f2)"

# ── 5. Groq API key (required) ────────────────────────────────────────────────
hdr "Groq API key (required — free key at console.groq.com/keys)"
GROQ_KEY="${GROQ_API_KEY:-}"
GROQ_KEY_FRESH=false
if [[ -z "$GROQ_KEY" && -f "$ENVF" ]]; then
  GROQ_KEY="$(grep -m1 '^GROQ_API_KEY=' "$ENVF" 2>/dev/null | cut -d= -f2- || true)"
  GROQ_KEY="${GROQ_KEY//\"/}"           # tolerate quoted values in the env file
  GROQ_KEY="${GROQ_KEY%%[[:space:]]*}"  # trim trailing spaces / inline comments
  GROQ_KEY="${GROQ_KEY//[[:space:]]/}"
fi
if [[ -n "$GROQ_KEY" ]]; then
  say "GROQ_API_KEY already available — reusing it"
fi
if [[ -z "$GROQ_KEY" ]]; then
  if [[ ! -t 0 ]]; then
    fail "GROQ_API_KEY is required and stdin is not interactive. \
Export GROQ_API_KEY=<key> (free at console.groq.com/keys) or run interactively."
  fi
  local_key=""
  read -r -p "  paste your Groq API key: " local_key || local_key=""
  local_key="${local_key//[[:space:]]/}"
  if [[ -z "$local_key" ]]; then
    fail "a Groq API key is required to run the interviewer LLMs. \
Get a free one at https://console.groq.com/keys and re-run."
  fi
  if curl -sf -m 8 -o /dev/null https://api.groq.com/openai/v1/models \
       -H "Authorization: Bearer $local_key"; then
    say "key verified against the Groq API"
  else
    warn "could not verify that key right now — continuing; if interviews fail, \
double-check GROQ_API_KEY in $ENVF"
  fi
  GROQ_KEY="$local_key"
  GROQ_KEY_FRESH=true
fi

# ── 6. .env (fresh file only; an existing one is never overwritten) ───────────
hdr "environment file (.env)"
if [[ -f "$ENVF" ]]; then
  say "keeping existing $ENVF"
  if [[ -n "$GROQ_KEY" ]] && ! grep -q '^GROQ_API_KEY=.' "$ENVF" 2>/dev/null; then
    echo "GROQ_API_KEY=$GROQ_KEY" >> "$ENVF"
    say "appended GROQ_API_KEY to .env"
  fi
  # an env file may be a minimal fragment — top up whatever the platform needs
  # so a partial .env can never half-break the setup
  ENVF_MISSING=0
  for kv in \
    "LLM_CONDUCTOR_PROVIDER=groq" \
    "LLM_EVALUATOR_PROVIDER=groq" \
    "LLM_EXTRACTOR_PROVIDER=groq" \
    "LLM_GENERATOR_PROVIDER=groq" \
    "LLM_REPORT_PROVIDER=groq" \
    "GROQ_MODEL=openai/gpt-oss-120b" \
    "COST_PER_MTOK_INPUT_USD=0.0" \
    "COST_PER_MTOK_OUTPUT_USD=0.0" \
    "SALARY_CAP_INR=200000" \
    "STT_MODEL=base" \
    "TTS_SERVICE_URL=http://localhost:8001" \
    "TTS_INTERNAL_KEY=$(rand_secret)" \
    "MAX_RESUME_MB=15" \
    "FRONTEND_ORIGIN=http://localhost:3000"
  do
    KVKEY="${kv%%=*}"
    grep -q "^${KVKEY}=" "$ENVF" 2>/dev/null && continue
    if [[ $KVKEY == DATABASE_URL ]]; then
      [[ -n "$DATABASE_URL" ]] || continue
      echo "DATABASE_URL=$DATABASE_URL" >> "$ENVF"
    else
      echo "$kv" >> "$ENVF"
    fi
    warn "added missing $KVKEY to .env"
    ENVF_MISSING=1
  done
  if [[ -n "$DATABASE_URL" ]] && ! grep -q '^DATABASE_URL=.' "$ENVF" 2>/dev/null; then
    if [[ -n "$DATABASE_URL" ]]; then
      echo "DATABASE_URL=$DATABASE_URL" >> "$ENVF"
      warn "added DATABASE_URL to .env (points at the database this script prepared)"
      ENVF_MISSING=1
    fi
  fi
  if ! grep -q '^AUTH_SECRET=.' "$ENVF" 2>/dev/null; then
    echo "AUTH_SECRET=$(rand_secret)" >> "$ENVF"
    warn "generated a fresh AUTH_SECRET (existing login sessions reset)"
    ENVF_MISSING=1
  fi
  # if this script just created the DB with a fresh password but .env still
  # points at the same socket with a stale URL, rewrite it to match
  if [[ -n "${PG_PASS:-}" && -n "$DATABASE_URL" ]] \
     && grep -q '^DATABASE_URL=.*localhost:5432/interview' "$ENVF" 2>/dev/null \
     && ! grep -q "^DATABASE_URL=.*:${PG_PASS}@" "$ENVF" 2>/dev/null; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" "$ENVF"
    warn "updated DATABASE_URL in .env to match the newly created database"
    ENVF_MISSING=1
  fi
  [[ $ENVF_MISSING == 1 ]] && say "topped up $ENVF with the missing defaults"
  chmod 600 "$ENVF" 2>/dev/null || true
else
  NTSECRET="$(rand_secret)"
  NTTKEY="$(rand_secret)"
  cat > "$ENVF" <<ENV
DATABASE_URL=$DATABASE_URL
LLM_CONDUCTOR_PROVIDER=groq
LLM_EVALUATOR_PROVIDER=groq
LLM_EXTRACTOR_PROVIDER=groq
LLM_GENERATOR_PROVIDER=groq
LLM_REPORT_PROVIDER=groq
GROQ_API_KEY=$GROQ_KEY
GROQ_MODEL=openai/gpt-oss-120b
COST_PER_MTOK_INPUT_USD=0.0
COST_PER_MTOK_OUTPUT_USD=0.0
SALARY_CAP_INR=200000
AUTH_SECRET=$NTSECRET
STT_MODEL=base
TTS_SERVICE_URL=http://localhost:8001
TTS_INTERNAL_KEY=$NTTKEY
MAX_RESUME_MB=15
FRONTEND_ORIGIN=http://localhost:3000
ENV
  chmod 600 "$ENVF"
  say "wrote $ENVF (all LLM providers → groq; secrets stay in this file only)"
fi

# ── 7. backend (venv, migrations, DB sanity, STT model prewarm) ──────────────
hdr "backend (fastapi :8000)"
[[ -f "$ROOT/backend/pyproject.toml" ]] || fail "backend/ not found where expected"
say "python venv — uv sync"
if ( cd "$ROOT/backend" && uv sync --frozen --quiet ); then
  say "python deps installed"
else
  warn "uv sync failed — checking Python 3.10+ availability (see log above)"
fi
say "applying migrations"
if ( cd "$ROOT/backend" && uv run python scripts/apply_migrations.py ); then
  say "migrations OK"
else
  warn "migrations failed — check DATABASE_URL creds in .env"
fi
say "database connection sanity check"
if ( cd "$ROOT/backend" && uv run python -c "
from app.config import settings
import psycopg
psycopg.connect(settings.database_url, connect_timeout=5).close()
print('  db connection OK')" ); then
  : # health confirmed
else
  warn "DB check failed — verify DATABASE_URL in .env"
fi
STT_MODEL="$(grep -m1 '^STT_MODEL=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
STT_MODEL="${STT_MODEL:-base}"
if [ -d "$ROOT/backend/whisper_models/hub" ] &&
   ls "$ROOT/backend/whisper_models/hub" 2>/dev/null | grep -q "faster-whisper-"; then
  say "STT model cached (backend/whisper_models)"
else
  say "pre-downloading faster-whisper '$STT_MODEL' STT model (one-off, ~150 MB)"
  if ( cd "$ROOT/backend" && uv run python -c "
from app.config import settings
from faster_whisper import WhisperModel
WhisperModel(settings.stt_model, device='cpu', compute_type='int8')" ); then
    say "STT model ready"
  else
    warn "STT model download failed (it will retry on first mic use)"
  fi
fi

# ── 8. frontend deps ─────────────────────────────────────────────────────────
hdr "frontend (next.js :3000)"
[[ -f "$ROOT/frontend/package.json" ]] || fail "frontend/ not found where expected"
if [[ -n "$(ls -A "$ROOT/frontend/node_modules" 2>/dev/null)" ]]; then
  say "node_modules already present"
else
  say "npm install (first run — a few minutes)"
  ( cd "$ROOT/frontend" && npm install --no-audit --no-fund --quiet ) \
    || warn "npm install failed — run it manually in frontend/"
fi

# ── 9. interviewer voice (optional local TTS) ────────────────────────────────
if [[ -x "$ROOT/backend/.venv-tts/bin/python" ]]; then
  say "TTS venv already present (backend/.venv-tts)"
else
  TTS_ANS="n"
  if [[ $WANT_TTS == true ]]; then TTS_ANS="y"; fi
  if [[ $TTS_ANS == n && -z "${CI:-}" && $MODE == up && -t 0 ]]; then
    read -r -p "  install local interviewer TTS voice? (~2 GB torch download; browser voice works without) [y/N] " TTS_ANS
    TTS_ANS="${TTS_ANS:-n}"
  fi
  if [[ "$TTS_ANS" == [yY]* ]]; then
    say "building TTS venv (backend/.venv-tts, CPU torch)"
    install_missing_pkgs ffmpeg
    if ( cd "$ROOT/backend" &&
      uv venv .venv-tts &&
      uv pip install --python .venv-tts/bin/python \
        torch torchaudio --index-url https://download.pytorch.org/whl/cpu --quiet &&
      uv pip install --python .venv-tts/bin/python "coqui-tts[codec]" --quiet ); then
      say "TTS venv ready (the voice model downloads on first service start)"
    else
      warn "TTS build failed — continuing with the browser voice instead"
    fi
  fi
fi

# ── 10. launch (restart-loop supervisors; ports left alone if already busy) ──
SUP_BACKEND="while true; do uv run uvicorn app.main:app --port 8000; echo \"\$(date '+%H:%M:%S') supervisor: backend exited rc=\$? — restarting in 2s\" >> $RT/backend.log; sleep 2; done"
SUP_TTS="while true; do env $(grep -E '^TTS_(INTERNAL_KEY|PORT)=' "$ROOT/.env" 2>/dev/null | tr -d '"') ./.venv-tts/bin/python -m tts_service.main; echo \"\$(date '+%H:%M:%S') supervisor: tts exited rc=\$? — restarting\" >> $RT/tts.log; sleep 2; done"
SUP_FRONTEND="while true; do npm run dev; echo \"\$(date '+%H:%M:%S') supervisor: frontend exited rc=\$? — restarting in 2s\" >> $RT/frontend.log; sleep 2; done"

start_supervised() {  # start_supervised NAME DIR PORT CMD
  local name="$1" dir="$2" port="$3" cmd="$4"
  if port_busy "$port"; then
    warn "$name already listening on :$port — not touched"
    return 0
  fi
  : > "$RT/$name.log"
  (
    cd "$dir"
    nohup bash -c "$cmd" >> "$RT/$name.log" 2>&1 < /dev/null &
    echo $! > "$RT/$name.pid"; disown 2>/dev/null || true
  )
  say "$name starting (log: $RT/$name.log)"
}

hdr "launching"
start_supervised backend "$ROOT/backend" 8000 "$SUP_BACKEND"
if [[ -x "$ROOT/backend/.venv-tts/bin/python" ]]; then
  start_supervised tts "$ROOT/backend" 8001 "$SUP_TTS"
fi
start_supervised frontend "$ROOT/frontend" 3000 "$SUP_FRONTEND"

say "waiting for health checks…"
if wait_http http://localhost:8000/api/health 45; then
  printf "  backend  :8000  ${grn}up${rst}\n"
else
  warn "backend did not answer — tail $RT/backend.log"
fi
if [[ -x "$ROOT/backend/.venv-tts/bin/python" ]]; then
  if wait_http http://localhost:8001/health 60; then
    printf "  tts      :8001  ${grn}up${rst} (real interviewer voice)\n"
  else
    warn "tts :8001 did not answer — browser voice will be used; tail $RT/tts.log"
  fi
fi
if wait_http http://localhost:3000 75; then
  printf "  frontend :3000  ${grn}up${rst}\n"
else
  warn "frontend did not answer — tail $RT/frontend.log"
fi

echo
printf "${grn}  open ${bld}http://localhost:3000${rst} in your browser and upload a resume (PDF)${rst}\n"
printf "  ${dim}stop:    ./scripts/quickstart.sh stop${rst}\n"
printf "  ${dim}status:  ./scripts/quickstart.sh status${rst}\n"
