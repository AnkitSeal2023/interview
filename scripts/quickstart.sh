#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SWE Mock Interview — one-shot setup + launcher  (Ubuntu/Debian & Arch)
#
#   ./scripts/quickstart.sh                 # interactive: installs deps, asks for
#                                           #   the Groq key, writes .env, builds,
#                                           #   migrates, launches everything
#   ./scripts/quickstart.sh -tts            # same, and install the local TTS voice
#   ./scripts/quickstart.sh stop            # stops backend / tts / frontend
#   ./scripts/quickstart.sh restart         # stop + up
#   ./scripts/quickstart.sh status          # service table
#
# Re-running is safe: every step is idempotent, running services are detected
# by port and left alone. Logs live in <repo>/.runtime/ like the other scripts.
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

tcp_open()   { ( : < /dev/tcp/127.0.0.1/"$1" ) 2>/dev/null; }
http_ok()    { curl -sf -m 3 "$1" >/dev/null 2>&1; }
wait_http()  { local i; for ((i = 0; i < "$2"; i++)); do http_ok "$1" && return 0; sleep 1; done; return 1; }
wait_tcp()   { local i; for ((i = 0; i < "$2"; i++)); do tcp_open "$1" && return 0; sleep 1; done; return 1; }
port_busy()  { [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]; }
port_owner() { ss -Htlnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

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
  echo "  ${dim}(installing: ${missing[*]})${rst}"
  if [[ $PM == apt ]]; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  else
    sudo pacman -Sy --noconfirm --needed "${missing[@]}"
  fi
}

# ── 2. system dependencies (Node.js >= 20 + npm, curl) ───────────────────────
hdr "system dependencies"
install_missing_pkgs curl ca-certificates
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [[ $(node_major) -lt 20 ]]; then
  say "installing Node.js 20+ and npm"
  if [[ $PM == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
    install_missing_pkgs nodejs
  else
    install_missing_pkgs nodejs npm
  fi
fi
say "node $(node -v), npm $(npm -v)"

# ── 3. postgres ───────────────────────────────────────────────────────────────
hdr "database (postgres :5432)"
if tcp_open 5432; then
  say "a postgres is already listening on :5432 — leaving it alone"
  warn "its credentials must match DATABASE_URL in $ENVF (default: postgres:2004)"
else
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    say "no postgres found — starting one in docker (container: interview-pg, postgres:16)"
    if ! docker ps -a --format '{{.Names}}' | grep -qx 'interview-pg'; then
      docker run -d --name interview-pg \
        -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=2004 -e POSTGRES_DB=interview \
        -p 5432:5432 -v interview-pg-data:/var/lib/postgresql/data \
        postgres:16-alpine >/dev/null
    else
      docker start interview-pg >/dev/null
    fi
  else
    say "no docker — installing postgres natively (superuser password → '2004')"
    if [[ $PM == apt ]]; then
      install_missing_pkgs postgresql postgresql-contrib
      sudo systemctl enable --now postgresql >/dev/null 2>&1 || sudo systemctl start postgresql
    else
      install_missing_pkgs postgresql
      if [[ ! -s /var/lib/postgres/data/PG_VERSION ]]; then
        sudo mkdir -p /var/lib/postgres
        sudo chown -R postgres:postgres /var/lib/postgres
        sudo -u postgres initdb -D /var/lib/postgres/data \
          --auth-local=trust --auth-host=scram-sha-256 >/dev/null
      fi
      sudo systemctl enable --now postgresql >/dev/null 2>&1 || sudo systemctl start postgresql
    fi
    sudo -u postgres psql -tAc "ALTER USER postgres PASSWORD '2004';" >/dev/null
    sudo -u postgres psql -tAc \
      "SELECT 1 FROM pg_database WHERE datname='interview'" | grep -q 1 \
      || sudo -u postgres createdb interview
  fi
  wait_tcp 5432 30 || fail "postgres did not come up on :5432 — check the container/service"
  say "postgres reachable on :5432"
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

# ── 5. Groq API key ───────────────────────────────────────────────────────────
hdr "Groq API key (free tier — get one at console.groq.com)"
GROQ_KEY="${GROQ_API_KEY:-}"
if [[ -z "$GROQ_KEY" && -f "$ENVF" ]]; then
  GROQ_KEY="$(grep -m1 '^GROQ_API_KEY=' "$ENVF" 2>/dev/null | cut -d= -f2- || true)"
  GROQ_KEY="${GROQ_KEY//\"/}"           # tolerate quoted values in the env file
  GROQ_KEY="${GROQ_KEY%%[[:space:]]*}"  # trim trailing spaces / inline comments
  GROQ_KEY="${GROQ_KEY//[[:space:]]/}"
fi
if [[ -n "$GROQ_KEY" ]]; then
  say "GROQ_API_KEY already configured — reusing it"
else
  TYPED_KEY=""
  read -r -p "  paste your Groq API key (Enter = skip for now): " TYPED_KEY || TYPED_KEY=""
  if [[ -n "$TYPED_KEY" ]]; then
    if curl -sf -m 8 -o /dev/null https://api.groq.com/openai/v1/models \
         -H "Authorization: Bearer $TYPED_KEY"; then
      say "key verified against the Groq API"
      GROQ_KEY="$TYPED_KEY"
    else
      warn "Groq rejected that key — continuing; fix GROQ_API_KEY in $ENVF before starting"
    fi
  fi
  if [[ -z "$GROQ_KEY" ]]; then
    warn "no Groq key yet — the platform will run with local Ollama models instead"
    warn "add GROQ_API_KEY=… to $ENVF later and re-run this script"
  fi
fi

# ── 6. .env (fresh file only; an existing one is never overwritten) ───────────
hdr "environment file (.env)"
if [[ -f "$ENVF" ]]; then
  say "keeping existing $ENVF"
  if [[ -n "$GROQ_KEY" ]] && ! grep -q '^GROQ_API_KEY=.' "$ENVF" 2>/dev/null; then
    echo "GROQ_API_KEY=$GROQ_KEY" >> "$ENVF"
    say "appended GROQ_API_KEY to .env"
  fi
  # an env file may be a minimal fragment — top up the platform requirements so
  # a partial .env can never half-break the setup
  ENVF_MISSING=0
  for kv in \
    "DATABASE_URL=postgresql://postgres:2004@localhost:5432/interview" \
    "GROQ_MODEL=openai/gpt-oss-120b" \
    "OLLAMA_BASE_URL=http://localhost:11434" \
    "OLLAMA_MODEL=qwen2.5:7b-instruct-q4_K_M" \
    "COST_PER_MTOK_INPUT_USD=0.0" \
    "COST_PER_MTOK_OUTPUT_USD=0.0" \
    "SALARY_CAP_INR=200000" \
    "STT_MODEL=base" \
    "TTS_SERVICE_URL=http://localhost:8001" \
    "TTS_INTERNAL_KEY=dev-insecure-tts-key" \
    "MAX_RESUME_MB=15" \
    "FRONTEND_ORIGIN=http://localhost:3000"
  do
    KVKEY="${kv%%=*}"
    grep -q "^${KVKEY}=" "$ENVF" 2>/dev/null && continue
    echo "$kv" >> "$ENVF"
    warn "added missing $KVKEY to .env"
    ENVF_MISSING=1
  done
  if ! grep -q '^AUTH_SECRET=.' "$ENVF" 2>/dev/null; then
    NSECRET="$(openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(32))')"
    echo "AUTH_SECRET=$NSECRET" >> "$ENVF"
    warn "generated a fresh AUTH_SECRET (existing login sessions reset)"
    ENVF_MISSING=1
  fi
  [[ $ENVF_MISSING == 1 ]] && say "topped up $ENVF with the missing defaults"
else
  NPROV="groq"
  if [[ -z "$GROQ_KEY" ]]; then NPROV="ollama"; fi
  NSECRET="$(openssl rand -hex 32 2>/dev/null \
    || python3 -c 'import secrets; print(secrets.token_hex(32))')"
  cat > "$ENVF" <<ENV
DATABASE_URL=postgresql://postgres:2004@localhost:5432/interview
LLM_CONDUCTOR_PROVIDER=$NPROV
LLM_EVALUATOR_PROVIDER=$NPROV
LLM_EXTRACTOR_PROVIDER=$NPROV
LLM_GENERATOR_PROVIDER=$NPROV
LLM_REPORT_PROVIDER=$NPROV
GROQ_API_KEY=$GROQ_KEY
GROQ_MODEL=openai/gpt-oss-120b
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b-instruct-q4_K_M
COST_PER_MTOK_INPUT_USD=0.0
COST_PER_MTOK_OUTPUT_USD=0.0
SALARY_CAP_INR=200000
AUTH_SECRET=$NSECRET
STT_MODEL=base
TTS_SERVICE_URL=http://localhost:8001
TTS_INTERNAL_KEY=dev-insecure-tts-key
MAX_RESUME_MB=15
FRONTEND_ORIGIN=http://localhost:3000
ENV
  chmod 600 "$ENVF"
  say "wrote $ENVF (LLM provider: $NPROV)"
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
    if ( cd "$ROOT/backend" &&
      uv venv .venv-tts &&
      uv pip install --python .venv-tts/bin/python \
        torch --index-url https://download.pytorch.org/whl/cpu --quiet &&
      uv pip install --python .venv-tts/bin/python coqui-tts --quiet ); then
      say "TTS venv ready (the voice model downloads on first service start)"
    else
      warn "TTS build failed — continuing with the browser voice instead"
    fi
  fi
fi

# ── 10. launch (bash supervisors, same pattern as scripts/*.sh) ──────────────
SUP_BACKEND="while true; do uv run uvicorn app.main:app --port 8000; echo \"\$(date '+%H:%M:%S') supervisor: backend exited rc=\$? — restarting in 2s\" >> $RT/backend.log; sleep 2; done"
SUP_TTS="while true; do ./.venv-tts/bin/python -m tts_service.main; echo \"\$(date '+%H:%M:%S') supervisor: tts exited rc=\$? — restarting\" >> $RT/tts.log; sleep 2; done"
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
