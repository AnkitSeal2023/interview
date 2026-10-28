#!/usr/bin/env zsh
# Usage: scripts/status.sh — at a glance: which services are running, where their logs are.
#
# Runtime artifacts live in <repo>/.runtime/ :
#   backend.log backend.pid   FastAPI :8000 (scripts/backend.sh)
#   tts.log      tts.pid      Coqui TTS :8001 (scripts/tts.sh) — WAV cache: /tmp/opencode/tts_cache
#   frontend.log frontend.pid Next.js :3000 (scripts/frontend.sh)
# A *.log file exists even if the service is stopped (output of the last run).
LOGDIR=$(cd "$(dirname "$0")/../.runtime" && pwd)
mkdir -p "$LOGDIR"

hdr() { printf "  %-10s %-22s %-12s %s\n" "$1" "$2" "$3" "$4"; }
alive() { kill -0 "$1" 2>/dev/null; }

pidinfo() {  # $1=pidfile → "running (pid N)" | "STALE pidfile (pid N)" | "stopped (no pidfile)"
  if [[ -f "$1" ]]; then
    local p=$(cat "$1" 2>/dev/null)
    if [[ -n "$p" ]] && alive "$p"; then echo "running (pid $p)"; else echo "STALE pidfile (pid $p dead)"; fi
  else
    echo "stopped (no pidfile)"
  fi
}

health() { curl -s -m 3 "$1" 2>/dev/null; }

echo "== services (sockets + pids) =="
hdr SERVICE "PID/STATE" "PORT" "HEALTH"
u=$(pidinfo $LOGDIR/backend.pid)
h=$(health http://localhost:8000/api/health)
hdr backend "$u" ":8000" "${h:-no response}"

u=$(pidinfo $LOGDIR/tts.pid)
h=$(health http://localhost:8001/health)
mod=$(echo "$h" | grep -o '"model loaded": *[a-z]*' | grep -o '[a-z]*$')
hdr tts "$u" ":8001" "$( [[ -n "$h" ]] && echo "up ("$( [[ "$mod" == true ]] && echo "model loaded" || echo "model NOT loaded (preloading)")")" || echo "no response")"

u=$(pidinfo $LOGDIR/frontend.pid)
h=$(curl -s -o /dev/null -m 3 -w "%{http_code}" http://localhost:3000 2>/dev/null)
hdr frontend "$u" ":3000" "$( [[ "$h" == 200 ]] && echo "up (http 200)" || echo "no response")"

echo
echo "== recent log tails (full files: $LOGDIR/*.log) =="
for f in backend tts frontend; do
  log="$LOGDIR/$f.log"
  if [[ -f "$log" ]]; then
    n=$(grep -ac "Traceback\|ERROR" "$log" 2>/dev/null)
    echo "--- $f.log ($(du -h "$log" | cut -f1), last modified $(date -r "$log" '+%H:%M:%S'), ERROR/traceback lines: $n)"
    tail -n 3 "$log" | sed 's/^/    /'
  else
    echo "--- $f.log (no log yet — service never started)"
  fi
done
