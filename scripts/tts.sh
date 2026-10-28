#!/usr/bin/env zsh
# Usage: scripts/tts.sh start|stop|restart
# Coqui TTS service (backend/.venv-tts) on :8001, supervised like backend.sh.
d=$(cd "$(dirname "$0")/.." && pwd)
rt="$d/.runtime"; mkdir -p "$rt"
pidfile="$rt/tts.pid"
port_owner() { ss -tlnp 2>/dev/null | grep -o ":8001 .*pid=[0-9]*" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2; }
case "$1" in
  start)
    cd "$d/backend"
    nohup zsh -c 'cd "'"$d"'/backend"; while true; do
      ./.venv-tts/bin/python -m tts_service.main >> "'"$rt"'/tts.log" 2>&1
      echo "$(date +%H:%M:%S) supervisor: tts_service exited rc=$? — restarting (model reloads ~5s)" >> "'"$rt"'/tts.log"
      sleep 2
    done' > /dev/null 2>&1 < /dev/null &
    echo $! > "$pidfile"; disown
    sleep 3; curl -s http://localhost:8001/health && echo " (tts up) [supervisor: $(cat "$pidfile")]" ;;
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
