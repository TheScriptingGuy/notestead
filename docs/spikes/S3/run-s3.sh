#!/usr/bin/env bash
# Spike S3: headless joplin CLI (pinned npm version) in a container on arm64, E2EE, stop-the-world sync.
# Prereqs: docs/spikes/S2/run-proxy-checks.sh has started s2-jserver (JOPLIN_IS_TESTING=1) + s2-caddy on s2net.
#
# Actors (all throwaway, user1@example.com on the throwaway server):
#   profile "device"   = stands in for the user's desktop/phone: enables E2EE, seeds notes, syncs.
#   profile "headless" = the system under test.
# Both run in the same s3-headless container (separate --profile dirs), which sits ONLY on an
# internal network (s3back) and reaches the server through Caddy's internal listener :8089.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${S3_WORK:-$HOME/joplin-web-app-work/spikes/S3}"
IMAGE=localhost/s3-headless:3.7.1
MPW='s3-master-password-Δ'          # throwaway E2EE master password
SYNC_URL=http://s2-caddy:8089/joplin-server
mkdir -p "$WORK"

say() { printf '\n### %s\n' "$*"; }
J() { podman exec s3-headless joplin --profile "/data/$1" "${@:2}"; }
ms() { date +%s%3N; }

say "Reset the throwaway server (clearDatabase + createTestUsers)"
for a in clearDatabase createTestUsers; do
  curl -s -o /dev/null -w "$a %{http_code}\n" -H 'Host: joplin.example.test' -X POST -H 'Content-Type: application/json' -d "{\"action\":\"$a\"}" http://127.0.0.1:22300/api/debug
done

say "Build image (npm install -g joplin@3.7.1) - timed"
t0=$(ms)
podman build -t $IMAGE -f "$HERE/Containerfile" "$HERE" 2>&1 | tee "$WORK/build.log" | grep -E 'joplin@|@joplin/|added|gyp|prebuild|ERR|warn' | head -30
echo "image build: $(( ($(ms)-t0)/1000 ))s"
podman image inspect $IMAGE --format 'image size={{.Size}} arch={{.Architecture}}'

say "Internal network (no egress) + start container"
podman network create --internal s3back >/dev/null 2>&1 || true
podman network connect s3back s2-caddy 2>/dev/null || true
podman rm -f s3-headless >/dev/null 2>&1
podman volume rm -f s3data >/dev/null 2>&1; podman volume create s3data >/dev/null
podman run -d --init --name s3-headless --network s3back --read-only --tmpfs /tmp:rw,mode=1777 -v s3data:/data:Z,U \
  --cap-drop=ALL --security-opt no-new-privileges "$IMAGE" >/dev/null
podman exec s3-headless sh -c 'mkdir -p /tmp/home /data/device /data/headless && chmod 700 /data/device /data/headless'
podman exec s3-headless joplin version
podman exec s3-headless sh -c 'npm ls -g --depth=2 2>/dev/null | grep -E "joplin@|@joplin/(lib|utils|renderer)@|sqlite3@|sharp@|keytar@" | sort -u'

say "Egress check from the internal network"
podman exec s3-headless sh -c 'curl -s -m 5 -o /dev/null -w "example.com -> %{http_code}\n" https://example.com || echo "example.com -> blocked (expected)"'
podman exec s3-headless sh -c "curl -s -m 5 $SYNC_URL/api/ping; echo"

say "Device profile: configure, enable E2EE, seed, sync"
printf '{"sync.target":9,"sync.9.path":"%s","sync.9.username":"user1@example.com","sync.9.password":"111111"}' "$SYNC_URL" \
  | podman exec -i s3-headless joplin --profile /data/device config --import
# NOTE: `joplin e2ee enable --password` as a standalone command exits 0 but does NOT persist the
# master key in CLI 3.7.1 command mode (verified 2026-10-04). Running it inside `batch` together
# with `sync` uploads the key + info.json from the same process, which works.
podman exec s3-headless sh -c "cat > /data/device-batch.txt <<EOF
e2ee enable --password $MPW
mkbook \"S3 Notebook\"
use \"S3 Notebook\"
mknote \"Seed note alpha\"
set \"Seed note alpha\" body \"The quick zebracorn jumps. seedword1\"
mktodo \"Seed todo beta\"
sync
EOF"
t=$(ms); J device batch /data/device-batch.txt | tail -2; echo "device batch (enable+seed+sync): $(( $(ms)-t ))ms"
J device e2ee status | head -5

say "Server-side check: items are encrypted at rest"
SESSION=$(podman exec s3-headless sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"email\":\"user1@example.com\",\"password\":\"111111\"}' $SYNC_URL/api/sessions" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
podman exec s3-headless sh -c "curl -s -H 'X-API-AUTH: $SESSION' '$SYNC_URL/api/items/root:/:/children?limit=50'" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("items on server:", len(d["items"]))'
for NAME in $(podman exec s3-headless sh -c "curl -s -H 'X-API-AUTH: $SESSION' '$SYNC_URL/api/items/root:/:/children?limit=50'" | python3 -c 'import json,sys; print(" ".join(i["name"] for i in json.load(sys.stdin)["items"] if i["name"].endswith(".md")))'); do
  podman exec s3-headless sh -c "curl -s -H 'X-API-AUTH: $SESSION' '$SYNC_URL/api/items/root:/$NAME:/content'" | grep -E '^(encryption_applied|type_):' | tr '\n' ' '; echo "<- $NAME"
done
podman exec s3-headless sh -c "curl -s -H 'X-API-AUTH: $SESSION' '$SYNC_URL/api/items/root:/info.json:/content'" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("info.json version=",d["version"],"e2ee=",d["e2ee"]["value"],"masterKeys=",len(d["masterKeys"]))'


say "Headless profile: secrets via config --import on STDIN (not argv), fixed api.port + generated token"
TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
printf '{"sync.target":9,"sync.9.path":"%s","sync.9.username":"user1@example.com","sync.9.password":"111111","encryption.masterPassword":"%s","api.token":"%s","api.port":41184}' \
  "$SYNC_URL" "$MPW" "$TOKEN" | podman exec -i s3-headless joplin --profile /data/headless config --import
echo "argv/environ leak check (needle passed on stdin; should print nothing):"
LEAKPROBE='read -r n; for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do tr "\\0" " " < "$f" 2>/dev/null | grep -qF -- "$n" && echo "LEAK in $f"; done; echo probe-done'
printf '%s\n' "$MPW" | podman exec -i s3-headless sh -c "$LEAKPROBE"
echo "positive control (planted marker in argv must be found):"
podman exec -d s3-headless sh -c 'sleep 30 # marker XYZZY'
printf '%s\n' "XYZZY" | podman exec -i s3-headless sh -c "$LEAKPROBE"
echo "settings.json keys: $(podman exec s3-headless sh -c 'python3 -c "import json;print(sorted(json.load(open(\"/data/headless/settings.json\")).keys()))"')"
echo "where is the master password stored?"; podman exec s3-headless sh -c "grep -c '$MPW' /data/headless/settings.json /data/headless/database.sqlite 2>/dev/null"

say "Cold start timings (CLI startup cost on the Pi)"
t=$(ms); podman exec s3-headless joplin --profile /data/headless version >/dev/null; echo "joplin version: $(( $(ms)-t ))ms"

say "Initial cycle: sync + decrypt + server start"
for i in 1; do podman exec s3-headless cycle.sh /data/headless 41184; done
API="http://127.0.0.1:41184"
podman exec s3-headless sh -c "curl -s '$API/notes?token=$TOKEN&fields=id,title,encryption_applied'"; echo
poll_search() { # $1 word -> prints ms until found (max 60s)
  local t=$(ms); for i in $(seq 1 120); do
    podman exec s3-headless sh -c "curl -s '$API/search?token=$TOKEN&query=$1&fields=id'" | grep -q '"id"' && { echo "search '$1' found after $(( $(ms)-t ))ms"; return; }; sleep 0.5; done; echo "search '$1' NOT found within 60s"; }
podman exec s3-headless sh -c "curl -s '$API/search?token=$TOKEN&query=zebracorn&fields=id,title'"; echo "  <- immediately after /ping"
poll_search zebracorn

say "Token in CLI request log? (ClipperServer.ts:215 logs request.url)"
podman exec s3-headless sh -c "grep -c 'token=$TOKEN' /data/headless/log-clipper.txt; grep -m1 'Request: GET' /data/headless/log-clipper.txt | sed -E 's/token=[0-9a-f]{8}[0-9a-f]+/token=<redacted-in-report>/'"

say "Write via REST while serving: metadata POST then PUT body (no media download path)"
NID=$(podman exec s3-headless sh -c "curl -s -X POST '$API/notes?token=$TOKEN' -d '{\"title\":\"Headless created gamma\"}'" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
podman exec s3-headless sh -c "curl -s -o /dev/null -w 'PUT body %{http_code}\n' -X PUT '$API/notes/$NID?token=$TOKEN' -d '{\"body\":\"gammaword unique-$NID\",\"todo_due\":$(( ($(date +%s)+86400)*1000 )),\"is_todo\":1}'"
echo "search before cycle (expected: not found, CLI does not index in command mode):"
sleep 15; podman exec s3-headless sh -c "curl -s '$API/search?token=$TOKEN&query=gammaword&fields=id,title'"; echo "  <- 15 s later, still before any cycle"

say "Device writes a new note, then measure 3 stop-the-world cycles"
podman exec s3-headless sh -c 'printf "%s\n" "mknote \"Device note delta\"" "set \"Device note delta\" body \"deltaword appears later\"" "sync" > /data/device-batch2.txt'
J device batch /data/device-batch2.txt | tail -1
SNAP_BEFORE=$(podman exec s3-headless sh -c 'cat /data/headless/settings.json')
for i in 1 2 3; do podman exec s3-headless cycle.sh /data/headless 41184; done
echo "search after cycles (expected: found once the 10 s scheduleSyncTables delay has passed):"
poll_search gammaword
poll_search deltaword

say "Settings not clobbered"
SNAP_AFTER=$(podman exec s3-headless sh -c 'cat /data/headless/settings.json')
python3 - "$SNAP_BEFORE" "$SNAP_AFTER" <<'EOF'
import json,sys
a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2])
changed={k:(a.get(k),b.get(k)) for k in set(a)|set(b) if a.get(k)!=b.get(k)}
print("settings.json changed keys:", sorted(changed) or "none")
EOF

say "Round trip: device sees the headless-created to-do (decrypted, with todo_due)"
J device sync | tail -1
J device ls -l | head -10
podman exec s3-headless sh -c "curl -s -H 'X-API-AUTH: $SESSION' '$SYNC_URL/api/items/root:/$NID.md:/content'" | grep -E '^(encryption_applied):'

say "Resource usage"
podman stats --no-stream --format 'headless mem {{.MemUsage}} cpu {{.CPUPerc}}' s3-headless
podman exec s3-headless sh -c 'ps -o rss,args -C node | head -5'
echo "TOKEN=$TOKEN" > "$WORK/token.env"; echo "SESSION=$SESSION" >> "$WORK/token.env"
