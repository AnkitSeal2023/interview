#!/usr/bin/env zsh
# Usage: scripts/frontend.sh start|stop|restart|status
# Runs the Next.js dev server (:3000). Log/pid in .runtime/ (repo-side) like the rest.
d=$(cd "$(dirname "$0")/.." && pwd)
rt="$d/.runtime"
mkdir -p "$rt"
log="$rt/frontend.log"
pidfile="$rt/frontend.pid"
case "$1" in
  start)
    cd "$d/frontend"
    nohup zsh -c 'cd "'"$d"'/frontend"; while true; do
      npm run dev >> "'"$rt"'/frontend.log" 2>&1
      echo "$(date +%H:%M:%S) supervisor: next dev exited rc=$? — restarting in 2s" >> "'"$rt"'/frontend.log"
      sleep 2
    done' > /dev/null 2>&1 < /dev/null &
    echo $! > "$pidfile"; disown
    sleep 4; curl -s -o /dev/null -m 5 -w "" http://localhost:3000 \
      && echo "(frontend up on :3000, log $log) [supervisor: $(cat "$pidfile")]" ;;
  stop)
    [[ -f "$pidfile" ]] && kill "$(cat $pidfile)" 2>/dev/null; rm -f "$pidfile"
    for i in 1 2 3 4 5; do
      p=$(ss -tlnp 2>/dev/null | grep -o ":3000 .*pid=[0-9]*" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)
      [[ -z "$p" ]] && break
      kill "$p" 2>/dev/null; sleep 1
    done
    echo stopped ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if curl -s -o /dev/null -m 3 http://localhost:3000; then echo running; else echo stopped; fi ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
