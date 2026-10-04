# ADR-0006: Container topology, networking, TLS and artifact versioning

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`), amended the same day (see Amendments): Cloudflare Tunnel is the default TLS front, the versioning rule D7 is adopted, and the public name is **Notestead**. Proposed in Phase A (2026-10-03). Channel selection (which registries and stores) belongs to `docs/delivery/channels.md` (ci-cd-specialist), approved at the same gate.

## Context
- **The browser needs a secure context** for OPFS, WebCrypto and service workers: HTTPS, or `localhost`/`127.0.0.1`. It also needs cross-origin isolation (COOP/COEP) for sqlite-wasm (findings §1). Phones don't trust a private CA unless it is installed manually.
- **The CLI's Data API binds only to `127.0.0.1`** (`upstream:packages/lib/ClipperServer.ts:280`) and has CORS `*`.
- **The CLI fetches media URLs found in `POST /notes` bodies** (ADR-0008). Limiting the headless service's egress is the strongest backstop, but host firewall changes are not allowed on the dev box and are intrusive for users.
- **The bootstrap plan suggested two containers.** S2 and S3 measured them:
  - `web` (Caddy) idles at a few tens of MB.
  - `headless`: the CLI `server start` process takes 134–165 MB RSS, and the container 84–109 MB (`podman stats`), measured in S3. The supervisor adds an estimated ~60–80 MB.
- **Images must be multi-arch** (amd64 + arm64). The web bundle is static and architecture-neutral (S1). The CLI's native modules (`sqlite3`, `sharp`) have prebuilt binaries for both architectures (S3).

## Decision
### Two containers, two networks, no pod
```
   Cloudflare edge ── cloudflared (default, compose profile `tunnel`)  ── or ──  existing reverse proxy  ── or ──  Caddy ACME
                                   │ https://notes.example.com → http://web:8080 (CF-Connecting-IP trusted only from cloudflared)
                          ┌────────▼─────────┐  net: frontend (bridge, egress allowed; cloudflared at a fixed address)
                          │ web  (Caddy)      │──────────────► user's Joplin Server (JOPLIN_SERVER_URL)
                          │  :8080 public     │
                          │  :8089 internal   │◄──┐ net: backend (internal: true, no egress)
                          └──────────────────┘   │
                          ┌──────────────────┐   │
                          │ headless          │───┘  sync.9.path = http://web:8089/joplin-server
                          │  supervisor :8090 │◄──── /mcp, /healthz, (opt-in) /api gateway, via web
                          │  joplin CLI 127.0.0.1:41184 (never exposed)
                          └──────────────────┘
```
- **`web`** is the only container with a published port (default `127.0.0.1:8080`) and the only one on a network with egress. It serves:
  - the bundle
  - the `/joplin-server/api/*` proxy (ADR-0002)
  - opt-in `/mcp` and `/api` routes to the supervisor
  - an **internal listener `:8089` on the backend network** that only proxies `/joplin-server/api/*` for the headless service
- **`headless`** is attached **only** to the `backend` network (`internal: true`). It has no route to the internet or the LAN, so its only egress is the `web` container's internal proxy to the configured Joplin Server. This enforces "outbound traffic limited to the Joplin Server" with plain podman/docker networking, with no host firewall changes.
- **No shared pod.** In a pod, `127.0.0.1:41184` would be reachable from `web`.
- **Hardening** (both containers):
  - non-root
  - read-only root filesystem, `tmpfs` for `/tmp`
  - `--cap-drop=ALL`, `no-new-privileges`
  - memory limits (`web` 128 MiB, `headless` 768 MiB)
  - a healthcheck
  - **a reaping init as PID 1** (`init: true` in compose / tini). Required by S3's zombie finding.
- **Volumes:**
  - `headless-data` (profile `0700`, pre-upgrade snapshots)
  - `caddy-data` (only with the ACME option)
- **Compose files** (`deploy/compose.yaml`) work with `podman compose` (podman-compose) and `docker compose`. Secrets are mounted as compose secrets.

### TLS (decided at gate 1: Cloudflare Tunnel)
1. **Default: Cloudflare Tunnel.** An optional third compose service `cloudflared` (compose profile `tunnel`) runs the official multi-arch image `docker.io/cloudflare/cloudflared`, pinned by digest (2026.9.3 runs natively on arm64, S6). It is a third-party component, not part of the Joplin pin.
   - **Wiring:** a remotely managed tunnel; its public hostname routes to `http://web:8080`. cloudflared sits on the `frontend` network at a **fixed address** and never joins `backend`. The tunnel token comes from the podman secret `cf_tunnel_token` through `TUNNEL_TOKEN_FILE` (never an env value). In this mode `web` needs no published port; `127.0.0.1:8080` stays available for local use.
   - **Client IP:** `web` trusts `CF-Connecting-IP` only from cloudflared's fixed address, otherwise it uses the TCP peer (ADR-0002 rule 4).
   - **Request bodies:** Cloudflare caps them per plan (Free/Pro 100 MB, Business 200 MB, Enterprise up to 5 GB). Of our traffic, only browser sync uploads can approach the limit (MCP request bodies are capped at 10 MiB, ADR-0008). Too-large attachments become per-item "cannot sync" entries (≈ 74 MB with E2EE on Free/Pro; limitation L16). Desktop and mobile sync with the server directly, and the headless service syncs through `web:8089` to the **direct** `JOPLIN_SERVER_URL`, so neither is affected.
   - **Timeouts:** Cloudflare answers **524** when the origin sends no response headers within 125 s (current docs; older sources say 100 s; only Enterprise can raise it). Rule: **every request through the front gets its response headers within 90 s.** Joplin sync uses short individual requests; the supervisor's queue timeout defaults to 60 s and may not exceed 90 s (M3-AC4); MCP `sync_now` waits at most 90 s and then reports the cycle as running (M4-AC14). Our MCP endpoint is stateless JSON without SSE (ADR-0004), so there are no long-lived streams to keep alive.
   - **Caching and transformations:** upstream's bundle files are not content-hashed (`[name].bundle.js`), and Cloudflare caches `.js` by extension for 120 min when the origin sends no `Cache-Control`. `web` therefore sends `Cache-Control: no-cache, no-transform` on static files (revalidation by ETag) and `no-store, no-transform` on `/joplin-server/*`, `/mcp` and `/api`. `no-transform` also stops Email Address Obfuscation (on by default; it rewrote HTML and injected a script in S6 T5) and Cloudflare's own compression, so Caddy compresses (`zstd`, `gzip`).
   - **Zone settings checklist** (deploy guide; checked in M5-S6): Rocket Loader off; Bot Fight Mode off (it can't be skipped per path and may challenge API clients); no "Under Attack" mode or managed challenges on `/joplin-server/*` and `/mcp`; no cache rule that caches HTML. Auto Minify was removed by Cloudflare in August 2024 and needs no action.
   - **Headers pass through:** COOP, COEP and CORP arrive unchanged (S6 T1). Cloudflare strips client-supplied `X-Real-IP`, appends to `X-Forwarded-For` and rejects client-supplied `CF-Connecting-IP` (S6 T2).
   - **Optional Cloudflare Access for `/mcp`:** a self-hosted Access application on `<host>/mcp` with a **Service Auth** policy and a service token, which MCP clients send as `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers. The tunnel ingress for `/mcp` sets `access.required` so cloudflared rejects requests without a valid Access JWT. Our bearer token stays mandatory: Access is an extra layer, never a replacement (ADR-0008). Putting the whole hostname behind interactive Access is possible but not recommended: when the Access session expires, the web app's background sync requests fail until the page is reloaded.
   - **Trust:** Cloudflare terminates TLS and sees the plaintext HTTP traffic (limitation L17, ADR-0008).
2. **Alternative: the user's existing reverse proxy.** `web` listens on plain HTTP on `127.0.0.1:8080`/LAN.
   - The proxy must forward `/joplin-server/api/*` bodies unbuffered up to 200 MB (or the user accepts its upload limit), and allow ≥ 125 s for response headers.
   - It must pass the client IP in a single header it overwrites; `TRUSTED_PROXIES` and `CLIENT_IP_HEADER` name the proxy and that header.
3. **Option: Caddy terminates TLS itself** with ACME (HTTP-01 if ports 80/443 are reachable; DNS-01 needs a Caddy build with a DNS provider module, which is a second image variant to maintain, so it is offered only on demand).
4. **Local-only use:** `http://127.0.0.1:8080` is a secure context on the same machine, so no TLS is needed for a single desktop.
5. **Not supported:** a private CA for phones (OPFS/WebCrypto/service worker would fail unless the CA is installed on every device).

### Artifact names and versioning (channels: `docs/delivery/channels.md`)
- **Artifacts and names** (public name **Notestead**, shown as "Notestead for Joplin (unofficial)"; channels.md §5):

  | Artifact | Name |
  |---|---|
  | `web` image (Caddy + overlaid bundle) | `ghcr.io/thescriptingguy/notestead-web` (Docker Hub, Phase 2: `thescriptingguy/notestead-web`) |
  | `headless` image (supervisor + pinned CLI + MCP) | `ghcr.io/thescriptingguy/notestead-headless` (Docker Hub, Phase 2: `thescriptingguy/notestead-headless`) |
  | MCP stdio package | npm `notestead-mcp`; MCP Registry `io.github.thescriptingguy/notestead` |
  | Web-bundle tarball | `notestead-web-bundle-X.Y.Z-joplin<web tag>.tar.gz` (GitHub Releases) |
  | Repository | `TheScriptingGuy/notestead` (after the approved rename of `Joplin-Web-App`) |
  | OCI label prefix | `io.github.thescriptingguy.notestead.` |

- **One lockstep semver** (`MAJOR.MINOR.PATCH`) for every artifact of a release, git tag `vX.Y.Z`, independent of Joplin's version numbers. Each artifact carries the upstream versions it contains:
  - OCI labels `org.opencontainers.image.version`, `…source`, `…revision` and `…licenses=AGPL-3.0-or-later`
  - `<prefix>joplin.web-ref`, `.web-tag`, `.cli-version`, `.minor`, `.server-tested`, `.sync-version`, taken from `upstream/joplin-version.json`
- **Bump rule (D7, gate 1):**

  | Change | Bump while 0.x | Bump from 1.0 |
  |---|---|---|
  | Upstream patch within the pinned minor (M6 bump PR), or our own fix | PATCH | PATCH |
  | Compatible feature (new MCP tool, new option) | MINOR | MINOR |
  | **Joplin minor upgrade** (e.g. 3.7 → 3.8; the user must move server and clients too, ADR-0005), or a breaking compose/env/config change | MINOR | **MAJOR** |

  A user who floats on `X` (or `X.Y` while 0.x) therefore never changes Joplin minor silently.
- **Image tags:** `X.Y.Z` and `X.Y.Z-joplin<minor>` (never move); `X.Y`, `X` (from 1.0), **`joplin<minor>`** (e.g. `joplin3.7`: the newest release for that Joplin minor) and `latest` (move on stable releases only); `X.Y.Z-rc.N` (never moves, GHCR only, never updates a floating tag). Exact versions are never re-tagged or re-published; rollbacks use digests (ADR-0005). channels.md §6 holds the full tag table.
- **Images are multi-arch manifests built natively per architecture** (x64 and arm64 runners, no QEMU for heavy steps). The web bundle is built **once** on x64 and copied into both architecture images (ADR-0001).

### Self-hosting catalogs (Phase 3): network-model pre-condition
Many catalogs (Umbrel, Unraid, TrueNAS) can't express the `internal: true` `backend` network that confines the `headless` container's egress (channels.md F5). That confinement is the network backstop of the `POST /notes` file:// guard (ADR-0008). **Pre-condition for any Phase 3 catalog story:** an amendment to this ADR decides, per catalog, whether its package may ship without the internal network, and with which compensating control. Current, non-binding position:
- a `web`-only package (no CLI, so no file:// path) needs no internal network;
- a package that includes `headless` needs an enforced egress restriction (the `internal` network, or a Kubernetes NetworkPolicy as in the Helm plan), or else ships with `MCP_READ_ONLY=true` and the gateway off, stated in the listing.

## Alternatives considered
- **Reuse upstream as-is: run the official `joplin/server`-style single image, or the community headless images (jspiers/headless-joplin, gelse/joplin-mcp).**
  - Upstream ships no web or headless image.
  - The community images run `joplin sync` in parallel with `server start`, which risks settings clobbering (findings §3). They have no egress control and no file:// guard.
  - We reuse their *idea* (CLI in a container) but not the images.
- **One container (Caddy + supervisor + CLI under one init).** Fewer moving parts, but the CLI then shares a network namespace with an internet-facing proxy that has egress, so egress can't be confined. One container would also need a process manager. Rejected in favour of two small containers.
- **Three containers (separate MCP container).** MCP needs the Data API token, which must not leave the headless network namespace (ADR-0008). Splitting it out would require exposing the CLI port. Rejected.
- **A podman pod for both containers.** Shared localhost exposes the Data API. Rejected.
- **Host firewall rules for headless egress.** Not portable and requires system changes. Rejected in favour of an `internal` network.
- **TLS front alternatives (gate 1).** The user's existing reverse proxy (the Phase A default) has no body-size or edge-timeout limits beyond its own and keeps TLS on the user's hardware, but needs an open port or an existing proxy. Caddy ACME needs reachable ports 80/443. Cloudflare Tunnel needs no open port and gives a publicly trusted certificate for phones, at the cost of the plan's body limit (L16) and Cloudflare seeing plaintext (L17). The user chose the tunnel; the other two stay documented.

## Consequences
- The headless service depends on `web` being up (its sync path goes through `web:8089`). Compose `depends_on` with health conditions orders startup, and the supervisor retries with backoff.
- Users route one hostname to `web` (a Cloudflare Tunnel public hostname by default, or their existing proxy). They don't need to change their Joplin Server configuration.
- With the tunnel, a third container (`cloudflared`) runs. It has egress on `frontend` but no route to `backend`, so it can't reach the headless service or the CLI.
- The web app's attachment uploads are limited by the Cloudflare plan (L16), and Cloudflare sees the plaintext HTTP traffic (L17).
- The internal proxy hop adds latency (sub-millisecond on the same host).

## Upgrade impact
- The topology doesn't depend on upstream internals, apart from the `127.0.0.1` bind (if upstream adds a bind-host option, nothing changes for us).
- A Joplin minor upgrade is our MAJOR (MINOR while 0.x) and moves the users of `joplin<new minor>`; users of `joplin<old minor>` stay put (D7).
- cloudflared is pinned by digest and updated like Caddy (Dependabot/Renovate PR, full suite). Cloudflare can change limits and zone defaults at any time; the M5-S6 checklist is re-run when the deploy guide changes.
- Image upgrades follow ADR-0005 (digest rollback, profile snapshot).

## Verification
- **S2:** the proxy, including the internal listener pattern.
- **S3:** the headless service synced *through* Caddy `:8089` from a `--internal` network; `https://example.com` was unreachable.
- **S3:** CLI resource use and the arm64 native module install.
- **S6:** Cloudflare Tunnel: header pass-through, the `CF-Connecting-IP` rule and its negative controls, `no-transform`, documented limits and timeouts.
- **M1-AC11/M1-AC12:** the client-IP rule with a fixture "cloudflared" peer, and the cache/transform headers (contract, no Cloudflare account needed).
- **M5-AC11:** the user's smoke test through their real tunnel, including the zone-settings checklist.
- **M1-AC18:** compose test stack up and torn down cleanly on the Pi (x64 CI after the first push, M1-AC22); the healthchecks pass.
- **M3-AC10:** headless egress test. From inside headless, `curl https://example.com` fails and the Joplin Server via `web:8089` succeeds. The positive control proves the network is up.
- **M5-AC4:** images run non-root with a read-only rootfs (inspect test).

## Amendments (2026-10-04, gate 1)
- **TLS front: Cloudflare Tunnel is the default** (user decision), as an optional `cloudflared` compose service with a fixed address on `frontend`, the token from a podman secret, and verified facts on client IP, body limits, timeouts, caching/transformations and optional Access for `/mcp` (S6). The existing reverse proxy stays documented as the alternative; Caddy ACME stays an option.
- **Versioning rule D7** (channels.md §6): a Joplin minor upgrade is our MAJOR (MINOR while 0.x), plus the floating `joplin<minor>` image tag.
- **Names:** Notestead artifact names from channels.md §5.
- **Catalog network model:** recorded as a pre-condition for Phase 3 catalog work, with a non-binding position.
