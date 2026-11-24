# M2-S5 work orders (QA executor)

These orders implement `docs/test-plans/M2-S5.md`. Read that plan first. Its Findings F1 to F8, Interpretations I1 to I7, Planner decisions D1 to D11, the AC table, the harness table and the sensitivity table are the design. Each order gives the files, signatures, assertions, the commit split and subjects, the commands, the expected outcome and the stop points. Upstream paths are `upstream:packages/…` under `~/joplin-web-app-work/upstream-joplin/` at `v3.7.21` (read-only).

**The story's shape.** The behaviour under test is upstream's (its service worker, its database-version check), and it exists at the pin. The planner expects `M2-AC15-01/-02` and `M2-AC16-01/-02/-03` to **pass on arrival** once the harness exists; RED for the right reason cannot be manufactured for upstream behaviour that exists. Their power to fail is proven by the NEGs, the in-test controls and the sensitivity runs (WO-7). The one RED that waits for the SE is `U-AC16-RB-01` (R1, the runbook). Harness failures are stop points; product facts are recorded.

## Rules for every order
- **Branch:** `feat/M2-S5-offline-upgrade`. WO-0 checks it.
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
  If the orchestrator's dispatch names your model, use it in `Co-Authored-By`.
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat` or `fix`, and never push. Stage by path (`git add <path>`), never `git add -A`.
- **Paths:** write only `tests/**`, `playwright.config.ts`, `docs/testing/**` and `docs/test-plans/M2-S5*.md`. Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**`, ADRs, the architecture or STATUS.
- **Upstream bytes:** the derived bundles (plan D1-D3) live only under `test-results/` (gitignored) and are removed at worker teardown. Never commit a bundle file, a bundle excerpt or a hash list of upstream files. Upstream source (D3's `base` and `n`) is read through git at test time (the M2-S6 D1 lookup).
- **Test-first history:** an order marked **RED → GREEN** is two commits.
  1. **The failing test.** Before committing: `corepack yarn eslint --max-warnings 0 <its files>` clean; `corepack yarn tsc -p tsconfig.json` (and `-p tests/acceptance/tsconfig.json` for `.mts`) with **only** the missing modules or exports the RED is about; the RED run logged under `red/`.
  2. **The support code,** the test passing, logged under `green/`. If the GREEN touches a shared harness module (`fixtures.ts`, `stack.ts`, `localProfile.ts`, `network.ts`, `webSqlite.ts`, `flows.ts`, `unoverlaid.ts`, `pages/joplinWebApp.ts`, `playwright.config.ts`), also run `corepack yarn jest tests/unit/harness tests/integration/harness`. All must pass.
- **Tests:**
  - No `.only`, `.skip`, `fixme`, `waitForTimeout`, `test.slow()` or sleeps. Wait only with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only with `typeLikeUser`/`clearLikeUser` (through `NoteScreen.typeBody`/`typeTitle`). Never `fill()` or `dispatchEvent`.
  - Never weaken an assertion; never change an asserted upstream string (the F1 refusal text, `Startup error.`, `Reloading page to make use of updated COOP/COEP Service Worker.`).
  - Every spec uses `test.describe.configure({ timeout: longSpecTimeoutMs })` and `requireUpstreamBundle(stack, 'M2-S5')`. No spec writes its own timeout number; bounds are plan D11.
  - Locators are role- or label-based. Never CSS classes.
  - Exactly **one** `page.reload()` per "one online reload" step. Upstream's own reloads are counted from the console, never caused by the test.
  - Failure messages and annotations are value-free: item ids, field names, counts and markers, never note text (M2-S2 r1 C4).
  - No screenshots, no `--trace on`, no `use.trace`.
- **Working tree during a run:** never keep another order's uncommitted files in the tree while running a command. A sensitivity edit starts only after its order is committed and is reverted with `git checkout -- <file>`.
- **Run environment (every heavy command):**
  ```sh
  cd ~/Joplin-Web-App
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/44916780204/extracted/web-bundle-v3.7.21
  export NOTESTEAD_KEEP_IMAGE=1
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); LANG=C.UTF-8 timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  e2e_pre() { [ -d test-results/e2e/stack ] && mkdir -p test-results/verify/m2-s5/stale-stack && mv test-results/e2e/stack "test-results/verify/m2-s5/stale-stack/$(date +%s)"; true; }
  IMG="NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1"
  ```
  - `$IMG` only after WO-0 step 4 says the kept web image was built from **this** artifact; until then, run without `NOTESTEAD_WEB_IMAGE` (the harness builds and keeps it).
  - **One heavy job at a time** (E2E, the `H-NR-01` integration run, full `yarn lint`, image builds, `check:no-upstream-copy`), in the background with `timeout`. **One Playwright worker** (never pass `--workers`).
  - After every E2E run: copy `test-results/e2e/junit.xml` next to its log as `<name>-junit.xml`, copy `test-results/e2e/not-run.json` (once WO-3 exists) as `<name>-not-run.json`, and run `node tests/harness/tools/scan-l20.ts test-results/e2e > <log dir>/<name>-l20.txt`. Run `e2e_pre` before every E2E run.
  - Logs: `test-results/verify/m2-s5/<phase>/<name>.log`, `<phase>` = `red`, `green`, `run`, `sens` or `verify`.
- **Images:** never `podman rmi`, `image prune`, `tag` or `untag`. An unexpected image state is a **RECORD**. A test-labelled container or stack you did not start is a **HARD STOP**; don't remove it. Never touch `byparr` or any unlabelled podman resource.
- **Network:** nothing in this story needs the internet, except the blobless upstream fetch if the local clone lacks the pin (it has it). Never point anything at a real Joplin Server.
- **L20 (plan D10):** record qualifying failures; never re-run to get green; the third in one Playwright invocation is a **HARD STOP**. The expected refusal of `M2-AC16-02` is not an occurrence.

### Stop points
- **HARD STOP.** Allowed: collect the evidence the order names (logs, `error-context.md`, the trace path, an `ariaSnapshot()`, the browser console, the test web container's log, `podman ps -a`/`podman images`); re-run the **same** command once only if the order says so; read upstream source; revert temporary edits; write the finding under `## Findings (executor)` in `docs/test-plans/M2-S5.md`, uncommitted; end your turn with a report (order and step, what happened, evidence paths, your view of the cause, `git status --short`). **Not allowed:** changing code, tests, locators, timeouts or config; adding a retry, a wait or a workaround; committing; continuing with other orders; removing containers or images.
- **RECORD.** Write the observation under `## Findings (executor)` with its evidence, and continue. Change nothing because of it.
- **PRODUCT FAILURE.** A test fails, the harness is shown sound (its self-checks and positive controls pass; the message names a product or upstream fact), and the cause is in what is served or in upstream's behaviour. Write it under `## Findings (executor)` → `### Product failures` with the test, the failing assertion text, the evidence path, and whether you believe the cause is ours (`deploy/web/**`) or upstream's. Continue with the other orders. Never change the test to make it pass.

---

## WO-0: Pre-flight (no commit)
1. `git branch --show-current` is `feat/M2-S5-offline-upgrade`; `git status --short` is empty; `git log --oneline -2` shows the planner's plan commit on top of `936c663`.
2. **The artifact** (CI run 44916780204, `web-bundle`, built at `65dc7b4`):
   ```sh
   A=~/joplin-web-app-work/ci-evidence/44916780204
   mkdir -p $A/extracted/web-bundle-v3.7.21
   cp $A/artifacts/x/{SHA256SUMS,bundle-manifest.json,web-bundle-v3.7.21.tar.zst} $A/extracted/web-bundle-v3.7.21/
   (cd $A/extracted/web-bundle-v3.7.21 && sha256sum -c SHA256SUMS)
   ```
   All `OK`; `bundle-manifest.json` has `notestead.commit` `65dc7b498a2186f858997f983fde1eedef47e88d`, `dirty: false`; `git merge-base --is-ancestor 65dc7b4 HEAD` exits 0; `git diff --stat 65dc7b4 HEAD -- packages deploy` is empty. Otherwise **HARD STOP**.
3. **Upstream at the pin:** `git -C ~/joplin-web-app-work/upstream-joplin cat-file -e e41516e669efb693b009bedb21f3eb1fcbea4fc9^{tree}` exits 0. From `git show e41516e66:packages/lib/services/database/migrations/index.ts`, the exported array has **13** entries (`migration42` … `migration54`); from `…/packages/lib/JoplinDatabase.ts`, `existingDatabaseVersions` ends at **41**. Any other value: **HARD STOP** (plan D3's numbers are wrong).
4. **Podman state** into `test-results/verify/m2-s5/podman-before.txt` (as M2-S4 WO-0 step 3). A test-labelled container you did not start: **HARD STOP**. **RECORD** whether the three kept image tags exist, and the web image's id. The kept web image was built for M2-S6 from a local repackage (`artifacts-m2s6`), not from this artifact: the **first** heavy run (WO-2 GREEN) runs **without** `NOTESTEAD_WEB_IMAGE` so the harness rebuilds it from this artifact; **RECORD** the new id, and use `$IMG` from then on.
5. **The anchors exist in the served bundle** (read-only, a scratch extract, deleted after): extract the tarball into a temporary directory under `test-results/verify/m2-s5/scratch/`, then check that `app.bundle.js` has exactly one match of `/[A-Za-z_$][\w$]*\.default\[[A-Za-z_$][\w$]*-42\]/` and exactly one array literal of 13 `<name>.default` entries. Print only the counts. Remove the scratch dir. Counts other than 1 and 1: **HARD STOP**.

## WO-1: Pure helpers (RED → GREEN)
**Files (all erasable TypeScript, no Playwright import):**
- `tests/e2e/support/testBundles.ts`:
  - `migrationVersions(upstreamDatabaseTs: string, upstreamIndexTs: string): { base: number; n: number; latest: number }` (parses D3's literal and array; throws naming what it found);
  - `appendLine(text: string, line: string): string` (adds `\n<line>\n` if the text does not end with a newline, else `<line>\n`);
  - `dropNewestMigration(appBundleJs: string, expected: { base: number; n: number }): { js: string; before: number; after: number }` (plan D3 anchors 1 and 2; throws with counts on 0 or more than 1 anchor, a missing module, 0 or more than 1 array, or a wrong `n`);
  - `manifestWith(base: BundleManifest, changes: { path: string; bytes: Buffer }[], testBundle: 'B' | 'B2' | 'O'): BundleManifest`.
- `tests/e2e/support/accessLog.ts`: `parseAccessLog(text: string): { method: string; path: string; status: number; ts: number }[]` (Caddy's JSON access lines: `logger` starts with `http.log.access`; `request.method`, `request.uri` with its query dropped, `status`, `ts`). Non-JSON and non-access lines are ignored.
- `tests/e2e/support/profileRefusal.ts`: `parseProfileRefusal(message: string): { profile: number; expected: number } | undefined` (must start with `Something went wrong while starting the application: Error: Unknown profile version. Most likely this is an old version of Joplin, while the profile was created by a newer version.` and contain `Profile version: <int>` and `Expected version: <int>`).
- `tests/e2e/support/webSqlite.ts` (shared): `excusedStartupFailures(failures: SqliteFailure[], consoleLines: string[], dialogs: { message: string; ts: number }[], windowMs = 10_000): { excused: SqliteFailure[]; rest: SqliteFailure[] }` (plan D6: a `startup` failure is excused only by a refusal dialog within `windowMs` after its console line's timestamp; one dialog excuses one failure; `step` and `save` never).
- `tests/e2e/support/snapshot.ts`: `type Snapshot`, `compareSnapshots(s0, s1): { missing: string[]; changed: { id: string; fields: string[] }[]; added: { id: string; kind: 'note' | 'folder'; parentId: string }[]; conflicts: string[] }` and `snapshotProblems(diff, allowed)` (the value-free message lines). `restSnapshot` (needs a `DataApi`) is in WO-2.
- `tests/e2e/support/notRun.ts`: `notRunTests(entries: { project: string; file: string; title: string; status: string }[])` (counts `skipped` and `interrupted`).

**Tests:** `tests/unit/harness/testBundles.test.ts` (`tb-01…08`), `accessLog.test.ts` (`al-01…04`), `profileRefusal.test.ts` (`pr-01…04`, `ws-r-01…05`), `snapshot.test.ts` (`sn-01…05`), `notRunReporter.test.ts` (`nr-01…04`), as in the plan's harness table. `tb` uses synthetic minified strings built in the test (a fake JoplinDatabase module with `b.default[e-42]` and `b=r(n(123))`, and a fake module `123:` with an array of `n` `x.default` entries), **never** bytes of the real bundle. `pr-01` builds the F1 message from its parts (the upstream sentence is the spec, typed in the test).

**Commit 1 (RED):** `test(harness): derived bundles, access log, profile refusal, snapshots and not-run helpers (M2-S5, RED)`. RED = the missing modules and the missing `excusedStartupFailures` export.
**Commit 2 (GREEN):** `test(harness): implement the M2-S5 pure helpers`. Run `corepack yarn jest tests/unit/harness` → `green/unit.log`.

## WO-2: Fixtures, probes and the harness self-checks (RED → GREEN)
**Files and design (plan D1, D4 to D8):**
- **`tests/e2e/support/unoverlaid.ts`:** move M2-S6 D2 step 1 into an exported `copyServedTree(stack, dir)`; `reconstructUnoverlaid` calls it (M2-S6 behaviour unchanged).
- **`tests/e2e/support/testBundles.ts`:** `buildTestBundles(stack, root, nonce): TestBundles` with `{ a, b, b2, o, manifests: { a, b, b2, o }, versions: { base, n, latest }, nonce }` (plan D1-D3), and `checkTestBundles(bundles): string[]` (the D1 self-check: A against `NOTESTEAD_WEB_ARTIFACT/bundle-manifest.json`, the per-bundle diffs, O's count). Upstream sources for `migrationVersions` through the M2-S6 lookup (`tests/acceptance/support/upstream.mts` or `tests/support/upstreamTree.ts`, whichever M2-S6 settled on). `removeTestBundles(root)`.
- **`tests/e2e/support/fixtures.ts`:**
  - worker fixture `testBundles` (built under `test-results/e2e/m2-s5-bundles/<worker index>`, the nonce from `randomBytes(4)`, `checkTestBundles` must return `[]` or the fixture throws with the problems; removed at worker teardown);
  - `extraWebs.redeploy(web, { mountDist })` and `extraWebs.accessLog(web)` (plan D4). `redeploy` reuses `stop` (log kept) and `upExtraWeb` with `port` = the old one; it asserts the new `url` equals the old one. "address already in use" → it throws `port <P> was taken during the redeploy`;
  - `WebApp.expectProfileRefusal(reason)` in `startAppSession` (plan D6): from the call on, `context.on('page')` and the current pages get a `dialog` listener that records `{ message, ts }` and `accept()`s. `finish`/`closeEarly` use `excusedStartupFailures` when it was called; dialogs are attached as `dialogs<suffix>.log` (redacted) on failure. Without the call, nothing changes (`webApp`'s observable behaviour must not change);
  - `appContexts.open` unchanged in signature.
- **`tests/e2e/support/swState.ts`:** `swController`, `swCacheKeys`, `swCachedDigest`, `cacheableLoadPaths`, `bundleMarker` (plan D5). The caching rule is a constant with the citation `upstream:packages/app-mobile/web/serviceWorker.ts:145-164`.
- **`tests/e2e/support/localProfile.ts`:** `clearSiteData(app)` (plan D7; closes the app page) and `localDatabaseFiles(app)` (D8; the main database file's bytes through `openProbe`/`readDatabaseFiles`, the app page stays open; throws if no file was read).
- **`tests/e2e/support/snapshot.ts`:** `restSnapshot(dataApi)` (D8; paged, `include_deleted=1`, bodies as sha256).
- **Self-checks:** `tests/e2e/harness/test-bundles.spec.ts` with `H-BUN-01`, `H-RD-01`, `H-OFF-01`, `H-CSD-01` (plan harness table). `H-BUN-01` asserts on the fixture's output plus a direct call `dropNewestMigration(a's app.bundle.js, { base, n: n + 1 })` that must throw (its NEG). `H-RD-01` and `H-CSD-01` use `e2eeAccount` (unlock with `openUnlockedWebApp`) so the sync is the real one.

**Commit 1 (RED):** `test(harness): test bundles, web redeploy, offline and clear-site-data self-checks (M2-S5, RED)`. RED = the missing fixtures and helpers.
**Commit 2 (GREEN):** `test(harness): derived bundles, web redeploy, service-worker probes and clear site data (M2-S5 D1-D8)`. Run (first heavy run, **without** `NOTESTEAD_WEB_IMAGE`, WO-0 step 4): `e2e_pre; T=60m run test-results/verify/m2-s5/green/harness-e2e.log corepack yarn playwright test tests/e2e/harness/test-bundles.spec.ts`. Then the shared-module regressions of the rules, plus M2-S6's users of the moved code and of the session teardown: `T=60m run …/green/m2-s6.log env $IMG corepack yarn playwright test tests/e2e/m2-s6 tests/e2e/harness/unoverlaid-dist.spec.ts` and `T=30m run …/green/m2-s1.log env $IMG corepack yarn playwright test tests/e2e/m2-s1/e2ee-unlock.spec.ts` (its own dialog handling).

**HARD STOPs in WO-2:**
- `H-BUN-01`: A differs from the artifact's manifest (the image does not serve the artifact), or a derived bundle differs from A in any file other than plan D2/D3's.
- `H-RD-01`: the sync through a test `web` fails (`configureAndCheckJoplinServerSync` not success, or no `delta` 200), or after the redeploy the origin, the registration scope or the main screen differ. Attach the container logs; do not change the proxy settings.
- `H-OFF-01`: offline, the probe reaches the access log (F7 is wrong: the offline emulation does not cover the worker). Do not switch to stopping the container.
- `H-CSD-01`: anything survives `clearSiteData` (name it), or its NEG half finds nothing to clear.
- Any M2-S6 or M2-S1 regression.

## WO-3: "Not run" counts as failed (plan D9) (RED → GREEN)
- `tests/integration/harness/not-run-reporter.test.ts` (`H-NR-01` and its NEG): writes a throwaway config and two spec files under `mkdtempSync(join(tmpdir(), 'nst-nr-'))` (projects `p1` and `p2` with `dependencies: ['p1']`; tests use no browser fixture), runs `node_modules/.bin/playwright test -c <tmp config>` with `spawnSync` (bounded 120 s), reporters `[['<abs path>/tests/e2e/support/notRunReporter.ts', { outputFile: '<tmp>/not-run.json' }], ['list']]`. Asserts per the plan's harness table. The NEG run makes `p1` pass: exit 0, `count` 0, no `NOT RUN` line. Removed in `afterEach`.
- `tests/e2e/support/notRunReporter.ts` (a Playwright `Reporter`: `onTestEnd` keeps the last result per test, `onEnd` uses `notRunTests`, prints, writes `outputFile` (default `test-results/e2e/not-run.json`), returns `{ status: 'failed' }` when `n > 0`).
- `playwright.config.ts`: the reporter added after the redacting reporter; the header comment says why (M2-S1 r1 C3).

**Commit 1 (RED):** `test(harness): a dependency failure's not-run tests must fail the run (M2-S1 r1 C3, RED)`. **Commit 2 (GREEN):** `test(harness): not-run reporter for Playwright projects with dependencies (M2-S5 D9)`. Run `T=10m run …/green/not-run.log corepack yarn jest tests/integration/harness/not-run-reporter.test.ts tests/unit/harness/notRunReporter.test.ts`, then the rules' shared-module regression (the config changed).

## WO-4: The runbook acceptance test (one commit, RED until the SE's R1)
- `tests/acceptance/m2-s5/runbook.test.mts` with `U-AC16-RB-01` (plan AC table). Reads `deploy/web/README.md` from the working tree. The section is from the heading to the next heading of the same or a higher level. The ordered checks are positions of the first match of each step's pattern **after** the previous one. Failure messages name the missing item.
- Run: `run test-results/verify/m2-s5/red/runbook.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s5/runbook.test.mts`. Expected: fails at "the heading `## Rolling back the web app`" (the section does not exist).
- **Commit:** `test(acceptance): the browser rollback runbook's steps (M2-AC16, RED until R1)`.

## WO-5: The M2-S5 E2E specs (one commit; run; record)
**Files** (plan AC table): `tests/e2e/m2-s5/offline.spec.ts` (`M2-AC15-01`, `-02`), `upgrade.spec.ts` (`M2-AC16-01`, `-03`), `downgrade.spec.ts` (`M2-AC16-02`). Details:
- **Setup in each test:** `const port = await freePort()`; `const web = await extraWebs.start({ role: 'web-extra', port, mountDist: testBundles.a })`; `const ctx = await appContexts.open(web.url, '<label>')`; `const app = new JoplinWebApp(ctx.page)`; `openUnlockedWebApp(app, web.url, \`${web.url}/joplin-server\`, e2eeAccount)`; syncs with `syncWebOnce(app, ctx.network)` or `syncWebThenHeadless(app, ctx.network, stack, headlessService)`.
- **Steps are `test.step`s** named as in the plan's AC table, so a failure names its step.
- **Marks:** before an offline phase or a reload, note `parseAccessLog(await extraWebs.accessLog(web)).length` and `ctx.console.length`; "after the mark" means entries or lines beyond those.
- **The offline reload (`M2-AC15-01`):** `const res = await ctx.page.reload({ timeout: appStartTimeoutMs })`; `expect(res?.fromServiceWorker()).toBe(true)`; then the main screen as in M2-S2 (`app.openFolder(seedFolder)`, the seeded titles). The note body through the viewer (`app.openNote`, `note.frameText()` contains seeded note 1's body).
- **The offline edit:** `note.typeBody(' ' + token)` (appending; `token` = `nst<hex>`), back to the list, `expectStoredLocally(ctx, token, 'the offline edit')`. After online: the exact body = seeded body + `' ' + token` (whatever exact form `typeBody` produces in M2-S2 is the oracle; reuse its pattern).
- **`M2-AC15-02`:** `await ctx.page.evaluate(() => caches.delete('v1'))`; `setOffline(true)`; `swCacheKeys` holds neither `/` nor `/index.html`; `await expect(ctx.page.reload()).rejects.toThrow(/net::ERR_(INTERNET_DISCONNECTED|FAILED)/)`; annotation `offline-reload-error`.
- **Redeploy (`M2-AC16-*`):** `const webB = await extraWebs.redeploy(web, { mountDist: testBundles.b })` (B2 / O likewise); before the reload: `expect(await bundleMarker(ctx.page)).toBeNull()`; then one `ctx.page.reload()`; then `expect.poll(() => bundleMarker(ctx.page), { timeout: appStartTimeoutMs })` → `B-<nonce>` (an evaluate that throws during upstream's own reload counts as "not yet").
- **`M2-AC16-03`:** after the marker, `expect.poll` (60 s) that a console line after the mark ends with `Reloading page to make use of updated COOP/COEP Service Worker.`; annotation `self-reloads` with the count of that line and of `Reloading page to make use of COOP/COEP Service Worker.`.
- **`M2-AC16-02`:** `ctx.expectProfileRefusal('M2-AC16-02: the downgrade to bundle O is refused by upstream (plan F1, D6)')` **before** the redeploy. The refusal: `expect.poll` (`appStartTimeoutMs`) until the session's recorded dialogs hold one that `parseProfileRefusal` accepts; assert `{ profile: versions.latest, expected: versions.latest - 1 }`; `getByText('Startup error.', { exact: true })` visible; `bundleMarker` = `O-<nonce>`; `holdsFor('the app stays refused', …, { windowMs: 10_000 })` with no sync wizard and no note list. Before the clear, one `localDatabaseFiles(ctx)` read must hold Z (the profile still exists after the refusal). Then `clearSiteData(ctx)` (it closes the app page). Open a new page with `ctx.context.newPage()` and assign it to `ctx.page` (the session records every page of the context through `context.on('page')`, so its console is captured), and make a new `JoplinWebApp` on it. `JoplinWebApp.open(web.url)` must show the sync wizard. Then `openUnlockedWebApp`, one web sync, `pollDecryptedStats` until `done === total` (`firstSyncTimeoutMs`), the UI checks, one `localDatabaseFiles` read for the comparison (D8), `syncHeadlessOnce`, `compareSnapshots`.
- **Network policy** per context at the end (`endOfTestViolations(ctx.network.entries(), web.url, [connectionCheckUrl])`), as in M2-S6's POS.
- **Commit:** `test(e2e): M2-S5 offline reload, bundle upgrade and the downgrade refusal with recovery (M2-AC15, M2-AC16)`, after eslint and tsc are clean.
- **Run:** `e2e_pre; T=90m run test-results/verify/m2-s5/run/m2-s5.log env $IMG corepack yarn playwright test tests/e2e/m2-s5`.

**Outcomes (the planner's prediction, not a requirement):** all five pass.
- A NEG or in-test control failing (`M2-AC15-02`; `M2-AC15-01`'s "REST does not have the offline edit yet"; `M2-AC16-01`'s `bundleMarker` `null` before the reload; `M2-AC16-03`'s self-reload line; `M2-AC16-02`'s "Z present before the clear"): **HARD STOP** (the test cannot see the difference it claims).
- `M2-AC15-02`'s reload **resolves** instead of rejecting: **HARD STOP** (record the resulting URL, `document.title` and the access log; the planner rules).
- No refusal dialog in `M2-AC16-02` but `Startup error.` shown, or the refusal shown in-page instead of as a dialog: **HARD STOP** (record the console and the page text; F1 says `alert`).
- `M2-AC16-02`'s O starts normally on the old profile (no refusal): **HARD STOP** (D3's anchor removed the wrong entry, or F1 is wrong).
- `M2-AC16-02` after the clear: O fails to start on its own fresh profile: **HARD STOP** (F4 is wrong).
- The app does not open offline (`M2-AC15-01`), B is not served after one reload (`M2-AC16-01`), the profile is recreated (sync wizard) after an upgrade, a `compareSnapshots` problem, or an `added` item that is not a new folder or a note in one: **PRODUCT FAILURE** (record which file you suspect: ours, `deploy/web/Caddyfile`'s cache headers, or upstream's service worker), unless a harness self-check also failed (then **HARD STOP**).
- A failure inside harness code (an exception in a helper; a locator that never matches an upstream control the `ariaSnapshot` shows under another name): **HARD STOP**.
- A qualifying L20 failure: plan D10.

## WO-6: The strategy (one commit)
`docs/testing/strategy.md`:
- **§4 Fixtures:** `testBundles` (A = the served tree; B, B2, O derived at test time, never committed; O's database version from upstream source), `extraWebs.redeploy`/`accessLog`, `expectProfileRefusal`, `clearSiteData`, `localDatabaseFiles`, `restSnapshot`/`compareSnapshots`.
- **§4 Serial rule:** replace "which is accepted, since the run is already red" with "they count as failed: the not-run reporter lists them by name and fails the run (M2-S1 r1 C3; `not-run.json`)".
- **§5 Rules:** "redeploying `web`" means a test's own `web` container on the same port, never the shared stack's (so no serial spec); the expected profile refusal is excused only by D6, never by `allowSqliteFailures`.

**Commit:** `docs(testing): bundle redeploy, offline and not-run rules (M2-S5)`.

## WO-7: Sensitivity runs (no commits)
Each is a temporary edit, run alone (`-g <test id>`), with `e2e_pre` and `env $IMG`, logged under `sens/<id>.log`, junit copied, reverted with `git checkout -- <files>`, and `git status --short` clean before the next. The table is the plan's "Sensitivity runs". `S-BUN` runs `tests/e2e/harness/test-bundles.spec.ts -g H-BUN-01`; `S-NR` runs the WO-3 Jest command.
- **A sensitivity run that passes, or fails elsewhere:** **HARD STOP**.
- A sensitivity whose target test is a recorded PRODUCT FAILURE is deferred to WO-8 and **RECORD**ed as deferred.
- A qualifying L20 failure during a sensitivity: an occurrence; re-run that sensitivity **once**; a second L20 hit: **HARD STOP**.

**End of the RED phase.** Report to the orchestrator: the commits, the per-test outcomes of WO-2 to WO-5, `U-AC16-RB-01` red at the heading (the SE's R1), the PRODUCT FAILURE list (if any), the sensitivities done and deferred, the L20 count, the RECORDs. Then stop; the SE works next (R1, plus any product failure the orchestrator routes).

---

## WO-8: Verify (after the SE reports done; no commits; logs under `verify/`)
1. Read the SE's worklog `docs/worklog/M2-S5.md`. If the SE changed `packages/web-build/**` or `deploy/web/Caddyfile`/`Containerfile`/entrypoint, the bundle or image under test changed: a CI `web-bundle` artifact from the new commit is needed when the bundle changed (otherwise **HARD STOP**: testing the old bundle proves nothing), and the kept web image must be rebuilt (one run without `NOTESTEAD_WEB_IMAGE`; **RECORD** the id). A change to `deploy/web/README.md` only needs neither.
2. `run verify/runbook.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s5/runbook.test.mts` (must pass now), then `T=60m run verify/acceptance.log corepack yarn test:acceptance`.
3. `T=30m run verify/harness.log corepack yarn jest tests/unit/harness tests/integration/harness`.
4. M2-S5 E2E: `e2e_pre; T=90m run verify/m2-s5.log env $IMG corepack yarn playwright test tests/e2e/m2-s5 tests/e2e/harness/test-bundles.spec.ts`.
5. The deferred sensitivities of WO-7; all of them again if the SE changed anything under `deploy/web/` other than the README, or `packages/web-build/`.
6. The full E2E regression (shared fixtures changed): `e2e_pre; T=100m run verify/full.log env $IMG corepack yarn playwright test`. `not-run.json` must have `count` 0.
7. `T=30m run verify/lint.log corepack yarn lint`; `T=60m run verify/no-upstream-copy.log corepack yarn check:no-upstream-copy` (a hit under `tests/**`, or any bundle file in the git tree: **HARD STOP**).
8. Tests untouched by others: `git log --format='%h %an %s%n%b' main..HEAD -- tests/ playwright.config.ts`; every commit must carry `Agent: qa-specialist`. **RECORD** any that does not.

A failure in steps 2 to 6: as in WO-5 (NEG, control or harness failing: **HARD STOP**; product: **PRODUCT FAILURE**, reported back for the next round; L20: D10).

## WO-9: Results (commit)
Append `## Results (QA executor, Pi arm64, <date>)` to `docs/test-plans/M2-S5.md`: per row of the AC table and the harness table, PASS/FAIL, the command, the duration (the log's `# duration`), the log/junit/trace paths under `test-results/verify/m2-s5/`, and the annotations (`cache`, `offline-requests`, `offline-reload-error`, `self-reloads`, `added-after-recovery`, `access-log`). Then the sensitivity table with each run's failure site, the L20 occurrences, the RECORDs, `not-run.json` counts, and x64 as **PENDING-CI**. Put a short "Results at a glance" under the plan's header.

**Commit:** `docs(test-plans): M2-S5 results on arm64`, staged by path. Then end your turn with the final report: the orders done, the commits, per-AC status, the L20 count, the RECORDs and any PRODUCT FAILURE still open.

---

## WO-5R: Resume after the planner's rulings RU-1 to RU-4 (2026-11-22)
The plan's "Planner rulings on the WO-5 HARD STOPs" is binding. The planner committed only `docs/test-plans/M2-S5*.md`, including your Findings section as you wrote it. Start from `6317c06` with a clean tree.

1. **Harness (`test(harness)`, one commit, shared-module regressions of the rules):**
   - `tests/e2e/support/fixtures.ts`: split `redeploy` into `extraWebs.down(web): DownWeb` (`{ port, url, role, container }`; log kept, container removed) and `extraWebs.up(down, { mountDist }): ExtraWeb` (same port; the two existing errors); `redeploy` = `up(down(web))`, behaviour unchanged.
   - `tests/e2e/support/upgradeFlows.ts`: `quiesce(fx, web)` (RU-3a: `waitFor` 120 s of a `holdsFor` 5 s window with no new access-log entry; the failure names the last 5 entries' method and path), `goOffline(fx, s)` and `goOnline(fx, down, { mountDist })` (RU-2 steps, in that order; `navigator.onLine === false` asserted after `setOffline(true)`), and `serverUnreachable(down)` (the RU-2 guard: `podman container exists` false and `net.connect` to `127.0.0.1:<P>` refused, bounded 5 s).
   - Unit test for the pure part of the guard's decision if any; otherwise none.
   - Regressions: `corepack yarn jest tests/unit/harness tests/integration/harness`; `e2e_pre; T=60m run …/green/harness-e2e-r2.log env $IMG corepack yarn playwright test tests/e2e/harness/test-bundles.spec.ts`.
2. **Specs (`test(e2e)`, one commit):**
   - `offline.spec.ts`:
     - `M2-AC15-01`: online part as now. Then `goOffline`, then `serverUnreachable`. Then the one `page.reload()` (`fromServiceWorker()` true, the main screen, the body, `crossOriginIsolated`), then the offline edit, `expectStoredLocally`, and the REST control. Then `serverUnreachable` again, then `goOnline` with A, and `syncWebThenHeadless` with the exact REST body. The access-log assertion goes; the annotation `offline-requests` is replaced by `offline-guard`, which records the refused connects.
     - `M2-AC15-02`: online part, `caches.delete('v1')`, then `goOffline` (it re-caches `/manifest.json` only, so the `/` and `/index.html` check still applies), then `serverUnreachable`, then the reload rejecting with the RU-2 regex.
   - `upgrade.spec.ts` (`M2-AC16-01`, `-03`) and `downgrade.spec.ts` (`M2-AC16-02`): RU-1 steps 1 to 6 exactly. For `-01`, edit X stays online and synced as before; only Y moves. Y is asserted in note 2 **before** bundle B's first web sync. The rest is unchanged: the marker, the cache digest, the access log after the load, the refusal, the clear, the re-sync and the comparison.
3. **Run:** `e2e_pre; T=90m run test-results/verify/m2-s5/run/m2-s5-r2.log env $IMG corepack yarn playwright test tests/e2e/m2-s5`. Expected: 5 passed.
   - The guard failing (a container or listener still there): **HARD STOP**.
   - `quiesce` never holding: **HARD STOP** (record the last entries; the app may poll, and the planner rules).
   - A REST control finding the token: **HARD STOP**.
   - A `PUT` or a `/joplin-server/` request in the new container's log before the load mark: **HARD STOP**.
   - Y not shown after the load: **PRODUCT FAILURE** if the harness controls passed, with the evidence.
   - The WO-5 outcome rules apply otherwise; L20 per D10. The story count is 1 so far, and the per-run HARD STOP stays at the third occurrence in one invocation.
4. Then **WO-6** and **WO-7** as written, with the amended sensitivity table (S-AC15a/b amended, S-AC16f/g added). End the RED phase with the report WO-7 describes. Also report whether the R1 wording constraint was relayed: it is in plan R1, and the SE reads it there.

## WO-8 amendments (rulings RU-7, RU-8, 2026-11-22)
- **L20 (RU-7):** in WO-8, an L20-only failure is recorded and does not fail the story by itself; the third occurrence in one invocation is still a **HARD STOP**. Record `M2-AC16-02`-style hits after an excused refusal as `startupFailed: no` (RU-7). In the results, state per AC test whether it has passed completely (WS-1 included) at least once, in WO-8 or in the CI proof run; `M2-AC15-01` and `M2-AC16-02` have not yet. If WO-8 leaves one without such a pass, report it; never re-run to get one.
- **Welcome notebooks (RU-8):** for `M2-AC16-02` in the WO-8 run, record the number of added welcome folders, their `created_time`s, and the number of app starts after the clear (`Starting application` and upstream's reload console lines). Record only.
- **Sensitivities:** S-AC15c/S-AC15c2 (RU-5) and S-AC16b with its attempt-1 log (RU-6) are ratified; list both in the results.

---

## WO-10: Diagnose the M2-AC16-03 self-reload hang (RU-9); m2-s6 targeted run (RU-10)
Rules for every order apply. **Changed rule:** `e2e_pre` now also moves the previous output, so evidence is never overwritten:
```sh
e2e_pre() { t=$(date +%s); mkdir -p test-results/verify/m2-s5/stale-stack test-results/verify/m2-s5/stale-output; [ -d test-results/e2e/stack ] && mv test-results/e2e/stack "test-results/verify/m2-s5/stale-stack/$t"; [ -d test-results/e2e/output ] && mv test-results/e2e/output "test-results/verify/m2-s5/stale-output/$t"; true; }
```
1. **Keep the evidence:** copy `test-results/e2e/output/m2-s5-upgrade-M2-S5-bundle-1313e--changes-the-service-worker-chromium/` to `test-results/verify/m2-s5/verify/full-ac16-03-hang/` before any run.
2. **`H-SWU-01` (one commit, `test(harness): characterise the service-worker update reload (M2-S5 RU-9)`), `tests/e2e/harness/sw-update.spec.ts`.**
   - Fixtures: `extraWebs`, `appContexts` and `testBundles` only; no account, no headless service.
   - Flow: start a test `web` with A, then `JoplinWebApp.open` (the sync wizard of a fresh profile is enough). Then **6 switches**, alternating B2, A, B2, A, B2, A. Every switch changes `serviceWorker.bundle.js`, because A's and B2's differ. Each switch is: `ctx.page.goto('about:blank')`, `extraWebs.redeploy` with the next bundle, the console and log marks, one `ctx.page.goto(url)`. Then wait up to 60 s for the updated-worker reload line, and up to 60 s more for a main-frame navigation that **commits after that line**: the CDP `Page.frameNavigated` of the main frame, followed by the marker of the expected bundle (`null` for A).
   - **Timeline (always attached, value-free, as `sw-timeline-<i>.json`):** from a CDP session on the page, `ServiceWorker.enable` → every `workerVersionUpdated` (`versionId`, `scriptURL` path, `status`, `runningStatus`, the time); and `Page.enable` → `frameRequestedNavigation`, `frameStartedLoading`, `frameNavigated` (main frame: `loaderId`, URL path), `frameStoppedLoading`. Add the console's reload lines and the container's `GET /` and `GET /serviceWorker.bundle.js` entries, all with times.
   - **Collect all 6 outcomes, then assert once** (like M2-S6 RU-3): every switch's self-reload committed. The failure lists the switches that hung. Annotation `sw-switches` with `<i>: committed in <ms> | hung` for each switch.
3. **Run it twice, logged separately:**
   - default: `e2e_pre; T=40m run test-results/verify/m2-s5/diag/swu-default.log env $IMG corepack yarn playwright test tests/e2e/harness/sw-update.spec.ts`;
   - Playwright's worker network instrumentation off: the same with `PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK=1` added to the env (`swu-nosw.log`).

   Copy each run's output directory to `diag/<name>-output/`. A failure is the measurement, **not** a HARD STOP. Do not run either variant more than once.
4. **Report** (under `## Findings (executor)` → `### WO-10 diagnosis`, uncommitted, then end your turn). For each variant: the hung/committed counts. For each hung switch: the last `workerVersionUpdated` states of the old and the new version, whether `frameRequestedNavigation`/`frameStartedLoading` happened, and whether any `GET /` arrived. Also compare with the full-run hang of step 1 (its console and container times). Give your reading, labelled unproven where it is. Change no test, harness or config beyond `H-SWU-01`.
5. **The m2-s6 targeted run (RU-10):** `e2e_pre; T=40m run test-results/verify/m2-s5/verify/m2-s6.log env $IMG corepack yarn playwright test tests/e2e/m2-s6 tests/e2e/harness/unoverlaid-dist.spec.ts tests/e2e/harness/opfs-files.spec.ts`. Expected: all pass, with L20 per D10. Any non-L20 failure: **HARD STOP**. Record the result in the report.
6. **Strategy (one commit, `docs(testing): local full regression bound and evidence-keeping (M2-S5 RU-9, RU-10)`):** in `docs/testing/strategy.md` §7, a local full E2E regression runs with a 170-minute bound, and every run moves the previous `test-results/e2e/output` aside first.

Then stop. The planner rules on RU-9 (a) or (b) from the report. `M2-AC16-03` is not run again before that ruling.

---

## WO-11: M2-AC16-03 and H-SWU-01 under RU-13 (RED → GREEN for the matcher; one run)
Rules for every order apply, with WO-10's `e2e_pre`.
1. **Matcher (RED → GREEN).**
   - Commit 1: `tests/unit/harness/swTimeline.test.ts` with `swu-01…05` (plan RU-13). RED = the missing module. Subject: `test(harness): classify upstream's self-reload as committed, the L22 race, or unknown (M2-S5 RU-13, RED)`.
   - Commit 2: `tests/e2e/support/swTimeline.ts`. Move `H-SWU-01`'s CDP recorder there as `recordSwTimeline(page): Promise<{ events, stop }>` (value-free events: kind, time, ids, path, status, runningStatus, reason), and add `classifySelfReload(events, accessEntries, lineTime, windowMs = 60_000): { outcome: 'committed' | 'race' | 'unknown'; parts: string[] }`. Subject: `test(harness): the self-reload timeline and its classifier (M2-S5 RU-13)`.
2. **Specs (one commit):**
   - `upgrade.spec.ts`, the `B2` branch of the `upgrade` flow:
     - start `recordSwTimeline` before the one online load;
     - after the updated-worker line, wait up to 60 s and then classify;
     - `committed`: continue;
     - `race`: exactly one `ctx.page.reload({ timeout: appStartTimeoutMs })`; it must commit (a `frameNavigated` of the main frame after it) and the container must log a `GET /`;
     - `unknown`: fail with `parts`;
     - always write the `self-reload` annotation and attach the timeline JSON;
     - every other step unchanged. `M2-AC16-01` (the B branch) is unchanged.
   - `sw-update.spec.ts` (`H-SWU-01`): each switch classified the same way; on `race`, one manual reload that must commit; `unknown` collected; one assertion at the end that no switch is `unknown` and every manual reload committed; `sw-switches` annotation with the C and R counts.
   - Subject: `test(e2e): M2-AC16-03 and H-SWU-01 accept a committed self-reload or the documented L22 race, nothing else (M2-S5 RU-13)`. Run eslint and tsc clean first; run `corepack yarn jest tests/unit/harness` (regression).
3. **One run** (not repeated, whatever the outcome): `e2e_pre; T=60m run test-results/verify/m2-s5/verify/ac16-03-r13.log env $IMG corepack yarn playwright test tests/e2e/m2-s5/upgrade.spec.ts tests/e2e/harness/sw-update.spec.ts`. Expected: `M2-AC16-01`, `M2-AC16-03` and `H-SWU-01` pass, with the outcome of each self-reload in the annotations.
   - `unknown` anywhere, or a manual reload that does not commit: **HARD STOP**. Attach the timelines; do not widen the matcher.
   - An L20 hit: per D10. A non-L20 failure elsewhere: **HARD STOP**.
4. **S-AC16h:** if the run's `M2-AC16-03` took (R), run S-AC16h once (`-g M2-AC16-03`, the temporary edit of plan RU-13). It must fail at "the hang does not match L22", naming (ii). If the run took (C), **RECORD** "S-AC16h not exercised in the browser; covered by `swu-03`", and do not repeat runs to get (R).
5. **Results (one commit, `docs(test-plans): M2-S5 WO-11 results`):** append `### WO-11 results` to the Results section: the per-test outcome, the `self-reload` and `sw-switches` annotations, S-AC16h's site or the RECORD, L20, and the logs. Then end your turn. The planner gives the sign-off from these logs (RU-14).

## WO-11R: Resume after ruling RU-15 (2026-11-23)
The planner committed your findings as written, plus RU-15. Start from `e8dc85e` with a clean tree. WO-10's `e2e_pre` applies.
1. **RED → GREEN.**
   - Commit 1: `swu-06…09` (plan RU-15) in `tests/unit/harness/swTimeline.test.ts`. RED = the missing `judgeUserReload` export. Subject: `test(harness): judge the race branch's user reload by commit and server request (M2-S5 RU-15, RED)`.
   - Commit 2: `judgeUserReload` and `userReload` in `tests/e2e/support/swTimeline.ts`. Subject: `test(harness): user reload judged by the browser's commit, not Playwright's promise (M2-S5 RU-15)`.
2. **Specs (one commit):**
   - `upgrade.spec.ts` (B2 branch, race case) and `sw-update.spec.ts` use `userReload` instead of a bare `page.reload()`. In `H-SWU-01` a switch ends only after its judgement. Every other step is unchanged.
   - Subject: `test(e2e): M2-AC16-03 and H-SWU-01 judge the user reload by its commit (M2-S5 RU-15)`.
   - Before committing: eslint and tsc clean, `corepack yarn jest tests/unit/harness`.
3. **One run** (a new run after a test change; not repeated whatever the outcome): `e2e_pre; T=60m run test-results/verify/m2-s5/verify/ac16-03-r15.log env $IMG corepack yarn playwright test tests/e2e/m2-s5/upgrade.spec.ts tests/e2e/harness/sw-update.spec.ts`. Copy the timelines to `verify/ac16-03-r15-timelines/`.
   - `unknown`, a user reload that does not commit, or a rejection other than `ERR_ABORTED`: **HARD STOP**.
   - L20: per D10. Any other failure: **HARD STOP**.
4. **S-AC16h:** as WO-11 step 4. Run it once if `M2-AC16-03` took (R); otherwise RECORD it.
5. **Results:** `docs(test-plans): M2-S5 WO-11 results`, as WO-11 step 5, adding the `user reload` annotations and the (C)/(R) counts. Then end your turn; the planner checks the logs for the sign-off (RU-14).

---

## WO-12: Self-reload outcome (N), commit-only load, and the exact upload control (RU-17, RU-18)
Rules for every order apply, with WO-10's `e2e_pre`. Start from `4ab86ef` plus the planner's ruling commit, with a clean tree.
1. **RED → GREEN.**
   - Commit 1: `swu-10…13` in `tests/unit/harness/swTimeline.test.ts` and `ro-01…04` in `tests/unit/harness/upgradeFlows.test.ts` (plan RU-17, RU-18). RED = the `N` outcome and the missing `unexpectedBeforeLoad`. Subject: `test(harness): the update-at-navigation outcome and the exact before-load control (M2-S5 RU-17, RU-18, RED)`.
   - Commit 2: `classifySelfReload` returns `committed | race | updated-at-navigation | unknown` (the (N) signature of RU-17; it takes the versionId that was active before the load). Add `unexpectedBeforeLoad` in `tests/e2e/support/upgradeFlows.ts`, and use it in `expectOnlyReadiness`. Subject: `test(harness): classify the update found at navigation, and name only unexplained requests before the load (M2-S5 RU-17, RU-18)`.
2. **Specs (one commit):**
   - **The one online load** in `sw-update.spec.ts`, `upgrade.spec.ts` and `downgrade.spec.ts`: `goto(url, { waitUntil: 'commit', timeout: appStartTimeoutMs })`. Then assert the response status (200 or 304) and a `GET /` after the mark.
   - **`H-SWU-01`:**
     - per switch, wait up to 60 s for the reload line **or** for the (N) signature, then classify;
     - (N) needs `bundleMarker` = expected;
     - the `sw-switches` annotation gains the `N` count;
     - `unknown` fails.
   - **`M2-AC16-03`:** the control step becomes "the worker was updated" (RU-17 point 3). On (R), `userReload` as now. Every other step unchanged.
   - Subject: `test(e2e): the one online load waits for the commit; the worker update may be found at navigation (M2-S5 RU-17, RU-18)`.
   - Before committing: eslint and tsc clean; `corepack yarn jest tests/unit/harness`.
3. **One local run** (not repeated): `e2e_pre; T=60m run test-results/verify/m2-s5/verify/wo12.log env $IMG corepack yarn playwright test tests/e2e/m2-s5 tests/e2e/harness/sw-update.spec.ts`. Copy the timelines to `verify/wo12-timelines/`.
   - Expected: all pass, each self-reload's outcome annotated.
   - `unknown`, a non-committing user reload, a rejection other than `ERR_ABORTED`, or an unexplained before-load entry: **HARD STOP**.
   - L20 per D10.
4. **Results:** `docs(test-plans): M2-S5 WO-12 results`. Append `### WO-12 results` with the outcomes, the C/R/N counts and L20. Then end your turn. The planner renews the sign-off from the logs, and the orchestrator starts the CI proof run.
