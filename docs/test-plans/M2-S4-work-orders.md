# M2-S4 work orders (QA executor)

These orders implement `docs/test-plans/M2-S4.md`. Read that plan first. Its Findings P1 to P8, Planner decisions D1 to D12, the AC table and the sensitivity table are the design. Each order gives the files, signatures, selectors, assertions, the commit split and subjects, the commands, the expected RED, and the stop points. Upstream paths are `upstream:packages/…` under `~/joplin-web-app-work/upstream-joplin/` at `v3.7.21` (read-only). Plugin paths are those of the user's plugin at tag `2.1.2`: read them on GitHub, or by extracting the fixture `.jpl` (`tar -xOf …`).

## Rules for every order
- **Branch:** `feat/M2-S4-plugins`. WO-0 checks it.
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
  If the orchestrator's dispatch names your model, use it in `Co-Authored-By`.
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat` or `fix`, and never push. Stage by path (`git add <path>`), never `git add -A`.
- **Paths:** write only these:
  - `tests/**`
  - `playwright.config.ts`
  - `docs/testing/**`
  - `docs/test-plans/M2-S4*.md`

  Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**`, ADRs, the architecture or STATUS. `e2e.yml` belongs to the ci-cd-specialist (CC-NET).
- **Test-first history:** an order marked **RED → GREEN** is two commits.
  1. **The failing test.** Before committing it:
     - run `corepack yarn eslint --max-warnings 0 <its files>`, which must be clean;
     - run `corepack yarn tsc -p tsconfig.json`: the **only** errors allowed are the missing modules or exports the RED is about;
     - log the RED run under `red/`.
  2. **The support code,** with the test passing, logged under `green/`.
     - If the GREEN touches a shared harness module (`fixtures.ts`, `flows.ts`, `network.ts`, `localProfile.ts`, `dueDate.ts`, `pages/joplinWebApp.ts`, `stack.ts`), also run `corepack yarn jest tests/unit/harness tests/integration/harness`. All of it must pass.
- **Tests:**
  - No `.only`, `.skip`, `fixme`, `waitForTimeout`, `test.slow()` or sleeps.
  - Wait only with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only with real key events (`typeLikeUser`, `clearLikeUser`). Never `fill()` or `dispatchEvent`.
  - Files go in only through `filechooser.setFiles(path)`.
  - Never weaken an assertion, and never change an asserted upstream string.
  - Every spec uses `test.describe.configure({ timeout: longSpecTimeoutMs })`. No spec writes its own timeout number (`CI-T-03`).
  - Any wait that can take longer than 60 s passes its own `timeout`, with the values of plan D11.
  - Locators are role- or label-based, or upstream's own test ids (`plugin-card`, `menu-content-open`, `screen-header-menu-trigger`, `prompt-dialog`). Never CSS classes.
- **Working tree during a run (R3, R4 rulings):**
  - Never keep another order's uncommitted files in the tree while running a command; Playwright loads every spec file.
  - A sensitivity edit starts only after its order's GREEN is committed, and is reverted with `git checkout -- <file>` against that commit.
- **Run environment (every heavy command):**
  - `NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21`. It is current for the pin; **no newer artifact is needed.**
  - `NOTESTEAD_KEEP_IMAGE=1`.
  - `LANG=C.UTF-8`, set only in the wrapper below. The harness still pins Chromium's own locale: add no other locale handling.
  - **One heavy job at a time** (E2E, contract, full `yarn lint`, image builds, `check:no-upstream-copy`), in the background with `timeout`.
  - **One Playwright worker** (the local default; never pass `--workers`).
  - Never touch `byparr`, or any podman resource without the label `io.github.thescriptingguy.notestead.test`.
- **Images:** keep every test-labelled image until the planner's sign-off; the orchestrator removes them.
  - Never `podman rmi`, `podman image prune`, `podman tag` or `podman untag`.
  - An unexpected image state is a **RECORD**.
- **Leftover stacks:** a test-labelled container or stack that you did not start is a **HARD STOP**. Don't remove it.
- **Network:** `M2-AC10` and `S-AC10` download from GitHub (read-only), and only those. Never point anything at a real Joplin Server.
- **Traces:** never add `--trace on`, and never set `use.trace`.
- **Logs:** every command's output goes under `test-results/verify/m2-s4/<phase>/<name>.log`, where `<phase>` is `red`, `green`, `sens` or `verify`. Use this wrapper:
  ```sh
  cd ~/Joplin-Web-App
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21
  export NOTESTEAD_KEEP_IMAGE=1
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); LANG=C.UTF-8 timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  # before EVERY E2E run (R5 ruling, 2026-11-20): move earlier stack logs out of the scanned tree
  e2e_pre() { [ -d test-results/e2e/stack ] && mkdir -p test-results/verify/m2-s4/stale-stack && mv test-results/e2e/stack "test-results/verify/m2-s4/stale-stack/$(date +%s)"; true; }
  IMG="NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1"
  # first heavy run (builds and keeps the images):  T=60m run test-results/verify/m2-s4/green/x.log corepack yarn playwright test <spec>
  # later heavy runs:                               T=60m run test-results/verify/m2-s4/green/x.log env $IMG corepack yarn playwright test <spec>
  ```
  - After every E2E run, copy `test-results/e2e/junit.xml` next to its log, as `<name>-junit.xml`.
  - After every E2E run, also run `node tests/harness/tools/scan-l20.ts test-results/e2e > test-results/verify/m2-s4/<phase>/<name>-l20.txt` (only this run's output; R5 ruling).
- **L20 (plan D12):**
  - A qualifying failure is an **L20 occurrence**. Record it under `## Findings (executor)` with: the test, the `rc`, the statement kind, the db (`main`/`log`), whether startup failed, and the evidence path.
  - **Never re-run to get green.**
  - **The third occurrence in one Playwright invocation is a HARD STOP.**
  - A failure that does not qualify is handled by its order's own stop rules.

### Stop points
- **HARD STOP.** **Allowed:**
  - collect the evidence the order names: logs, `error-context.md`, the trace path, an `ariaSnapshot()` of the region, the browser console lines of plan D9, the `podman ps -a`/`podman images` state;
  - re-run the **same** command, unchanged, once, only if the order says so, to capture evidence that is missing;
  - read upstream and plugin source;
  - revert every temporary edit (`git checkout -- <file>`);
  - write the finding under `## Findings (executor)` in `docs/test-plans/M2-S4.md`, uncommitted;
  - end your turn with a report to the orchestrator: the order and step, what happened, the evidence paths, your view of the cause, and `git status --short`.

  **Not allowed:**
  - changing any code, test, locator, timeout or config;
  - adding a retry, a wait or a workaround, or trying another seam;
  - committing anything for the stopped order or any later order;
  - continuing with other orders;
  - removing containers or images.
- **RECORD.** Write the observation under `## Findings (executor)`, with its evidence, and continue. Change nothing because of it.

---

## WO-0: Pre-flight (no commit)
1. `git branch --show-current` is `feat/M2-S4-plugins`, and `git status --short` is empty. `git log --oneline -3` shows the planner's commits (the fixture `f6c14d6`, then the plan and work orders).
2. **The fixture:**
   ```sh
   cd tests/fixtures/plugins/repeating-todos
   echo "df95494a42e02b95dade2d653fc247380457ff1ff375105c16f66bf5bd7d42eb  repeating-todos-2.1.2.jpl" | sha256sum -c
   tar --version | head -1; tar -tf repeating-todos-2.1.2.jpl
   ```
   - The sum must be `OK`.
   - `tar` must be GNU tar (the unit tests use it as their oracle).
   - The listing must equal `provenance.json`'s `entries`.
   - Otherwise: **HARD STOP**.
3. **The podman state:**
   ```sh
   mkdir -p test-results/verify/m2-s4
   { podman ps -a; podman network ls; podman volume ls; podman images; } > test-results/verify/m2-s4/podman-before.txt
   for i in localhost/notestead-web:stack-test localhost/notestead-headless:stack-test localhost/notestead-test-device:3.7.1; do podman image inspect --format "$i {{.Id}} {{index .Labels \"io.github.thescriptingguy.notestead.test\"}}" "$i" 2>&1; done >> test-results/verify/m2-s4/podman-before.txt
   ```
   - A test-labelled container or stack that you did not start: **HARD STOP**.
   - If all three tags exist with the label, use `$IMG`. Otherwise the first heavy run (WO-2 GREEN) builds them. **RECORD** which.
4. `ls $NOTESTEAD_WEB_ARTIFACT` lists `SHA256SUMS`, and `(cd $NOTESTEAD_WEB_ARTIFACT && sha256sum -c SHA256SUMS)` is all `OK`.
5. `curl -sS -o /dev/null -w '%{http_code}\n' https://raw.githubusercontent.com/joplin/plugins/master/.gitignore` prints `200`. If not: **RECORD**. M2-AC10 is then deferred to CI, and M2-AC9 must still pass (plan P7).

## WO-1: Pure helpers (RED → GREEN)
**RED.** Four unit test files. They import modules and exports that don't exist yet.
- **`tests/unit/harness/pluginJpl.test.ts` (new), describe `plugin jpl (M2-S4 D7)`.** It imports `ustar` from `../../support/ustar.ts` and `buildProbeJpl` from `../../e2e/support/pluginProbe.ts`. Use `mkdtempSync(join(tmpdir(), 'nst-jpl-'))`, removed in `afterEach`. `spawnSync('tar', …)` is the oracle.
  - **`jpl-01 tar lists exactly the entries in order`:** `ustar([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'index.js', data: Buffer.from('x') }])`, written to a file. `tar -tf` gives `manifest.json\nindex.js\n`.
  - **`jpl-02 tar extracts every entry byte for byte`:** add an entry `a/b.txt` with `'é漢\n'` (UTF-8). `tar -xOf <f> <name>` equals each `data`.
  - **`jpl-03 the archive is deterministic and block aligned`:**
    - two calls give the same sha256;
    - `length % 512 === 0`;
    - the last 1024 bytes are zero;
    - `tar -tvf` shows mode `-rw-r--r--`, owner `0/0` and the date `1970-01-01`.
  - **`jpl-04 bad names throw`:** a name of 101 bytes, `../x`, `/x` and `''` each throw an `Error` whose message names the entry.
  - **`jpl-05 the probe plugin's manifest and marker`:** `buildProbeJpl({ kind: 'desktop', run: 'r1', dir })` returns `{ path, sha256, id, marker }`.
    - `tar -xOf path manifest.json` parses to an object with `manifest_version: 1`, `id: 'org.notestead.test.probe-desktop'`, a non-empty `name`, `version: '1.0.0'`, `app_min_version: '3.5'` and `platforms: ['desktop']`.
    - `marker === 'nst-plugin-probe-desktop-r1'`.
    - `index.js` contains `JSON.stringify(marker)` exactly once and no `__NST_MARKER__`.
    - `sha256` is the file's.
    - `kind: 'mobile'` gives `id: 'org.notestead.test.probe-mobile'`, `platforms: ['desktop', 'mobile']` and `nst-plugin-probe-mobile-r1`.
  - **`jpl-06 the probe source is ours`:** the `index.js` and `manifest.base.json` files under `tests/fixtures/plugins/probe/` exist. `index.js` starts with an SPDX line `AGPL-3.0-or-later` and contains neither `require(` nor `@joplin/`.
- **`tests/unit/harness/repeatingTodos.test.ts` (new), describe `repeating-todos fixture and seed (M2-S4 P6)`.** It imports `repeatingTodosFixture`, `repeatingTodoUserData` and `recurrenceOf` from `../../e2e/support/repeatingTodos.ts`.
  - **`fix-01 the committed jpl matches provenance.json`:** `repeatingTodosFixture()` returns `{ path, id, version, sha256, size, name }` from `provenance.json`. The sha256 and size of the file at `path` equal them.
  - **`fix-02 its manifest is the pinned one`:** `tar -xOf path manifest.json` has `id`, `version` and `name` equal to `provenance.json`'s, and `platforms` includes `'mobile'`.
  - **`rec-01 the user_data shape`:** `JSON.parse(repeatingTodoUserData({ interval: 'day' }, 1_700_000_000_000))` deep-equals `{ [fixture.id]: { recurrence: { v: <rec-02's object>, t: 1_700_000_000_000 } } }`.
  - **`rec-02 v is the plugin's RecurrenceData at 2.1.2`:** `v` deep-equals:
    ```
    { enabled: true, interval: 'day', intervalNumber: 1, weekSunday: false, weekMonday: false, weekTuesday: false,
      weekWednesday: false, weekThursday: false, weekFriday: false, weekSaturday: false, monthOrdinal: 'first',
      monthWeekday: '', stopType: 'never', stopDate: null, stopNumber: 1, resetAlarmWhenNotDone: false }
    ```
    (plugin `src/model/recurrence.ts:51-68`, `:82-97`).
  - **`rec-03 recurrenceOf`:** it returns rec-02's `v` for rec-01's string, and `undefined` for `''`, `'{'`, `'{"other":{"recurrence":{"v":{},"t":1}}}'` and `'null'`.
- **`tests/unit/harness/dueDate.test.ts` (append)**, importing `localNoonEpoch`:
  - **`due-08`:** `localNoonEpoch(Date.UTC(2026, 10, 19, 18, 0), 1, 'Europe/Amsterdam') === Date.UTC(2026, 10, 20, 11, 0)`, and with `2` it is `Date.UTC(2026, 10, 21, 11, 0)`.
  - **`due-09`:** from `Date.UTC(2027, 2, 26, 12)`: `+2 − +1` is `23 * 3_600_000` (2027-03-28 is the spring change).
  - **`due-10`:** from `Date.UTC(2026, 9, 23, 12)`: `+2 − +1` is `25 * 3_600_000` (2026-10-25).
  - In every case `partsIn(result, 'Europe/Amsterdam').hour === '12'` and `.minute === '00'`.
- **`tests/unit/harness/network.test.ts` (append)**, importing `pluginRepositoryPrefixes` from `../../e2e/support/plugins.ts`:
  - **`net-18`:** it deep-equals the six prefixes of plan P7a, in that order, and each ends in `/`.
  - `endOfTestViolations([GET https://raw.githubusercontent.com/joplin/plugins/master/manifests.json, GET https://raw.githubusercontent.com/other/repo/x], 'http://127.0.0.1:1', pluginRepositoryPrefixes)` is exactly one line, naming `raw.githubusercontent.com/other/repo/x`.

**RED run:** `run test-results/verify/m2-s4/red/wo1-unit.log corepack yarn jest tests/unit/harness/pluginJpl.test.ts tests/unit/harness/repeatingTodos.test.ts tests/unit/harness/dueDate.test.ts tests/unit/harness/network.test.ts`.
- **Expected:** `Cannot find module` for `ustar.ts`, `pluginProbe.ts`, `repeatingTodos.ts` and `plugins.ts`, and `localNoonEpoch is not a function` (or a missing export). `due-01…07` and `net-01…17` still pass.
- **Any other failure** (for example GNU `tar` missing, or an earlier test failing): **HARD STOP**.

**Commit 1:** `test(harness): failing unit tests for the jpl writer, probe plugin, repeating-todos seed and local noon (M2-S4)`.

**GREEN** (all pure; no browser):
- **`tests/support/ustar.ts`:**
  ```ts
  export interface TarEntry { name: string; data: Buffer }
  export const ustar = (entries: TarEntry[]): Buffer
  ```
  - POSIX ustar: a 512-byte header per entry, then the data padded to 512, then two zero blocks.
  - The header holds:
    - `name` (≤ 100 bytes);
    - mode `0000644`;
    - uid and gid `0000000`;
    - the size in 11-digit octal;
    - mtime `00000000000`;
    - typeflag `'0'`;
    - magic `ustar\0` and version `00`;
    - uname and gname empty;
    - the checksum computed with the field as spaces, written as 6 octal digits, NUL and space.
  - It throws on an empty name, a name over 100 bytes, an absolute path or any `..` segment.
- **`tests/fixtures/plugins/probe/manifest.base.json`:**
  ```json
  { "manifest_version": 1, "version": "1.0.0", "app_min_version": "3.5", "author": "Notestead tests", "description": "Notestead test probe (M2-S4 NEG 2): creates one note titled with its marker on start." }
  ```
- **`tests/fixtures/plugins/probe/index.js`:**
  ```js
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Notestead test probe plugin (docs/test-plans/M2-S4.md D7): on start, creates one note titled with its marker.
  /* global joplin */
  joplin.plugins.register({
  	onStart: async () => {
  		await joplin.data.post(['notes'], null, { title: '__NST_MARKER__' });
  	},
  });
  ```
  The builder replaces `'__NST_MARKER__'`, quotes included, with `JSON.stringify(marker)`. If eslint objects to the file, **RECORD** the rule and use an inline `eslint-disable-next-line <rule>` with a reason. Never edit `eslint.config.js`.
- **`tests/e2e/support/pluginProbe.ts`:**
  ```ts
  export type ProbeKind = 'desktop' | 'mobile';
  export interface ProbePlugin { path: string; sha256: string; id: string; name: string; marker: string }
  export const buildProbeJpl = (opts: { kind: ProbeKind; run: string; dir: string }): ProbePlugin
  ```
  - It reads both source files (locate the repo with `findRepoRoot`).
  - `id` is `org.notestead.test.probe-<kind>`.
  - `name` is `Notestead probe (desktop only)` or `Notestead probe (mobile)`.
  - `platforms` is `['desktop']` or `['desktop', 'mobile']`.
  - It writes `<dir>/<id>.jpl` (entries `manifest.json`, then `index.js`).
- **`tests/e2e/support/repeatingTodos.ts`:**
  ```ts
  export interface RepeatingTodosFixture { path: string; id: string; name: string; version: string; sha256: string; size: number }
  export const repeatingTodosFixture = (): RepeatingTodosFixture   // from tests/fixtures/plugins/repeating-todos/provenance.json
  export const recurrenceKey = 'recurrence';
  export const repeatingTodoUserData = (r: { interval: 'day' }, nowMs: number): string
  export const recurrenceOf = (userData: string): Record<string, unknown> | undefined
  // the plugin's own label strings (plugin src/core/commands.ts, src/gui/menu.ts at 2.1.2)
  export const pluginMenuLabels = ['Repeating Todos', 'Update All Recurrence Information', 'Update Overdue To-Dos', 'Reschedule Overdue To-Dos to Today'] as const;
  export const pluginNoteToolbarLabel = 'Open Recurrence Dialog';
  export const recurringTagTitle = 'recurring';
  ```
- **`tests/e2e/support/dueDate.ts`:** add `localNoonEpoch(nowMs, days, timeZone)`, as in plan D10.
- **`tests/e2e/support/plugins.ts`** (new; the page-object helpers join it in WO-4): `export const pluginRepositoryPrefixes = [ …the six of P7a… ] as const;`.

**GREEN run:** the same command, under `green/wo1-unit.log`, then the whole harness set (`dueDate.ts` and `network.test.ts` are shared): `run test-results/verify/m2-s4/green/wo1-harness.log corepack yarn jest tests/unit/harness tests/integration/harness`. Everything must pass.

**Commit 2:** `test(harness): ustar writer, probe plugin builder, repeating-todos seed and local noon (M2-S4)`.

## WO-2: The OPFS file probe (RED → GREEN)
**RED: `tests/e2e/harness/opfs-files.spec.ts` (new).** It imports `localFilesNamed` from `../support/localProfile.ts`. It uses the `webApp` fixture only (no account), and the `longSpecTimeoutMs` describe configuration.
- **`M2-S4-OPFS-01 localFilesNamed lists every OPFS file with that name, with size and sha256`:**
  - `webApp.page.goto(new URL('/manifest.json', webApp.baseURL).href)`.
  - In the page, write 3000 deterministic bytes (`(i * 31 + 7) & 255`) to `navigator.storage.getDirectory()` → `joplin-web/app/plugins/x.jpl`, and 5 bytes to `joplin-web/other/x.jpl`, both through `createWritable()`.
  - `localFilesNamed(webApp, 'x.jpl')`, sorted by path, deep-equals `[{ path: '/joplin-web/app/plugins/x.jpl', size: 3000, sha256: <Node's> }, { path: '/joplin-web/other/x.jpl', size: 5, sha256: <Node's> }]`.
- **`M2-S4-OPFS-02 an absent name gives an empty list`:** the same setup, then `localFilesNamed(webApp, 'absent.jpl')` is `[]`.

**RED run** (light: Playwright only loads the file):
`run test-results/verify/m2-s4/red/wo2-list.log corepack yarn playwright test tests/e2e/harness/opfs-files.spec.ts --list`
- **Expected:** a load error saying `localProfile.ts` does not provide an export named `localFilesNamed`.
- **Otherwise: HARD STOP.**

**Commit 1:** `test(e2e): failing harness spec for the OPFS file probe (M2-S4)`.

**GREEN: `tests/e2e/support/localProfile.ts`, `localFilesNamed(webApp, baseName, opts?)`.**
- It follows `scanLocalProfile`: it closes the app page and opens a probe page on `/manifest.json` (no app code).
- It walks `navigator.storage.getDirectory()` and returns `{ path, size, sha256 }` for each file whose last path segment equals `baseName`. The sha256 is `crypto.subtle.digest('SHA-256', …)`, as lowercase hex.
- It retries through `waitFor` while any entry fails to read (30 s), and returns no content.
- The caller must not use the app page afterwards: say so in its comment, as `scanLocalProfile` does.

**GREEN run** (heavy; the first one builds the images unless WO-0 found them):
`T=60m run test-results/verify/m2-s4/green/wo2-opfs.log corepack yarn playwright test tests/e2e/harness/opfs-files.spec.ts`
- Both tests pass.
- Then run the harness set (`localProfile.ts` is shared), as in WO-1.
- **S-OPFS** (sensitivity, temporary): make the walk skip any path containing `/plugins/`. `M2-S4-OPFS-01` must fail. Log it under `sens/s-opfs.log`, then `git checkout -- tests/e2e/support/localProfile.ts`.

**Commit 2:** `test(harness): localFilesNamed, a value-free OPFS file digest probe (M2-S4)`.

## WO-3: The M2-S4 E2E specs (RED)
Three files under `tests/e2e/m2-s4/`. They import the page objects and flows that WO-4 adds (`ConfigScreen`, `PluginsScreen` from `../support/pages/joplinWebApp.ts`; `installPluginFromFile`, `enablePluginSupport`, `pluginRunning` from `../support/plugins.ts`). Write each as the plan's AC table and D1 to D6 describe, with numbered `test.step`s whose titles are the plan's step names.

**`plugin-jpl.spec.ts`:**
- **`M2-AC9-01 the repeating-todos .jpl uploaded with plugin support enabled installs enabled, survives a reload, has no views.menus entry on web (NEG1), and reopens a completed daily to-do with its due date one day later, in the UI and through REST`:**
  - **Step 0, the seed:**
    - `fx = repeatingTodosFixture()`; `run = randomBytes(4).toString('hex')`; `R = 'Notestead repeating ' + run`; `T = 'Notestead once ' + run`;
    - `due = localNoonEpoch(Date.now(), 1, userTimeZone)`; `expectedDue = localNoonEpoch(Date.now(), 2, userTimeZone)`, both computed **now**;
    - `folderId` = the seeded note 1's `parent_id`;
    - `tagsTitled(restGet(dataApi), 'recurring')` must be `[]`;
    - `POST /notes` for R and T (`{ title, is_todo: 1, todo_due: due, parent_id: folderId }`);
    - `PUT /notes/<R>` `{ user_data: repeatingTodoUserData({ interval: 'day' }, Date.now()) }`;
    - `POST /tags { title: 'recurring' }`, then `POST /tags/<tag>/notes { id: R }`.
  - **The seed check (data level):**
    - `recurrenceOf(GET /notes/<R>?fields=user_data .user_data)` deep-equals rec-02's `v`;
    - `noteTagTitles(R)` is `['recurring']`; `noteTagTitles(T)` is `[]`;
    - T's `user_data` is `''`.

    Then `syncHeadlessOnce(stack, headlessService)`, `openUnlockedWebApp(…)`, and `app.openFolder(seedFolder)`. Wait (`expect.poll`, 3 min) until both `app.todoCheckbox(R)` and `app.todoCheckbox(T)` are visible, with `aria-checked="false"`.
    - Record `folderIdsBefore`: the sorted ids of `allItems(get, '/folders/<id>/notes', 'id')`.
  - **Step 1:** `const plugins = await enablePluginSupport(app)`. This is Configuration → Plugins → "Enable plugin support", ending on the plugin list. Then `plugins.noneInstalled()` is visible. **Data level:** `localFilesNamed` is **not** called here, because it closes the app page. The OPFS "before" state is proven by `M2-AC9-02`'s end state and by `M2-S4-OPFS-02`'s NEG.
  - **Step 2:** `await installPluginFromFile(plugins, fx.path)`. Then:
    - `plugins.installedHeading(1)` (`Installed (1):`) is visible;
    - `plugins.card(fx.name)` is visible;
    - `plugins.chips(fx.name)` contains none of `Incompatible`, `Error`, `Disabled`;
    - `plugins.enabledSwitch(fx.name)` is `aria-checked="true"`, read inside the card's info dialog, which is then closed.
  - **Step 3:** back to the list, open R, then `pluginRunning(note, 120_000)`. That polls `note.menuItemNames()` until it includes `pluginNoteToolbarLabel`. Back to the list.
  - **Step 4:**
    - `webApp.page.reload()`, then `app.sidebarButton().waitFor({ timeout: appStartTimeoutMs })`;
    - the same checks as steps 2 and 3 (`enabledSwitch` too), reaching the plugin list through `app.openConfiguration()` → `openSection('Plugins')`. Support is already enabled, so there is no enable page.
  - **Step `NEG1`** (**amended 2026-11-19 by the H5 ruling**; the plan section "Planner ruling on HARD STOP H5" is normative). With R open, the plugin running, and the action menu open:
    1. `note.menuItemNames()` includes `pluginNoteToolbarLabel` and none of `pluginMenuLabels`.
    2. `app.renderedTopFrame()` (new: top-frame `body` `innerText()` and `ariaSnapshot()`, no child frames). Both `text` and `aria` contain `pluginNoteToolbarLabel` (positive control), and neither contains any of `pluginMenuLabels`. Message: `"<label>" rendered in <text|aria> (action menu open)`.
    3. Close the menu, back to the list, `app.openSidebar()`, `app.renderedTopFrame()`: `text` contains `Configuration` (positive control); neither field contains any of `pluginMenuLabels` (`… (side menu open)`); `app.closeSidebar()`.

    Keep each check's forbidden list a separate local constant (each initialised from `pluginMenuLabels`), so the sensitivity runs S-NEG1a/b/c can edit one list at a time. `frameHtml()` is not used in NEG1. **RECORD** whether the `ariaSnapshot()` showed any child-frame content.
  - **Step 5:** `doneAt = Date.now()`. Click `app.todoCheckbox(R)`, then `app.todoCheckbox(T)`. Both read `aria-checked="true"` (the default 5 s).
  - **Step 6:**
    - `expect.poll(() => app.todoCheckbox(R).getAttribute('aria-checked'), { timeout: 120_000, intervals: [1_000] }).toBe('false')`;
    - then `expect(app.todoCheckbox(T)).toHaveAttribute('aria-checked', 'true')`;
    - annotation `reopen`: `R unchecked after <ms> ms`.
  - **Step 7:** `cycle('reopen')` (the M2-S2 pattern: `syncWebThenHeadless` plus the `cycle` annotation). Then, with `expect.poll` (60 s) on REST:
    - `GET /notes/<R>?fields=id,is_todo,todo_due,todo_completed,is_conflict` equals `{ id: R, is_todo: 1, todo_due: expectedDue, todo_completed: 0, is_conflict: 0 }`;
    - `recurrenceOf(R's user_data)` matches `{ enabled: true, interval: 'day', intervalNumber: 1 }` (`toMatchObject`; never `t`);
    - `notesTitled(dataApi, R, { includeDeleted: true }).map(id)` is `[R]`;
    - the folder's sorted note ids equal `folderIdsBefore`;
    - T: `todo_due === due`, and `todo_completed` is between `doneAt − 60 000` and `Date.now() + 60 000`;
    - `partsIn(expectedDue, userTimeZone)` has `hour '12'` and is not the same day as `partsIn(due, …)`. This is a guard on the oracle.
  - **Step 8:** `files = await localFilesNamed(webApp, fx.id + '.jpl')`.
    - Exactly one entry, with `path` ending in `/plugins/<id>.jpl`, `size === fx.size` and `sha256 === fx.sha256`.
    - Annotation `opfs`: the path.
  - **Step 9:** for each prefix, `webNetwork.allow(prefix)` (also at the start of the test). Then:
    - `endOfTestViolations(webNetwork.entries(), origin, webNetwork.allowed())` is `[]`;
    - no request goes to `joplinServer.url`;
    - annotation `plugin-repo`: the sorted unique `METHOD host+path status` of the requests under the prefixes (no query string).
- **`M2-AC9-02 negative control: without the plugin, a completed repeating to-do stays completed with its due date unchanged`:**
  - Step 0 as in `-01`.
  - Step 1 as in `-01`: enable support, and "No plugins are installed."
  - Back to the list. Click R; `aria-checked="true"`; `clickedAt = Date.now()`.
  - `holdsFor('R stays completed without the plugin', …, { windowMs: 75_000, intervalMs: 1_000 })`. The probe returns a message if `aria-checked` is not `'true'`.
  - `cycle`. REST R: `todo_completed > 0`, `todo_due === due`, and `recurrenceOf(user_data)` deep-equals the seeded `v`.
  - `localFilesNamed(webApp, fx.id + '.jpl')` is `[]`. This is the data-level "never installed".
  - Network as in step 9.

**`plugin-platforms.spec.ts`: `M2-AC9-03 (NEG 2) a platforms: ["desktop"] plugin uploaded on web installs but is marked Incompatible and never runs, while its mobile twin runs`:**
- **Build** in a `mkdtemp` directory, removed in `finally`:
  - `desktop = buildProbeJpl({ kind: 'desktop', run, dir })`;
  - `mobile = buildProbeJpl({ kind: 'mobile', run, dir })`.
- `openUnlockedWebApp`, then `enablePluginSupport`.
- **Install `desktop`:**
  - `Installed (1):`;
  - `plugins.chips(desktop.name)` contains `Incompatible`;
  - `plugins.incompatibleMessage(desktop.name)` (press the chip, read the message box, close it) equals `This plugin doesn't support Joplin Mobile.` exactly.
- **Install `mobile`:**
  - `Installed (2):`;
  - `plugins.chips(mobile.name)` does not contain `Incompatible`.
- **Marker check:** `markerCount(m)` is `notesTitled(dataApi, m, { includeDeleted: true }).length`. Cycle until `markerCount(mobile.marker) ≥ 1`, at most 3 cycles (each cycle one `cycle()`, then one REST read). Record `before = markerCount(mobile.marker)`. Then `markerCount(desktop.marker) === 0`.
- **Reload:** `webApp.page.reload()`, wait for the app, then reopen the plugin list:
  - the desktop card still shows `Incompatible`;
  - `Installed (2):`.
- **After the reload:** cycle until `markerCount(mobile.marker) > before`, at most 3 cycles. Then `markerCount(desktop.marker) === 0`.
- **OPFS:** `localFilesNamed(webApp, desktop.id + '.jpl')` has exactly one entry, with `sha256 === desktop.sha256`. Annotation `neg2`: `desktop-only stored, not run`.
- **Network:** as in `-01`.

**`plugin-repository.spec.ts`: `test('M2-AC10 a plugin installed from the official repository in the web app downloads from raw.githubusercontent.com, stores the published bytes and runs', { tag: '@network' }, …)`:**
- `openUnlockedWebApp`, then `enablePluginSupport`, then `noneInstalled()`.
- `plugins.repositoryLoaded(120_000)`. That is: the `Loading...` progress bar is gone, the text "Plugin repository failed to load" is absent, and "Content provided by:" is absent.
- `plugins.search('Repeating To-Dos')` (typed like a user into "Search for plugins..."). Then `plugins.installFromSearch('Repeating To-Dos', 120_000)`: press the result card's Install button and wait until it reads `Installed`.
- Clear the search, then:
  - `Installed (1):` and the card;
  - the running check (step 3 of `-01`), on note 1 of the seed.
- **The published hash:** `fetch('https://raw.githubusercontent.com/joplin/plugins/master/manifests.json')` from Node, before the install and after the OPFS read.
  - `hash = manifests[fx.id]._publish_hash.replace(/^sha256:/, '')`.
  - The two reads must agree. Otherwise fail with `the repository changed during the test`.
- **OPFS:** exactly one `<id>.jpl` under `/plugins/`, whose `sha256 === hash`. Annotation `ac10`: the repository's `version` and `hash`.
- **Network:**
  - an entry `GET https://raw.githubusercontent.com/joplin/plugins/master/plugins/<id>/plugin.jpl` with status 200;
  - no URL containing `/releases/download/`;
  - the policy clean (allowed prefixes only).

**`tests/acceptance/m2-s4/` is not part of this order** (WO-5).

**RED run** (light): `run test-results/verify/m2-s4/red/wo3-list.log corepack yarn playwright test tests/e2e/m2-s4 --list`
- **Expected:** load errors naming the missing exports (`ConfigScreen`/`PluginsScreen` from `pages/joplinWebApp.ts`, and `enablePluginSupport` and the others from `plugins.ts`).
- eslint must be clean on the three files.
- `tsc` must show only those missing exports.
- **Any other error: HARD STOP.**

**Commit:** `test(e2e): failing M2-S4 plugin specs: .jpl install and core behaviour, NEG 1, NEG 2, repository (@network)`.

## WO-4: Page objects and flows (GREEN for WO-3; heavy, iterative)
**Files:**
- **`tests/e2e/support/pages/joplinWebApp.ts`:**
  - **`JoplinWebApp.openConfiguration(): Promise<ConfigScreen>`:** `openSidebar()`, then `getByRole('button', { name: 'Configuration', exact: true })` (`upstream:packages/app-mobile/components/side-menu-content.tsx:646`). Wait for the screen.
  - **`class ConfigScreen`:**
    - `openSection(name: 'Plugins'): Promise<PluginsScreen>`: the section selector's button, named by `Setting.sectionNameToLabel` (`upstream:packages/lib/models/Setting.ts:1363`, `'Plugins'`);
    - `back()`.
  - **`class PluginsScreen`:**
    - `enableButton()`: button "Enable plugin support";
    - `noneInstalled()`: text "No plugins are installed.";
    - `installedHeading(n)`: text `Installed (${n}):`;
    - `card(name)`: `getByTestId('plugin-card').filter({ hasText: name })`;
    - `chips(name): Promise<string[]>`: the visible texts among `Incompatible`, `Error`, `Disabled`, `Update available`, `Installed`, `Built-in`, `Dev` inside the card;
    - `openInfo(name)` and `enabledSwitch()`: in the info dialog, the switch labelled by "Enabled" (`…/plugins/PluginInfoModal.tsx:93-94`);
    - `closeInfo()`;
    - `incompatibleMessage(name): Promise<string>`: press the card's `Incompatible` chip, read upstream's message box (`shim.showMessageBox`; find out whether it is a native `dialog` or the in-app `prompt-dialog`, and **RECORD** which), close it with "OK";
    - `advancedSettings()`: the "Advanced settings" accordion button (`ConfigScreen.tsx:687-692`);
    - `installFromFileButton()`;
    - `repositoryLoaded(timeoutMs)`;
    - `search(text)`;
    - `installFromSearch(name, timeoutMs)`: the result card's button, named `Install  ${name}` (two spaces, `…/plugins/buttons/ActionButton.tsx:26`; check the normalised accessible name in an `ariaSnapshot()` and **RECORD** it).
  - **`NoteScreen.menuItemNames(): Promise<string[]>`:** open `actionsButton()`, read the accessible names of every button in `getByTestId('menu-content-open')`, then close the menu with `Escape`. If `Escape` does not close it, **RECORD** what does and use that. Keep `menuAction` unchanged.
- **`tests/e2e/support/plugins.ts`:**
  - **`enablePluginSupport(app): Promise<PluginsScreen>`:** `openConfiguration` → `openSection('Plugins')` → `enableButton().click()` → `noneInstalled().waitFor()`.
  - **`installPluginFromFile(plugins, path, timeoutMs = 120_000)`:** open `advancedSettings()` if `installFromFileButton()` is hidden. Then `const chooser = page.waitForEvent('filechooser', { timeout: 30_000 })`, click, `(await chooser).setFiles(path)`, and wait for the next `Installed (n):` within `timeoutMs`.
  - **`pluginRunning(note, timeoutMs)`.**
  - The `pluginRepositoryPrefixes` from WO-1.
  - **The D9 console attachment:** a helper `attachPluginConsole(webApp, testInfo)` that each spec calls in `test.afterEach` **on failure only**. It writes the filtered `webApp.console` lines through `attachText`, which redacts them.

**Development runs, one at a time, each logged under `green/`:**
`T=40m run test-results/verify/m2-s4/green/wo4-ac9-01-<n>.log env $IMG corepack yarn playwright test tests/e2e/m2-s4/plugin-jpl.spec.ts -g 'M2-AC9-01'`
- Then `-g 'M2-AC9-02'`, then `plugin-platforms.spec.ts`.
- **While you develop locators:** use `ariaSnapshot()` of the region on a failing step (it is in `error-context.md`). Fix only **harness** code (page objects, flows, helpers).
- **What counts as a locator problem:** a locator that does not match the DOM, when the DOM shows the right state. Note each one in the commit body. Changing **what** a spec asserts is never a locator fix.

**HARD STOPs in WO-4** (each with the D9 console lines, the trace path and an `ariaSnapshot()`):
- **H1:** after "Install from file", there is no `Installed (1):` within 120 s, or upstream shows `Error: …`.
- **H2:** the plugin installs but is not running: "Open Recurrence Dialog" never appears within 120 s, after the install or after the reload. Collect the console lines with `PluginRunner`, `PluginService`, `Could not load plugin` or `Repeating Todos`, plus the response headers of the app page (COOP/COEP). This is plan P3 and "Requirements on the implementation", the contingency.
- **H3:** the step 0 seed check fails: `user_data` does not round-trip through the headless REST API (P6), or the `recurring` tag already exists.
- **H4:** R is not unchecked within 120 s after the tick (step 6) while the plugin was shown running. **This is the core behaviour failing.** Collect the console lines, and R's REST state after one cycle (record it, and do not change the test).
- **H5:** NEG1 (as ruled 2026-11-19, plan "Planner ruling on HARD STOP H5") finds a plugin menu label by role or in the top frame's rendered text or accessibility tree, or one of its in-test positive controls is missing.
- **H6:** NEG 2: the desktop-only upload is **refused** (an error box, no card), instead of marked "Incompatible". The AC allows it, but the plan asserts P4, so the planner amends the plan. Also: the incompatibility text differs from `This plugin doesn't support Joplin Mobile.`, or the desktop marker appears in REST.
- **H7:** a cross-origin request outside the allowed prefixes (step 9).
- **H8:** step 7's `todo_due` differs from `expectedDue`. Report both epochs and their `partsIn`.
- **H9:** the third qualifying L20 occurrence in one run (D12).

**Commits** (split as the work goes; each GREEN commit after its spec passes once, cleanly):
1. `test(e2e): page objects for Configuration and the Plugins screen, and the note menu's item names (M2-S4)`. The harness set must pass (shared module).
2. `test(e2e): plugin flows and the plugin console attachment (M2-S4)`.

In each body, list which specs now pass, and the log paths.

## WO-5: The `@network` exclusion (RED → GREEN)
**RED: `tests/acceptance/m2-s4/network-tag.test.mts` (new, node:test).** Model it on `tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` (`repoRoot`, `spawnSync`).
- **`NT-01`:**
  - `spawnSync('corepack', ['yarn', 'playwright', 'test', '--list'], { env: { ...process.env, NOTESTEAD_NETWORK_TESTS: '' } })` exits 0;
  - its stdout lists `M2-AC9-01`, `M2-AC9-02` and `M2-AC9-03`;
  - it lists no line containing `@network` or `M2-AC10`.
- **`NT-02`:** with `NOTESTEAD_NETWORK_TESTS: '1'`, the stdout lists `M2-AC10`.

**RED run:** `run test-results/verify/m2-s4/red/wo5-nt.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s4/network-tag.test.mts`.
- **Expected:** NT-01 fails, naming `M2-AC10`. NT-02 passes.
- **Otherwise: HARD STOP.**

**Commit 1:** `test(acceptance): failing check that @network E2E tests stay out of the default run (M2-S4 D8)`.

**GREEN: `playwright.config.ts`.**
- Add `grepInvert: process.env.NOTESTEAD_NETWORK_TESTS === '1' ? undefined : /@network/,` beside `forbidOnly`.
- Add one header comment line: `// - @network tests (internet access) run only with NOTESTEAD_NETWORK_TESTS=1: nightly and on pin bumps in CI (docs/test-plans/M2-S4.md D8).`
- **Runs:**
  - the same command under `green/`, where both pass;
  - `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts tests/acceptance/ci-m2-s2/timeouts.test.mts`, where all must pass.

**Commit 2:** `test(e2e): leave @network tests out unless NOTESTEAD_NETWORK_TESTS=1 (M2-S4 D8)`.

## WO-6: The CI half of D8 (RED, stays red until CC-NET)
- **Append to `tests/acceptance/m2-s4/network-tag.test.mts`, `NT-03`.** Parse `.github/workflows/e2e.yml` with `yaml`, reusing the job and step model of `ac22-e2e-workflow.test.mts` (copy the small helpers, or import them if they are exported). It asserts:
  - `on.schedule` is a non-empty list with a `cron`;
  - `on.workflow_dispatch.inputs.network.type === 'boolean'`;
  - on both runners, every Playwright step's `env.NOTESTEAD_NETWORK_TESTS` is a `${{ … }}` expression containing `steps.network.outputs`;
  - the same job has a step with `id: network` whose `run` contains `upstream/joplin-version.json` and `schedule`.
- **RED run:** under `red/wo6-nt03.log`.
  - **Expected:** NT-03 fails at `on.schedule`; NT-01 and NT-02 pass.
  - **Otherwise: HARD STOP.**
- **Commit:** `test(acceptance): failing check that e2e.yml runs @network tests nightly and on pin bumps (M2-S4 CC-NET)`.

Then **stop and report to the orchestrator** that brief CC-NET (plan) can be dispatched. **Continue with WO-7 and WO-8 in the meantime.** NT-03 stays red until CC-NET lands. That is expected, and not a stop.

## WO-7: Sensitivity runs (no commits)
Each is a temporary edit. Run each one alone, with `env $IMG`, log it under `sens/<id>.log`, and copy its junit. Revert with `git checkout -- <files>`, and check `git status --short` is clean before the next one.

| ID | Edit | Command (`-g`) | Must fail at |
|---|---|---|---|
| S-AC9a | `plugin-jpl.spec.ts` step 0: comment out R's `PUT user_data`, and the seed-check line for it | `M2-AC9-01` | step 6 (R unchecked, 120 s) |
| S-AC9b | step 7: `expectedDue` uses `+3` | `M2-AC9-01` | step 7 `todo_due` (expected vs received) |
| S-AC9c | **exactly steps 1 to 3 of the plan's "Planner ruling on the S-AC9c HARD STOP", then steps 4 to 7 of "Planner ruling on the second S-AC9c HARD STOP"** (Delete, confirm `OK` in `prompt-dialog`, the dialog with `Install Repeating To-Dos` and no switch, its `Close`, "No plugins are installed.", back). No `infoDialog()`, `enabledSwitch()` or `closeInfo()` after the delete | `M2-AC9-01` | step 4 `Installed (1):` |
| S-NEG1a | add `pluginNoteToolbarLabel` to check 1's forbidden list only | `M2-AC9-01` | NEG1 check 1 (role-based names) |
| S-NEG1b | add `pluginNoteToolbarLabel` to check 2's forbidden list only | `M2-AC9-01` | NEG1 check 2, `"Open Recurrence Dialog" rendered in text (action menu open)` |
| S-NEG1c | add `Configuration` to check 3's forbidden list only | `M2-AC9-01` | NEG1 check 3, `(side menu open)` |
| S-NEG2 | `plugin-platforms.spec.ts`: build `desktop` with `platforms` forced to `['desktop', 'mobile']` (a temporary option on `buildProbeJpl`, reverted afterwards) | `M2-AC9-03` | the `Incompatible` chip expectation |
| S-AC10 | `plugin-repository.spec.ts`: change the last hex digit of `hash` | `M2-AC10`, with `NOTESTEAD_NETWORK_TESTS=1` | the OPFS sha256 assertion |

- **Run each sensitivity by hand, one at a time** (no queued driver), with `e2e_pre` first.
- **A sensitivity run that passes, or fails elsewhere:** **HARD STOP** (the test cannot see what the plan says it sees).
- **A qualifying L20 failure during a sensitivity run:** an occurrence (D12), not a sensitivity result. Record it, and re-run that sensitivity **once**, unchanged: an L20 hit says nothing about the sensitivity. If the second attempt also hits L20: **HARD STOP**.

## WO-8: Verify (no commits; logs under `verify/`)
Run in this order, one at a time:
1. **Unit and acceptance:**
   - `corepack yarn jest tests/unit/harness tests/integration/harness` → `verify/harness.log`;
   - `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s4/network-tag.test.mts tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts tests/acceptance/ci-m2-s2/timeouts.test.mts` → `verify/acceptance.log`. NT-03 is red unless CC-NET has landed: **RECORD** which.
2. **M2-S4, per commit:** `T=60m run verify/m2-s4.log env $IMG corepack yarn playwright test tests/e2e/m2-s4 tests/e2e/harness/opfs-files.spec.ts`. That is 5 tests: `M2-AC10` is excluded, and the list in the log proves it.
3. **M2-AC10:** `T=30m run verify/ac10.log env $IMG NOTESTEAD_NETWORK_TESTS=1 corepack yarn playwright test tests/e2e/m2-s4/plugin-repository.spec.ts`.
   - If WO-0 step 5 failed (no internet), **RECORD**. M2-AC10 then stays PENDING-CI.
4. **The full E2E regression** (the shared page objects changed): `T=100m run verify/full.log env $IMG corepack yarn playwright test`. About an hour.
5. **Lint and checks:**
   - `T=30m run verify/lint.log corepack yarn lint`;
   - `T=60m run verify/no-upstream-copy.log corepack yarn check:no-upstream-copy`. This covers the committed `.jpl` and the probe source. A hit on `tests/fixtures/plugins/**`: **HARD STOP**.
6. **L20:** `node tests/harness/tools/scan-l20.ts test-results/e2e` after each E2E run (wrapper rule). List every occurrence with its record fields.
7. **Tests untouched by others:** `git log --format='%h %an %s%n%b' main..HEAD -- tests/ playwright.config.ts`. Every commit must carry `Agent: qa-specialist`; **RECORD** any that does not.

**A failure in steps 2 to 4:** the WO-4 HARD STOP list applies (H1 to H9). Any other failure is a **HARD STOP**, except a qualifying L20 occurrence (D12).

## WO-9: Results and the strategy (commit)
- **Append `## Results (QA executor, Pi arm64, <date>)` to `docs/test-plans/M2-S4.md`.** For each row of the AC table and each harness item, give:
  - PASS/FAIL;
  - the command;
  - the duration (from the log's `# duration` line);
  - the log, junit and trace paths under `test-results/verify/m2-s4/`;
  - the annotations (`reopen`, `cycle`, `opfs`, `plugin-repo`, `neg2`, `ac10`).
- **Then:**
  - the sensitivity table with each run's failure site;
  - the L20 occurrences, if any, with their record fields;
  - the RECORDs;
  - x64 as **PENDING-CI** (per commit: the next CI run of the branch; M2-AC10: after CC-NET).
- **Put a short "Results at a glance" at the top of the plan**, as M2-S3 did.
- **Update `docs/testing/strategy.md`:**
  - **§3 Tooling:** plugin fixtures are pinned by version and sha256, with a `provenance.json` and the plugin's licence beside them. Synthetic plugins are built per test from `tests/fixtures/plugins/probe/` by the ustar writer `tests/support/ustar.ts`, never committed as binaries.
  - **§5 Rules:** the `@network` tag. A test that needs the internet carries `{ tag: '@network' }`. `playwright.config.ts` leaves it out unless `NOTESTEAD_NETWORK_TESTS=1`. CI includes it nightly and on pin bumps (CC-NET). A failure caused by an external outage (DNS, or a 5xx from GitHub, visible in `network.log`) is recorded, and never retried or skipped.
  - **§4 Fixtures:** `localFilesNamed` (OPFS digest probe), and the network policy's plugin repository prefixes.
- **Commit:** `docs(test-plans): M2-S4 results on arm64` and `docs(testing): @network tag, plugin fixtures and the OPFS probe (M2-S4)` (two commits, staged by path).

Then end your turn with the final report: the orders done, the commits, per-AC status, the L20 count, the RECORDs, and whether CC-NET is still pending.
