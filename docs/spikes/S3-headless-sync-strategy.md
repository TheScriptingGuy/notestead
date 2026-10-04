# Spike S3: headless sync strategy on arm64 (pinned `joplin` CLI in a container, E2EE)

## Question
1. Does the pinned npm CLI (`joplin@3.7.1`) install and run in a container on arm64?
2. Does stop-the-world sync work, and how long is the outage per cycle? Stop-the-world means: stop `server start` → `joplin sync` → `joplin e2ee decrypt` → restart. Compare it with the in-process alternatives.
3. Does E2EE decrypt work **non-interactively** through `encryption.masterPassword`?
4. Does search find newly synced notes?
5. Are settings left unclobbered?
6. Can secrets be configured without argv?
7. Does an internal-only network confine egress?

## Timebox
3 h. Used: ~2 h 30 min over two sessions (the first run was cut short by a session stop; all evidence below is from the complete second run on 2026-10-04).

## Setup
- **Host:** Raspberry Pi 4 (arm64), podman 5.4.2. Throwaway `joplin/server:3.7.2` and Caddy from S2 (`s2-jserver`, `s2-caddy` on `s2net`, server started with `node dist/index.js --env dev --env-file /dev/null`, `JOPLIN_IS_TESTING=1`).
- **Image:** `docs/spikes/S3/Containerfile` is `node:22-bookworm-slim` + `npm install -g --omit=dev joplin@3.7.1` + `cycle.sh`. It runs as non-root `node`.
- **Container:** `--init --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges`, volume `/data`. It is attached **only** to `s3back`, a podman network created with `--internal`. `s2-caddy` is also connected to `s3back` and offers the internal listener `:8089` (S2 Caddyfile). The CLI's sync URL is `http://s2-caddy:8089/joplin-server`.
- **Two profiles in the container:**
  - `/data/device` stands in for the user's desktop/phone. It enables E2EE (master password `s3-master-password-Δ`), seeds notes and syncs.
  - `/data/headless` is the system under test.
- **Scripts:**
  - `docs/spikes/S3/run-s3.sh`: the end-to-end run.
  - `docs/spikes/S3/cycle.sh`: a bash stand-in for the supervisor's stop-the-world cycle.
  - `docs/spikes/S3/tui-probe.sh`: experimental strategy B.
  - Logs: `~/joplin-web-app-work/spikes/S3/run-s3.log`, `tui-probe.log`.

## Evidence

**1. Install on arm64** (first build: 224 s for the image, `npm install` "added 684 packages in 1m"; image 1.01 GB with build tools):
```
node-pre-gyp http GET https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.6/napi-v6-linux-glibc-arm64.tar.gz
node-pre-gyp info install unpacking napi-v6-linux-glibc-arm64/node_sqlite3.node      <- prebuilt, no compile
joplin 3.7.1 (prod, linux)  Device: linux, Cortex-A72  Sync Version: 3  Profile Version: 53  Keychain Supported: No
+-- joplin@3.7.1  +-- @joplin/lib@3.7.1  +-- @joplin/renderer@3.7.1  +-- @joplin/utils@3.7.1
+-- keytar@7.9.0  +-- sharp@0.34.5  +-- sqlite3@5.1.6
```
- `sqlite3` and `sharp` use prebuilt arm64 binaries.
- `keytar` installs, but isn't used on Linux ("Keychain Supported: No").
- The build tools in the spike image were not needed for these packages. The production image can drop them, which the M1-S5 build verifies.

**2. Egress confinement through the internal network:**
```
example.com -> 000        (blocked: no route from the --internal network)
{"status":"ok","message":"Joplin Server is running"}   (via http://s2-caddy:8089/joplin-server/api/ping)
```

**3. E2EE fixture: a CLI finding.**
- `joplin e2ee enable --password X` run **as a standalone command exits 0 but persists nothing** in CLI 3.7.1: `e2ee status` still says "Disabled", and the `syncInfoCache` setting has `masterKeys: []`. The debug log shows the key being generated and selected in-process ("activeMasterKeySanityCheck: Selected new active key"), but it is gone in the next process.
- Running enable **inside `joplin batch`, together with `sync`**, works: the key and `info.json` are uploaded from the same process.
  ```
  device batch (enable+seed+sync): 8553ms
  Encryption is: Enabled
  encryption_applied: 1 type_: 2 <- 5dc6a94a….md
  encryption_applied: 1 type_: 1 <- 4b812116….md
  encryption_applied: 1 type_: 1 <- c7db7811….md
  info.json version= 3 e2ee= True masterKeys= 1
  ```
- This doesn't affect the product: the headless service joins an existing E2EE account and never enables E2EE. It does affect the test fixture `e2eeAccount` (ADR-0007), which must use `batch`. Worth an upstream issue.

**4. Secrets through `config --import` on stdin, and a probe for argv/environ leaks.** The probe receives the needle on stdin, so its own argv doesn't contain it, and it has a positive control:
```
argv/environ leak check (needle passed on stdin; should print nothing):
probe-done
positive control (planted marker in argv must be found):
LEAK in /proc/123/cmdline
settings.json keys: ['$schema','altInstanceId','api.port','api.token','locale',…,'sync.9.path','sync.9.username','sync.target']
where is the master password stored?  /data/headless/settings.json:0  /data/headless/database.sqlite:1
```
- The master password and sync password are **not** in `settings.json`. They sit in plaintext in `database.sqlite` (secure settings fall back to the DB, "Keychain Supported: No").
- `api.token` **is** in `settings.json`.

**5. CLI start cost and stop-the-world cycles** (small delta: 1–3 items):
```
joplin version: 4450ms                                  <- bare CLI start on the Pi
cycle: stop=5ms sync=6497ms(rc=0) decrypt=5093ms(rc=0) start=5147ms OUTAGE=16742ms   (initial)
cycle: stop=9ms sync=6622ms(rc=0) decrypt=4928ms(rc=0) start=5003ms OUTAGE=16562ms
cycle: stop=9ms sync=6065ms(rc=0) decrypt=4806ms(rc=0) start=5019ms OUTAGE=15899ms
cycle: stop=9ms sync=6006ms(rc=0) decrypt=4754ms(rc=0) start=4995ms OUTAGE=15764ms
cycle: stop=9ms sync=7411ms(rc=0) decrypt=5958ms(rc=0) start=5177ms OUTAGE=18555ms   (after the browser uploaded 15 items, S4)
```
- The outage is **~16–19 s per cycle on the Pi**. It is dominated by three CLI process starts at ~4.5 s each.
- At the default 300 s interval, that is ~5–6 % of the time unavailable. Requests queue rather than fail (ADR-0003).

**6. Non-interactive E2EE decrypt.** `e2ee decrypt --force` with `encryption.masterPassword` set gives rc=0. "Decrypted items: 3 … Completed decryption." The REST API then returns plaintext:
```
{"items":[{"title":"Seed note alpha","encryption_applied":0},{"title":"Seed todo beta","encryption_applied":0}]}
```

**7. Search freshness:**
```
{"items":[],"has_more":false}  <- search immediately after /ping
search 'zebracorn' found after 9814ms                   <- SearchEngine.scheduleSyncTables() runs 10 s after start
search before cycle: {"items":[]}  <- 15 s after a REST-created note (no indexing in command mode)
search 'gammaword' found after 9990ms                   <- REST-created note, after the next cycle
search 'deltaword' found after 323ms                    <- device note synced in the same cycles
```
- Search sees new notes ~10 s after each restart (`upstream:packages/lib/services/search/SearchEngine.ts:179-189`, a 10 s timeout).
- Notes created through REST are invisible to search until the next cycle (limitation L6).
- **Design consequence:** the supervisor should treat the API as ready for *search* only after the first index pass. It does so by polling `/search` for a sentinel, or simply by waiting until `scheduleSyncTables` has run (~10 s).

**8. Settings integrity across 4 cycles:**
```
settings.json changed keys: none
```

**9. Round trip, headless → device** (REST `POST /notes {title}` then `PUT {body, is_todo:1, todo_due}`):
```
server item for the headless-created note: encryption_applied: 1
device (after sync + e2ee decrypt): 7b56f … [ ] Headless created gamma   is_todo: 1   todo_due: 1791182441000
```
The device side needs `e2ee decrypt` too: a CLI device shows an empty title until it decrypts, because command mode never runs the decryption worker.

**10. Token leak into the CLI request log** (`upstream:packages/lib/ClipperServer.ts:215`):
```
grep -c 'token=<current token>' /data/headless/log-clipper.txt  ->  15
```
`--quiet` silences the console only. Rotating the token on every start and truncating the log (ADR-0008) are confirmed as necessary.

**11. Zombie processes: a design finding.**
- On the first attempt the cycle hung forever in "stop". The stopped `server start` had become `[node] <defunct>`: it was started through `podman exec`, so it was reparented to PID 1 (`sleep infinity`), which never reaps children. `kill -0` succeeds on a zombie.
- **Fix:** run the container with `--init` (tini/catatonit as PID 1), and have the supervisor own the CLI as a direct child (Node reaps its own children).
- `cycle.sh` now also treats state `Z` as stopped.

**12. Resource use:**
- `headless` container: 84–109 MB (`podman stats`); the CLI `server start` process: 134–165 MB RSS.
- A sync or decrypt step briefly uses one core at ~80 %.

**13. Strategy B, "tui-pty"** (`tui-probe.sh`: the CLI's interactive mode, `hasGui()` true, under `script` as a PTY):
```
attempt 1 (raw ":server start --exit-early\r" written to the PTY):
  "API did not come up" ; TUI shows "No such command: :sync878…"  (keystrokes misparsed)
attempt 2 (Esc, ':', 1 s pause, command, Enter):
  tui: API up after 14776ms
  tui: API still up during/after in-process sync: 200
  log: DecryptionWorker started in-process; SearchEngine "Updated FTS table" runs periodically
  but ":sync" was not executed (no Synchronizer lines), so no data synced within 140 s
```
- The interactive mode does provide in-process services, and the API stays up.
- Driving it by keystrokes is unreliable and has **no machine-readable status or errors**. The automatic sync would only start after `sync.interval` (≥ 300 s).

## Result
**GO-WITH-CONDITIONS** for strategy A (stop-the-world, public CLI commands only) as the default `SyncStrategy`. **NO-GO** for strategy B (TUI under a PTY) as a default; it is kept only as a documented experiment. Strategy C (in-process hooks into CLI internals) was not spiked: it is deferred by ADR-0003 and only revisited if the user rejects the outage.

Conditions:
1. **The outage is ~16–19 s per cycle on the Pi** (expect less on x64). Requests queue during cycles, with `CYCLE_QUEUE_TIMEOUT` defaulting to 60 s. The default interval is 300 s, plus a 30 s debounce after writes. **The user must accept this** (open question Q6), or wait for upstream U3.
2. Containers run with `--init`. The supervisor spawns the CLI directly and reaps it. A cycle never waits on a zombie.
3. The token is rotated on every start, `log-clipper.txt` is truncated, and relayed lines are redacted (shown necessary by evidence 10).
4. Search readiness is tracked separately: about 10 s after `/ping`.
5. The `e2eeAccount` test fixture uses `joplin batch` (enable + sync in one process), and an upstream issue should be filed for the standalone `e2ee enable` persistence bug.

## Follow-ups
- **M3 acceptance criteria use these numbers.** M3-AC4: p95 outage ≤ 2 × the S3 median, i.e. ≤ 34 s on the Pi for small deltas.
- **Upstream-first U3** (sync, decrypt and index while `server start` runs) would remove the outage entirely. The ledger records it.
- **Upstream issue (with user approval):** `joplin e2ee enable --password` doesn't persist the master key in command mode (3.7.1).
- **Production image:** drop the build tools. The base is `node:22-bookworm-slim`. Expected size is ~400–500 MB, which M1-S5 measures.
