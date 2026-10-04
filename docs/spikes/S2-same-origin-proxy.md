# Spike S2: same-origin reverse proxy to an unmodified Joplin Server

## Question
Can the web app on our own origin reach an **unmodified** Joplin Server through a same-origin reverse proxy, given the server's hard-coded CORS list and its Host-based origin check? Specifically:
- Host rewrite vs `isValidOrigin`
- prefix strip
- the Origin header
- the login rate limiter behind the proxy
- large attachments
- share/publish links
- the E2EE round trip in a browser
- the sync-target version staying unchanged

## Timebox
2 h (HTTP part 1 h; the browser part runs with S4). Used: ~1 h 15 min.

## Setup
- **Throwaway server:** `docker.io/joplin/server:3.7.2` (arm64, image id `1356845399266606…`), Caddy `docker.io/library/caddy:2-alpine` (v2.11.6), podman 5.4.2 on the Pi.
  - It sits on a podman network `s2net`.
  - `APP_BASE_URL=https://joplin.example.test` stands in for the user's public server URL.
  - Caddy dials `http://jserver:22300` and rewrites Host to `joplin.example.test`.
- **Scripts** (reproducible, in the repo):
  - `docs/spikes/S2/Caddyfile`: the main site `:8080`, the internal listener `:8089`, and the negative-control sites `:8081` (no Host rewrite) and `:8082` (client `X-Real-IP` passed through).
  - `docs/spikes/S2/run-proxy-checks.sh`: C1–C8.
  - `docs/spikes/S2/run-ratelimit-checks.sh`: R1–R4.
  - `docs/spikes/S2/cleanup.sh`.
- **Commands:**
  ```bash
  podman run --rm … caddy validate --config /etc/caddy/Caddyfile   # "Valid configuration"
  docs/spikes/S2/run-proxy-checks.sh            # log: ~/joplin-web-app-work/spikes/S2/run-proxy-checks.log
  docs/spikes/S2/run-ratelimit-checks.sh        # log: ~/joplin-web-app-work/spikes/S2/run-ratelimit-checks.log
  ```
- **Finding about the test-server recipe.** `APP_ENV=dev` has **no effect** on `joplin/server:3.7.2`.
  - The image runs `tini -- yarn start-prod` (pm2, env prod), and the server reads its env from the `--env` argument (`upstream:packages/server/src/app.ts:101`).
  - `/api/debug` throws Forbidden unless `config().env === Env.Dev` (`…/routes/api/debug.ts:28`). The first run therefore returned `{"error":"Not allowed: POST "}` for `createTestUsers`.
  - **Working recipe:** override the command with `node dist/index.js --env dev --env-file /dev/null`. Without `--env-file`, dev mode looks for a credentials file.
  - `CLAUDE.md`'s "APP_ENV=dev" should be corrected by the orchestrator, and the QA harness must use this recipe.

## Evidence
(Trimmed. Full logs are in `~/joplin-web-app-work/spikes/S2/`.)

```
### C1 ping through proxy (Host rewrite + prefix strip)
{"status":"ok","message":"Joplin Server is running"}                       PASS C1
### C1-neg proxy WITHOUT Host rewrite (expect 404 Invalid origin)
HTTP 404 Invalid origin: http://127.0.0.1:8081                              PASS C1-neg
### C2 login via proxy with a browser-like foreign Origin header (proxy strips Origin)
session=lXmIwm...                                                           PASS C2
### C2b CORS response for the foreign origin when hitting the server directly (informational)
Access-Control-Allow-Origin: https://joplinapp.org
### C3 item round trip via proxy (PUT/GET content, delta)
PUT 200                                                                     PASS C3
{"items":[],"cursor":"","has_more":false}
### C4 server web UI is NOT re-published (expect 404 from Caddy)
/joplin-server/login -> 404   /joplin-server/admin -> 404   /joplin-server/ -> 404   /joplin-server/users/me -> 404
### C5 large attachment (100 MiB) streamed through the proxy
PUT 200 104857600 bytes 6.301041s
GET 200 104857600 bytes 2.825505s                                           PASS C5 sha256 match
caddy mem 10.92MB / 8.2GB
### C6 published-note link (re-run after fixing the fixture: the item parser rejects a trailing newline after `type_: 1`)
PUT note 200
share: {"type":1,…,"id":"JuIeUFsmiWCw8SFVWp3xXe",…}
HTTP/1.1 302 Found
Location: https://joplin.example.test/shares/JuIeUFsmiWCw8SFVWp3xXe
direct server render: 200   ("Hello from spike S2" found in the HTML served by the server origin)
non-share path under prefix: 404
### C7 info.json / .sync/version.txt before any client sync
{"error":"Not found: root:/info.json:", …}   (baseline: no client has initialised the target yet; see S4 for after-sync)
### C8 Caddy access log redaction
PASS C8 session id not in caddy log
logged headers: {"Accept":["*/*"],"X-Api-Auth":"REDACTED","Content-Type":["application/octet-stream"],…}
```

Rate limiter (server **without** `JOPLIN_IS_TESTING`; each client is a separate short-lived container on `s2net`, so each has its own source IP):
```
### R1 client A: 12 bad logins via main site (:8080) while spoofing a new X-Real-IP each time
403 403 403 403 403 403 403 403 403 403 429 429
### R2 client B (different container IP) right after: 1 correct login via :8080
200
### R3-neg proxy that forwards client X-Real-IP unchanged (:8082): spoofing bypasses the limiter
403 403 403 403 403 403 403 403 403 403 403 403
### R4-neg (empirical) client C: 11 bad logins via :8082 WITHOUT X-Real-IP; then client D logs in correctly via :8082
403 403 403 403 403 403 403 403 403 403 429
429      <- client D is locked out by client C: everyone shares the proxy's IP
```

Resources: `s2-jserver` 213 MB RSS, `s2-caddy` 12 MB RSS (`podman stats`).

**Code facts this confirms** (`server-v3.7.2`):
- `isValidOrigin` compares `host` only (`upstream:packages/server/src/utils/routeUtils.ts:173-189`), enforced for every route in `execRequest` (:217).
- `userIp()` returns `X-Real-IP` if present (`…/utils/requestUtils.ts:166-169`).
- The limiter allows 10 requests/min per IP (`…/utils/request/limiterLoginBruteForce.ts`).
- The CORS allow-list is hard-coded (`…/app.ts:129-160`).

**Browser part (run in S4 with the bundle):**
- the web app configured with `<origin>/joplin-server` syncs
- E2EE round trip with the CLI as the "other device"
- `info.json` version after a browser sync

Results (details in `docs/spikes/S4-browser-and-mcp.md` §B):
```
check config: Success! Synchronisation configuration appears to be correct.   (URL http://127.0.0.1:8080/joplin-server)
all sync requests same-origin: POST /joplin-server/api/sessions, GET …/items/…/content|delta, PUT …/batch_items, PUT …/.resource/…
decrypted note title "Seed note alpha" visible after entering the master password (53.9 s from cold start on the Pi)
server: md items encrypted=15 plaintext=0 ; info.json version= 3 e2ee= True   <- unchanged after browser syncs
headless (S3) decrypts the browser-created "1. Welcome to Joplin!" after one cycle
```

## Result
**GO-WITH-CONDITIONS.** An unmodified Joplin Server 3.7.2 serves a same-origin web app through Caddy with no server-side change. Conditions, each now a contract test (M1-AC10/11/13):
1. **Rewrite Host** to the host of the server's `APP_BASE_URL`. Without it every route returns `404 Invalid origin` (C1-neg).
2. **Overwrite `X-Real-IP` with the real client IP.** The server trusts the header blindly:
   - passing it through lets any client bypass the login limiter (R3-neg)
   - omitting it makes one bad client lock out everyone behind the proxy (R4-neg)

   If the user's own TLS front sits before Caddy, Caddy's `trusted_proxies` must list it so that `{client_ip}` is the real client.
3. **Proxy only `/joplin-server/api/*`**, and redirect `/joplin-server/shares/<id>` to the server's public URL. Published notes then never render on the app origin (C4, C6).
4. **Redact `X-Api-Auth`, `Authorization`, `Cookie` and `token=`** in access logs (C8).
5. **Front-proxy body limits** (tunnels/CDNs) apply to attachments. Caddy itself streams 100 MiB with ~11 MB RSS (C5).

## Follow-ups
- The orchestrator corrects the test-server recipe in `CLAUDE.md` (`node dist/index.js --env dev --env-file /dev/null`; `APP_ENV` is ignored).
- **Upstream-first proposals:**
  - a `CORS_ALLOWED_ORIGINS` env (would make the proxy optional)
  - honouring `X-Forwarded-*` only from configured trusted proxies, instead of trusting `X-Real-IP` unconditionally (a security improvement for every Joplin Server behind a proxy)
- Error responses in env=dev include stack traces. Irrelevant for the user's prod server, but the harness must not snapshot them.
