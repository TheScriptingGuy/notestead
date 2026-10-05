# ADR-0002: Same-origin reverse proxy from the web origin to the user's Joplin Server

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`), amended the same day for the Cloudflare Tunnel front (see Amendments). Proposed in Phase A (2026-10-03). Verified by spike S2 (GO-WITH-CONDITIONS, `docs/spikes/S2-same-origin-proxy.md`) and spike S6 (GO-WITH-CONDITIONS, `docs/spikes/S6-cloudflare-tunnel.md`).

## Context
- **The web app syncs from the browser.** Its sync client builds every request as `${sync.9.path}/${path}` (`upstream:packages/lib/JoplinServerApi.ts:203`). Every path the client uses starts with `api/` (`api/items/…`, `api/batch_items`, `api/locks`, `api/sessions`, `api/shares`, `api/share_users`, `api/users/…`; grep of `packages/lib` at `v3.7.21`). Auth is the `X-API-AUTH` header plus `X-API-MIN-VERSION`, with no cookies (`JoplinServerApi.ts:183-184`).
- **Joplin Server's CORS allow-list is hard-coded:** `https://joplinapp.org` and `https://app.joplincloud.com`, plus `localhost:8077/8088` in dev. There is no env var (`upstream:packages/server/src/app.ts:129-160` at `server-v3.7.2`). A web app on the user's own origin cannot call the server cross-origin.
- **Every route checks the request origin against the configured base URL:** `execRequest` → `isValidOrigin(ctx.URL.origin, baseUrl(endPoint.type), …)` compares **`host`** (hostname:port) only (`upstream:packages/server/src/utils/routeUtils.ts:173-189, 217`). Koa's `app.proxy` is not set, so `X-Forwarded-Host` is ignored and the **Host header** must equal the host of `APP_BASE_URL` (or `API_BASE_URL`).
- **The login limiter trusts `X-Real-IP` blindly.**
  - `/api/sessions` and the login routes call `limiterLoginBruteForce(userIp(ctx))`: 10 requests/min (`…/utils/request/limiterLoginBruteForce.ts`).
  - `userIp()` returns the `X-Real-IP` header when present, else the socket IP (`…/utils/requestUtils.ts:166-169`).
- **Published-note links are built from the sync URL.** `ShareService.shareUrl()` → `personalizedUserContentBaseUrl(userId, baseUrl, userContentBaseUrl)`. For target 9, `sync.9.userContentPath` is a non-public setting that defaults to `''`, so the link is `${sync.9.path}/shares/<id>` (`upstream:packages/lib/services/joplinServer/personalizedUserContentBaseUrl.ts`, `ShareService.ts:381`). The mobile/web app can publish notes (`components/screens/ShareNoteDialog.tsx`).
- **`isJoplinCloudWebApp` is true only for `https://app.joplincloud.com`** (`upstream:packages/app-mobile/utils/buildStartupTasks.ts:189`). On our origin the sync wizard offers Joplin Server (target 9).

## Decision
The `web` container (Caddy) serves the bundle and is the **only** path from the browser to the user's Joplin Server:

```
https://<web-host>/                       static bundle (ADR-0001)
https://<web-host>/joplin-server/api/*    → reverse_proxy to JOPLIN_SERVER_URL, prefix stripped
https://<web-host>/joplin-server/shares/<id>  → 302 to JOPLIN_SERVER_PUBLIC_URL/shares/<id>
https://<web-host>/joplin-server/*        → 404 (server login/admin UI is not re-published)
```

The user enters `https://<web-host>/joplin-server` as the Joplin Server URL in the web app's sync settings.

**Proxy rules** (each one has a contract test from S2):
1. **Host rewrite:** `header_up Host {JOPLIN_SERVER_HOST}`. It defaults to the host of `JOPLIN_SERVER_PUBLIC_URL`, which must equal the server's `APP_BASE_URL`. *(C1, run with the override unset so the default is under test; negative control C1-neg: a wrong Host, such as the web app's own host that the server would see without the rewrite, gets `404 Invalid origin`. Wording clarified 2026-10-05, M1-S4.)*
2. **Prefix strip** via `handle_path /joplin-server/*`. Only `/api/*` is forwarded. *(C1, C3, C4.)*
3. **Strip `Origin`, `Referer` and `Cookie`** upstream, and `Set-Cookie` downstream. Same-origin requests don't need CORS. Stripping keeps the server's CORS layer from echoing `https://joplinapp.org` and keeps browser cookies away from the server. Also strip the Cloudflare Access credentials `Cf-Access-Jwt-Assertion` and `Cf-Access-Authenticated-User-Email` upstream (gate 1). *(C2, C9.)*
4. **Overwrite `X-Real-IP`** with Caddy's `{client_ip}`, which comes from exactly one source:
   - **`CF-Connecting-IP`, only when the TCP peer is cloudflared** (`TRUSTED_PROXIES` = cloudflared's fixed address, `CLIENT_IP_HEADER=CF-Connecting-IP`; the default front since gate 1, ADR-0006).
   - **the TCP peer** for every other request (LAN clients, the internal listener, any other container).
   - With an existing reverse proxy instead of the tunnel, `TRUSTED_PROXIES` names that proxy and `CLIENT_IP_HEADER` names the single header it sets (`X-Real-IP`, or `X-Forwarded-For` parsed right to left).
   - Never the left part of `X-Forwarded-For`: Cloudflare *appends* to a client-supplied value (S6 T2b).

   The limiter then stays per real client and can't be bypassed by a client-supplied header. *(R1, R2; negative controls: R3-neg, passing the header through lets a client reset the limiter at will; R5-neg, `CF-Connecting-IP` from a peer other than cloudflared is ignored, S6 T3/T4.)*
5. **Streaming both ways** (`flush_interval -1`; Caddy doesn't buffer bodies by default). Attachments up to the server's 200 MB hard limit (`ItemModel.itemSizeHardLimit`) pass through our proxy. *(C5: 100 MiB round trip, sha256 equal.)* The front can be stricter: Cloudflare caps request bodies per plan (Free/Pro 100 MB, Business 200 MB). Upstream treats the resulting 413 as "rejected by target", so the item shows as "cannot sync" and the rest of the sync continues (`upstream:packages/lib/file-api-driver-joplinServer.ts:188-193`, `upstream:packages/lib/Synchronizer.ts:810-812`). With E2EE the upload is ≈ 1.34× the attachment, so the web app's practical attachment limit behind Free/Pro is ≈ 74 MB (limitation L16, S6).
6. **Published notes are never served from the app origin.** `/joplin-server/shares/<id>` redirects to the server's public URL. The server renders user content on its own origin, which holds no OPFS data or secrets. *(C6.)*
7. **Access-log redaction** of `X-Api-Auth`, `Authorization`, `Cookie`, `Cf-Access-Jwt-Assertion`, `CF-Access-Client-Secret` and the `token` query parameter. *(C8.)*
8. **No caching or transformation by a front** (gate 1): proxied responses carry `Cache-Control: no-store, no-transform`. *(C10.)*

**Configuration** (env):
- `JOPLIN_SERVER_URL`: the address Caddy dials. It **must be a direct address** of the server (LAN or container network, e.g. `http://192.168.1.10:22300`), not a Cloudflare-proxied hostname: Cloudflare strips `X-Real-IP` (S6 T2b), and the headless sync path would then also be subject to the body limit and an extra edge round trip.
- `JOPLIN_SERVER_PUBLIC_URL`: the server's `APP_BASE_URL`.
- `JOPLIN_SERVER_HOST`: optional override.
- `TRUSTED_PROXIES`, `CLIENT_IP_HEADER` (default: none trusted, TCP peer only; the `tunnel` compose profile sets cloudflared's fixed address and `CF-Connecting-IP`).

The headless container reaches the same server **through this proxy** on an internal-only listener (ADR-0006). That gives the headless service exactly one egress path.

## Alternatives considered
- **Reuse upstream as-is: point the web app straight at the server.** Blocked by the hard-coded CORS allow-list. The browser refuses the responses. Not viable without a server patch.
- **Patch Joplin Server to read extra CORS origins from env.** This is a patch to the user's *existing* server. It would have to be maintained, and the user would have to run our build of the server. Rejected; it is proposed upstream instead (`CORS_ALLOWED_ORIGINS` env, upstream-first list).
- **Serve the bundle from the Joplin Server's origin** (e.g. under `APP_BASE_URL/web`, via the user's existing front proxy). That makes the web app same-origin with the server's own pages, published notes and admin UI, which render user-controlled content on the origin that would hold OPFS data and secrets. It also requires changing the user's existing proxy. Rejected for security, though it is documented as a possible setup for users who accept the trade-off.
- **Rely on `X-Forwarded-Host`.** Ignored by the server (`app.proxy` is unset). Doesn't work.
- **Proxy everything under `/joplin-server/*`, including the server UI.** That re-publishes `/login`, `/admin` and user content on the app origin. Rejected.
- **nginx instead of Caddy.** Both work. Caddy wins on automatic HTTPS if the user wants it (ADR-0006), a single static binary in multi-arch official images, simple header rules and the Apache-2.0 licence.

## Consequences
- The web app works with an **unmodified** Joplin Server of any 3.x version whose sync API lives under `/api/`.
- If the user's server sits behind another proxy that already sets `X-Real-IP`, the web container must be listed in that proxy's trust, or its own `trusted_proxies` must include it. Otherwise the limiter sees a single IP. This is documented in the deploy guide.
- Under rootless podman, a direct request through a published port arrives with the `web` container's own address as its source (S6 T3), so all direct-LAN clients share one limiter key. That is stricter, not bypassable. Tunnel clients are keyed individually by `CF-Connecting-IP`.
- Published-note links created in the web app are only useful if `JOPLIN_SERVER_PUBLIC_URL` is reachable by the people the user shares with. This is the same as for links created by desktop/mobile.

## Upgrade impact
- **If upstream adds a non-`/api/` path to the sync client:** the proxy returns 404 and the E2E sync suite fails loudly.
- **If upstream makes CORS configurable:** we can drop the proxy for users who prefer direct access. The proxy itself remains valid.
- **If upstream starts honouring `X-Forwarded-*`:** the Host rewrite stays correct.
- **If upstream changes the `X-Real-IP` trust:** the R1–R3 contract tests detect it.

## Verification
- **Spike S2:** C1–C8 and R1–R3 with outputs.
- **Spike S6:** the client-IP rule behind cloudflared (T2–T4), header pass-through (T1), `no-transform` (T5).
- **Backlog:**
  - M1-AC10, M1-AC11, M1-AC13 (proxy contract suite, rate limiter, internal listener)
  - M2-AC1 (browser sync through the proxy)
  - M2-AC7 (large attachment through the browser)
  - M2-AC14 (published-note link redirect)

## Amendments (2026-10-04, gate 1)
- **Front = Cloudflare Tunnel** (user decision). Rule 4 now names its single client-IP source: `CF-Connecting-IP` only from cloudflared's fixed address, otherwise the TCP peer; new negative control R5-neg (M1-AC11).
- Rule 3 also strips Cloudflare Access credentials upstream (C9); rule 7 redacts them; new rule 8 sends `no-store, no-transform` on proxied responses (C10). Both in M1-AC10.
- Rule 5 documents the Cloudflare body limit and upstream's per-item 413 handling (limitation L16).
- `JOPLIN_SERVER_URL` must be a direct address, never a Cloudflare-proxied hostname.
- Evidence: `docs/spikes/S6-cloudflare-tunnel.md`.
