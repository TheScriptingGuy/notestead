# S6: Cloudflare Tunnel as the HTTPS front (gate 1 follow-up)

## Question
The user chose **Cloudflare Tunnel** (cloudflared → the `web` container) as the HTTPS front at gate 1. Before ADR-0002/0006/0008 change, verify with current facts:
1. Where does the real client IP come from, and how does the `web` container's `X-Real-IP` overwrite rule (ADR-0002 rule 4) stay unspoofable?
2. What are the request-body limits, and what happens to large attachment sync?
3. What origin timeout applies to long requests (sync, MCP)?
4. Which Cloudflare features can break the app (caching, Rocket Loader, Auto Minify, Email Obfuscation, challenges)? Do COOP/COEP/CORP pass through?
5. Can Cloudflare Access protect `/mcp` without breaking MCP clients?

## Timebox
45 minutes, light job (no build). Used ~35 minutes.

## Setup
- Throwaway Caddy (`docker.io/library/caddy:2-alpine`) with the client-IP rule modelled in `docs/spikes/S6/Caddyfile`:
  `trusted_proxies static <cloudflared fixed IP>/32` + `client_ip_headers CF-Connecting-IP`.
- `docker.io/cloudflare/cloudflared:latest` = **2026.9.3**, arm64 image pulled natively on the Pi, run as a **quick tunnel** (`tunnel --url`, no Cloudflare account, random `*.trycloudflare.com` host). No Joplin Server, account or note data was involved.
- Both on a podman network `s6-edge` (10.89.66.0/24) with fixed addresses: cloudflared `.10`, Caddy `.20`; Caddy also published on `127.0.0.1:18080`.

```bash
bash docs/spikes/S6/run-cloudflare-checks.sh              # T1–T8 (uploads ~150 MB)
S6_UPLOADS=0 bash docs/spikes/S6/run-cloudflare-checks.sh # T1–T6 only
```
The script removes its containers and network on exit (verified: `podman ps -a`, `podman network ls`). Full logs: `~/joplin-web-app-work/spikes/S6/run{1,2}.log` (they contain the Pi's public IP, so they stay out of the repo).

Documentation checked on 2026-10-04 (sources at the end).

## Evidence
**T1: security headers pass through the tunnel unchanged.**
```
HTTP/2 200
cf-cache-status: DYNAMIC
server: cloudflare
cross-origin-embedder-policy: credentialless
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```
Cloudflare documents that it removes only `X-Accel-*` and `Alt-Svc` response headers and adds `Cf-Ray`/`Cf-Cache-Status`. Upstream's service worker also re-adds COOP/COEP/CORP to every response it serves (`upstream:packages/app-mobile/web/serviceWorker.ts:122-131`), but the first, uncontrolled load needs them from the origin, so T1 matters.

**T2: client IP (public IP masked as `A.B.x.x`).**
```
T2a  no extra headers           remote=10.89.x.x(cloudflared) client=A.B.x.x cfci=A.B.x.x xff=A.B.x.x xri=
T2b  client sends X-Real-IP: 5.6.7.8, X-Forwarded-For: 9.9.9.9
                                 remote=10.89.x.x client=A.B.x.x cfci=A.B.x.x xff=9.9.9.9,A.B.x.x xri=
T2c  client sends CF-Connecting-IP: 1.2.3.4   → "error code: 1000" (status=403) at Cloudflare's edge
T3   NEG direct to the published port with CF-Connecting-IP: 1.2.3.4
                                 remote=10.89.66.20 client=10.89.66.20 cfci=1.2.3.4
T4   NEG other container on the same network with CF-Connecting-IP: 1.2.3.4
                                 remote=10.89.66.2 client=10.89.66.2 cfci=1.2.3.4
```
- `CF-Connecting-IP` carries exactly the real client IP. Cloudflare **strips** a client-supplied `X-Real-IP`, **appends** to a client-supplied `X-Forwarded-For` (so its left part is attacker-controlled), and **refuses** a client-supplied `CF-Connecting-IP` with error 1000.
- With the peer-restricted rule, `{client_ip}` is the real client only when the TCP peer is cloudflared; for every other peer the header is ignored (T3, T4).
- **Side finding (rootless podman):** a request through the published port arrives with the `web` container's own address as its source (T3: `10.89.66.20`), not the real client. Direct-LAN clients therefore all share one limiter key: stricter, not bypassable. The tunnel path doesn't have this problem.

**T5: Email Address Obfuscation rewrites HTML unless the origin sends `no-transform`.**
```
/html-plain        → <a href="/cdn-cgi/l/email-protection" class="__cf_email__" …>[email protected]</a>
                     <script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>
/html-notransform  → <p>contact s6@example.com</p>   (Cache-Control: no-cache, no-transform)
```
Docs: obfuscation is **on by default** for new zones and skipped when the response carries `Cache-Control: no-transform`; `no-transform` also disables Cloudflare compression, Polish and JavaScript Detections injection. Docs don't list Rocket Loader under `no-transform`.

**T6: JS caching.** `cf-cache-status: DYNAMIC` twice on the quick-tunnel zone. **Inconclusive for user zones:** per the docs, a normal zone caches `.js` by extension (HTML and JSON are not cached) with a 120 min edge TTL when the origin sends no `Cache-Control`, and never caches `no-cache`/`no-store`/`private`/`max-age=0`. Upstream's webpack output is **not content-hashed** (`filename: '[name].bundle.js'`, `upstream:packages/app-mobile/web/webpack.config.ts:52`), so edge caching would mix bundle versions after an upgrade.

**T7/T8: uploads.**
```
T7  PUT 50 MiB   status=200 time=6.7s
T8  PUT 101 MiB  status=200 time=12.4s
```
The quick-tunnel zone accepted 101 MiB, so it isn't subject to the Free-plan limit. **Inconclusive for the user's zone.** The documented limits are: Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB; larger bodies get **413**.

**Upstream behaviour on 413 (code).** `FileApiDriverJoplinServer.isRejectedBySyncTargetError` treats 409/413/422 as "rejected by target" (`upstream:packages/lib/file-api-driver-joplinServer.ts:188-193`). The synchronizer then records the item as "cannot sync" and continues with the rest (`upstream:packages/lib/Synchronizer.ts:810-812`). A too-large attachment therefore fails **per item and visibly** (sync status lists it), and doesn't abort the sync.

**E2EE size overhead (computed from code, not measured).** `FileV1` reads the file as base64 in 128 Ki-character chunks (96 KiB binary), encrypts each chunk with AES-GCM and stores it base64 in JSON, plus a 6-hex length prefix (`upstream:packages/lib/services/e2ee/EncryptionService.ts:137, 494-500, 586-606`). The upload is ≈ **1.34×** the attachment. Behind a 100 MB limit the largest E2EE attachment the web app can upload is ≈ **74 MB**; behind 200 MB ≈ 149 MB (which equals the server's own 200 MB hard limit on the encrypted item).

**Timeouts (docs).** Cloudflare returns **524** when the origin sends no response headers within **125 s** (the current documented default for all plans; older docs and third-party pages say 100 s). Enterprise can raise it up to 6,000 s. Proxy idle timeout to the origin: 900 s. cloudflared's origin settings have connect/TLS/keep-alive timeouts (30 s/10 s/90 s) and **no response timeout**.

**Bot protection (docs).** Bot Fight Mode "cannot be bypassed or skipped using WAF custom rules or Page Rules" and "may challenge API or mobile app traffic".

**Cloudflare Access (docs).** Non-browser clients authenticate to an Access application with a **service token** (`CF-Access-Client-Id` + `CF-Access-Client-Secret` headers; the policy action must be **Service Auth**). cloudflared can validate the Access JWT itself (`originRequest.access`: `teamName`, `audTag`, `required`), so a request that didn't pass Access never reaches `web`.

**cloudflared packaging.** `docker.io/cloudflare/cloudflared` 2026.9.3 runs natively on arm64 and supports `--token-file` / `TUNNEL_TOKEN_FILE`, so the tunnel token can come from a podman secret instead of an env var.

## Result
**GO-WITH-CONDITIONS.** Cloudflare Tunnel works as the default front with these conditions, all carried into ADR-0002/0006/0008 and the backlog:
1. **Client IP:** `web` takes the client IP from `CF-Connecting-IP` **only** when the TCP peer is cloudflared's fixed address, otherwise from the TCP peer. Never from `X-Forwarded-For`.
2. **`JOPLIN_SERVER_URL` must be a direct address** (LAN or container network) of the Joplin Server, not a Cloudflare-proxied hostname. Otherwise Cloudflare strips our `X-Real-IP`, the 100 MB limit applies to the headless sync path too, and every request takes an extra edge round trip.
3. **Attachment limit:** on Free/Pro, attachments uploaded from the web app are capped at ≈ 74 MB with E2EE (100 MB without). Larger ones show as "cannot sync" in the web app; desktop and mobile sync directly with the server and are unaffected. This is documented as limitation L16.
4. **Responses:** `web` sends `Cache-Control: no-cache, no-transform` on static files and `no-store, no-transform` on `/joplin-server/*`, `/mcp` and `/api`, and compresses itself.
5. **Zone settings** for the hostname: Rocket Loader off, no challenges (Bot Fight Mode off, no "Under Attack", no managed challenges on `/joplin-server/*` and `/mcp`). The deploy guide carries a checklist.
6. **Every request through the front answers within 90 s** (queue timeout, `sync_now` wait cap).
7. **Cloudflare terminates TLS, so it sees plaintext traffic,** including the web login password, the MCP bearer token and decrypted note content returned by MCP. E2EE sync payloads stay encrypted. Stated plainly as limitation L17.

## Follow-ups
- M1-AC11/M1-AC12 gain the client-IP and cache/transform header checks (contract, no Cloudflare account needed: a fixture container at the trusted address plays cloudflared).
- M5-S4 adds the `tunnel` compose profile and the zone-settings checklist; M5-S6 verifies on the user's real zone: headers, no `email-decode` script, no `cf-cache-status: HIT` on `index.html`/bundles, and a > limit attachment showing as "cannot sync".
- Not verified here: the Free-plan 413 itself (the quick-tunnel zone isn't a Free zone), and Rocket Loader's effect on the bundle. Both are checked on the user's zone in M5-S6.

## Sources (checked 2026-10-04)
- Connection limits: https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- Error 413 (upload limits per plan): https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/
- Error 524: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
- HTTP headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`): https://developers.cloudflare.com/fundamentals/reference/http-headers/
- Default cache behaviour: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- Origin Cache-Control (`no-transform`): https://developers.cloudflare.com/cache/concepts/cache-control/
- Email Address Obfuscation: https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/
- Rocket Loader: https://developers.cloudflare.com/speed/optimization/content/rocket-loader/
- Bot Fight Mode: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
- Service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- cloudflared origin parameters: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/
- Auto Minify removal (August 2024): https://developers.cloudflare.com/fundamentals/api/reference/deprecations/
