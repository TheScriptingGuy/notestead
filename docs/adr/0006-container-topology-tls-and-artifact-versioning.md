# ADR-0006: Container topology, networking, TLS and artifact versioning

## Status
Proposed (Phase A, 2026-10-03). Channel selection (which registries and stores) is **out of scope**. It belongs to `docs/delivery/channels.md` (ci-cd-specialist, pending), approved at the same gate.

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
                 user's TLS front (existing reverse proxy / tunnel)  ── or ──  Caddy ACME (option)
                                   │ https://notes.example.com
                          ┌────────▼─────────┐  net: frontend (bridge, egress allowed)
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

### TLS (the user chooses at the gate)
1. **Default: behind the user's existing TLS front** (reverse proxy or tunnel). `web` listens on plain HTTP on `127.0.0.1:8080`/LAN.
   - The front must forward `/joplin-server/api/*` bodies unbuffered up to 200 MB, or the user accepts its upload limit for attachments. Some tunnel/CDN plans cap request bodies, e.g. at 100 MB.
   - The front must pass the client IP, and `TRUSTED_PROXIES` must be set.
2. **Option: Caddy terminates TLS itself** with ACME (HTTP-01 if ports 80/443 are reachable; DNS-01 needs a Caddy build with a DNS provider module, which is a second image variant to maintain, so it is offered only on demand).
3. **Local-only use:** `http://127.0.0.1:8080` is a secure context on the same machine, so no TLS is needed for a single desktop.
4. **Not supported:** a private CA for phones (OPFS/WebCrypto/service worker would fail unless the CA is installed on every device).

### Artifact versioning (topology-level; channels are decided in `docs/delivery/channels.md`)
- **Artifacts:**
  - the `web` image (Caddy + overlaid bundle)
  - the `headless` image (supervisor + pinned CLI + MCP)
  - the standalone MCP package (stdio bin)
  - the web-bundle tarball (static files plus checksums)
- **Our version is semver** (`MAJOR.MINOR.PATCH`), independent of Joplin's. Each artifact carries the upstream versions it contains:
  - OCI labels `org.opencontainers.image.version`, `…source`, `…revision` and `…licenses=AGPL-3.0-or-later`
  - custom labels for the web ref, CLI version and minor, taken from `upstream/joplin-version.json`
- **Tags.** Image tags include `X.Y.Z`, `X.Y` and a compound `X.Y.Z-joplin3.7`, so users can see the Joplin minor. Exact naming is finalised in the channel plan.
- **Images are multi-arch manifests built natively per architecture** (x64 and arm64 runners, no QEMU for heavy steps). The web bundle is built **once** on x64 and copied into both architecture images (ADR-0001).

## Alternatives considered
- **Reuse upstream as-is: run the official `joplin/server`-style single image, or the community headless images (jspiers/headless-joplin, gelse/joplin-mcp).**
  - Upstream ships no web or headless image.
  - The community images run `joplin sync` in parallel with `server start`, which risks settings clobbering (findings §3). They have no egress control and no file:// guard.
  - We reuse their *idea* (CLI in a container) but not the images.
- **One container (Caddy + supervisor + CLI under one init).** Fewer moving parts, but the CLI then shares a network namespace with an internet-facing proxy that has egress, so egress can't be confined. One container would also need a process manager. Rejected in favour of two small containers.
- **Three containers (separate MCP container).** MCP needs the Data API token, which must not leave the headless network namespace (ADR-0008). Splitting it out would require exposing the CLI port. Rejected.
- **A podman pod for both containers.** Shared localhost exposes the Data API. Rejected.
- **Host firewall rules for headless egress.** Not portable and requires system changes. Rejected in favour of an `internal` network.

## Consequences
- The headless service depends on `web` being up (its sync path goes through `web:8089`). Compose `depends_on` with health conditions orders startup, and the supervisor retries with backoff.
- Users with an existing front must route one hostname to `web`. They don't need to change their Joplin Server configuration.
- The internal proxy hop adds latency (sub-millisecond on the same host).

## Upgrade impact
- The topology doesn't depend on upstream internals, apart from the `127.0.0.1` bind (if upstream adds a bind-host option, nothing changes for us).
- Image upgrades follow ADR-0005 (digest rollback, profile snapshot).

## Verification
- **S2:** the proxy, including the internal listener pattern.
- **S3:** the headless service synced *through* Caddy `:8089` from a `--internal` network; `https://example.com` was unreachable.
- **S3:** CLI resource use and the arm64 native module install.
- **M1-AC18:** compose test stack up and torn down cleanly on the Pi (x64 CI after the first push, M1-AC22); the healthchecks pass.
- **M3-AC10:** headless egress test. From inside headless, `curl https://example.com` fails and the Joplin Server via `web:8089` succeeds. The positive control proves the network is up.
- **M5-AC4:** images run non-root with a read-only rootfs (inspect test).
