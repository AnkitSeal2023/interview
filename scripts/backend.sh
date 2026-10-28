#!/usr/bin/env zsh
# Usage: scripts/backend.sh start|stop|restart
# start runs a small SUPERVISOR loop (auto-restarts uvicorn if it dies) detached via
# nohup+disown. Logs/pids in .runtime/ (repo-side). Stop kills the supervisor AND the
# port owner (belt+braces), waiting until :8000 is actually free.
d=$(cd "$(dirname "$0")/.." && pwd)
rt="$d/.runtime"; mkdir -p "$rt"
pidfile="$rt/backend.pid"
port_owner() { ss -tlnp 2>/dev/null | grep -o ":8000 .*pid=[0-9]*" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2; }
case "$1" in
  start)
    cd "$d/backend"
    nohup zsh -c 'cd "'"$d"'/backend"; while true; do
      uv run uvicorn app.main:app --port 8000 >> "'"$rt"'/backend.log" 2>&1
      echo "$(date +%H:%M:%S) supervisor: uvicorn exited rc=$? — restarting in 2s" >> "'"$rt"'/backend.log"
      sleep 2
    done' > /dev/null 2>&1 < /dev/null &
    echo $! > "$pidfile"; disown
    sleep 3; curl -s http://localhost:8000/api/health && echo " (backend up) [supervisor: $(cat "$pidfile")]" ;;
  stop)
    [[ -f "$pidfile" ]] && kill "$(cat $pidfile)" 2>/dev/null; rm -f "$pidfile"
    for i in 1 2 3 4 5; do
      p=$(port_owner); [[ -z "$p" ]] && break
      kill "$p" 2>/dev/null; sleep 1
    done
    echo stopped ;;
  restart) "$0" stop; "$0" start ;;
  *) echo "usage: $0 start|stop|restart"; exit 1 ;;
esac
