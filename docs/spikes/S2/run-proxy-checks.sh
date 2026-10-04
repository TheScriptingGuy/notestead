#!/usr/bin/env bash
# NOTE: the image CMD (yarn start-prod) runs env=prod; env comes from `--env`, not APP_ENV.
# Spike S2: same-origin reverse proxy (Caddy) in front of a throwaway Joplin Server.
# HTTP-level checklist; the browser/E2EE part lives in docs/spikes/S4/.
#
# Usage: run-proxy-checks.sh [bundle-dir]
#   bundle-dir: static web bundle to serve at / (optional for these checks)
# Leaves containers running for the browser spike; clean up with: cleanup.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${S2_WORK:-$HOME/joplin-web-app-work/spikes/S2}"
BUNDLE="${1:-$WORK/www}"
SERVER_IMAGE="${SERVER_IMAGE:-docker.io/joplin/server:3.7.2}"
CADDY_IMAGE="${CADDY_IMAGE:-docker.io/library/caddy:2-alpine}"
NET=s2net
PUBLIC_HOST=joplin.example.test          # stands in for the user's APP_BASE_URL host
mkdir -p "$WORK" "$BUNDLE"

say() { printf '\n### %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; }

start_server() { # $1 = extra env (e.g. "-e JOPLIN_IS_TESTING=1")
  podman rm -f s2-jserver >/dev/null 2>&1
  # shellcheck disable=SC2086
  podman run -d --name s2-jserver --network $NET --network-alias jserver \
    -p 127.0.0.1:22300:22300 \
    -e APP_PORT=22300 -e APP_BASE_URL=https://$PUBLIC_HOST $1 \
    "$SERVER_IMAGE" node dist/index.js --env dev --env-file /dev/null >/dev/null
  for _ in $(seq 1 90); do
    curl -fs -H "Host: $PUBLIC_HOST" http://127.0.0.1:22300/api/ping >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server did not become ready"; podman logs --tail 50 s2-jserver; return 1
}

direct() { curl -s -H "Host: $PUBLIC_HOST" "$@"; }

podman network create $NET >/dev/null 2>&1 || true

say "Start joplin/server (env=dev, JOPLIN_IS_TESTING=1, APP_BASE_URL=https://$PUBLIC_HOST)"
start_server "-e JOPLIN_IS_TESTING=1" || exit 1
podman image inspect "$SERVER_IMAGE" --format 'server image {{.Id}} arch={{.Architecture}}'
direct -X POST -H 'Content-Type: application/json' -d '{"action":"createTestUsers"}' http://127.0.0.1:22300/api/debug; echo " <- createTestUsers"

say "Start Caddy (bundle=$BUNDLE)"
podman rm -f s2-caddy >/dev/null 2>&1
podman run -d --name s2-caddy --network $NET -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 -p 127.0.0.1:8082:8082 \
  -e JOPLIN_SERVER_DIAL=http://jserver:22300 -e JOPLIN_SERVER_HOST=$PUBLIC_HOST \
  -e JOPLIN_SERVER_PUBLIC_URL=https://$PUBLIC_HOST -e COEP="${COEP:-credentialless}" \
  -v "$HERE/Caddyfile:/etc/caddy/Caddyfile:ro,Z" -v "$BUNDLE:/srv/www:ro,Z" "$CADDY_IMAGE" >/dev/null
sleep 2
podman exec s2-caddy caddy version

P=http://127.0.0.1:8080/joplin-server

say "C1 ping through proxy (Host rewrite + prefix strip)"
out=$(curl -s $P/api/ping); echo "$out"
[[ "$out" == *'"status":"ok"'* ]] && pass C1 || fail C1

say "C1-neg proxy WITHOUT Host rewrite (expect 404 Invalid origin)"
code=$(curl -s -o $WORK/neg.txt -w '%{http_code}' http://127.0.0.1:8081/joplin-server/api/ping); echo "HTTP $code $(cat $WORK/neg.txt)"
[[ "$code" == 404 ]] && grep -q 'Invalid origin' $WORK/neg.txt && pass C1-neg || fail C1-neg

say "C2 login via proxy with a browser-like foreign Origin header (proxy strips Origin)"
SESSION=$(curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: https://notes.example.test' \
  -d '{"email":"user1@example.com","password":"111111"}' $P/api/sessions | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "session=${SESSION:0:6}..."; [[ -n "$SESSION" ]] && pass C2 || fail C2

say "C2b CORS response for the foreign origin when hitting the server directly (informational)"
direct -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://notes.example.test' -H 'Access-Control-Request-Method: PUT' http://127.0.0.1:22300/api/items/root:/x:/content | grep -i 'access-control-allow-origin'

say "C3 item round trip via proxy (PUT/GET content, delta)"
echo "hello s2 $(date +%s)" > $WORK/small.txt
curl -s -o /dev/null -w 'PUT %{http_code}\n' -X PUT -H "X-API-AUTH: $SESSION" -H 'Content-Type: application/octet-stream' --data-binary @$WORK/small.txt "$P/api/items/root:/s2test.txt:/content"
got=$(curl -s -H "X-API-AUTH: $SESSION" "$P/api/items/root:/s2test.txt:/content")
[[ "$got" == "$(cat $WORK/small.txt)" ]] && pass C3 || fail "C3 got=$got"
curl -s -H "X-API-AUTH: $SESSION" "$P/api/items/root:/:/delta" | head -c 200; echo

say "C4 server web UI is NOT re-published (expect 404 from Caddy)"
for p in /joplin-server/login /joplin-server/admin /joplin-server/ /joplin-server/users/me; do
  printf '%s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080$p)"
done

say "C5 large attachment (100 MiB) streamed through the proxy"
head -c $((100*1024*1024)) /dev/urandom > "$WORK/big.bin"
RID=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
t0=$(date +%s.%N)
curl -s -o /dev/null -w 'PUT %{http_code} %{size_upload} bytes %{time_total}s\n' -X PUT -H "X-API-AUTH: $SESSION" \
  -H 'Content-Type: application/octet-stream' --data-binary @"$WORK/big.bin" "$P/api/items/root:/.resource/$RID:/content"
curl -s -o "$WORK/big.back" -w 'GET %{http_code} %{size_download} bytes %{time_total}s\n' -H "X-API-AUTH: $SESSION" "$P/api/items/root:/.resource/$RID:/content"
a=$(sha256sum < "$WORK/big.bin"); b=$(sha256sum < "$WORK/big.back")
[[ "$a" == "$b" ]] && pass "C5 sha256 match" || fail "C5 sha256 mismatch"
podman stats --no-stream --format 'caddy mem {{.MemUsage}}' s2-caddy
rm -f "$WORK/big.back"

say "C6 published-note link: create a note item + share, then follow the proxy URL"
NID=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
cat > $WORK/note.md <<EOF
S2 published note

Hello from spike S2.

id: $NID
parent_id:
created_time: 2026-10-03T00:00:00.000Z
updated_time: 2026-10-03T00:00:00.000Z
is_conflict: 0
latitude: 0.00000000
longitude: 0.00000000
altitude: 0.0000
author:
source_url:
is_todo: 0
todo_due: 0
todo_completed: 0
source: joplin
source_application: net.cozic.joplin-desktop
application_data:
order: 0
user_created_time: 2026-10-03T00:00:00.000Z
user_updated_time: 2026-10-03T00:00:00.000Z
encryption_cipher_text:
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id:
conflict_original_id:
master_key_id:
user_data:
deleted_time: 0
type_: 1
EOF
truncate -s -1 $WORK/note.md   # the item parser rejects a trailing newline after type_
curl -s -o /dev/null -w 'PUT note %{http_code}\n' -X PUT -H "X-API-AUTH: $SESSION" -H 'Content-Type: application/octet-stream' --data-binary @$WORK/note.md "$P/api/items/root:/$NID.md:/content"
SHARE=$(curl -s -X POST -H "X-API-AUTH: $SESSION" -H 'Content-Type: application/json' -d "{\"note_id\":\"$NID\"}" "$P/api/shares")
echo "share: $SHARE"
SID=$(echo "$SHARE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "web-app link would be: http://127.0.0.1:8080/joplin-server/shares/$SID"
curl -s -o /dev/null -D - "http://127.0.0.1:8080/joplin-server/shares/$SID" | grep -iE '^(HTTP|location)'
printf 'direct server render: %s\n' "$(direct -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:22300/shares/$SID")"
direct -s "http://127.0.0.1:22300/shares/$SID" | grep -o 'Hello from spike S2' | head -1

say "C7 sync target info.json/version via proxy (baseline before any client sync)"
curl -s -H "X-API-AUTH: $SESSION" "$P/api/items/root:/info.json:/content" | head -c 300; echo
curl -s -H "X-API-AUTH: $SESSION" "$P/api/items/root:/.sync/version.txt:/content"; echo

say "C8 Caddy access log redaction (X-API-AUTH must not appear)"
if podman logs s2-caddy 2>&1 | grep -q "$SESSION"; then fail "C8 session id found in caddy log"; else pass "C8 session id not in caddy log"; fi
podman logs s2-caddy 2>&1 | grep -m1 '"uri":"/joplin-server/api/sessions"' | cut -c1-400

echo; echo "SESSION=$SESSION" > "$WORK/session.env"
echo "done (containers left running: s2-jserver, s2-caddy)"
