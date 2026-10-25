# WEB-SQLITE-1: the web app's browser SQLite fails on arm64. Senior-engineer investigation brief

- **Origin:** DNS-1 finding W-DNS1-1, upgraded to a bug (`docs/test-plans/DNS-1.md` §"The finding" and §T). It is queued first in M2-S3 (`docs/backlog/STATUS.md`). The M2-S3 QA side is in `docs/test-plans/M2-S3.md` §Revision 2026-10-25, WS-1 to WS-6.
- **Occurrences, all arm64:**

  | # | Where | Shape | The lines (verbatim, cut as the log cuts them) |
  |---|---|---|---|
  | 1 | CI e2e 40075823250, `m2-s1/e2ee-unlock.spec.ts:181`, attempt 1 | B, startup | `[warning] sqlite3_step() rc= 10 SQLITE_IOERR SQL = CREATE TABLE migrations (…)` then `[error] … root: Startup failure during task: buildStartupTasks/openDatabase` |
  | 2 | Pi, DNS-1 V1c, `m2-s2/notes.spec.ts:102` | A, lost write | `[warning] sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN (…)` then `[error] … models/Setting: Could not save settings {type: error, dbId: …, messageId: exec#2297, …}`. The UI showed the edited title; the synced copy had the old one |
  | 3 | CI e2e 40102184409, `m1-s7/walking-skeleton.spec.ts:107`, attempt 1 (a flake) | B, startup | `rc= -1 undefined SQL = COMMIT`, `rc= 1 SQLITE_ERROR SQL = ROLLBACK`, then `Startup failure during task: buildStartupTasks/openDatabase` |

- **Why it matters:** a user's edit can be shown in the UI and silently never stored, so it never syncs. Or the app can fail to start.
- **The rules: reuse, never fork** (CLAUDE.md). The deliverable is an evidence-backed upstream issue, or a deploy-level setting we own. **No `patches/` file without the orchestrator's decision.**

## Facts from the source at the pin (`v3.7.21`), read by the planner
- `packages/app-mobile/utils/database-driver-react-native.web.ts` opens the database through `@sqlite.org/sqlite-wasm`'s `sqlite3Worker1Promiser`, with `filename: file:<name>.sqlite3?vfs=opfs`. That is the **`opfs` VFS**: an async proxy worker plus `SharedArrayBuffer`/`Atomics`. It is **not** `opfs-sahpool`. Its comment says WAL is not enabled.
- Every statement goes through **one** worker connection (`dbId`). `@joplin/lib`'s `Database` (`transactionExecBatch`, and the `BEGIN`/`COMMIT` it issues) runs on that single connection, from asynchronous callers that do not wait for each other.

## Questions to answer (investigation first)
1. **Transaction scope.** On the single web connection, can statements from unrelated callers interleave inside another caller's open `BEGIN … COMMIT`? Read `@joplin/lib/database.ts` and the web driver at the pin. A trace of the statement order is better still, see 3.

   If they can, then the failed `COMMIT` (occurrence 3) or the failed settings `DELETE` (occurrence 2) followed by `ROLLBACK` would undo the user's note save. That would explain shape A: the UI updated from memory, and the row rolled back.
2. **The I/O error itself.** The `opfs` VFS gets a sync access handle per file, and has a bounded retry when the handle is busy, which then gives `SQLITE_IOERR` or a lock error.
   - Is there a second holder in our setup? For example the service worker, or a second tab (the harness opens a same-origin probe page only after closing the app page, `localProfile.ts`).
   - Or is it plain slowness on arm64, the handle-acquire retry running out?
   - Look up the retry and backoff constants in the bundled sqlite-wasm version.
3. **Reproduce on the Pi:**
   - Use a dev stack (`node tests/stack/cli.ts up`, report the project, `cli.ts down` afterwards).
   - Run M2-AC3's edit flow in a loop, or a minimal page from the served bundle that edits a note title while settings are written. Record every `sqlite3_step() rc=` line, every `Could not save`, and the order of `BEGIN`/`COMMIT`/`ROLLBACK`. QA's WS-2 capture shows the shape.
   - Also record `navigator.storage.estimate()` and `navigator.storage.persisted()`.
   - Then try once under CPU contention (a second heavy process) to see whether it is timing-related.
4. **What we own, evaluated but not implemented:**
   - Any `web`-served header or setting that would make the app choose a different VFS. Probably none, since the driver hard-codes `vfs=opfs`.
   - Anything in our serving that adds a second OPFS holder.
   - If the cause is upstream, a minimal reproduction for the upstream issue, and the reasoning for which VFS or transaction change upstream should make.

## Deliverable
`docs/worklog/WEB-SQLITE-1.md` holds:
- the answers to questions 1 to 4, with source references at the pin;
- the reproduction recipe and its counts;
- the proposed path: an upstream issue (its draft text), a deploy-level change, or a documented limitation for the architect, if nothing we own can help.

QA turns the confirmed mechanism into a regression test (fault injection, if the mechanism permits it).
