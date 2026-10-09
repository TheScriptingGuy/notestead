# `web` image: Caddy, the web bundle and the Joplin Server proxy

The `web` container of Notestead for Joplin (unofficial). It serves the overlaid upstream web bundle and is the only
path from the browser to your Joplin Server (ADR-0002, ADR-0006, ADR-0008).

| Port | Serves |
|---|---|
| `8080` (public) | the bundle at `/`; `/joplin-server/api/*` proxied to your server; `/joplin-server/shares/<id>` redirected to `JOPLIN_SERVER_PUBLIC_URL/shares/<id>`; every other `/joplin-server/*` path is 404 |
| `8089` (internal, backend network only) | `/joplin-server/api/*` for the headless container's sync; everything else is 404 |

## Build
The bundle comes from the named build context `dist`, normally the output of `import`, so the Pi never runs the
upstream build:

```sh
corepack yarn workspace web-build import <artifact-dir> --out <dist>     # CI artifact or `package` output
podman build -f deploy/web/Containerfile --build-context dist=<dist> -t localhost/notestead-web deploy/web
```

A local overlaid `dist/` (after `web-build overlay`) takes the same path. `import` refuses artifacts that are not
built from the pinned upstream (`upstream/joplin-version.json`) or that fail `verify`.

## Run
```sh
podman run -d -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges --memory 128m \
  -e JOPLIN_SERVER_URL=http://192.168.1.10:22300 -e JOPLIN_SERVER_PUBLIC_URL=https://joplin.example.com \
  localhost/notestead-web
```

The image runs as uid 65532 and writes only to `/tmp`. Point the web app's Joplin Server sync target at
`https://<web host>/joplin-server`.

| Variable | Default | Meaning |
|---|---|---|
| `JOPLIN_SERVER_URL` | required | The server's **direct** address that Caddy dials (`scheme://host[:port]`; trailing `/`s are removed), never a Cloudflare-proxied hostname. |
| `JOPLIN_SERVER_PUBLIC_URL` | required | The server's `APP_BASE_URL`, the target of published-note redirects. |
| `JOPLIN_SERVER_HOST` | the host of `JOPLIN_SERVER_PUBLIC_URL` | The `Host` sent to the server; it must equal the host of `APP_BASE_URL`, or the server answers `Invalid origin`. |
| `COEP` | `credentialless` | `Cross-Origin-Embedder-Policy`: `credentialless` or `require-corp`. |
| `TRUSTED_PROXIES` | none | Space-separated addresses or CIDR ranges allowed to name the client IP: cloudflared's fixed address (`/32`) with the tunnel, or your reverse proxy. |
| `CLIENT_IP_HEADER` | none | The one header those peers set: `CF-Connecting-IP` with the tunnel. From any other peer the TCP address is used. |

The server's login limiter keys on the `X-Real-IP` this proxy always overwrites with that client IP. Access logs go to
stdout with `X-API-AUTH`, `Authorization`, `Cookie`, the Cloudflare Access credentials and `?token=` redacted.

For a healthcheck (compose), `wget -q -O /dev/null http://127.0.0.1:8080/` works inside the image.

## Updating Caddy
The base image is pinned by its multi-arch index digest. To update, take the new `caddy:<version>-alpine` tag, read its
index digest from the registry (`Docker-Content-Digest` of the image index; it must list `linux/amd64` and
`linux/arm64`), change both in the `FROM` line, and run the contract suite
(`corepack yarn jest -c jest.contract.config.js tests/contract/m1-s4`).
