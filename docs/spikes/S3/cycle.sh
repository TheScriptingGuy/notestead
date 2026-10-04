#!/usr/bin/env bash
# Stand-in for the supervisor's stop-the-world SyncStrategy (spike only).
# Usage inside the container: cycle.sh <profile> <api-port>
#   1) stop `server start` (SIGTERM)  2) joplin sync  3) joplin e2ee decrypt --force  4) restart server, wait for /ping
set -uo pipefail
P="$1"; PORT="${2:-41184}"
ms() { date +%s%3N; }
t0=$(ms)
PID=$(cat "$P/clipper-pid.txt" 2>/dev/null || true)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  # wait until gone; a zombie (state Z) counts as stopped - PID 1 must reap it (run the container with --init)
  while kill -0 "$PID" 2>/dev/null && ! awk '{exit ($3=="Z")?0:1}' "/proc/$PID/stat" 2>/dev/null; do sleep 0.1; done
fi
t1=$(ms)
joplin --profile "$P" sync > "$P/../last-sync.log" 2>&1; rc_sync=$?
t2=$(ms)
joplin --profile "$P" e2ee decrypt --force > "$P/../last-decrypt.log" 2>&1; rc_dec=$?
t3=$(ms)
setsid nohup joplin --profile "$P" server start --quiet > "$P/../server.log" 2>&1 < /dev/null &
until curl -fs "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; do sleep 0.1; done
t4=$(ms)
echo "cycle: stop=$((t1-t0))ms sync=$((t2-t1))ms(rc=$rc_sync) decrypt=$((t3-t2))ms(rc=$rc_dec) start=$((t4-t3))ms OUTAGE=$((t4-t0))ms"
