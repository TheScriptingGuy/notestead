# ADR-0003: Headless Data API = pinned `joplin` CLI under a Node supervisor, with a pluggable `SyncStrategy` (default: stop-the-world)

## Status
Proposed (Phase A, 2026-10-03).

Spike S3 (`docs/spikes/S3-headless-sync-strategy.md`):
- Stop-the-world: **GO-WITH-CONDITIONS**, ~16–19 s outage per cycle on the Pi.
- TUI under a PTY: **NO-GO** as a default.

## Context
- **The npm CLI (`joplin@3.7.1`) runs the desktop's Data API.** `joplin server start` runs the same `ClipperServer` + `Api` as desktop (`upstream:packages/app-cli/app/command-server.ts`; `packages/lib/ClipperServer.ts`).
  - It binds `127.0.0.1` only (`ClipperServer.ts:280`).
  - Its port comes from `api.port`.
  - Its token is `api.token`, accepted only as `?token=`.
  - `--quiet` silences console info, but `log-clipper.txt` still receives every request URL (`:215`).
- **In command mode the CLI has a dummy GUI,** so `hasGui()` is false (`upstream:packages/app-cli/app/app.ts:223, 412-433`). These GUI-gated services therefore **don't run**:
  - recurrent sync (`reg.setupRecurrentSync`)
  - the decryption worker
  - resource auto-download
  - search-index updates on note changes (`SearchEngine.scheduleSyncTables` on `NOTE_UPDATE_ONE`)
  - `RevisionService`

  The gates are in `upstream:packages/lib/BaseApplication.ts:428-438, 491-493, 615-620`. The search index is synced at startup. `SearchEngine.search()` doesn't sync tables first (`SearchEngine.ts:810`).
- **`joplin sync`** (`command-sync.ts`):
  - takes a per-profile lock in `os.tmpdir()`
  - runs `ShareService.maintenance()`
  - syncs
  - in command mode downloads all resources (`ResourceFetcher.fetchAll()`)
  - **never** starts the decryption worker

  `--upgrade` would upgrade the sync target (forbidden by ADR-0005).
- **`joplin e2ee decrypt --force`** runs the `DecryptionWorker` until done. It doesn't prompt with `--force` (`command-e2ee.ts:55-80`). It finds the password in the `encryption.masterPassword` setting (`e2ee/utils.ts:142`).
- **Each CLI command loads settings at start and saves them at exit** (`app.ts:428-430`: `Setting.saveAll()`). Two processes on one profile at the same time can overwrite each other's settings (findings §3).
- **`config --import` reads JSON from stdin** (`command-config.ts:21`). Secrets therefore never need to be on a command line.
- **The CLI has no plugin support.** It does not run upstream's AlarmService either (alarms are per-device anyway).

## Decision
1. **`packages/headless`: a TypeScript supervisor.** The container runs it with a reaping init (`--init`/tini as PID 1). It spawns the CLI as **direct children** and reaps them. S3 found that an orphaned `server start` becomes a zombie under a non-reaping PID 1 and hangs the stop phase. that owns one CLI profile (`/data/profile`, mode `0700`) and runs the pinned CLI (`node_modules/.bin/joplin`, from our lockfile) **only as child processes, through public commands**: `config --import`, `sync`, `e2ee decrypt --force`, `server start --quiet`, `version`. It never `require`s CLI or `@joplin/lib` internals.
2. **A `SyncStrategy` interface** isolates how sync happens:
   ```ts
   interface SyncStrategy {
     start(): Promise<void>;                     // bring the Data API up (initial sync first)
     requestSync(reason: 'timer'|'write'|'manual'): Promise<SyncResult>; // coalesces
     withApi<T>(fn: (api: DataApiClient) => Promise<T>): Promise<T>;     // queues during outages
     status(): SyncStatus;
     stop(): Promise<void>;
   }
   ```
   - **Default: `StopTheWorldStrategy`.** Under one mutex, one cycle is:
     1. queue new API calls and drain in-flight ones
     2. SIGTERM `server start`
     3. `joplin sync`
     4. `joplin e2ee decrypt --force`
     5. `server start --quiet` with a fresh token
     6. wait for `/ping`
     7. release the queue
   - The restart is also what refreshes the search index and loads new master keys.
   - **Triggers:** a timer (`SYNC_INTERVAL`, default 300 s), a debounce after write calls (default 30 s), and `sync_now`.
   - **Outage (S3, Pi, small delta):**
     - stop 5–9 ms
     - `sync` 6.0–7.4 s
     - `e2ee decrypt` 4.8–6.0 s
     - start until `/ping` 5.0–5.2 s
     - **total 15.8–18.6 s**

     Each CLI process start costs ~4.5 s on the Pi. The outage is reported by `/status` (`outageMsP50/P95`).
   - **Search readiness:** after `/ping`, the upstream search index catches up ~10 s later (`SearchEngine.scheduleSyncTables` 10 s timer). The supervisor reports `searchReady` separately and holds `search_notes`/`/search` calls until it is true.
3. **Rejected as a default by S3 (kept as a documented experiment only):** run the CLI's interactive mode (`joplin` without a command, which gives `hasGui() = true` and therefore desktop-like services) under a pseudo-terminal. Start the API with `:server start --exit-early` and trigger sync with `:sync`. S3 showed that the API does stay up and the in-process services do run (DecryptionWorker, FTS indexing). But keystroke injection was unreliable: the first attempt misparsed the commands, and in the second `:sync` silently didn't run. There is no machine-readable status. NO-GO.
4. **Not adopted: in-process hooks into CLI internals** (`reg.setupRecurrentSync`, `DecryptionWorker.instance()`, `SearchEngine.scheduleSyncTables`). This would mean a Node host that `require`s `joplin/app/*` and `@joplin/lib` services. It is reconsidered only if the stop-the-world outage proves unacceptable to the user, and then only behind `SyncStrategy` with a dedicated contract suite.
5. **Opt-in Data API gateway** (`DATA_API_GATEWAY=true`): the supervisor exposes the **same REST Data API** (same routes and shapes) to LAN clients through `web` at `/api/*`.
   - It authenticates with a separate **gateway token** (header, or `?token=` for drop-in compatibility with existing Data API clients) and swaps it for the internal `api.token`.
   - Requests during cycles are queued.
   - `POST /notes` bodies referencing `file:` are rejected by default (ADR-0008).
   - This is how the stack delivers "the same REST API the desktop app exposes" without exposing the CLI's port or token.
6. **Configuration** comes from env plus secrets:
   - `JOPLIN_SERVER_URL` (internal path via `web:8089`), the username
   - the secrets `joplin_password` and `e2ee_master_password`
   - the `mcp_token` and `gateway_token` secrets
   - `SYNC_INTERVAL`, `WRITE_DEBOUNCE`, `CYCLE_QUEUE_TIMEOUT`

   They are applied through `config --import` on stdin at every start (idempotent). There is a `/healthz`, plus `/status` on the backend network only.

## Alternatives considered
- **Reuse upstream as-is: `joplin server start` alone.** It never syncs, never decrypts and doesn't index new notes (see Context). It is not a usable service on its own.
- **Reuse the community pattern: `joplin sync` in a loop next to a live `server start`** (jspiers/headless-joplin, gelse/joplin-mcp, jordanburke/joplin-mcp-server).
  - Two processes save settings to the same profile concurrently, so `sync.9.context` and `syncInfoCache` can be clobbered.
  - The serving process never loads new master keys and never re-indexes.
  - Rejected. The anti-pattern is reproduced as a negative control (M3-AC16).
- **TUI under a PTY by default.** No outage, but it is fragile: screen-driven automation, error messages that aren't machine-readable. Opt-in only (see Decision 3).
- **In-process hooks into internals.** No outage, but it couples us to private APIs that change without notice. Deferred (see Decision 4).
- **Build our own Data API on `@joplin/lib`.** That re-implements upstream, and it is unnecessary.
- **Upstream-first fix** that would remove the shim: a CLI `server start --sync-interval N` (or honouring `sync.interval` in server mode) that runs `setupRecurrentSync` + `DecryptionWorker` + `scheduleSyncTables` while serving, plus an `api.bindHost` setting and header token auth. When upstream ships it, a new `SyncStrategy` (`UpstreamDaemonStrategy`) replaces stop-the-world without changing anything else.

## Consequences
- **The REST API, gateway and MCP are briefly unavailable during each cycle,** ~16–19 s on the Pi, i.e. ~5–6 % of the time at the 300 s default. Requests queue, so callers see added latency rather than errors (bounded by `CYCLE_QUEUE_TIMEOUT`, default 60 s).
- **Search reflects REST-created notes only after the next cycle** (limitation L6). The supervisor debounces a cycle after writes to shorten this window.
- **Each cycle costs three CLI process starts** (CPU on the Pi, see S3).
- **The CLI profile holds plaintext secrets and decrypted data** (ADR-0008).

## Upgrade impact
- **The interfaces consumed are CLI commands and flags**, the settings keys `sync.*`, `encryption.masterPassword`, `api.token`, `api.port`, `mcp.enabled` and `ai.tool.*.enabled`, and the files `clipper-pid.txt` and `log-clipper.txt`.
- **The `headless` contract suite detects drift on every bump:** sync round trip, decrypt, search freshness, settings integrity, token rotation and `syncVersion` guard.

## Verification
- **S3:** CLI install on arm64, E2EE decrypt with `encryption.masterPassword` (non-interactive), search freshness, settings integrity, outage per cycle, internal-network egress.
- **Backlog:** M1-AC14–17, M3-AC1–16.
