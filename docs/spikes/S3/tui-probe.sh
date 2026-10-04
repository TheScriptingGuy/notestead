#!/usr/bin/env bash
# Spike S3, experimental strategy B ("tui-pty"): run the CLI's interactive mode (hasGui() = true, so
# recurrent sync, decryption worker, search indexing run in-process) under a pseudo-terminal and start
# the Data API inside it with ":server start --exit-early". Runs INSIDE the s3-headless container.
# Usage (host): podman exec s3-headless bash /data/tui-probe.sh <master-password> <sync-url>
set -uo pipefail
MPW="$1"; SYNC_URL="$2"
P=/data/tui; PORT=41185; TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
mkdir -p $P && chmod 700 $P
printf '{"sync.target":9,"sync.9.path":"%s","sync.9.username":"user1@example.com","sync.9.password":"111111","encryption.masterPassword":"%s","api.token":"%s","api.port":%s,"sync.interval":300}' \
  "$SYNC_URL" "$MPW" "$TOKEN" "$PORT" | joplin --profile $P config --import
ms() { date +%s%3N; }
rm -f /tmp/tui.in; mkfifo /tmp/tui.in
t0=$(ms)
script -qfec "stty cols 140 rows 40; TERM=xterm-256color joplin --profile $P" /dev/null < /tmp/tui.in > /tmp/tui.out 2>&1 &
SPID=$!
exec 3>/tmp/tui.in
sleep 12   # spike only: let the TUI draw (no machine-readable readiness signal exists - that is a finding)
tui_cmd() { printf '\033' >&3; sleep 1; printf ':' >&3; sleep 1; printf '%s' "$1" >&3; sleep 0.5; printf '\r' >&3; }
tui_cmd 'server start --exit-early'
until curl -fs "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; do sleep 0.2; [ $(( $(ms)-t0 )) -gt 60000 ] && { echo "API did not come up"; break; }; done
echo "tui: API up after $(( $(ms)-t0 ))ms"
tui_cmd sync
# wait for the initial sync + decryption worker: poll until notes are decrypted
for i in $(seq 1 120); do
  n=$(curl -s "http://127.0.0.1:$PORT/search?token=$TOKEN&query=zebracorn&fields=id,title" | grep -c '"id"')
  [ "$n" -gt 0 ] && break; sleep 1
done
echo "tui: synced+decrypted+indexed seed note visible via search after $(( $(ms)-t0 ))ms (hits=$n)"
NID=$(curl -s -X POST "http://127.0.0.1:$PORT/notes?token=$TOKEN" -d '{"title":"TUI created zeta"}' | grep -o '"id":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
curl -s -o /dev/null -X PUT "http://127.0.0.1:$PORT/notes/$NID?token=$TOKEN" -d '{"body":"zetaword in tui"}'
t1=$(ms)
for i in $(seq 1 60); do
  n=$(curl -s "http://127.0.0.1:$PORT/search?token=$TOKEN&query=zetaword&fields=id" | grep -c '"id"')
  [ "$n" -gt 0 ] && break; sleep 1
done
echo "tui: REST-created note searchable after $(( $(ms)-t1 ))ms without restart (hits=$n)"
tui_cmd sync; sleep 8
echo "tui: API still up during/after in-process sync: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ping")"
ps -o rss,args -C node | grep -E 'joplin|node' | head -3
echo "--- last TUI screen bytes (sanitised) ---"; tail -c 600 /tmp/tui.out | tr -cd '[:print:]\n' | tail -5
tui_cmd exit; sleep 2; kill $SPID 2>/dev/null; exec 3>&-
