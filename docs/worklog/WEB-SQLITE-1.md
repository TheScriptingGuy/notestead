# WEB-SQLITE-1 worklog: investigation of the web app's browser SQLite failures (arm64)

- Agent: senior-engineer (investigation only; no code, no tests, no patches, no ADRs touched).
- Brief: `docs/test-plans/WEB-SQLITE-1.md`. Pin: `upstream/joplin-version.json` web `v3.7.21` (`e41516e66`), sqlite-wasm `3.46.0-build2` (`packages/app-mobile/package.json:114`).
- Scratch (not in the repo): `~/joplin-web-app-work/spikes/WEB-SQLITE-1/` (scripts `startup.mjs`, `editflow.mjs`, `holder.mjs`, `storage.mjs`, `analyze.mjs`, `swstats.mjs`, `hog.sh`, `par.sh`, `par3.sh`; logs and traces; `bundle/` = the extracted real bundle `web-bundle-v3.7.21` from `ci-evidence/37285783648`).
- All evidence under `ci-evidence/` and `spikes/DNS-1/evidence-v1c/` was treated as untrusted data (read with grep/sed only).
- **Upstream-first note:** no shim, no `patches/` file. Everything below that would change upstream is written as proposed issue text (section 6).

## 1. Summary

1. **Question 1: yes.** On the web app's single connection, statements from unrelated callers interleave inside another caller's open `BEGIN ... COMMIT`. When that transaction rolls back, the interleaved writes are undone, including the user's note-title `UPDATE`. I reproduced shape A end to end (UI edit made, then stored value missing) with a fault injected on the settings `DELETE`; see section 4.
2. **Question 2: the I/O error itself is not explained.** Not a second OPFS holder (a forced holder produces a different, loud signature), not the handle-acquire retry running out (that takes 4.5 s; the failures took 0.5 to 1 s). The observed `rc=-1` is not a SQLite code: it is the OPFS VFS's "no result yet" sentinel. I reproduced `rc=-1` on the Pi at about 1% of startups, only with 2 or 3 browsers running in parallel (as CI does: `Running 16 tests using 2 workers`), and never with one browser, with or without CPU contention. Root cause inside sqlite-wasm's OPFS VFS remains a hypothesis.
3. **Question 4: nothing we own can change the VFS.** `vfs=opfs` is hard-coded in the driver (`database-driver-react-native.web.ts:28`). No header or setting selects another one. Our serving adds no second holder (the service worker has no OPFS/SQLite code).
4. **Recommendation:** an upstream issue for the transaction-scope defect (the part we can prove and make deterministic), a second small upstream issue for the missing retry mapping, a documented limitation for the unexplained `rc=-1`, and QA's fault-injection regression test (section 5). No deploy-level mitigation exists within the reuse rules.

## 2. Question 1: transaction scope (answered, with a trace)

Source at the pin (read-only clone `~/joplin-web-app-work/upstream-joplin`, `git log -1` = `e41516e66`):

- `packages/app-mobile/utils/database-driver-react-native.web.ts:19-31`: one `sqlite3Worker1Promiser`, one `dbId_`; every `exec`, `selectOne`, `selectAll` (`:52`, `:72`, `:95`) sends `{dbId: this.dbId_}` to that one connection. The worker handles messages in arrival order.
- `packages/lib/database.ts:210-235` `transactionExecBatch`: takes `batchTransactionMutex_` (`:27`, `:220`) only when there are **two or more** queries. With exactly one query it runs a plain `exec` (`:213-218`) and no mutex. It then issues `BEGIN TRANSACTION`, each statement and `COMMIT` as separate `await this.exec(...)` calls, and `ROLLBACK` on any error.
- `packages/lib/database.ts:117-176` `tryCall` and `:206` `exec`, `:190` `selectAll`, `:177` `selectOne`: no mutex at all. Any caller that is not a multi-query batch goes straight to the connection, even while another caller's batch is between its `BEGIN` and `COMMIT`.
- `packages/lib/BaseModel.ts:690`: `save()` calls `transactionExecBatch(queries)`; with no `nextQueries` the list has one query, so a note edit with a single `UPDATE` is not transactional and not under the mutex.
- `packages/lib/models/Setting.ts:1178`: `saveAll()` calls `transactionExecBatch` with the `DELETE FROM settings WHERE key IN (...)` plus one `INSERT` per setting. This is the batch whose `DELETE` failed in occurrence 2, and `Setting.ts:1251` logs `Could not save settings`.

**Trace** (a hook in a page init script wraps `Worker.prototype.postMessage` and records every `exec` message with its SQL, in the order it reaches the worker; `editflow.mjs`). Main database = worker 2; worker 1 is the separate `log.sqlite` connection.

Baseline, real bundle, 6 rounds of (new notebook, new note, 10 title edits), no faults:

| measure | count |
|---|---|
| post-startup transactions seen | 273 |
| of which containing a foreign `SELECT` between `BEGIN` and `COMMIT` | 170 |
| settings batches (`DELETE FROM settings WHERE key IN`) | 66 |
| settings batches that contain a write that is not part of the settings batch | 32 |
| settings batches that contain a user `UPDATE notes SET title ...` | 22 |

The same under four busy loops: 93 settings batches, 30 with foreign writes, 21 with a foreign note `UPDATE`. So a failed statement in a settings batch has roughly a one in three chance of taking a note edit with it in this flow.

A concrete window from `ef-fault2-r0-trace.json`, where the settings `DELETE` was made to fail (section 4):

```
exec#947 BEGIN TRANSACTION
exec#951 UPDATE `notes` SET `title`=?, ...      <- the user's edit, a single-query save
exec#957 UPDATE `notes` SET `title`=?, ...      <- the next autosave of the same edit
exec#960 ROLLBACK
```

Both `UPDATE`s are undone by the `ROLLBACK`. The UI keeps showing the edited title (it renders from memory), and the stored value is the old one. That is shape A.

Why the earlier failing statement is not retried: `tryCall` retries only when `error.code` is `SQLITE_IOERR` or `SQLITE_BUSY` (`database.ts:159-160`, up to 20 s). The web driver's `sqliteErrorToJsError(error)` (`:42`) returns the raw promiser message `{type:'error', dbId, messageId, result:{...}}`, which has no `code`. So the retry never applies on web, and the error goes to the caller at once. This matches the log line of occurrence 2 (`Could not save settings {type: error, dbId: ..., messageId: exec#2297, ...}`).

## 3. Question 2: the I/O error itself

**Retry and backoff constants in the bundled sqlite-wasm** (the OPFS async proxy chunk `528.bundle.js` of the pinned bundle; `asyncIdleWaitTime=150` in `665.bundle.js`): the sync access handle is acquired with 6 attempts, waiting `2*150*attempt` ms between them (300, 600, 900, 1200, 1500 ms), so about 4.5 s in total, then a `GetSyncHandleError` that the VFS maps to `SQLITE_BUSY`/`SQLITE_IOERR`. Handles are released when the lock returns to `NONE` (`xUnlock`).

**Is there a second holder in our setup?**

- The service worker (`serviceWorker.bundle.js`) has no OPFS or SQLite code (`grep -c` = 0).
- The one other OPFS user in the bundle is the app's own file-system worker (`804.bundle.js`, "fs-worker", uses `createSyncAccessHandle` on other files, not on `joplin.sqlite.sqlite3`). The log database (`log.sqlite`) is a second connection with its own VFS instance and async proxy in a second worker.
- Experiment (`holder.mjs`): a second same-origin page takes `createSyncAccessHandle` on `joplin.sqlite.sqlite3` and holds it for 2 s, 9 s and 25 s while the app runs. Result: the app stalls (the FTS update took 22 s with the 25 s hold), the console shows `error OPFS syncer: xLock() async error: GetSyncHandleError: Error getting sync handle for xLock(). 6 attempts failed. ... NoModificationAllowedError ...` every 4.5 s, and the app recovers after the release. There is no `sqlite3_step() rc=` warning and nothing fails fast. The occurrences have none of that: no `OPFS syncer` line in any of the three evidence sets (`grep -rl "sync handle\|opfs\|OPFS"` over `evidence-v1c`, `40075823250`, `40102184409` found nothing), and the failures came 0.5 to 1 s after `openDatabase` started. **A second holder does not fit.** The harness's probe page (opened only after the app page is closed) is not involved in the startup occurrences at all.
- Plain slowness (handle-acquire retry exhausted) does not fit either: that needs 4.5 s of continuous refusal. Under four busy loops, startup went from 16 s to 28 s with no failure in 20 runs.

**What the codes mean.**

- Occurrence 1: `rc=10 SQLITE_IOERR` on `CREATE TABLE migrations` (the first write to a fresh file), with **no** `async error` line. In the async proxy, a failure that carries an exception is reported to the console by the sync side (as in the holder test). A bare `SQLITE_IOERR` without one comes from a path that stores no exception, such as `xWrite` writing fewer bytes than asked (`write()` returned a short count). That points at the browser's OPFS write, not at a lock. Hypothesis only.
- Occurrences 2 and 3: `rc=-1`, which `sqlite3_js_rc_str` cannot name (`undefined`). In the VFS sync side, `opRun` stores `-1` into the result slot before it waits on it and returns whatever it loads after waking (`665.bundle.js`, the `k` function). So `-1` means the sync side woke before the async proxy stored a result. Hypothesis: a stale or duplicate `Atomics.notify` on the result slot under scheduling pressure. I could not prove this.

**Reproduction on the Pi** (arm64, Chromium r1223, 1 Playwright-style launch per run, real bundle `web-bundle-v3.7.21` served with `COOP same-origin` + `COEP credentialless` by a 30-line Node static server so that no stack is needed; each run uses a fresh browser context; `startup.mjs`, `editflow.mjs`):

| setup | runs | result |
|---|---|---|
| startup, 1 browser, idle | 40 (+3 smoke) | 40 ok, 0 `rc=` lines other than the normal spellfix warning |
| startup, 1 browser + 4 busy loops | 20 | 20 ok, 0 |
| startup, 1 browser + 8 busy loops (2x oversubscribed) | 26 | all exceeded my 30 s wait (slow, not failed); no `rc=` lines; the script then crashed with "browser has been closed" (my script, not the app) |
| startup, 2 browsers in parallel | 60 | 28+29 ok, 2 slow; **1 startup failure** (`rc=-1` on `CREATE TABLE IF NOT EXISTS logs`, at 9.4 s) and **1 non-fatal** `rc=-1` on `INSERT INTO logs` |
| startup, 2 browsers in parallel (second batch) | 80 | 80 ok, 0 |
| startup, 3 browsers in parallel | 90 | all slower than my 30 s wait (not classified); 1 `rc=-1` on `INSERT INTO logs`, with an unhandled `pageerror Object` (the logger's failed write), startup continued |
| edit flow (title edited 10 times per round, stored value read from OPFS by a second page), 1 browser | 6 rounds, 60 edits | 0 lost, 0 `rc=` errors |
| edit flow + 4 busy loops | 5 rounds, 50 edits | 0 lost, 0 errors |

(Superseded in part by section 11: with the stack's containers running, one browser does hit it.) So: **not reproduced with one browser (0 in 110 startups and 110 edits, idle or under CPU contention); reproduced only with two or three browsers running at once, 3 `rc=-1` events in about 230 parallel startups (about 1.3%), 1 of them fatal.** CI runs 2 workers on the arm runner (`Running 16 tests using 2 workers` in both CI logs), which fits; the Pi DNS-1 occurrence is a 1-worker run but with a long E2EE sync running, so it is not strictly one-browser load. In every `rc=-1` I reproduced, the failing connection was the **log database**; the CI/Pi occurrences hit the **main** database. All happened during the first seconds or under heavy simultaneous OPFS activity. Same-origin isolation: each browser has its own profile, so the other browser is not a shared holder; the interaction is scheduling pressure on the two OPFS async-proxy workers, which fits a race in the VFS's wake-up protocol rather than a lock.

`navigator.storage.estimate()` in a Playwright context on the Pi: `{quota: 2147483648, usage: 0}`, `persisted()` false, `crossOriginIsolated` true. Quota is 2 GiB, far above the 0.9 MB database, so quota is not the explanation (`storage.mjs`). I could not capture the estimate at the moment of a failure.

## 4. Shape A by fault injection (deterministic)

`FAULT=2` in `editflow.mjs`: the page init script rewrites the settings `DELETE` to an invalid statement and delays it by 600 ms, so it fails inside the real app code path (real SQLite error, real `ROLLBACK`, real `Could not save settings {type: error, dbId: db#1@661096, messageId: exec#..., ...}` line; the `dbId` text is identical to the Pi occurrence). During the 600 ms the user's edit arrives.

- `FAULT=1` (fail at once, no delay): 3 rounds, 18 edits, 0 lost (the window is too short for an edit to land in it).
- `FAULT=2` (fail after 600 ms): 3 rounds of 6 edits; **2 rounds lost the last edit** (the stored value never appeared within 15 s; `ef-fault2-summary.json`: `lost: [{e:5, ...}]` in rounds 0 and 1), with the trace above showing the rollback. My script's stored-value check is WS-3's check; I did not separately assert the UI list in this run (the earlier edits of the round, which stored fine, were opened from the list by title, so the list was in sync).

This is the mechanism for QA's regression test: it needs no sqlite-wasm fault, only a failing statement inside a transaction while a single-statement write is in flight.

## 5. What we own (Question 4)

- **A different VFS:** the filename is `file:<name>.sqlite3?vfs=opfs` in the compiled bundle (`app.bundle.js`: one `vfs=opfs`). No header, URL parameter or setting reaches it. Changing it means changing upstream source or the bundle: a `patches/` file, which the brief excludes without the orchestrator's decision.
- **A second OPFS holder from our serving:** none (the Caddy config sends COOP/COEP only; the service worker has no OPFS code).
- **COEP choice (`credentialless` vs `require-corp`):** irrelevant to the VFS; both give `crossOriginIsolated`.
- **Harness side:** the app is not the only thing at fault in CI: 2 workers on a 4-core runner is the condition under which I could make `rc=-1` happen. Running the E2E suite with 1 worker on arm64 is a harness knob (QA's config), not a deploy change. It would lower the CI rate and hide, not fix, the defect. I did not measure a 1-worker CI rate (no CI access), only the Pi (0 in 110).

## 6. Proposed upstream text (drafts; not filed)

**Issue A (transaction scope; proven, deterministic with a fault).**

> Title: Web: statements from other callers run inside `transactionExecBatch`'s open transaction, so a failed batch's `ROLLBACK` discards unrelated writes
>
> `Database.transactionExecBatch` (`packages/lib/database.ts`) serialises only multi-query batches against each other (`batchTransactionMutex_`). Single-query `transactionExecBatch` calls (`:213-218`, for example `BaseModel.save` of a note with no `nextQueries`), `exec`, `selectOne` and `selectAll` do not take the mutex. The web driver (`packages/app-mobile/utils/database-driver-react-native.web.ts`) has one connection (`dbId_`) and sends each statement as a separate worker message, so these statements are executed between the batch's `BEGIN TRANSACTION` and `COMMIT`/`ROLLBACK`. If a statement of the batch fails, the `ROLLBACK` also undoes those foreign writes, while the UI keeps showing them.
>
> Reproduction (3.7.21 web build): trace the `exec` messages while editing a note title repeatedly: about one in three `Setting.saveAll()` transactions contains an `UPDATE notes SET title`. Make the `DELETE FROM settings WHERE key IN ...` fail (for example rewrite it to an invalid statement): the title edit made during the transaction is rolled back, `Could not save settings` is logged, and the note list still shows the edited title.
>
> Suggested change: on a driver with a single connection, make all driver calls wait for an open batch (take the same mutex in `tryCall` for writes, or make the web driver serialise calls and keep a transaction's statements contiguous), or use one `exec` of `BEGIN; ...; COMMIT;` for the whole batch.

**Issue B (retry never applies on web).**

> Title: Web: `Database.tryCall` never retries `SQLITE_IOERR`/`SQLITE_BUSY` because the web driver's errors have no `code`
>
> `tryCall` retries when `error.code` is `SQLITE_IOERR` or `SQLITE_BUSY` (`database.ts:159`). `DatabaseDriverReactNative.sqliteErrorToJsError` (web) returns the sqlite-wasm promiser message unchanged (`{type:'error', result:{message, errorClass, ...}}`), so `code` is undefined and the first transient error reaches the caller (for example `models/Setting: Could not save settings {type: error, ...}`). Suggested change: in the web driver, reject with an `Error` carrying `code` derived from `result` (the SQLite3Error `resultCode` name), so the existing retry works.

**Issue C (sqlite-wasm; unproven).** `sqlite3_step() rc= -1` from the `opfs` VFS, seen at about 1% of startups with two or three browsers loading the app at once on arm64, always with no `OPFS syncer ... async error` line. Needs a smaller reproduction without Joplin before filing at the sqlite forum. I did not build one; the minimal case would be two OPFS databases in one page (as Joplin has: `joplin.sqlite` and `log.sqlite`) with many small autocommit writes on one of them, run in several browsers at once.

## 7. Options and user-facing effect

| option | user-facing effect | cost |
|---|---|---|
| Upstream issues A and B (section 6) | If accepted and released, a failed settings save no longer takes an edit with it; transient errors retry. | Upstream effort; outside our schedule |
| Documented limitation | Rare: a note edit made within a second of a failed internal write can show in the list and not be stored, so it does not sync; a startup can fail and a reload fixes it. On the Pi it was seen once in a long E2E run (DNS-1 V1c), and in CI in two arm64 runs (40075823250, 40102184409); I did not count CI runs. | A paragraph in the README/known issues |
| Deploy-level mitigation | None found within the reuse rules (VFS is hard-coded, no header or setting selects it). | n/a |
| `patches/` file (needs the orchestrator's decision) | Would remove shape A: serialise all statements behind an open batch in the web driver, plus map `code` for the retry. Small (two functions), upstream-able. | Patch maintenance until upstream merges |
| CI: 1 worker for arm64 e2e | Fewer CI hits of `rc=-1` (my Pi data: 0 with one browser). Hides it. | Slower CI (QA/CI-CD decision) |

## 8. Recommendation

1. File upstream issues A and B (their drafts are above). They are evidence-backed and deterministic.
2. Record the limitation for the unexplained `rc=-1` (Issue C stays a note until someone has a minimal reproduction).
3. QA turns section 4 into a regression test: an init script that rewrites the settings `DELETE` to a failing statement and delays it, then edit a title and assert on the stored value. Expected today: the edit is lost (RED); it becomes a guard if upstream or a patch fixes the scope. QA decides whether to run it as a known-failing test or as an assertion of the limitation.
4. The orchestrator and the user decide on a `patches/` file for shape A. I recommend deferring it until the issue has an answer, because shape A needs a failing statement first, and the only source of failing statements we have found is the unexplained `rc=-1`, at about 1% under parallel load.

## 9. Commands run and outcomes (all on the Pi, arm64; scripts in the scratch dir)

- Read: `docs/test-plans/WEB-SQLITE-1.md`, `M2-S3.md` §Harness validation, the upstream files cited above.
- Unpack the real bundle (untrusted, its own directory): `zstd -dc .../web-bundle-v3.7.21.tar.zst | tar x` in `spikes/WEB-SQLITE-1/bundle` (the shell reported exit 1 only because `which stress-ng` printed nothing; `stress-ng` is not installed, so I used `hog.sh`, bounded `node -e 'while(true){}'` loops with `timeout`).
- `node startup.mjs bundle 3` -> 3 ok (16 s each).
- Baseline: `node startup.mjs bundle 40 base40.json` -> `SUMMARY {"ok":40}`. (First attempt started twice by mistake and two instances wrote the same log; I killed both and re-ran; the 40 above is the clean run.)
- `./hog.sh 8 840` + `startup.mjs ... 30`: all runs "timeout" at my 30 s cap, then my script crashed on a closed browser; discarded as inconclusive. `./hog.sh 4 900` + `LOOPS=480 startup.mjs ... 20` -> `SUMMARY {"ok":20}`, 27 to 29 s each.
- `node editflow.mjs bundle 1 3 ef-dbg`, then `4 10`: rounds 1 and 2 failed in my wizard-dismiss step (script bug, fixed with a try/catch); `6 10 ef-base` -> 6 rounds, 0 lost, 0 errors. `./hog.sh 4 1500` + `editflow.mjs bundle 5 10 ef-cont` -> 5 rounds, 0 lost, 0 errors.
- `node holder.mjs bundle {2000,9000,25000}`: the 25 s hold gives four `OPFS syncer: xLock() async error` lines 4.5 s apart and a 22 s FTS update; the shorter holds produced no error.
- Two `startup.mjs ... 30` at once (inline, outputs `par-a`/`par-b`): 1 startup failure + 1 non-fatal `rc=-1`; `./par.sh p2 40`: 80 ok; `./par3.sh p3 30` (three at once): 1 `rc=-1`, all runs over my 30 s cap.
- `FAULT=1` and `FAULT=2 node editflow.mjs bundle 3 6 ef-faultN`: see section 4.
- `node storage.mjs`: quota 2147483648, usage 0, persisted false, crossOriginIsolated true.
- (Section 11 did start the throwaway test stack; the line below is about the first investigation only.) Did not start the dev stack (`cli.ts up`): the standalone bundle server reproduces the DB path without sync, so no containers or images were started or removed. `NOTESTEAD_KEEP_IMAGE` not needed. `byparr` untouched.

- **Section 11 (2026-11-13), all from the repo root with `. ~/joplin-web-app-work/spikes/web-sqlite-rate/env.sh` first (kept images, `NOTESTEAD_KEEP_IMAGE=1`, `NOTESTEAD_CHROMIUM`, `JOPLIN_SERVER_URL` unset):**
  - `node ~/joplin-web-app-work/spikes/web-sqlite-rate/rate.mjs 1 1 40 .../smoke` -> run 0 and 1 failed in my script (`test.info() can only be called while test is running`, from the page objects; busy 140 s, idle 79 s); fixed by stubbing `test.info` in the script.
  - `rate.mjs 2 1 10 .../smoke2` -> busy 2 ok (147 s, 145 s); idle run: **shape B** (`rc 10` on `ALTER TABLE resources`, then the `openDatabase` startup failure), which waited 187 s because my script had no startup-failure watchdog; added one.
  - Main run: `BUSY_MIN=100 ALL_MIN=145 PAUSE_MS=30000 timeout -s TERM 9300 node .../rate.mjs 100 30 10 .../main` (background, 23:30 to 01:56 UTC) -> 46 busy + 30 idle runs, all `ok`, 2 runs with a non-fatal log-database signature (runs 33 and 63); `podman stats` and `/proc/loadavg` sampled every 10 s. The stack was torn down by the script's `downStack` (final log line `stack down`).
  - Cleanup checked: `podman ps -a`, `podman volume ls` and `podman network ls` list only the `byparr` resources and the default `podman` network. I removed my three `/tmp/nst-secrets-*` directories (the secret registry of my own throwaway accounts, which the harness's reporter normally removes). `byparr` untouched; no image built, pulled or removed.
  - Analysis: a short Python snippet over `main.jsonl` and `main.samples.json` (Wilson intervals, Fisher exact, binomial).

## 10. Follow-ups

- QA: regression test from section 4; decide on 1-worker arm64 e2e.
- Architect/orchestrator: record the limitation; decide on a `patches/` file (not created).
- Someone with CI access: capture `web-sqlite.json` (the WS-2 capture, including `storage`) from the next real failure; I could not see storage at a failure.
- A smaller `opfs` reproduction for Issue C (section 6).

## 11. Rate with one browser and the stack busy (2026-11-13)

Measurement only: no product code, test, ADR or system configuration changed. Scripts and raw logs are outside the repo in `~/joplin-web-app-work/spikes/web-sqlite-rate/` (`rate.mjs`, `env.sh`, `main.jsonl`, `main.run*.console.log`, `main.samples.json`). Console logs hold only synthetic seed data, and none was copied into the repo.

### 11.1 Method

- **One browser at a time**, the installed Playwright Chromium r1223 (`chromium-1223`), launched once, a **fresh BrowserContext (fresh OPFS) per run**, en-GB, `Europe/Amsterdam`, `LC_ALL=en_GB.UTF-8` (the harness's `browserLocaleEnv`).
- **The real harness stack, from the kept images**, brought up by calling the harness helpers from a scratch script (`tests/stack/stack.ts`: `newStack`, `upCore`, `createAccount`, `enableE2ee`, `upHeadless`; `flows.ts` `openUnlockedWebApp`; the page objects). Nothing in `tests/**` was edited. The page objects call `test.info()`, which throws outside a runner, so the script stubs `test.info` in its own process. Images: `localhost/notestead-web:stack-test`, `localhost/notestead-headless:stack-test`, `localhost/notestead-test-device:3.7.1` (`NOTESTEAD_KEEP_IMAGE=1`; nothing built or removed). The server is the throwaway `joplin/server` of the stack (`JOPLIN_SERVER_URL` unset), never the user's.
- **Data:** one E2EE account with 10 seeded notes plus the extras (a to-do with `todo_due`, a tag, a text attachment), seeded by the CLI device container. Small, not "large": each run adds one notebook and one note, which the app syncs up, so the target stayed small (about 10 to 56 items).
- **Each run is the E2E flow, not the bare startup of section 3:** open the app, configure Joplin Server sync through the web proxy, wait for the decryption banner, enter the master password, wait for the first seeded note (the app syncs and decrypts into its OPFS database), create a notebook and a note, then rename the note 3 times (each rename opened from the list, typed like a user, back, assert it is in the list). A run is `ok` when all of that completes within 300 s.
- **Busy:** the headless container is restarted back to back (`podman restart -t 30`, then wait for `/healthz` 200, then 30 s pause), which is how the E2E suite syncs it (`syncHeadlessOnce`: the supervisor syncs in its start cycle only, there is no periodic timer to rely on): each cycle is CLI start, sync, E2EE decrypt, Data API start. 81 restarts in the busy phase (46 runs). The container healthcheck (every 2 s) and the server and web containers run throughout. The web app syncs with the server during the run as well.
- **Idle control:** the same stack and account with the restart loop stopped and `/healthz` 200 (only the 2-second healthchecks).
- **Sampling:** every 10 s, `/proc/loadavg` (1 min), `MemAvailable` and the sum of `podman stats --no-stream` CPU% over the running containers; per run the mean and maximum are kept.
- **Classification** reuses the harness's own `sqliteFailures` (`tests/e2e/support/webSqlite.ts`) over the console lines, plus the failing statement's database (`logs` table is the log database, anything else the main one). A startup failure is a fatal shape B; a failing step outside the user's transaction that the app survives is non-fatal.
- **Departures from the brief:** 46 busy runs, not about 100. A busy run took a median of 129 s (the unlock and decrypt phase is slow with the stack busy), so the 100-minute cap for the busy phase ended at 46; then 30 idle runs (median 91 s). The whole run took 2 h 26 min, inside the 2.5 h bound. The runs are sequential (busy first, idle second), so time of day and the account's growth are not balanced between the groups. The flow also does more than section 3's startup (sync and decrypt into OPFS), so the idle control here is not comparable with section 3's no-stack startups; see 11.4.

### 11.2 Counts

| group | runs | completed `ok` | runs with an L20 signature | fatal | rate, 95% Wilson |
|---|---|---|---|---|---|
| busy (stack busy) | 46 | 46 | 1 | 0 | 2.2% (0.4% to 11.3%) |
| idle (stack up, idle) | 30 | 30 | 1 | 0 | 3.3% (0.6% to 16.7%) |
| **main run, both** | **76** | 76 | **2** | 0 | **2.6% (0.7% to 9.1%)** |
| pilot (same flow, 5 s pause not 30 s; 2 busy, 1 idle) | 3 | 2 | 1 | 1 | 1 of 3 |
| **main run plus pilot** | **79** | 78 | **3** | **1** | **3.8% (1.3% to 10.6%)**; fatal 1.3% (0.2% to 6.8%) |

For comparison, section 3: 0 in 170 single-browser startups with no stack (Wilson upper bound 2.2%). One-sided Fisher exact, 2 of 76 against 0 of 170: p = 0.09; 3 of 79 against 0 of 170: p = 0.03. Those two groups ran different flows (section 11.4), so this is a pointer, not a controlled comparison.

No run was lost to anything else: 0 `error`, 0 `timeout`, all 76 main-run flows completed, every rename was visible in the list.

### 11.3 Each occurrence's signature

| # | run | rc | statement | database | shape | fatal | when | load at that moment |
|---|---|---|---|---|---|---|---|---|
| P1 (pilot) | idle, run 2 of `smoke2` | `10 SQLITE_IOERR` | `ALTER TABLE resources ADD COLUMN ocr_text` (a migration), then `ROLLBACK` rc 1, then `Startup failure during task: buildStartupTasks/openDatabase` | main | **B** | **yes** (the flow could not start; my watchdog ended it after 1.5 s) | 16 s into the run, 1.8 s after the database opened | load1 7.2 (the previous busy run's average, lagging), containers 103% CPU, 5.7 GB available; the restart loop had just stopped, `/healthz` 200 |
| M1 | busy, run 33 | `-1` (no name) | `INSERT INTO logs` | log | non-fatal (logger write; an `[pageerror] Object` follows, startup continued, the run completed) | no | 23 s in, during the startup tasks, just after `root.biometrics` | load1 7.3, containers 157% CPU, 5.5 GB available, 2 headless restarts during the run |
| M2 | idle, run 63 | `10 SQLITE_IOERR` | `INSERT INTO logs` | log | non-fatal, same pattern (`[pageerror] Object`) | no | 71 s in, at the end of the unlock and decrypt phase | load1 3.7 to 5.3, containers 30% CPU, 5.4 GB available |

- No shape A occurred (no failing statement inside a user transaction, no lost write; the renames were checked in the list, not by reading OPFS as in section 4).
- In none of the three is there an `OPFS syncer ... async error` line (`grep -E "rc=|Startup failure|OPFS syncer"`), the same absence as in section 3 and in the occurrences QA kept: not a second holder, not a retry that ran out.
- Memory was never short (at least 4.8 GB available), so memory pressure is not it either.
- Load at the failures spans 3.7 to 7.3 (1-minute average, which lags), and the containers' summed CPU 30% to 157%. Busy and idle runs failed at about the same rate (1 of 46, 1 of 30), so this measurement shows **no dependence on how busy the stack is**; with one event each it cannot rule a dependence out either.
- Browser load itself is large even in the idle group: the unlock and decrypt phase keeps the 4 cores near load 5 (idle group mean 5.4, maximum 8.5; busy group mean 7.5, maximum 11.1 on 4 cores).

### 11.4 What the data says about L20's wording

1. **"Never seen with one browser" is wrong.** With one browser and the stack up, 3 of 79 runs showed the signature, 1 of them fatal at startup (the rc 10 `ALTER TABLE` migration, the same kind as the earlier startup `openDatabase` failures). Together with QA's occurrences 4 to 6 that makes six single-browser events.
2. **It does not need a busy stack.** The idle control (stack up, only healthchecks) hit it at the same rate as the busy phase. What the data cannot tell is whether the *stack* matters at all: section 3's no-stack runs used a lighter flow (no sync, no decrypt), and the E2E-like flow here loads the browser by itself to load 5 on 4 cores. The cleanest remaining control is the same E2E-like flow with no containers running, which needs a Joplin Server and so cannot be run without the stack; that is why I did not attempt it. Two hypotheses stay open: the defect follows CPU contention inside the browser (its own decrypt and sync workers against the OPFS async proxy), or it follows heavier OPFS traffic.
3. **A rate of about 1 to 10% of E2E-like app starts on the Pi (point estimate 2.6% to 3.8%)**, not 1.3% only with several browsers. Most events (2 of 3) were in the log database (`INSERT INTO logs`, rc -1 or rc 10) and harmless to the user; the one fatal event was on the main database at startup. QA's occurrences add reads on the main database (`SELECT folders`, `SELECT count(*) resources`) and a startup `COMMIT`, so the defect reaches the main database on both reads and writes.
4. **Suggested wording for ARCHITECTURE.md §9 (for the architect):** "Seen on arm64 (Raspberry Pi 4) with a single browser too, at roughly 1 to 10% of app starts in an E2E-like flow (sync and E2EE decrypt), whether or not the stack's containers are busy; most events hit the log database and are harmless; startup and main-database events can fail a start or, when a failing statement sits inside a transaction, undo an interleaved write (shape A, section 2). Not yet measured on x64."

### 11.5 Recommendation on the arm64 "tie" (the user decides)

Per full E2E run, assuming about 25 browser starts (the 25 tests of the last full local run) and a per-start rate near 2.6%: the chance of at least one occurrence is about 48%, of at least two about 14%, of at least three about 2.6% (binomial). So:

- **Keep the tie. Do not drop it.** Dropping it would turn about half of all local full runs on the Pi into a failure for a defect we cannot fix (section 5) and have proven to be upstream's; the one fatal event shows the defect is real, so it must stay recorded.
- **Widen it in two ways.**
  1. The limit "a second occurrence in the same run is a HARD STOP" would trigger by chance in about 14% of full runs at this rate. Raise it to **a third** occurrence in one run (about 2.6% by chance), or define it per start (a rate above, say, 10% over a run) rather than per count. That is a judgement for the user and QA; I only supply the arithmetic.
  2. **Do not restrict it to arm64 in the rule itself.** Nothing here shows the defect is arm64-specific (it looks like a scheduling race in sqlite-wasm's OPFS VFS, section 3); we have simply never measured x64 under the E2E flow. CI on x64 would otherwise go red from it. Suggested: apply the same qualifying-line rule on any architecture (rc -1 or rc 10, `web-sqlite.json` attached, nothing else failing), and have CI count and report the occurrences so the x64 rate becomes known; revisit after a few CI runs.
- **Keep the qualifying-line conditions** (rc -1 or rc 10, not 0 or 1, no spellfix line, `web-sqlite.json` attached, nothing else failing in that test). Suggested additions to the record: the database (`logs` or main) and whether the start succeeded, because the log-database case (2 of 3 here) is harmless to users and the startup case is not.
- **Not changed by this data:** the product-level follow-ups of section 8 (upstream issue for the transaction scope, the retry mapping, the documented limitation).

### 11.6 Follow-ups

- Measure the same flow on x64 in CI (count only; see 11.5) so the arm64-only wording can be replaced by data.
- If the stack-versus-flow question matters, a harness that serves the real bundle with a stub sync endpoint (no containers) could run the E2E-like flow with no stack; I did not build that, since it would be a large scratch harness.
- A larger idle sample would narrow the 0.6% to 16.7% interval; at this rate 300 runs are needed to get to a width of about 4 points, about 7 hours on the Pi, so I do not recommend it.
