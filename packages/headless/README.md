# headless: Notestead headless supervisor for Joplin (unofficial)

The supervisor runs the pinned Joplin CLI (`joplin`, exact version from `upstream/joplin-version.json`, installed from
this repository's `yarn.lock`) under a small Node process (ADR-0003). It configures one CLI profile, performs an
initial `sync` and `e2ee decrypt`, then serves the CLI's REST Data API on `127.0.0.1:41184` inside the container.

M1-S5 scope: the initial cycle only. The sync loop, request queueing, token rotation per cycle, `/status`, backoff and
the `degraded` state come in M3.

## Image
- `packages/headless/Containerfile`, built with the repository root as the context:
  `podman build -f packages/headless/Containerfile -t <tag> .`
- Base: the official multi-arch `node:22` (bookworm-slim) image, pinned by index digest. Runs as uid/gid 1000.
- Install, in this order: a focused production install of the headless workspace from `yarn.lock`
  (`yarn workspaces focus --production headless`), then a lockfile check (`yarn install --mode=update-lockfile`
  compared with the committed `yarn.lock`) that fails the build when `yarn.lock` doesn't match the manifests.
- Install scripts: off (`.yarnrc.yml` `enableScripts: false`). The **only** allow-list is the root `package.json`
  `dependenciesMeta` (today `sqlite3`, which downloads its prebuilt binding; `sharp` and `keytar` stay unbuilt).
  ADR-0009 A4, M1-AC23.

## Run
Hardening and topology from ADR-0006: a reaping init, a read-only root filesystem, the `internal` backend network only.
Without an init (`--init`, compose `init: true`) the supervisor is PID 1 and can't reap the CLI children it stops; it then
logs one `warning: running as PID 1 without an init; …` line at startup and carries on.
```sh
podman run -d --init --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges --memory 768m \
  --network <backend> --network-alias headless \
  -v headless-data:/data \
  -v ./secrets/joplin_password:/run/secrets/joplin_password:ro \
  -v ./secrets/e2ee_master_password:/run/secrets/e2ee_master_password:ro \
  -e JOPLIN_SERVER_URL=http://web:8089/joplin-server -e JOPLIN_USERNAME=you@example.com \
  <image>
```

| Input | Meaning |
|---|---|
| `JOPLIN_SERVER_URL` | The Joplin Server URL the CLI syncs with (`sync.9.path`): `http(s)`, no credentials, no query. Through `web`'s internal listener: `http://web:8089/joplin-server`. |
| `JOPLIN_USERNAME` | The Joplin Server account (`sync.9.username`). |
| `/run/secrets/joplin_password` | Sync password. |
| `/run/secrets/e2ee_master_password` | E2EE master password. |

Secret files: exactly one trailing `\n` (or `\r\n`) is removed; every other byte is the secret. Secrets reach the CLI
only through `joplin config --import` on a stdin pipe: never argv, never a child's environment, never a log line.
The profile (`/data/profile`, mode `0700`) stores them in plaintext (upstream limitation on Linux, ADR-0008): keep
the volume on an encrypted disk.

## Endpoints
- `GET /healthz` on `0.0.0.0:8090`: `503 {"state":"starting"}` until the initial sync and decryption succeeded and the
  Data API answers, then `200 {"state":"ready","lastSync":"<ISO-8601 UTC>"}`. Every other path is `404`.
- The CLI's Data API listens on `127.0.0.1:41184` only, so nothing outside the container's network namespace reaches it.

## How a successful sync is recognised
`joplin sync` (CLI 3.7.1) exits 0 even when the sync failed, and prints no error at all when the target refuses
connections. The supervisor therefore requires all of: the target's public `GET /api/ping` answers
`{"status":"ok"}` right before and right after the sync, exit code 0, a `Completed:` line and no `Last error:` line
(the profile's locale is fixed to `en_GB`). A failed attempt keeps `/healthz` at 503 and is retried every 30 s.

## Exit codes
`64` invalid configuration (the message names the variable or file, never a value), `70` the installed CLI doesn't
match the pinned version, `73` the profile directory can't be created, `1` the CLI's `server start` exited.
`SIGTERM` stops the CLI children and exits 0.

## Development
`corepack yarn test` runs the unit tests (`src/*.test.ts`, with a fake CLI in `src/testing/`); the contract suite
(`corepack yarn test:contract tests/contract/m1-s5`) builds and runs the real image.
