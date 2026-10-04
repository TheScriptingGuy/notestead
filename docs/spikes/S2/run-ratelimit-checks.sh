#!/usr/bin/env bash
# Spike S2 (part 2): Joplin Server login brute-force limiter behind the proxy.
# Server code: limiterLoginBruteForce = 10 req/min keyed by userIp(ctx), and
# userIp() trusts the X-Real-IP request header if present (requestUtils.ts:166).
# Requires run-proxy-checks.sh to have created network s2net and container s2-caddy.
set -uo pipefail
PUBLIC_HOST=joplin.example.test
SERVER_IMAGE="${SERVER_IMAGE:-docker.io/joplin/server:3.7.2}"
CADDY_IMAGE="${CADDY_IMAGE:-docker.io/library/caddy:2-alpine}"

echo "### restart server WITHOUT JOPLIN_IS_TESTING (limiter active)"
podman rm -f s2-jserver >/dev/null 2>&1
podman run -d --name s2-jserver --network s2net --network-alias jserver -p 127.0.0.1:22300:22300 \
  -e APP_PORT=22300 -e APP_BASE_URL=https://$PUBLIC_HOST "$SERVER_IMAGE" node dist/index.js --env dev --env-file /dev/null >/dev/null
for _ in $(seq 1 90); do curl -fs -H "Host: $PUBLIC_HOST" http://127.0.0.1:22300/api/ping >/dev/null 2>&1 && break; sleep 1; done
curl -s -H "Host: $PUBLIC_HOST" -X POST -H 'Content-Type: application/json' -d '{"action":"createTestUsers"}' http://127.0.0.1:22300/api/debug; echo

# Clients are short-lived containers on s2net (distinct source IPs); busybox wget from the caddy image.
echo "### R1 client A: 12 bad logins via main site (:8080) while spoofing a new X-Real-IP each time"
podman run --rm --network s2net --entrypoint sh "$CADDY_IMAGE" -c '
  for i in $(seq 1 12); do
    code=$(wget -S -q -O /dev/null --header "Content-Type: application/json" --header "X-Real-IP: 10.9.9.$i" \
      --post-data "{\"email\":\"user1@example.com\",\"password\":\"wrong\"}" \
      http://s2-caddy:8080/joplin-server/api/sessions 2>&1 | grep -o "HTTP/1.1 [0-9][0-9][0-9]" | tail -1 | cut -d" " -f2)
    printf "%s " "$code"
  done; echo'
echo "(expect 403 x10 then 429: the spoofed header is overwritten with the real client IP)"

echo "### R2 client B (different container IP) right after: 1 correct login via :8080"
podman run --rm --network s2net --entrypoint sh "$CADDY_IMAGE" -c '
  wget -S -q -O - --header "Content-Type: application/json" \
    --post-data "{\"email\":\"user1@example.com\",\"password\":\"111111\"}" \
    http://s2-caddy:8080/joplin-server/api/sessions 2>&1 | grep -o "HTTP/1.1 [0-9][0-9][0-9]" | tail -1 | cut -d" " -f2'
echo "(expect 200: limiter is keyed per real client IP, not per proxy IP)"

echo "### R3-neg proxy that forwards client X-Real-IP unchanged (:8082): spoofing bypasses the limiter"
podman run --rm --network s2net --entrypoint sh "$CADDY_IMAGE" -c '
  for i in $(seq 1 12); do
    code=$(wget -S -q -O /dev/null --header "Content-Type: application/json" --header "X-Real-IP: 10.8.8.$i" \
      --post-data "{\"email\":\"user1@example.com\",\"password\":\"wrong\"}" \
      http://s2-caddy:8082/joplin-server/api/sessions 2>&1 | grep -o "HTTP/1.1 [0-9][0-9][0-9]" | tail -1 | cut -d" " -f2)
    printf "%s " "$code"
  done; echo'
echo "(expect only 403s: shows why the main site must set X-Real-IP itself)"

echo "### R4-neg proxy without X-Real-IP at all: every client shares the proxy's IP"
echo "(by code inspection: userIp() falls back to ctx.ip = the proxy's address; app.proxy is not set)"

echo "### R4-neg (empirical) client C: 11 bad logins via :8082 WITHOUT X-Real-IP; then client D logs in correctly via :8082"
podman run --rm --network s2net --entrypoint sh "$CADDY_IMAGE" -c '
  for i in $(seq 1 11); do
    code=$(wget -S -q -O /dev/null --header "Content-Type: application/json" \
      --post-data "{\"email\":\"user1@example.com\",\"password\":\"wrong\"}" \
      http://s2-caddy:8082/joplin-server/api/sessions 2>&1 | grep -o "HTTP/1.1 [0-9][0-9][0-9]" | tail -1 | cut -d" " -f2)
    printf "%s " "$code"
  done; echo'
podman run --rm --network s2net --entrypoint sh "$CADDY_IMAGE" -c '
  wget -S -q -O - --header "Content-Type: application/json" \
    --post-data "{\"email\":\"user1@example.com\",\"password\":\"111111\"}" \
    http://s2-caddy:8082/joplin-server/api/sessions 2>&1 | grep -o "HTTP/1.1 [0-9][0-9][0-9]" | tail -1 | cut -d" " -f2'
echo "(expect client D = 429: without X-Real-IP every client is keyed on the proxy IP and locks out everyone)"
