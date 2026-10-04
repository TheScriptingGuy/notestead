#!/usr/bin/env bash
# S6: Cloudflare Tunnel in front of the web container (throwaway Caddy, quick tunnel, no account).
# Usage: bash docs/spikes/S6/run-cloudflare-checks.sh   (cleans up on exit)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=s6-edge
trap 'podman rm -f s6-web s6-cfd s6-other >/dev/null 2>&1; podman network rm -f $NET >/dev/null 2>&1' EXIT

podman network create --subnet 10.89.66.0/24 $NET >/dev/null
podman run -d --name s6-web --network $NET --ip 10.89.66.20 -p 127.0.0.1:18080:8080 \
  -v "$HERE/Caddyfile:/etc/caddy/Caddyfile:ro,Z" docker.io/library/caddy:2-alpine >/dev/null
podman run -d --name s6-cfd --network $NET --ip 10.89.66.10 docker.io/cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --url http://10.89.66.20:8080 >/dev/null

URL=""
for _ in $(seq 1 30); do
  URL=$(podman logs s6-cfd 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
  [ -n "$URL" ] && break; sleep 2
done
echo "tunnel: ${URL:-none}"; [ -z "$URL" ] && exit 1
for _ in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' "$URL/echo" | grep -q 200 && break; sleep 2; done

echo "== T1 response headers through the tunnel (/)"
curl -sI "$URL/html-plain" | grep -i -E '^(HTTP|cross-origin|cache-control|cf-cache-status|server|content-type)'
echo "== T2a client IP via tunnel, no extra headers"
curl -s "$URL/echo"; echo
echo "== T2b client spoofs X-Real-IP and X-Forwarded-For"
curl -s -H 'X-Real-IP: 5.6.7.8' -H 'X-Forwarded-For: 9.9.9.9' "$URL/echo"; echo
echo "== T2c client sends its own CF-Connecting-IP"
curl -s -w ' (status=%{http_code})' -H 'CF-Connecting-IP: 1.2.3.4' "$URL/echo"; echo
echo "== T3 NEG: direct request via published port with spoofed CF-Connecting-IP"
curl -s -H 'CF-Connecting-IP: 1.2.3.4' http://127.0.0.1:18080/echo; echo
echo "== T4 NEG: other container on the edge network (not cloudflared) spoofs CF-Connecting-IP"
podman run --rm --name s6-other --network $NET docker.io/library/caddy:2-alpine \
  wget -qO- --header 'CF-Connecting-IP: 1.2.3.4' http://10.89.66.20:8080/echo; echo
echo "== T5 HTML transforms (email obfuscation) with and without no-transform"
curl -s "$URL/html-plain"; echo; curl -s "$URL/html-notransform"; echo
echo "== T6 JS caching at the edge (no Cache-Control from origin): two fetches"
for i in 1 2; do curl -sI "$URL/app.bundle.js" | grep -i -E '^cf-cache-status' || echo "(no cf-cache-status)"; done
[ "${S6_UPLOADS:-1}" = 1 ] || exit 0
echo "== T7 upload 50 MiB (under limit)"
head -c 52428800 /dev/urandom > /tmp/s6-50m.bin
curl -s -o /dev/null -w 'status=%{http_code} time=%{time_total}s up=%{size_upload}\n' -X PUT --data-binary @/tmp/s6-50m.bin "$URL/upload"
echo "== T8 upload 101 MiB (over 100 MB Free limit)"
head -c 105906176 /dev/zero > /tmp/s6-101m.bin
curl -s -o /tmp/s6-413.txt -w 'status=%{http_code} time=%{time_total}s up=%{size_upload}\n' --max-time 120 -X PUT --data-binary @/tmp/s6-101m.bin "$URL/upload"
head -c 200 /tmp/s6-413.txt; echo
rm -f /tmp/s6-50m.bin /tmp/s6-101m.bin /tmp/s6-413.txt
