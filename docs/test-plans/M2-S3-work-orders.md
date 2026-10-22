# M2-S3 work orders (QA executor)

These orders implement `docs/test-plans/M2-S3.md`. Read that plan first: its Planner decisions D1 to D9, Findings F1 to F10 and the AC table are the design. Each order gives the files, signatures, selectors, assertions, the commit split and subjects, the commands, and the expected outcome. Upstream paths are under `~/joplin-web-app-work/upstream-joplin/packages/` at `v3.7.21` (read-only).

## Rules for every order
- **Branch:** `feat/M2-S3-search-attachments-trash`, with `main` (including the CI-M2-S2 fix-forward) merged in. WO-0 checks this.
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
  If the orchestrator's dispatch names your model, use it in `Co-Authored-By`.
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat` or `fix` (P-R1), and never push. Stage by path (`git add <path>`), never `git add -A`.
- **Paths:** write only these:
  - `tests/**`
  - `playwright.config.ts`
  - `docs/testing/**`
  - `docs/test-plans/M2-S3*.md`

  Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**`, ADRs or STATUS. `.github/workflows/e2e.yml` belongs to the ci-cd-specialist (D7).
- **Test-first history (strategy §8, P2, CI-P2):** an order marked **RED commit** is two commits.
  1. **The failing test.** Before committing it:
     - run `corepack yarn eslint --max-warnings 0 <its files>`, which must be clean;
     - run `corepack yarn tsc -p tsconfig.json`: the **only** errors allowed are the missing module or export that the RED is about (this catches the one-argument `expect(x, msg)` slip: Jest's `expect` takes one argument);
     - log the RED run under `red/`.
  2. **The support code,** with the test passing, logged under `green/`.
     - If the GREEN touches a shared harness module (`fixtures.ts`, `flows.ts`, `redactingReporter.ts`, `failureLine.ts`, `syncPress.ts`, `stack.ts`, `images.ts`, `http.ts`, `pages/joplinWebApp.ts`), also run the whole harness set: `corepack yarn jest tests/unit/harness tests/integration/harness`. All of it must pass.
- **Tests:**
  - No `.only`, `.skip`, `fixme`, `waitForTimeout`, `test.slow()` or sleeps.
  - Wait only with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only with real key events (`typeLikeUser`, `clearLikeUser`, `NoteScreen.typeBody`). Never `fill()` or `dispatchEvent`.
  - Never weaken an assertion, and never change an asserted upstream string.
- **Bounds (CI-M2-S2):** actions 60 s, navigations 120 s, `expect` 5 s.
  - **Any wait that can take longer than 60 s passes its own `timeout`.**
  - Every spec uses `test.describe.configure({ timeout: longSpecTimeoutMs })` (import it from `tests/e2e/support/timeouts.ts`). No spec writes its own timeout number: `CI-T-03` fails otherwise.
- **Locale:** the harness pins Chromium's locale. Never set `LANG`/`LC_ALL` yourself, and never add locale handling.
- **Pi rules:**
  - Run one heavy job at a time (E2E, contract, full `yarn lint`, image builds), in the background with `timeout`, with one Playwright worker (the local default).
  - Never touch `byparr` or any podman resource without the label `io.github.thescriptingguy.notestead.test`.
- **Images:** **keep every test-labelled image until the planner's sign-off. The orchestrator removes them.**
  - Never `podman rmi`, `podman image prune`, `podman tag` or `podman untag` an image yourself, even a test-labelled or dangling one.
  - If an image looks wrong (untagged, missing, an unexpected id), record it. That is **RECORD**, below.
- **Leftover stacks (strategy §8):** if `podman ps -a` shows a test-labelled stack or container that you did not start, that is a **HARD STOP**. Don't remove it. Report its compose project, age and labels.
- **Calendar (D8 C2):** no run that includes `M2-AC5` may be running at any time between **2026-10-24 22:30 UTC and 2026-10-25 02:00 UTC**. That covers `tests/e2e/m2-s2/todos.spec.ts`, every full run, S-C1, S-C2 and S-C3. A full run takes about an hour, so check `date -u` before starting one. During that window, do the other orders or wait. This is not a stop.
- **Traces:** never add `--trace on`, and never set `use.trace`. The `webApp` fixture records traces itself (the Node 24 workaround).
- **Logs:** every command's output goes under `test-results/verify/m2-s3/<phase>/<name>.log`, where `<phase>` is `red`, `green`, `meas`, `sens` or `verify`. Use this wrapper:
  ```sh
  cd ~/Joplin-Web-App
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  IMG="NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1"
  # heavy example (background):  T=60m run test-results/verify/m2-s3/green/x.log env $IMG corepack yarn playwright test <spec>
  ```
  After every E2E run, copy `test-results/e2e/junit.xml` next to its log, as `<name>-junit.xml`, because the annotations are in it.
- **Light checks after each order:**
  - `corepack yarn eslint --max-warnings 0 <changed files>`;
  - `corepack yarn tsc -p tsconfig.json` (on a RED commit, see above);
  - the full `corepack yarn lint` once, in WO-24.

### Stop points (review CI-M2-S2-r1 P1; this has happened three times before)
There are two kinds. The orders name which one applies at each point.
- **HARD STOP.** **Allowed:**
  - collect the evidence the order names: logs, `error-context.md`, the trace path, an `ariaSnapshot()` of the region, the `podman ps -a`/`podman images` state;
  - re-run the **same** command, unchanged, once, only if the order says so, to capture evidence that is missing;
  - read upstream source;
  - revert every **temporary** edit (`git checkout -- <file>`);
  - write the finding under `## Findings (executor)` in `docs/test-plans/M2-S3.md`, uncommitted;
  - end your turn with a report to the orchestrator: the order and step, what happened, the evidence paths, your view of the cause, and `git status --short`.

  **Not allowed:**
  - fixing or changing any code, test, locator, helper, timeout or config;
  - adding a retry, a wait or a workaround, or trying another seam;
  - running with changes;
  - committing anything for the stopped order, or any later order;
  - continuing with other orders;
  - removing containers or images.

  The stopped order's own uncommitted work stays in the working tree for the planner to read. Orders committed before the stop stay committed. The planner decides what happens next, even when the fix looks small.
- **RECORD.** Write the observation under `## Findings (executor)`, with its evidence, and continue. Change nothing because of it.

---

## WO-0: Pre-flight (no commit)
1. **The base.** `git log --oneline -1 main` and `git merge-base --is-ancestor 1739167 HEAD`.
   - The CI-M2-S2 head `1739167` must be an ancestor of `HEAD`.
   - `tests/e2e/support/timeouts.ts`, `tests/e2e/support/syncPress.ts` and `tests/e2e/support/failureLine.ts` must exist.
   - Otherwise: **HARD STOP**. The fix-forward is not merged.
2. `git status --short` is empty, and `git log -1 --format=%h` is the planner's commit or the merge after it.
3. **The podman state:**
   ```sh
   mkdir -p test-results/verify/m2-s3
   { podman ps -a; podman network ls; podman volume ls; podman images; } > test-results/verify/m2-s3/podman-before.txt
   for i in localhost/notestead-web:stack-test localhost/notestead-headless:stack-test localhost/notestead-test-device:3.7.1; do podman image inspect --format "$i {{.Id}} {{index .Labels \"io.github.thescriptingguy.notestead.test\"}}" "$i" 2>&1; done >> test-results/verify/m2-s3/podman-before.txt
   ```
   - A test-labelled **container** or stack that you did not start: **HARD STOP** (leftover stack).
   - If all three tags exist with the test label, `$IMG` is valid. Otherwise the first heavy run (WO-11) builds them. **RECORD** which.
   - An untagged test-labelled image (a `<none>` left by F-H1): **RECORD**, and leave it alone.
4. `ls $NOTESTEAD_WEB_ARTIFACT` lists `SHA256SUMS`.
5. `date -u`: plan your heavy runs around the calendar rule.

## WO-1: F-H1, the contract layer never takes the E2E device image's tag (RED commit)
**RED** (`tests/unit/harness/imageTags.test.ts`, new; describe `image tags (F-H1)`). It imports from `../../stack/imageTags.ts`, plus `builtTags` from `../../stack/images.ts`, `webImageTag` from `../../contract/support/globalSetup.ts` and `headlessTag` from `../../contract/support/headless.ts`.
- `fh1-01 a device image named by NOTESTEAD_DEVICE_IMAGE is used as prebuilt, so a contract teardown never removes it`: `contractDeviceChoice('localhost/x:1')` equals `{ image: 'localhost/x:1', prebuilt: true }`.
- `fh1-02 otherwise the contract layer builds its own tag, never the one the E2E run keeps`:
  - `contractDeviceChoice(undefined)` and `contractDeviceChoice('')` each equal `{ image: contractDeviceTag, prebuilt: false }`;
  - `contractDeviceTag === 'localhost/notestead-test-device:m1-s5-test'`;
  - `stackDeviceTag('3.7.1') === 'localhost/notestead-test-device:3.7.1'`.
- `fh1-03 the tags the E2E stack builds and keeps and the tags the contract layer builds and removes never overlap`: the set `[builtTags.web, builtTags.headless, stackDeviceTag('3.7.1')]` and the set `[webImageTag, headlessTag, contractDeviceTag]` have no common element.

Log: `red/wo1-unit.log` (`corepack yarn jest tests/unit/harness/imageTags.test.ts`). Expect `Cannot find module '../../stack/imageTags.ts'`. Any other failure, for example an import of the contract modules failing under Jest, is a **HARD STOP**.

**Commit 1:** `test(harness): failing unit tests for separate E2E and contract device image tags (CI-M2-S2 F-H1)`.

**GREEN:**
- `tests/stack/imageTags.ts` (new, pure, no imports):
  ```ts
  // Image tags of the test layers (docs/test-plans/M2-S3.md F10; CI-M2-S2 F-H1). The E2E stack builds and may keep
  // stackDeviceTag (NOTESTEAD_KEEP_IMAGE=1); the contract layer used to build that same tag and remove it at teardown, which
  // left the kept E2E image untagged. The contract layer now uses a prebuilt NOTESTEAD_DEVICE_IMAGE as it is (never removed),
  // or builds its own tag, as its web (m1-s4-test) and headless (m1-s5-test) images already do.
  export const stackDeviceTag = (cliVersion: string): string => `localhost/notestead-test-device:${cliVersion}`;
  export const contractDeviceTag = 'localhost/notestead-test-device:m1-s5-test';
  export const contractDeviceChoice = (env: string | undefined): { image: string; prebuilt: boolean } =>
  	(env ? { image: env, prebuilt: true } : { image: contractDeviceTag, prebuilt: false });
  ```
- `tests/stack/images.ts`, `buildDevice`: `const tag = stackDeviceTag(cli.version);`. Nothing else changes.
- `tests/contract/support/headless.ts`, `deviceImage`:
  ```ts
  export const deviceImage = (): string => lazyImage('device', () => {
  	const choice = contractDeviceChoice(process.env.NOTESTEAD_DEVICE_IMAGE);
  	if (choice.prebuilt) return { image: choice.image, prebuilt: true };
  	const { cli } = readFullPin();
  	const dir = join(fixtures, 'device');
  	const built = runLogged('build-device', 'podman', ['build', '-f', join(dir, 'Containerfile'), '--build-arg', `JOPLIN_CLI_VERSION=${cli.version}`,
  		'--label', `${testLabel}=contract`, '--layer-label', `${testLabel}=contract`, '-t', choice.image, dir], { timeoutMs: 30 * 60_000 });
  	if (built.code !== 0) throw new Error(`the device fixture image failed to build (log ${built.log}): ${built.stderr.slice(-2000)}`);
  	return { image: choice.image };
  });
  ```
  Update the module's header comment: "`NOTESTEAD_DEVICE_IMAGE` is used as prebuilt". `globalTeardown.ts` needs no change, because `lazyImages` already skips `prebuilt` records.

Log: `green/wo1-unit.log` (3 of 3 pass), then the whole harness set into `green/wo1-jest-harness.log`. The contract proof is WO-12.

**Commit 2:** `test(harness): the contract layer builds its own device image tag and uses a prebuilt one as it is (CI-M2-S2 F-H1)`.

## WO-2: P2 and CI-P2, strategy §8 (`docs(testing)`)
In `docs/testing/strategy.md` §8, replace the bullet **"Test-first history in harness work (review M2-S1-r1 P2)."** with:

> - **Test-first history in harness work (reviews M2-S1-r1 P2, M2-S2-r1 P2, CI-M2-S2-r1 P2).**
>   - **Which changes need a fake-driven unit test.** A harness change with decision logic (counting, classifying, parsing, choosing or computing a value a test asserts) gets one. It lands as two commits: the failing test (RED, logged), then the support code (GREEN).
>   - **The RED commit.** It may not type-check only because it imports a module or an export that does not exist yet; that is the RED, never a stub. Before committing it, `eslint` must be clean on its files, and `tsc` may report only that missing module or export. This catches mistakes such as passing a message to Jest's one-argument `expect`.
>   - **The GREEN commit.** If it touches a shared harness module (fixtures, flows, the reporter and its failure line, the stack, images, HTTP helpers, page objects), it runs the whole `tests/unit/harness tests/integration/harness` set. A change to `redactingReporter.ts` or `failureLine.ts` also runs the contract self-tests (`tests/contract/m1-s6 m1-s6a m1-s7`).
>   - **Changes without decision logic** (a locator, a wait on an observed event) are proven by the spec that uses them and by a sensitivity run named in the test plan.

**Commit:** `docs(testing): decision logic gets a unit test, RED commits are linted, shared-module GREENs run the whole harness set (M2-S2 r1 P2, CI-M2-S2 r1 P2)`.

## WO-3: CI-C2, the strategy says how `syncWebOnce` presses (`docs(testing)`)
In `docs/testing/strategy.md` §5, in the bullet **"One web sync, one headless sync (from M2-S2)."**:
- If it still says "presses `Synchronise` once", replace that clause with: "presses `Synchronise`, and presses again, at most twice more, only when the button is idle again, no `delta` (200) was seen since the last press and 3 s have passed (the press cancelled the app's own sync, CI-M2-S2 F-R2; `syncPress.ts`); each re-press is a `sync-repress` annotation; completion still needs a delta after the last press".
- If the merged `main` already says this, make no change, and **RECORD** "CI-C2 already done on main".

**Commit (only if changed):** `docs(testing): syncWebOnce presses again, at most twice, when a press started no sync (CI-M2-S2 r1 C2)`.

## WO-4: C5 and CI-C5, `syncWebThenHeadless` and the sync probe (RED commit)
**RED** (`tests/unit/harness/syncPress.test.ts`, extend; keep `press-01…03`). Add a describe `sync probe`. Its fake is:
```ts
const deps = (o: { delta?: boolean; idle?: boolean; report?: string; now: () => number }) => {
	const calls = { press: 0, mark: 0 };
	return { calls, d: { deltaSinceMark: () => o.delta ?? false, idle: async () => o.idle ?? true, press: async () => { calls.press++; }, setMark: () => { calls.mark++; }, report: async () => o.report ?? '', now: o.now } };
};
```
The state starts as `{ presses: 1, pressedAt: 0, report: '' }`.
- `press-04 completion: a delta since the mark, an idle button and a Completed report`: the verdict is `'completed'`, `state.report` holds the report, and `calls.press` is 0.
- `press-05 a lost press is made again once, and the clock restarts at it`:
  - with `delta: false, idle: true` and the clock at `pressSettleMs`, the verdict matches `/^pressed again \(press 2\)/`; `calls.press` and `calls.mark` are 1; `state.presses` is 2; `state.pressedAt` is `pressSettleMs`;
  - a second probe with the clock at `pressSettleMs + 1000` (still no delta) gives `'no delta request since the press'`, and `calls.press` is still 1.
- `press-06 never more than maxPresses`: with `state.presses = maxPresses` and the clock at `10 * pressSettleMs`, the verdict is `'no delta request since the press'` and `calls.press` is 0.
- `press-07 a running sync`: with `delta: true, idle: false`, the verdict is `'a sync is running'`.
- `press-08 an error or no report yet`:
  - `report: 'Last error: boom'` gives a verdict matching `/^the sync reported an error: /`;
  - `report: 'Created local items: 1'` gives one matching `/^no completed report yet: /`.

Log: `red/wo4-unit.log`. Expect `syncProbe is not a function` in `press-04…08`, while `press-01…03` pass.

**Commit 1:** `test(harness): failing unit tests for the web sync probe and its re-press clock (CI-M2-S2 r1 C5)`.

**GREEN:**
- `tests/e2e/support/syncPress.ts`: add the pure probe. This is the poll body of `syncWebOnce`, moved here unchanged:
  ```ts
  export interface SyncProbeState { presses: number; pressedAt: number; report: string }
  export interface SyncProbeDeps {
  	deltaSinceMark: () => boolean;
  	idle: () => Promise<boolean>;
  	press: () => Promise<void>;
  	setMark: () => void;
  	report: () => Promise<string>;
  	now: () => number;
  }
  // One probe of syncWebOnce's poll (review CI-M2-S2-r1 C5: the wiring gets a fake-driven test). A re-press sets the mark and
  // restarts the clock before it clicks, so the next probe cannot press again at once.
  export const syncProbe = async (s: SyncProbeState, d: SyncProbeDeps): Promise<string> => {
  	if (!d.deltaSinceMark()) {
  		if (pressAgain({ deltaSeen: false, idle: await d.idle(), msSincePress: d.now() - s.pressedAt, presses: s.presses })) {
  			s.presses++;
  			d.setMark();
  			s.pressedAt = d.now();
  			await d.press();
  			return `pressed again (press ${s.presses}): the last press started no sync`;
  		}
  		return 'no delta request since the press';
  	}
  	if (!(await d.idle())) return 'a sync is running';
  	s.report = await d.report();
  	if (/Last error:/.test(s.report)) return `the sync reported an error: ${s.report}`;
  	return /\bCompleted: /.test(s.report) ? 'completed' : `no completed report yet: ${JSON.stringify(s.report)}`;
  };
  ```
- `tests/e2e/support/flows.ts`:
  - **`syncWebOnce`** keeps its signature and its result `{ report, durationMs, presses }`. Its body becomes:
    1. open the side menu;
    2. the idle `expect`;
    3. `let mark = network.entries().length; const state = { presses: 1, pressedAt: Date.now(), report: '' };`;
    4. `await app.syncIdle().click();`;
    5. `await expect.poll(() => syncProbe(state, deps), { timeout: timeoutMs, intervals: [1_000] }).toBe('completed');`, where `deps` wires:
       - `deltaSinceMark` to the network check that exists today;
       - `idle` to `app.syncIdle().isVisible()`;
       - `press` to `app.syncIdle().click()`;
       - `setMark` to `mark = network.entries().length`;
       - `report` to `app.syncReport()`;
       - `now` to `Date.now()`.
    6. the `sync-repress` annotation (unchanged) and `closeSidebar`.

    Keep its comment, adding "the poll body is `syncProbe` (syncPress.ts)".
  - **`syncWebThenHeadless`** (C5):
    ```ts
    // One web sync, then one headless sync of the test's own service (M2-S2 D2, D3). The timeouts are for waits above the
    // defaults (M2-S3 D7: M2-AC7a's 100 MiB attachment).
    export const syncWebThenHeadless = async (app: JoplinWebApp, network: NetworkRecorder, stack: StackState, service: HeadlessService, opts: { webTimeoutMs?: number; headlessTimeoutMs?: number } = {}): Promise<{ webMs: number; headlessMs: number }> => {
    	const web = await syncWebOnce(app, network, opts.webTimeoutMs);
    	const headless = await syncHeadlessOnce(stack, service, opts.headlessTimeoutMs);
    	return { webMs: web.durationMs, headlessMs: headless.durationMs };
    };
    ```
- Run `grep -rn webReport tests/`. It must print nothing.

Logs:
- `green/wo4-unit.log` (`press-01…08` pass);
- the whole harness set, into `green/wo4-jest-harness.log`.

The E2E proof is WO-11 (M2-S2 specs, 4 cycles in M2-AC3) and S1c″ (WO-24).

**Commit 2:** `test(harness): syncWebOnce's poll body is the unit-tested syncProbe; syncWebThenHeadless returns the durations and takes timeouts (CI-M2-S2 r1 C5, M2-S2 r1 C5)`.

## WO-5: C4, value-free checks of seeded values (RED commit, then two commits)
**RED** (`tests/unit/harness/seedScan.test.ts`, extend):
- `seed-04 fieldsThatDiffer names the fields of expected whose values differ, sorted`:
  - `fieldsThatDiffer({ id: 'a', title: 'T', body: 'B2', extra: 1 }, { id: 'a', title: 'T', body: 'B' })` is `['body']`;
  - with equal values it is `[]`;
  - a key missing from `actual` is named;
  - arrays and objects compare by value: `fieldsThatDiffer({ x: [1, 2] }, { x: [1, 2] })` is `[]`.
- `seed-05 fieldsThatDiffer never returns a compared value`: for `actual = { title: 'Notestead note abc12', body: 'Seeded body abc12 zebracorn' }` and `expected = { title: 'other', body: 'other body' }`, `JSON.stringify(result)` contains neither actual value nor either expected value, and it equals `["body","title"]`.

Log: `red/wo5-unit.log` (`fieldsThatDiffer is not a function`). `seed-01…03` must pass.

**Commit 1:** `test(harness): failing unit tests for a value-free field diff (M2-S2 r1 C4)`.

**GREEN** (`tests/e2e/support/seedScan.ts`):
```ts
import { isDeepStrictEqual } from 'node:util';
// The names of the fields of `expected` whose values differ in `actual`, sorted; never a value (M2-S2 r1 C4: a failing
// check of seeded data names what differs, as seedLabelIn names what it found).
export const fieldsThatDiffer = (actual: Record<string, unknown>, expected: Record<string, unknown>): string[] =>
	Object.keys(expected).filter(k => !isDeepStrictEqual(actual[k], expected[k])).sort();
```
Log: `green/wo5-unit.log`.

**Commit 2:** `test(harness): a value-free diff of named fields (M2-S2 r1 C4)`.

**Commit 3** (`tests/e2e/m2-s1/e2ee-unlock.spec.ts`; import `fieldsThatDiffer` from `../support/seedScan.ts`):
- **`readReference`:** change the callback to `(n, i) => …`, and replace its `expect(note, \`note "${n.title}" …\`).toMatchObject({ id: n.id, title: n.title, body: n.body, encryption_applied: 0, is_conflict: 0 })` with:
  ```ts
  expect(fieldsThatDiffer(note, { id: n.id, title: n.title, body: n.body, encryption_applied: 0, is_conflict: 0 }), `seeded note ${i + 1} through the headless REST API: the fields that differ from the seed`).toEqual([]);
  ```
- **Step `9.`:**
  - replace `expect(readReference(dataApi, seed)).toEqual(reference);` with:
    ```ts
    const after = readReference(dataApi, seed);
    expect(after.map((n, i) => fieldsThatDiffer(n, reference[i])), 'the fields of each seeded note that changed after one headless sync').toEqual(reference.map(() => []));
    ```
  - replace the `for` line with `seed.notes.forEach((n, i) => expect(notesTitled(dataApi, n.title).map(x => x.id), \`exactly one note with seeded title ${i + 1}, the seeded one\`).toEqual([n.id]));`.
- Nothing else in the file changes. Ids are random and may print.

Subject: `test(e2e): M2-AC2 seeded-value checks name fields, never values (M2-S2 r1 C4)`. The E2E proof is WO-11 and S-C4.

**Commit 4** (`docs/testing/strategy.md` §5, after the bullet "Seed scans report a label, never a value"), adding this bullet:
> - **Checks on seeded values name fields or labels, never values (M2-S2 r1 C4).** `fieldsThatDiffer` names what differs. A data diff of per-run synthetic values that the test made itself (titles and bodies it typed, ids, generated file hashes) may print: the diff is the point of a REST assertion, and those values are random per run and secret-free.

Subject: `docs(testing): seeded values are named, synthetic per-run values may print in a diff (M2-S2 r1 C4)`.

## WO-6: C2, the repeated hour when summer time ends (RED commit, then one commit)
**RED** (`tests/unit/harness/dueDate.test.ts`, extend):
- `due-06 a wall clock in the repeated hour names two instants`: in `'Europe/Amsterdam'`, `wallClockIsUnique` is `false` for:
  - `Date.UTC(2026, 9, 25, 0, 0)` (02:00 CEST);
  - `Date.UTC(2026, 9, 25, 0, 30)`;
  - `Date.UTC(2026, 9, 25, 0, 59)`;
  - `Date.UTC(2026, 9, 25, 1, 30)` (02:30 CET);
  - `Date.UTC(2026, 9, 25, 1, 59)`.
- `due-07 every other wall clock names one`: `true` for:
  - `Date.UTC(2026, 9, 24, 23, 59)` (01:59);
  - `Date.UTC(2026, 9, 25, 2, 0)` (03:00 CET);
  - `Date.UTC(2026, 9, 25, 2, 30)`;
  - `Date.UTC(2026, 2, 29, 1, 30)` (03:30 CEST, after the spring gap);
  - `Date.UTC(2026, 2, 29, 0, 59)` (01:59 CET);
  - `Date.UTC(2027, 6, 15, 12, 30)`;
  - and `true` in `'UTC'` for every instant of `due-06`.

  (The planner checked these values on the Pi.)

Log: `red/wo6-unit.log` (`wallClockIsUnique is not a function`).

**Commit 1:** `test(harness): failing unit tests for wall clocks in the repeated hour when summer time ends (M2-S2 r1 C2)`.

**GREEN** (`tests/e2e/support/dueDate.ts`):
```ts
// False when the zone's wall clock of `epochMs` also names another instant 30 or 60 minutes away: the repeated hour when
// summer time ends. A datetime-local value cannot tell the two apart, and the browser takes the first (M2-S2 r1 C2).
export const wallClockIsUnique = (epochMs: number, timeZone: string): boolean => {
	const own = datetimeLocalValue(partsIn(epochMs, timeZone));
	return [-60, -30, 30, 60].every(m => datetimeLocalValue(partsIn(epochMs + m * 60_000, timeZone)) !== own);
};
```
Log: `green/wo6-unit.log`.

**Commit 2:** `test(harness): tell when a wall clock names two instants (M2-S2 r1 C2)`.

**Commit 3** (`tests/e2e/m2-s2/todos.spec.ts`, step `2.`; import `wallClockIsUnique` and `datetimeLocalValue` as needed). Right after `due = nextWholeMinute(Date.now(), 150_000);`:
```ts
expect(wallClockIsUnique(due, userTimeZone), `the due time's ${userTimeZone} wall clock names one instant: it is not in the repeated hour when summer time ends (02:00-03:00 local), which datetime-local cannot name (M2-S2 r1 C2); rerun after 03:00 local`).toBe(true);
```
After `await alarm.enterLocal(partsIn(due, userTimeZone));`:
```ts
const typed = await alarm.input().inputValue();
expect(await webApp.page.evaluate(v => new Date(v).getTime(), typed), 'the page reads the typed wall clock as the due epoch, in its own time zone (M2-S2 D5, r1 C2)').toBe(due);
```
The existing "at least a minute before the due time" check and the alert check stay where they are.

Subject: `test(e2e): M2-AC5 checks the typed due time in the page and refuses the repeated hour (M2-S2 r1 C2)`. The E2E proof is WO-11 and S-C2.

## WO-7: C3, the spy covers the app's sandboxed frames (one commit)
`tests/e2e/m2-s2/todos.spec.ts`, step `4.`, appended after the positive-control assertion:
```ts
// C3 (M2-S2 r1): the init script reaches the app's own sandboxed frames: the note viewer, then the Markdown editor.
await app.openNote(note1.title);
await note.waitOpen();
const coverage = async (): Promise<string> => {
	const r = await readNotificationSpy(webApp.page);
	if (r.frames < 2) return `only ${r.frames} frame(s)`;
	return r.framesWithSpy === r.frames ? 'covered' : `${r.framesWithSpy} of ${r.frames} frames have the spy`;
};
await expect.poll(coverage, { message: 'every frame of the open note has the spy (the viewer)', timeout: 60_000, intervals: [500] }).toBe('covered');
const viewer = await readNotificationSpy(webApp.page);
await note.startEditing();
await expect.poll(coverage, { message: 'every frame has the spy (the editor)', timeout: 60_000, intervals: [500] }).toBe('covered');
const editing = await readNotificationSpy(webApp.page);
test.info().annotations.push({ type: 'spy-frames', description: `viewer: ${viewer.framesWithSpy} of ${viewer.frames}; editor: ${editing.framesWithSpy} of ${editing.frames}` });
expect(editing.main?.docId, 'the same document throughout the test').toBe(docId);
await app.backToList();
```
Step `5.` then finds the to-do in the same list, so it is unchanged.

Subject: `test(e2e): M2-AC5 shows the notification spy in the viewer's and the editor's frames (M2-S2 r1 C3)`. The E2E proof is WO-11 and S-C3.

## WO-8: C1, `waitSettled` waits for upstream's focus target (RED commit, then one commit)
**RED** (`tests/unit/harness/settle.test.ts`, new; describe `settle`):
- `settle-01 upstream's focus target`: `focusTargetFor('note')` is `'editor'`, and `focusTargetFor('todo')` is `'title'`.
- `settle-02 settled at the n-th consecutive reading of the target`: `seen = settleTracker('editor', 3)`; three readings of `'editor'` give `false, false, true`.
- `settle-03 any other reading resets the count`:
  - `'editor', 'editor', 'title'` give `false, false, false`;
  - then `'editor'` ×3 give `false, false, true`;
  - `settleTracker('x', 0)` throws `/at least one poll/`.

Log: `red/wo8-unit.log` (`Cannot find module '../../e2e/support/settle.ts'`).

**Commit 1:** `test(harness): failing unit tests for the focus target and the settle tracker (M2-S2 r1 C1)`.

**GREEN:**
- `tests/e2e/support/settle.ts` (new, pure):
  ```ts
  // Where upstream puts the focus when a new note or to-do opens in edit mode (Note.tsx scheduleFocusUpdate: a to-do's title,
  // a note's body, which is the Markdown editor; docs/test-plans/M2-S3.md F5), and a tracker that says when the focus has
  // stayed there for n polls in a row (M2-S2 r1 C1). No Playwright import.
  export type FocusTarget = 'title' | 'editor';
  export const focusTargetFor = (kind: 'note' | 'todo'): FocusTarget => (kind === 'todo' ? 'title' : 'editor');
  export const settleTracker = (target: string, polls: number): ((owner: string) => boolean) => {
  	if (!(polls >= 1)) throw new Error(`a settle needs at least one poll (${polls})`);
  	let steady = 0;
  	return owner => {
  		steady = owner === target ? steady + 1 : 0;
  		return steady >= polls;
  	};
  };
  ```
- `tests/e2e/support/pages/joplinWebApp.ts`, class `NoteScreen`:
  - **`editorFrame(): Promise<Frame>`:** the `waitFor` that `editor()` has today, returning the frame instead of its locator.
  - **`editor()`:** `return (await this.editorFrame()).locator('.cm-content')`.
  - **`waitSettled(kind: 'note' | 'todo'): Promise<{ kind: 'note' | 'todo'; editorMs: number; landedMs: number; settledMs: number }>`:**
    1. `started = Date.now()`; `await this.editorFrame()`; `editorMs = Date.now() - started`;
    2. `target = focusTargetFor(kind)`, `settled = settleTracker(target, 10)`;
    3. a `waitFor`, with `timeoutMs: 60_000, intervalMs: 100`, described as ``the focus to land on the ${target} (upstream's focus for a new ${kind}) and stay for 10 polls``. Each poll reads `owner = await this.focusOwner()`. It records `landedMs` at the first reading of `target` after a non-target, clears it on a non-target reading, and resolves when `settled(owner)`;
    4. returns `{ kind, editorMs, landedMs, settledMs }`.
  - **`focusOwner(): Promise<string>`:**
    - `frame = await this.editorFrame()`, `iframe = await frame.frameElement()`, `title = await this.titleField().elementHandle()`;
    - in the page: `document.activeElement === title` gives `'title'`; `=== iframe` gives `'iframe'`; otherwise `` `other:${localName}` ``;
    - if `'iframe'`, then in `frame`: `document.activeElement?.closest('.cm-content')` gives `'editor'`, otherwise `'other:iframe'`;
    - dispose the handles (`dispose()`) in `finally`;
    - use the `globalThis` casts the file already uses.
  - **`createFromFab`:** `const timing = await screen.waitSettled(item === 'New to-do' ? 'todo' : 'note');`, then:
    ```ts
    test.info().annotations.push({ type: 'settle', description: `${timing.kind}: editor ${timing.editorMs} ms, focus on the ${focusTargetFor(timing.kind)} at ${timing.landedMs} ms, settled ${timing.settledMs} ms` });
    ```
    `import { test } from '@playwright/test';` (`flows.ts` does the same).
  - Update the comment above `waitSettled` to the new rule (plan D8 C1, F5).

Logs:
- `green/wo8-unit.log`;
- the whole harness set, into `green/wo8-jest-harness.log`.

The E2E proof is WO-11 (M2-AC3 for a note, M2-AC5 for a to-do) and S-C1.

**Commit 2:** `test(harness): a new note or to-do settles when the focus lands where upstream puts it (M2-S2 r1 C1)`.

**Commit 3** (`docs/testing/strategy.md` §3). In the "Absence over a window" bullet, replace the sentence that starts "A **stabilisation** is the same rule at a small scale" with:
> A **stabilisation** is the same rule at a small scale: "nothing changes for N polls" after an observed event. It needs evidence, either the measured lag of what it waits out or the failing run it fixes, and it starts from a positive event where one exists. For example, a new note's editor loads, then the focus lands where upstream puts it (a note's editor, a to-do's title), then 10 × 100 ms (`NoteScreen.waitSettled`; M2-S2 F8, M2-S3 C1). The lag is recorded in the `settle` annotation.

Subject: `docs(testing): a stabilisation needs evidence and starts from a positive event (M2-S2 r1 C1)`.

## WO-9: CI-C1, the failure line says what failed (RED commit)
**RED** (`tests/unit/harness/failureLine.test.ts`, extend; `ci-fail-01…05` stay as they are):
- **`ci-fail-06 a matcher failure appends its first Expected and Received lines`.**
  - The error is:
    ```
    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "completed"
    Received: "no delta request since the press"

    Call Log:
    - Timeout 180000ms exceeded while waiting on the predicate
    ```
  - The line ends with `: Error: expect(received).toBe(expected) // Object.is equality | Expected: "completed" | Received: "no delta request since the press"`.
- **`ci-fail-07 a timeout appends its first waiting-for line`.**
  - The error is:
    ```
    TimeoutError: locator.click: Timeout 60000ms exceeded.
    Call log:
      - waiting for getByRole('button', { name: 'nst-never-there' })
    ```
  - The line ends with `: TimeoutError: locator.click: Timeout 60000ms exceeded. | waiting for getByRole('button', { name: 'nst-never-there' })`.
  - The same rule applies to a matcher without a `Received` line, for example `expect(locator).toBeVisible()`: it gets `Expected: …` and the first `waiting for` line.
- **`ci-fail-08 the detail is redacted before the cut`:** a `Received:` line holding a registered secret shows its label, never the value. A first line of 280 characters followed by details is cut at 300 characters plus `…`, and leaves no part of a secret.
- **`ci-fail-09 the reporter path redacts a registered secret in the detail`** (the review's ci-fail-04 item):
  - feed the reporter as `tests/unit/harness/secrets.test.ts` does (`createSecretsFile()`, then `registerSecrets([{ label: 'failline_secret', value: 'nstfailline0123456789abcdef' }])`, then a new `RedactingReporter()`);
  - the error is a matcher header, then `Received: "nstfailline0123456789abcdef"`;
  - the printed line contains `[failline_secret]` and not the value;
  - restore the env, and remove the file afterwards as that suite does.

Log: `red/wo9-unit.log`. Expect `ci-fail-06…09` to fail on the missing detail; `ci-fail-01…05` pass.

**Commit 1:** `test(harness): failing unit tests for a failure line that names what failed (CI-M2-S2 r1 C1)`.

**GREEN** (`tests/e2e/support/failureLine.ts` only; the reporter already passes the whole message):
```ts
const matcherHeader = /^Error: expect\(/;
const timeoutHeader = /TimeoutError|Timeout \d+ms exceeded/;
const detailLine = (lines: string[], pattern: RegExp): string | undefined => lines.map(l => l.trim().replace(/^-\s*/, '')).find(l => pattern.test(l));
// A matcher's header or a Playwright timeout names the kind of failure, not what failed; the first Expected and Received
// lines, or the call log's first "waiting for" line, do (review CI-M2-S2-r1 C1). Redacted before the cut, as the first line.
const details = (lines: string[], first: string): string[] => {
	if (matcherHeader.test(first)) {
		const found = [detailLine(lines, /^Expected\b/), detailLine(lines, /^Received\b/)].filter((l): l is string => !!l);
		const waiting = detailLine(lines, /^waiting for\b/);
		return found.length < 2 && waiting ? [...found, waiting] : found;
	}
	if (timeoutHeader.test(first)) {
		const waiting = detailLine(lines, /^waiting for\b/);
		return waiting ? [waiting] : [];
	}
	return [];
};
```
In `failureLine`, after `first`:
```ts
const full = [first, ...details(redacted.split('\n').slice(1), first)].join(' | ');
```
Cut `full` (not `first`) to `maxMessage`. Update the header comment: "the first line, plus for a matcher or timeout its first Expected/Received or waiting-for lines".

Logs:
- `green/wo9-unit.log`;
- the whole harness set, into `green/wo9-jest-harness.log`.

The contract self-test regression is WO-12.

**Commit 2:** `test(harness): the failure line adds a matcher's Expected and Received lines or a timeout's waiting-for line (CI-M2-S2 r1 C1)`.

## WO-10: CI-C4, the CI-T-02 message and per-test timeouts in CI-T-03 (one commit, then a mutation run)
`tests/acceptance/ci-m2-s2/timeouts.test.mts`:
1. **`CI-T-02`'s message:** replace "cover globalTeardown's stack removal and the reporters' onEnd" with "cover the reporters' onEnd/onExit and the upload gate (the global deadline also bounds globalTeardown; F-B1)".
2. **`specTimeouts`:** add a third pattern, a per-test options object after a string title. The title may contain commas, so match the literal:
   ```ts
   const titled = /\btest(?:\.\w+)?\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,\s*\{([^}]*)\}/g;
   for (const m of source.matchAll(titled)) {
   	const t = /\btimeout:\s*([^,}]+?)\s*(?:,|$)/.exec(m[1]);
   	if (t) found.push({ file, expression: t[1], ms: evaluate(t[1], file, longSpecTimeoutMs) });
   }
   ```
   Extend the file's header comment ("CI-T-03 … also per-test `{ timeout }` options, review CI-M2-S2-r1 C4").

Then:
- `T=5m run green/wo10-acc.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/ci-m2-s2/timeouts.test.mts`: 4 of 4 pass.
- **Mutation (no commit):**
  1. create `tests/e2e/m2-s3/zz-mutation.spec.ts` containing `import { test } from '../support/fixtures.ts';` and `test('mutation, with a comma', { timeout: 30 * 60_000 }, async () => {});`;
  2. `T=5m run sens/wo10-mutation.log node --test … timeouts.test.mts`. CI-T-03 must fail, naming `tests/e2e/m2-s3/zz-mutation.spec.ts` and `30 min`;
  3. `rm tests/e2e/m2-s3/zz-mutation.spec.ts`; `git status --short` shows no such file.

  If CI-T-03 passes, that is a **HARD STOP**.

**Commit:** `test(harness): CI-T-03 also bounds per-test timeouts; CI-T-02 names what its margin covers (CI-M2-S2 r1 C4)`.

## WO-11: Regression run 1 for WO-4 to WO-8 (heavy, no commit)
Check the calendar rule first. This is usually the first heavy run of the story.
- **If WO-0 found the three tagged images:** `T=60m run verify/wo11-regression.log env $IMG corepack yarn playwright test tests/e2e/m2-s1/e2ee-unlock.spec.ts tests/e2e/m2-s2/todos.spec.ts tests/e2e/m2-s2/notes.spec.ts`.
- **Otherwise:** the same with `env NOTESTEAD_KEEP_IMAGE=1` and **without** `$IMG`. It builds the three images; `$IMG` is valid afterwards.

Expected: 4 tests pass: M2-AC2, M2-AC2 NEG, M2-AC5 and M2-AC3. Copy the junit next to the log. From the annotations, record:
- `settle`: a note in M2-AC3, a to-do in M2-AC5;
- `spy-frames`;
- `cycle`;
- `sync-repress`, if any.

Any failure is a **HARD STOP**. Evidence: the test's `error-context.md`, `browser-console.log`, `network.log`, the trace path, and the `[notestead] FAILED` line.

## WO-12: The F-H1 proof and the failure-line regression: the contract self-tests (heavy, no commit)
This needs `localhost/notestead-headless:stack-test`, which exists after WO-11.
1. `podman image inspect --format '{{.Id}}' localhost/notestead-test-device:3.7.1 > test-results/verify/m2-s3/verify/wo12-device-before.txt`.
2. Run this command. **Do not set** `NOTESTEAD_DEVICE_IMAGE` or `NOTESTEAD_KEEP_IMAGE`, so the contract layer builds and removes its own device tag:
   ```sh
   T=60m run verify/wo12-contract.log env NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test corepack yarn test:contract --verbose tests/contract/m1-s6 tests/contract/m1-s6a tests/contract/m1-s7
   ```
   Expected: all suites pass. CI-M2-S2 recorded 8 suites and 45 tests in 1175 s.
3. Afterwards:
   - `localhost/notestead-test-device:3.7.1` exists, with the **same id** as in step 1;
   - `localhost/notestead-test-device:m1-s5-test` does not exist;
   - `podman images --filter dangling=true --filter label=io.github.thescriptingguy.notestead.test=stack` lists nothing new against `podman-before.txt`.

   Write all of it to `verify/wo12-device-after.txt`.
- **A failing contract test, or a changed or missing device tag, is a HARD STOP.** Evidence: the log and the podman state. A failing test is a reporter or failure-line regression, or the contract device path; the planner decides which.

## WO-13: Generated test files (RED commit)
**RED** (`tests/unit/harness/testFiles.test.ts`, new; describe `test files`). It imports from `../../e2e/support/testFiles.ts`, plus `node:zlib`, `node:crypto`, `node:fs`, `node:os` and `node:path`. Parse a PNG with a small helper in the test: an 8-byte signature, then chunks of length (u32be), type, data and CRC.
- **`files-01 the keystream is fixed by its seed and independent of chunking`:**
  - `testBytes('golden')(16).toString('hex') === '3aa4d19b823f298be72bbf7e3449c3ff'`;
  - the sha256 of 1 MiB drawn as chunks of `[1, 100_000, 1048576 - 100_001]` is `'734d4d8ec0c342121a8e504345b0461374523c9ee44beb0931ae6101ec9be7ac'`, and so is that of one 1 MiB draw from a fresh `testBytes('golden')`;
  - `testBytes('other')(16)` differs.
- **`files-02 a PNG's structure`:**
  - `pngBytes('golden', { width: 4, height: 3 })` is 107 bytes long, with sha256 `'312882492b6c90b74f20e10a7f0c72e4d84a2c148e1cac34b10a4f8264b1f676'`;
  - the signature is `89 50 4e 47 0d 0a 1a 0a`;
  - the chunk types are `['IHDR', 'IDAT', 'IEND']`;
  - every CRC equals `zlib.crc32(Buffer.concat([type, data]))`;
  - IHDR is width 4, height 3, then `8, 2, 0, 0, 0`;
  - `zlib.inflateSync(IDAT data)` equals 3 rows of `[0x00, …12 bytes of testBytes('golden')]`, drawn in order.
- **`files-03 padding to an exact size`:**
  - `big = pngBytes('x', { width: 1280, height: 1364, totalBytes: 5 * 1024 * 1024 })` is exactly 5 242 880 bytes, with types `['IHDR', 'nsTt', 'IDAT', 'IEND']` and an `nsTt` data length of 3281;
  - width and height are at most 1920 (upstream's `Resource.IMAGE_MAX_DIMENSION`; say so in a comment);
  - `base = pngBytes('x', { width: 1280, height: 1364 }).length` is 5 239 587, and `totalBytes: base` gives no `nsTt`;
  - `totalBytes: base - 1` and `totalBytes: base + 5` each throw `/cannot be padded/`.
- **`files-04 a streamed binary`:**
  - in a `mkdtemp` dir, `f = writeBinary(dir, 'nst-x.bin', 'seed-a', 3 * 1024 * 1024 + 5)` gives `f.size === 3145733` and `statSync(f.path).size === f.size`;
  - the sha256 of the file read back equals `f.sha256`, and equals the sha256 of `testBytes('seed-a')(f.size)`;
  - the names `'../x'`, `'A.bin'` and `''` throw `/unsafe file name/`;
  - remove the dir in `afterEach`.
- **`files-05 writePng`:**
  - `writePng(dir, 'nst-a.png', 's1', { width: 96, height: 64 })` returns `{ name, path, seed: 's1', size: 18564, width: 96, height: 64 }`, with the file's sha256;
  - the same seed gives the same sha256, and `'s2'` another.

Log: `red/wo13-unit.log` (`Cannot find module '../../e2e/support/testFiles.ts'`).

**Commit 1:** `test(harness): failing unit tests for seeded test files: keystream, exact-size PNG, streamed binary (M2-S3 D4)`.

**GREEN** (`tests/e2e/support/testFiles.ts`, new; pure Node, no Playwright import). Write it as below; the planner computed the goldens with this code:
```ts
// Large and binary test files, generated at test time from a seed (docs/test-plans/M2-S3.md D4): never committed, written
// outside test-results/, hashed while they are written. The bytes are a ChaCha20 keystream keyed by sha256 of the seed, so a
// seed gives the same bytes on every Node version and architecture (files-01's golden values). The PNG is 8-bit RGB with
// stored (uncompressed) deflate blocks, so its size is known in advance; a private ancillary chunk "nsTt" pads it to an
// exact size. Unit tests: tests/unit/harness/testFiles.test.ts.
import { createCipheriv, createHash } from 'node:crypto';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

export interface GeneratedFile { name: string; path: string; seed: string; size: number; sha256: string; width?: number; height?: number }

export const testBytes = (seed: string): ((count: number) => Buffer) => {
	const cipher = createCipheriv('chacha20', createHash('sha256').update(`nst-test-bytes\0${seed}`, 'utf8').digest(), Buffer.alloc(16));
	return count => cipher.update(Buffer.alloc(count));
};

const u32 = (n: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};
const chunk = (type: string, data: Buffer): Buffer => {
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	return Buffer.concat([u32(data.length), typed, u32(zlib.crc32(typed))]);
};
const adler32 = (buf: Buffer): number => {
	let a = 1;
	let b = 0;
	for (const byte of buf) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
};
// zlib header 78 01, then stored blocks of at most 65535 bytes (BFINAL on the last), then the Adler-32 of the data.
const storedZlib = (raw: Buffer): Buffer => {
	const parts = [Buffer.from([0x78, 0x01])];
	for (let off = 0; off < raw.length; off += 65535) {
		const len = Math.min(65535, raw.length - off);
		const head = Buffer.alloc(5);
		head[0] = off + len >= raw.length ? 1 : 0;
		head.writeUInt16LE(len, 1);
		head.writeUInt16LE(~len & 0xffff, 3);
		parts.push(head, raw.subarray(off, off + len));
	}
	parts.push(u32(adler32(raw)));
	return Buffer.concat(parts);
};

export const pngBytes = (seed: string, opts: { width: number; height: number; totalBytes?: number }): Buffer => {
	const { width, height } = opts;
	const next = testBytes(seed);
	const row = 1 + 3 * width;
	const raw = Buffer.alloc(row * height);
	for (let y = 0; y < height; y++) next(3 * width).copy(raw, y * row + 1); // filter byte 0 stays 0
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour (RGB)
	const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]);
	const idat = chunk('IDAT', storedZlib(raw));
	const iend = chunk('IEND', Buffer.alloc(0));
	const base = head.length + idat.length + iend.length;
	const pad = opts.totalBytes === undefined ? 0 : opts.totalBytes - base;
	if (pad === 0) return Buffer.concat([head, idat, iend]);
	if (pad < 12) throw new Error(`a ${width}x${height} PNG cannot be padded to ${opts.totalBytes} bytes: it needs ${base}, and a padding chunk takes at least 12`);
	return Buffer.concat([head, chunk('nsTt', testBytes(`${seed}/pad`)(pad - 12)), idat, iend]);
};

const safeName = (name: string): string => {
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`unsafe file name: ${JSON.stringify(name)}`);
	return name;
};

export const writePng = (dir: string, name: string, seed: string, opts: { width: number; height: number; totalBytes?: number }): GeneratedFile => {
	const path = join(dir, safeName(name));
	const bytes = pngBytes(seed, opts);
	writeFileSync(path, bytes, { mode: 0o600 });
	return { name, path, seed, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: opts.width, height: opts.height };
};

// Streamed in 1 MiB chunks, hashed as written: memory stays flat for 100 MiB.
export const writeBinary = (dir: string, name: string, seed: string, size: number): GeneratedFile => {
	const path = join(dir, safeName(name));
	const next = testBytes(seed);
	const hash = createHash('sha256');
	const fd = openSync(path, 'w', 0o600);
	try {
		for (let left = size; left > 0;) {
			const part = next(Math.min(left, 1024 * 1024));
			hash.update(part);
			writeSync(fd, part);
			left -= part.length;
		}
	} finally {
		closeSync(fd);
	}
	return { name, path, seed, size, sha256: hash.digest('hex') };
};
```
Before writing the GREEN, check that `zlib.crc32` is typed in `@types/node` 22.20.4. If it is not, a 10-line table CRC-32 in this module is the accepted alternative; say so in the commit body.

Logs:
- `green/wo13-unit.log`: 5 of 5 pass;
- `green/wo13-unit-tz.log`: the same under `TZ=Pacific/Auckland`.

A golden mismatch is a **HARD STOP**. Never edit a golden value.

**Commit 2:** `test(harness): seeded test files: ChaCha20 bytes, an exact-size PNG and a streamed binary, hashed as written (M2-S3 D4)`.

## WO-14: The `testFiles` fixture and `M2-S3-FILES-01` (RED commit; heavy)
**RED** (`tests/e2e/harness/test-files.spec.ts`, new; fixtures `{ webApp, testFiles }`; no app code):
```ts
// M2-S3-FILES-01 (docs/test-plans/M2-S3.md D4): the files of the testFiles fixture reach a real browser byte for byte when
// given by path to a file input, and Chromium decodes the PNGs. A plain page on the web origin (a secure context, so
// crypto.subtle exists); no app code.
test.describe('M2-S3 generated test files in the browser', () => {
	test.describe.configure({ timeout: longSpecTimeoutMs });
	test('M2-S3-FILES-01 a 5 MiB PNG, a 96x64 PNG and a 100 MiB binary given by path arrive with their sizes and sha256, and the PNGs decode', async ({ webApp, testFiles }) => { … });
});
```
Steps:
1. `1. generate`: `big = testFiles.png('nst-files-big.png', { width: 1280, height: 1364, totalBytes: 5 * 1024 * 1024 })`, `small = testFiles.png('nst-files-small.png', { width: 96, height: 64 })`, `bin = testFiles.binary('nst-files-bin.bin', 100 * 1024 * 1024)`. Push a `files` annotation with the total bytes and the ms.
2. `2. a file input on the web origin`:
   - `page.goto(new URL('/manifest.json', webApp.baseURL).href)`;
   - `page.setContent('<input type="file" multiple aria-label="Files">')`;
   - `expect(await page.evaluate(() => (globalThis as unknown as { isSecureContext: boolean }).isSecureContext)).toBe(true)`. If this fails: **HARD STOP**.
3. `3. given by path`: `page.getByLabel('Files').setInputFiles([big.path, small.path, bin.path], { timeout: 60_000 })`.
4. `4. the browser holds the same bytes, and decodes the PNGs`: one `page.evaluate` (with `globalThis` casts). For each `File` of the input, it returns:
   - `{ name, size, type, sha256 }`, where `sha256` is the hex of `crypto.subtle.digest('SHA-256', await f.arrayBuffer())`;
   - for `image/png` also `{ width, height }` from `createImageBitmap(f)`.

   Expect, in order:
   - `{ name: 'nst-files-big.png', size: 5242880, sha256: big.sha256, width: 1280, height: 1364 }`;
   - `{ name: 'nst-files-small.png', size: 18564, sha256: small.sha256, width: 96, height: 64 }`;
   - `{ name: 'nst-files-bin.bin', size: 104857600, sha256: bin.sha256 }`.

   Compare with `toMatchObject` on each. Push a `files` annotation with `` `browser MIME of .bin: ${type}` `` (F7). The two PNGs' `type` must be `image/png`.

Log: `red/wo14-files.log` (`T=30m run … env $IMG corepack yarn playwright test tests/e2e/harness/test-files.spec.ts`). Expect `Test has unknown parameter "testFiles"`, or Playwright's equivalent for a missing fixture. A different failure is a **HARD STOP**.

**Commit 1:** `test(harness): failing spec for generated files in a real browser (M2-S3 D4)`.

**GREEN** (`tests/e2e/support/fixtures.ts`):
- Imports: `mkdtempSync` and `rmSync` from `node:fs`, `tmpdir` from `node:os`, `randomBytes` from `node:crypto`, and `writePng`, `writeBinary` and `type GeneratedFile` from `./testFiles.ts`.
- ```ts
  export interface TestFiles {
  	dir: string;
  	png: (name: string, opts: { width: number; height: number; totalBytes?: number }) => GeneratedFile;
  	binary: (name: string, size: number) => GeneratedFile;
  	made: () => GeneratedFile[];
  }
  ```
  Add `testFiles: TestFiles` to `TestFixtures`.
- The fixture:
  ```ts
  // Files generated at test time from a per-test seed, outside test-results/ (never uploaded), removed at teardown; on failure
  // only their names, seeds, sizes and hashes are attached (docs/test-plans/M2-S3.md D4).
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
  testFiles: async ({}, use, testInfo) => {
  	const dir = mkdtempSync(join(tmpdir(), 'nst-files-'));
  	const run = randomBytes(4).toString('hex');
  	const made: GeneratedFile[] = [];
  	try {
  		await use({
  			dir,
  			png: (name, opts) => { const f = writePng(dir, name, `${run}/${name}`, opts); made.push(f); return f; },
  			binary: (name, size) => { const f = writeBinary(dir, name, `${run}/${name}`, size); made.push(f); return f; },
  			made: () => made.map(f => ({ ...f })),
  		});
  	} finally {
  		if (failed(testInfo)) await attachText(testInfo, 'test-files.json', `${JSON.stringify(made.map(({ name, seed, size, sha256, width, height }) => ({ name, seed, size, sha256, width, height })), null, 2)}\n`);
  		rmSync(dir, { recursive: true, force: true });
  	}
  },
  ```
- Update the header comment's fixture list.

Logs:
- `green/wo14-files.log`: 1 passed. Copy the junit. **RECORD** the `.bin` MIME;
- the whole harness set, into `green/wo14-jest-harness.log`.

**Commit 2:** `test(harness): testFiles fixture: seeded files in a temp dir, removed at teardown (M2-S3 D4)`.

## WO-15: The network item filter (RED commit)
**RED** (`tests/unit/harness/network.test.ts`, extend; keep `app = 'http://127.0.0.1:41234'`):
- **`net-16 itemContentRequests finds one item's content requests through the proxy`.** Entries:
  - `PUT ${app}/joplin-server/api/items/root:/.resource/abc:/content?x=1` (raw);
  - `PUT ${app}/joplin-server/api/items/root%3A%2F.resource%2Fabc%3A%2Fcontent` (encoded);
  - `GET` on the first URL;
  - `PUT` of `.resource/abd`;
  - `PUT http://127.0.0.1:22300/api/items/root:/.resource/abc:/content` (the server's own port);
  - `PUT not a url`.

  `itemContentRequests(entries, 'PUT', '.resource/abc')` returns exactly the first two.
- **`net-17 decodedPathOf`:** it decodes `%3A` and `%2F`; for `${app}/a%E0%A4%A` (a malformed escape) it returns the raw pathname; for `'not a url'` it returns `undefined`.

Log: `red/wo15-unit.log` (`itemContentRequests is not a function`). `net-01…15` pass.

**Commit 1:** `test(harness): failing unit tests for finding an item's content requests through the proxy (M2-S3 D3 to D5)`.

**GREEN** (`tests/e2e/support/network.ts`):
```ts
// The decoded path of a URL (the sync client may encode the ":" and "/" of root:/…:/), the raw path when it does not decode,
// undefined when the URL does not parse.
export const decodedPathOf = (url: string): string | undefined => {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return undefined;
	}
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
};
// The requests for one item's content on the sync target through the proxy (Joplin Server's api/items/root:/<name>:/content):
// an attachment's blob is ".resource/<id>", a note "<id>.md" (docs/test-plans/M2-S3.md D3 to D5).
export const itemContentRequests = (entries: NetEntry[], method: string, itemName: string): NetEntry[] =>
	entries.filter(e => e.method === method && decodedPathOf(e.url) === `/joplin-server/api/items/root:/${itemName}:/content`);
```
In `tests/e2e/support/flows.ts`, remove the private `decodedPath` and use `decodedPathOf` (from `./network.ts`) in the delta check of `syncWebOnce`'s `deps`.

Logs:
- `green/wo15-unit.log`;
- the whole harness set, into `green/wo15-jest-harness.log`.

**Commit 2:** `test(harness): find an item's content requests through the proxy, by decoded path (M2-S3 D3 to D5)`.

## WO-16: The resource probe, `dataApi.fileDigest`/`createResource` and `serverItemDigest` (RED commit; heavy)
**RED** (`tests/e2e/harness/resource-probe.spec.ts`, new; fixtures `{ stack, e2eeAccount, headlessService, dataApi, testFiles }`).
- `import * as stackApi from '../../stack/stack.ts'`, as a namespace import. The new export does not exist yet, and a named import would fail at ESM link time before any step (M2-S2 WO-7). The GREEN commit switches to named imports.
- `test.describe.configure({ timeout: longSpecTimeoutMs })`.
- The title is `M2-S3-RES-01 resources created through the headless Data API come back with their metadata and bytes, the server holds them encrypted, and no body leaves the container`.

Steps (`get = restGet(dataApi)`; `run` = 8 random hex characters):
1. **`1. a binary through POST /resources`:**
   - `bin = testFiles.binary(\`nst-probe-${run}.bin\`, 40 * 1024)`;
   - `r = dataApi.createResource({ title: bin.name, fileName: bin.name, mime: 'application/octet-stream', bytes: readFileSync(bin.path) })`;
   - `r.error` is undefined, `r.status` is 200, and `id = String((r.body as { id: unknown }).id)` matches `/^[0-9a-f]{32}$/`;
   - `JSON.stringify(r).length < 2000`: the response is metadata only.

   RED fails here: `dataApi.createResource is not a function`.
2. **`2. its metadata and its bytes`:**
   - `pick(ok(dataApi.get(\`/resources/${id}?fields=id,title,mime,size,file_extension\`)), [...])` equals `{ id, title: bin.name, mime: 'application/octet-stream', size: 40960, file_extension: 'bin' }`;
   - `pick(dataApi.fileDigest(id), ['status', 'sha256', 'size'])` equals `{ status: 200, sha256: bin.sha256, size: 40960 }`;
   - `JSON.stringify(dataApi.fileDigest(id)).length < 400`.
3. **`3. the PNG of M2-AC7b`:**
   - `png = testFiles.png(\`nst-probe-${run}.png\`, { width: 96, height: 64 })`, created the same way with `mime: 'image/png'`;
   - its metadata is `{ title: png.name, mime: 'image/png', size: 18564, file_extension: 'png' }`, and its digest equals the file's.
4. **`4. NEG: an unknown id`:**
   - `dataApi.fileDigest('0'.repeat(32))` has `status` 404 and a `sha256` that is not `bin.sha256`;
   - `expect(() => dataApi.fileDigest('../etc')).toThrow(/32 hex/)`.
5. **`5. the server holds the blobs encrypted`:**
   - `syncHeadlessOnce(stack, headlessService)`;
   - `serverItemNames` contains `.resource/${id}` and `${id}.md`;
   - `d = await stackApi.serverItemDigest(stack, e2eeAccount, \`.resource/${id}\`, { headBytes: 5 })` has `status` 200 and `head` `'JED01'`, `d.sha256 !== bin.sha256`, and `d.size > 40960`;
   - `(await serverItemContent(stack, e2eeAccount, \`${id}.md\`)).text` matches `/^encryption_applied: 1$/m`.
6. **`6. serverItemDigest agrees with serverItemContent`:** for `${id}.md`, `serverItemDigest(…).sha256` equals the sha256 of `Buffer.from((await serverItemContent(…)).text, 'utf8')`, and the sizes are equal.

Log: `red/wo16-res.log` (`T=30m run … env $IMG corepack yarn playwright test tests/e2e/harness/resource-probe.spec.ts`). Expect a failure at step 1, `createResource is not a function`, with the stack and the headless service started. A different failure is a **HARD STOP**.

**Commit 1:** `test(harness): failing spec for creating and hashing resources inside the headless container (M2-S3 D4, D5)`.

**GREEN:**
- **`tests/fixtures/m2-s3/in-container/data-api-resource.mjs`** (new). An `.mjs` under `tests/fixtures/` is exempt from the timer ban; `AbortSignal.timeout` is not a sleep anyway.
  ```js
  // Resource probe for the E2E harness (docs/test-plans/M2-S3.md D4, D5). It runs INSIDE a headless container, the only network
  // namespace where the CLI's Data API (127.0.0.1:41184) exists, piped to `node -` on stdin by the dataApi fixture. The token is
  // read from the profile at call time and never printed, and no file body leaves the container.
  //   podman exec -i <c> node - digest <resource id> <timeout ms>
  //       GET /resources/:id/file streamed into a sha256: RESULT {"status","sha256","size","contentType"}
  //   podman exec -i <c> node - create <timeout ms> <base64 JSON {"title","fileName","mime"}> <base64 file bytes>
  //       POST /resources (multipart: props + data): RESULT {"status","body"} (the new resource's metadata)
  // Any failure prints RESULT {"error"} and exits 0, so the test reports the reason.
  import { createHash } from 'node:crypto';
  import { readFileSync } from 'node:fs';

  const [mode, ...args] = process.argv.slice(2);
  const print = value => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
  const withToken = path => {
  	const token = JSON.parse(readFileSync('/data/profile/settings.json', 'utf8'))['api.token'];
  	if (typeof token !== 'string' || token === '') throw new Error('no api.token in /data/profile/settings.json');
  	return `http://127.0.0.1:41184${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  };

  try {
  	if (mode === 'digest') {
  		const [id, timeout] = args;
  		if (!/^[0-9a-f]{32}$/.test(id ?? '')) throw new Error('digest: a resource id is 32 hex characters');
  		const res = await fetch(withToken(`/resources/${id}/file`), { signal: AbortSignal.timeout(Number(timeout)) });
  		const hash = createHash('sha256');
  		let size = 0;
  		if (res.body) for await (const part of res.body) { hash.update(part); size += part.length; }
  		print({ status: res.status, sha256: hash.digest('hex'), size, contentType: res.headers.get('content-type') ?? '' });
  	} else if (mode === 'create') {
  		const [timeout, metaB64, dataB64] = args;
  		const meta = JSON.parse(Buffer.from(metaB64, 'base64').toString('utf8'));
  		if (!/^[a-z0-9][a-z0-9.-]*$/.test(meta.fileName ?? '')) throw new Error('create: unsafe file name');
  		const form = new FormData();
  		form.append('props', JSON.stringify({ title: meta.title }));
  		form.append('data', new Blob([Buffer.from(dataB64, 'base64')], { type: meta.mime }), meta.fileName);
  		const res = await fetch(withToken('/resources'), { method: 'POST', body: form, signal: AbortSignal.timeout(Number(timeout)) });
  		const text = await res.text();
  		let body = text;
  		try {
  			body = JSON.parse(text);
  		} catch {
  			// not JSON
  		}
  		print({ status: res.status, body });
  	} else {
  		throw new Error(`unknown mode ${mode}`);
  	}
  } catch (error) {
  	print({ error: `${error.name}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}` });
  }
  ```
- **`tests/e2e/support/fixtures.ts`:**
  - `runProbe(container, probe, args, timeoutMs = 120_000)`; its `spawnSync` uses that timeout.
  - `export interface FileDigest { status?: number; sha256?: string; size?: number; contentType?: string; error?: string }`.
  - `DataApi` gains `fileDigest: (resourceId: string, opts?: { timeoutMs?: number }) => FileDigest` and `createResource: (file: { title: string; fileName: string; mime: string; bytes: Buffer }) => DataApiResult`.
  - In the `dataApi` fixture (read the probe once, as the others are):
    ```ts
    fileDigest: (resourceId, opts = {}) => {
    	if (!/^[0-9a-f]{32}$/.test(resourceId)) throw new Error('fileDigest: a resource id is 32 hex characters');
    	const timeoutMs = opts.timeoutMs ?? 120_000;
    	return runProbe(headlessService.container, resourceProbe, ['digest', resourceId, String(timeoutMs)], timeoutMs + 30_000) as FileDigest;
    },
    createResource: file => {
    	// The bytes travel base64 in argv (the probe itself comes on stdin): 64 KiB keeps them under Linux's 128 KiB argument limit.
    	if (file.bytes.length > 64 * 1024) throw new Error(`createResource: ${file.bytes.length} bytes is over the probe's 64 KiB limit`);
    	if (!/^[a-z0-9][a-z0-9.-]*$/.test(file.fileName)) throw new Error('createResource: unsafe file name');
    	const meta = Buffer.from(JSON.stringify({ title: file.title, fileName: file.fileName, mime: file.mime }), 'utf8').toString('base64');
    	return runProbe(headlessService.container, resourceProbe, ['create', '60000', meta, file.bytes.toString('base64')]);
    },
    ```
  - Update the header comment's `dataApi` line.
- **`tests/contract/support/http.ts`:** add a **new** `requestDigest`. Leave `request` and `requestHashed` unchanged.
  ```ts
  export interface DigestResponse extends HashedResponse { head: Buffer }
  // Streams the response body into a hash and keeps its first `headBytes` bytes (an attachment blob on the server can be over
  // 130 MiB; docs/test-plans/M2-S3.md F8).
  export const requestDigest = async (req: HttpRequest, headBytes: number): Promise<DigestResponse> => send(req, (res, resolve, reject) => {
  	const hash = createHash('sha256');
  	const head: Buffer[] = [];
  	let size = 0;
  	let kept = 0;
  	res.on('data', (part: Buffer) => {
  		hash.update(part);
  		size += part.length;
  		if (kept < headBytes) {
  			const piece = part.subarray(0, headBytes - kept);
  			head.push(piece);
  			kept += piece.length;
  		}
  	});
  	res.on('error', reject);
  	res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, sha256: hash.digest('hex'), size, head: Buffer.concat(head) }));
  }) as Promise<DigestResponse>;
  ```
- **`tests/stack/stack.ts`:**
  ```ts
  // An item's content on the server streamed into a sha256, with its first bytes (latin1): attachment blobs can be over 130 MiB
  // (docs/test-plans/M2-S3.md D4). This stack's published port only, with the Host of APP_BASE_URL.
  export const serverItemDigest = async (state: StackState, account: Account, name: string, opts: { headBytes?: number; timeoutMs?: number } = {}): Promise<{ status: number; size: number; sha256: string; head: string }> => {
  	if (!state.serverUrl) throw new Error('the stack server is not up');
  	const session = await sessionFor(state, account.email, account.password);
  	const r = await requestDigest({ port: Number.parseInt(new URL(state.serverUrl).port, 10), path: `/api/items/root:/${name}:/content`, headers: { Host: publicHost, 'X-API-AUTH': session }, timeoutMs: opts.timeoutMs ?? 300_000 }, opts.headBytes ?? 8);
  	return { status: r.status, size: r.size, sha256: r.sha256, head: r.head.toString('latin1') };
  };
  ```
  Import `requestDigest` with `request`.
- **The spec:** switch to named imports (`serverItemDigest`, `serverItemContent`, `serverItemNames`, `syncHeadlessOnce`).

Logs:
- `green/wo16-res.log`: 1 passed;
- the whole harness set, into `green/wo16-jest-harness.log`.

If the CLI refuses the multipart request (a status other than 200 at step 1), that is a **HARD STOP**. Record the status and the body's `error` field only.

**Commit 2:** `test(harness): create and hash resources inside the headless container, and digest server items as a stream (M2-S3 D4, D5)`.

## WO-17: Page objects for search, trash, attachments and the viewer (one commit; checked by WO-18 to WO-21)
Everything goes in `tests/e2e/support/pages/joplinWebApp.ts`, in the existing style. Read each upstream file named in the plan's strings table once before writing its page object. The strings are upstream's, exact.

**`JoplinWebApp` additions:**
```ts
// The note list's header search button (ScreenHeader/index.tsx searchButton: an IconButton described "Search").
public searchButton(): Locator { return this.page.getByRole('button', { name: 'Search', exact: true }); }
public async openSearch(): Promise<SearchScreen> { await this.searchButton().click(); const s = new SearchScreen(this.page); await s.waitOpen(); return s; }
// The side menu's "Trash" notebook, which upstream always lists (folders-screen-utils.ts includeTrash).
public async openTrash(): Promise<void> { await this.openFolder('Trash'); }
```

**`SearchScreen`** (new class):
```ts
public heading(): Locator { return this.page.getByRole('heading', { name: 'Search', exact: true }); }
public field(): Locator { return this.page.getByPlaceholder('Search notes, notebooks...', { exact: true }); }
// The search screen itself: the deepest element holding its header and its field (hidden screens are aria-hidden anyway).
public root(): Locator { return this.page.locator('div').filter({ has: this.heading() }).filter({ has: this.field() }).last(); }
public result(title: string): Locator { return this.root().getByRole('button', { name: title, exact: true }); }
public async waitOpen(): Promise<void> { await this.field().waitFor(); }
// Upstream runs a query only when its text changes, and indexes a synced note about 10 s after it changes
// (docs/test-plans/M2-S3.md D3): clear and retype the word, as a user would, until the result shows.
public async searchUntilFound(word: string, title: string, opts: { timeoutMs?: number; attemptMs?: number } = {}): Promise<{ attempts: number; ms: number }>
	// started = Date.now(); attempts = 0;
	// await waitFor(`the search to list the note titled "${title}"`, async () => {
	//   attempts++; await clearLikeUser(this.field()); await typeLikeUser(this.field(), word);
	//   try { await this.result(title).waitFor({ timeout: opts.attemptMs ?? 5_000 }); return true; } catch { return undefined; }
	// }, { timeoutMs: opts.timeoutMs ?? 180_000, intervalMs: 250 });
	// return { attempts, ms: Date.now() - started }
// From a note opened from the results, "Back" returns here (the search screen has no Sidebar button).
public async backFromNote(): Promise<void> { await this.page.getByRole('button', { name: 'Back', exact: true }).click(); await this.field().waitFor(); }
public async close(): Promise<void> { await this.page.getByRole('button', { name: 'Back', exact: true }).click(); await this.page.getByRole('button', { name: 'Sidebar', exact: true }).waitFor(); }
```

**`NoteScreen` additions:**
```ts
// Upstream's Attach... (Note.tsx menuOptions) → "Choose an option" (DialogManager showMenu, test id prompt-dialog) →
// "Attach file" → pickDocument creates a hidden <input type="file" multiple> and clicks it, so Playwright sees a file chooser.
// The file goes in by path (a local browser reads it itself: no buffer limit), never as a buffer.
public async attachFile(path: string, timeoutMs: number): Promise<void>
	// await this.menuAction('Attach...');
	// const chooserEvent = this.page.waitForEvent('filechooser', { timeout: 30_000 });
	// await this.page.getByTestId('prompt-dialog').getByRole('button', { name: 'Attach file', exact: true }).click();
	// const chooser = await chooserEvent;
	// if (!chooser.isMultiple()) throw new Error('the file chooser is not upstream\'s attach input (pickDocument: multiple)');
	// await chooser.setFiles(path, { timeout: timeoutMs });
// The link upstream inserts into the Markdown editor for an attachment (Resource.markupTag): ![name](:/<id>) or [name](:/<id>).
// Returns the resource id.
public async waitForAttachmentLink(fileName: string, timeoutMs: number): Promise<string>
	// const link = new RegExp(`\\[${escapeRegExp(fileName)}\\]\\(:/([0-9a-f]{32})\\)`);
	// return waitFor(`the editor to hold the link to ${fileName}`, async () => link.exec(await this.editorText())?.[1], { timeoutMs, intervalMs: 500 });
// A trashed note's Actions offer "Restore" (Note.tsx: restoreItems, then back to the list).
public async restore(): Promise<void> { await this.menuAction('Restore'); }
// The note viewer (a sandboxed srcdoc iframe) shows an image attachment as <img data-resource-id> with a blob: URL it made from
// the File the app passed it, or upstream's placeholder .not-loaded-resource[data-resource-id] (docs/test-plans/M2-S3.md D5, F4).
public async viewerImage(resourceId: string): Promise<{ found: boolean; complete?: boolean; naturalWidth?: number; naturalHeight?: number; scheme?: string; placeholder: boolean }>
	// validate /^[0-9a-f]{32}$/; read every frame (frame.evaluate; a detached frame reads as { found: false, placeholder: false });
	// in a frame: img = querySelector(`img[data-resource-id="${id}"]`); placeholder = !!querySelector(`.not-loaded-resource[data-resource-id="${id}"]`);
	//   no img → { found: false, placeholder }; else { found: true, complete, naturalWidth, naturalHeight, scheme: new URL(img.src).protocol, placeholder }
	// return the first reading with found, else the first with placeholder, else { found: false, placeholder: false }
// The bytes the viewer shows: fetched inside that frame from its own blob: URL (the page's CSP allows connect-src blob:).
public async viewerImageBytes(resourceId: string): Promise<Buffer>
	// for each frame: frame.evaluate(async id => { img = …; if (!img) return undefined;
	//   try { const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer()); base64 via btoa over 0x8000-byte slices; return { b64 } }
	//   catch (e) { return { error: `${e.name}: ${e.message}` } } }, resourceId), a detached frame gives undefined;
	// { b64 } → Buffer.from(b64, 'base64'); { error } → throw new Error(`the viewer frame could not read its image: ${error}`);
	// no frame → throw new Error(`no frame shows the image of resource ${resourceId}`)
```
`escapeRegExp` already exists in the file. **Read upstream's `PromptDialog.tsx`** to confirm that the menu's buttons are role `button` named by their text, as the tag menu's `Rename` is. If they are not, that is a **HARD STOP**, with an `ariaSnapshot()` of the dialog.

**Check:** lint and tsc on the file, and the whole harness set into `green/wo17-jest-harness.log`.

**Commit:** `test(harness): page objects for search, the trash, attaching a file and the note viewer's images (M2-S3)`. The body cites plan D3 to D6 and F2 to F5.

## Common to the AC specs (WO-18 to WO-21)
- **Location and header:** `tests/e2e/m2-s3/<file>.spec.ts`. The header comment names the AC, the plan's decision, the plan path and the bundle requirement, as the M2-S2 specs do.
- **Setup:**
  - `test.describe('M2-S3 …', () => { test.describe.configure({ timeout: longSpecTimeoutMs }); … })`;
  - fixtures `{ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }`, plus `testFiles` where needed;
  - start with `await requireUpstreamBundle(stack, 'M2-S3')`;
  - locals: `app = new JoplinWebApp(webApp.page)`, `note = new NoteScreen(webApp.page)`, `origin`, `get = restGet(dataApi)`, `run = randomBytes(4).toString('hex')`, `seedFolder = e2eeAccount.folder`, `note1 = e2eeAccount.notes?.[0]` (throw if either is missing).
  - `seedFolderId` is read as in M2-S2 step 0, and the folder's title is checked.
- **The `cycle(label, opts?)` helper:** `syncWebThenHeadless(app, webNetwork, stack, headlessService, opts)`, then a `cycle` annotation `${label}: web ${webMs} ms, headless ${headlessMs} ms`.
- **Network policy** is always the last step: `violationLines(classifyRequests(webNetwork.entries(), origin))` is `[]`, and no URL starts with `joplinServer.url`.
- **Any failure** of an AC spec in its own WO run is a **HARD STOP**, unless the order names an expected failure. Evidence: `error-context.md`, the `[notestead] FAILED` line, `browser-console.log`, `network.log`, the trace path, and an `ariaSnapshot()` if a locator did not match.
- **If upstream's UI differs from the plan,** that is also a **HARD STOP**. Examples: a string or a role, the trash not listed, `Restore` missing, the attach menu, a resize prompt for the 5 MiB PNG, or an error dialog after an attach.
- **Upstream strict-mode twins:** if a role locator hits a strict-mode violation because a hidden screen has a twin, add `.filter({ visible: true })` and **RECORD** it. That is the M2-S2 F7 rule, and the only change allowed without stopping.

## WO-18: `tests/e2e/m2-s3/trash.spec.ts` (M2-AC8)
- `test.use({ e2eeSeed: { notes: 2 } })`.
- `note2 = e2eeAccount.notes![1]`, `T = note2.title`.
- `fields = 'id,title,body,parent_id,deleted_time,is_conflict'`.
- `readNote(id)` = `pick(ok(dataApi.get(\`/notes/${id}?fields=${fields}\`), …), fields.split(','))`.
- `withDeleted(id)` = `allItems(get, '/notes?include_deleted=1', 'id,deleted_time').filter(n => n.id === id)`: the AC's literal query.

**Title:** `M2-AC8 a note deleted in the web UI is listed in the web trash and in GET /notes?include_deleted=1 with deleted_time > 0, and once restored in the web UI its deleted_time is 0 in the REST API`.

0. **`0. data level before`:**
   - `before2 = readNote(note2.id)` matches `{ id: note2.id, title: T, deleted_time: 0, is_conflict: 0 }`;
   - `before1 = readNote(note1.id)`;
   - `seedFolderId = before2.parent_id`, and its folder title is `seedFolder`;
   - `withDeleted(note2.id)` equals `[{ id: note2.id, deleted_time: 0 }]`. Use `pick`, since the API adds `type_`.
1. **`1. open the web app and unlock it`:**
   - `openUnlockedWebApp(…)`;
   - `app.openFolder(seedFolder)`;
   - `await expect(app.noteInList(T)).toBeVisible({ timeout: 60_000 })`.
2. **`2. delete note 2 to the trash`:**
   - `app.openNote(T)`, `note.waitOpen()`;
   - `deletedAt = Date.now()`;
   - `note.deleteToTrash()`;
   - `app.backToList()`;
   - `expect.poll(() => app.noteInList(T).count(), { timeout: 30_000, intervals: [500] }).toBe(0)`.
3. **`3. the web trash lists it, and only it of the two`:**
   - `app.openTrash()`;
   - `await expect(app.noteInList(T)).toBeVisible({ timeout: 30_000 })`;
   - `await expect(app.noteInList(note1.title)).toHaveCount(0)`.
4. **`4. cycle: deleted_time > 0 in GET /notes?include_deleted=1`:**
   - `cycle('delete')`;
   - `expect.poll(() => { const d = Number(readNote(note2.id).deleted_time); return d > 0 ? 'trashed' : \`deleted_time ${d}\`; }, { timeout: 60_000, intervals: [1_000] }).toBe('trashed')`;
   - `readNote(note2.id)` matches `{ title: T, body: before2.body, parent_id: seedFolderId, is_conflict: 0 }`, and its `deleted_time` lies in `[deletedAt - 60_000, Date.now() + 60_000]`;
   - `withDeleted(note2.id)` has length 1, and its `deleted_time` equals `readNote`'s;
   - `notesTitled(dataApi, T)` is `[]` (not in the default listing);
   - `notesTitled(dataApi, T, { includeDeleted: true }).map(n => n.id)` is `[note2.id]`;
   - `readNote(note1.id)` equals `before1`.
5. **`5. restore it in the web UI`.** The trash list is still open:
   - `app.openNote(T)`, `note.waitOpen()`;
   - `note.restore()`;
   - `expect.poll(() => app.noteInList(T).count(), { timeout: 30_000, intervals: [500] }).toBe(0)` (gone from the trash);
   - `app.openFolder(seedFolder)`;
   - `await expect(app.noteInList(T)).toBeVisible({ timeout: 30_000 })`.
6. **`6. cycle: deleted_time is 0, the note is back exactly as it was`:**
   - `cycle('restore')`;
   - poll the verdict `deleted_time === 0 ? 'restored' : \`deleted_time ${d}\`` (60 s);
   - `readNote(note2.id)` toEqual `before2`;
   - `notesTitled(dataApi, T).map(n => n.id)` is `[note2.id]` (listed again, once: no conflict copy);
   - `withDeleted(note2.id)` equals `[{ id: note2.id, deleted_time: 0 }]` (with `pick`);
   - `readNote(note1.id)` equals `before1`.
7. **`7. network policy`.**

**Run:** `T=40m run green/wo18-trash.log env $IMG corepack yarn playwright test tests/e2e/m2-s3/trash.spec.ts`. It must pass.

**Commit:** `test(e2e): M2-AC8 a note trashed and restored in the web UI, checked in GET /notes?include_deleted=1`.

## WO-19: `tests/e2e/m2-s3/search.spec.ts` (M2-AC6 and its NEG)
- `TS = \`Notestead search target ${run}\``.
- `W = \`nstword${randomBytes(5).toString('hex')}\``.
- `BODY = \`This body holds the unique word ${W} for M2-AC6.\``.

**Title:** `M2-AC6 a note created through the headless API with a unique word in its body is found by the web UI search after a headless sync and a web sync, and (NEG) a word in no note returns no results`.

0. **`0. data level before`:** `seedFolderId` is read, and `notesTitled(dataApi, TS)` is `[]`.
1. **`1. open the web app and unlock it`.**
2. **`2. headless: create the note`:**
   - `mark = webNetwork.entries().length`;
   - `r = dataApi.request('POST', '/notes', { title: TS, body: BODY, parent_id: seedFolderId })`. Add a comment: "a test-made body: plain words, no file:/http(s):/data: URL (CLAUDE.md security rules)";
   - `id = String(ok(r, 'POST /notes').id)`;
   - `pick(ok(dataApi.get(\`/notes/${id}?fields=id,title,body,parent_id\`)), …)` equals `{ id, title: TS, body: BODY, parent_id: seedFolderId }`.
3. **`3. one headless sync: the server holds it encrypted`:**
   - `{ durationMs } = await syncHeadlessOnce(stack, headlessService)`, then a `cycle` annotation `headless: ${durationMs} ms`;
   - `serverItemContent(stack, e2eeAccount, \`${id}.md\`)` has status 200 and matches `/^encryption_applied: 1$/m`, and neither `W` nor `TS` is in it in clear.
4. **`4. one web sync: the web app downloaded it through the proxy`:**
   - `{ durationMs } = await syncWebOnce(app, webNetwork)`, then an annotation;
   - `itemContentRequests(webNetwork.entries().slice(mark), 'GET', \`${id}.md\`).some(e => e.status === 200)` is `true`.
5. **`5. the web search finds it by the word in its body`:**
   - `search = await app.openSearch()`;
   - `found = await search.searchUntilFound(W, TS)`, then a `search` annotation `${found.attempts} attempt(s), ${found.ms} ms`;
   - `search.result(TS).click()`, `note.waitOpen()`;
   - `expect.poll(async () => ((await app.frameText()).includes(W) ? 'shown' : 'not shown'), { message: 'the opened result shows the word in its body', timeout: 60_000, intervals: [500] }).toBe('shown')`;
   - `search.backFromNote()`;
   - `await expect(search.field()).toHaveValue(W)`.
6. **`6. NEG: a word in no note returns no results`:**
   - `typeLikeUser(search.field(), \`${W}x\`)`;
   - `await expect(search.result(TS), 'the result for the word is gone once the query for the NEG word has run').toHaveCount(0, { timeout: 30_000 })`;
   - `await expect(search.field()).toHaveValue(\`${W}x\`)`;
   - `titles = [...new Set(allItems(get, '/notes?include_conflicts=1&include_deleted=1', 'id,title').map(n => String(n.title)))]`, with `expect(titles.length).toBeGreaterThanOrEqual(2)`;
   - `listed = []`; for each title, `if ((await search.result(t).count()) > 0) listed.push(t)`; then `expect(listed, 'no note of the account is listed for a word that is in no note').toEqual([])`;
   - an annotation `neg: ${titles.length} note titles checked`;
   - `search.close()`.
7. **`7. network policy`.**

**Run:** `T=40m run green/wo19-search.log env $IMG corepack yarn playwright test tests/e2e/m2-s3/search.spec.ts`. It must pass. **RECORD** the attempts.

**Commit:** `test(e2e): M2-AC6 the web search finds a headless-made note by a word in its body; NEG a word in no note lists nothing`.

## WO-20: `tests/e2e/m2-s3/attachments-headless.spec.ts` (M2-AC7b)
Fixtures add `testFiles`. `TN = \`Notestead headless attachment ${run}\``.

**Title:** `M2-AC7b an image attached through the headless API is shown in the web UI with the same bytes after a headless sync and a web sync`.

0. **`0. data level before`:** `seedFolderId`.
1. **`1. open the web app and unlock it`.**
2. **`2. headless: the attachment and its note`:**
   - `mark = webNetwork.entries().length`;
   - `img = testFiles.png(\`nst-headless-${run}.png\`, { width: 96, height: 64 })`;
   - `r = dataApi.createResource({ title: img.name, fileName: img.name, mime: 'image/png', bytes: readFileSync(img.path) })`, then `R = String((ok(r, 'POST /resources') as { id: unknown }).id)`;
   - the metadata of `R` is `{ id: R, title: img.name, mime: 'image/png', size: img.size, file_extension: 'png' }`;
   - `pick(dataApi.fileDigest(R), ['status', 'sha256', 'size'])` equals `{ status: 200, sha256: img.sha256, size: img.size }` (the positive control);
   - `N = String(ok(dataApi.request('POST', '/notes', { title: TN, parent_id: seedFolderId, body: \`Attachment made through the headless API ${run}\n\n![${img.name}](:/${R})\` }), 'POST /notes').id)`, with the same security comment as WO-19;
   - `allItems(get, \`/notes/${N}/resources\`, 'id').map(x => x.id)` equals `[R]`;
   - **NEG (data):** `serverItemNames(stack, e2eeAccount)` contains neither `.resource/${R}` nor `${R}.md`.
3. **`3. one headless sync: the server holds the attachment encrypted`:**
   - `syncHeadlessOnce`, then an annotation;
   - the names contain `.resource/${R}`, `${R}.md` and `${N}.md`;
   - `${R}.md` matches `/^encryption_applied: 1$/m`, without `img.name` in clear;
   - `d = serverItemDigest(stack, e2eeAccount, \`.resource/${R}\`, { headBytes: 5 })` has status 200 and `head === 'JED01'`, `d.sha256 !== img.sha256`, and `d.size > img.size`;
   - an `e2ee-overhead` annotation `${(d.size / img.size).toFixed(3)} for ${img.size} B`.
4. **`4. one web sync`:** `syncWebOnce(app, webNetwork)`, then an annotation.
5. **`5. the web UI shows the image with the same bytes`:**
   - `app.openFolder(seedFolder)`, `app.openNote(TN)`, `note.waitOpen()`;
   - `shownAt = Date.now()`;
   - `await expect.poll(() => note.viewerImage(R), { message: 'the viewer shows the attachment decoded from a blob: URL', timeout: 180_000, intervals: [1_000] }).toEqual({ found: true, complete: true, naturalWidth: 96, naturalHeight: 64, scheme: 'blob:', placeholder: false })`, then an annotation `viewer: ${Date.now() - shownAt} ms`;
   - `bytes = await note.viewerImageBytes(R)`;
   - `expect({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'the bytes the web UI shows are the file\'s').toEqual({ size: img.size, sha256: img.sha256 })`;
   - `itemContentRequests(webNetwork.entries().slice(mark), 'GET', \`.resource/${R}\`).some(e => e.status === 200)` is `true` (the blob came through the proxy);
   - `app.backToList()`.
6. **`6. network policy`.**

**Run:** `T=40m run green/wo20-headless-attachment.log env $IMG corepack yarn playwright test tests/e2e/m2-s3/attachments-headless.spec.ts`. It must pass.
- If `viewerImageBytes` throws "could not read its image", that is a **HARD STOP**. Record the error name only. The planner then decides on the pixel-comparison fallback; do not write it.
- **RECORD** the viewer time.

**Commit:** `test(e2e): M2-AC7b an image attached through the headless API is shown in the web UI with the same bytes`.

## WO-21: `tests/e2e/m2-s3/attachments-upload.spec.ts` (M2-AC7a): measurement, then the bounds (heavy; one commit)
**The spec.** Fixtures add `testFiles`. `TA = \`Notestead attachments ${run}\``.

At the top of the file, set the phase bounds. Each carries a comment that WO-21's commit fills in with "Pi measurement: X ms → bound":
```ts
const attachTimeoutMs = 10 * 60_000;
const webSyncTimeoutMs = 20 * 60_000;
const headlessSyncTimeoutMs = 20 * 60_000;
const digestTimeoutMs = 5 * 60_000;
```
These are the provisional values, for the measurement run.

**Title:** `M2-AC7a a 5 MiB image and a 100 MiB binary attached in the web UI are uploaded through the proxy, and their sha256 read back through GET /resources/:id/file on the headless API is equal`.

0. **`0. generate the files; data level before`:**
   - `image = testFiles.png(\`nst-image-${run}.png\`, { width: 1280, height: 1364, totalBytes: 5 * 1024 * 1024 })`;
   - `binary = testFiles.binary(\`nst-binary-${run}.bin\`, 100 * 1024 * 1024)`;
   - a `files` annotation (ms);
   - `seedFolderId`;
   - `allItems(get, '/resources', 'id,title').filter(r => [image.name, binary.name].includes(String(r.title)))` is `[]`, and `notesTitled(dataApi, TA)` is `[]`.
1. **`1. open the web app and unlock it`.**
2. **`2. attach both in the web UI`:**
   - `app.openFolder(seedFolder)`;
   - `await app.newNote()`;
   - `note.typeTitle(TA)`;
   - for each of `image` and `binary`, in that order: `t = Date.now(); await note.attachFile(f.path, attachTimeoutMs); ids[f.name] = await note.waitForAttachmentLink(f.name, attachTimeoutMs);`, then an `attach` annotation `${f.name}: ${Date.now() - t} ms`;
   - `app.backToList()`;
   - `await expect(app.noteInList(TA)).toBeVisible({ timeout: 60_000 })`.
3. **`3. one web sync and one headless sync`:** `cycle('upload', { webTimeoutMs: webSyncTimeoutMs, headlessTimeoutMs: headlessSyncTimeoutMs })`.
4. **`4. REST: the two resources, with equal sha256`:**
   - `expect.poll(() => notesTitled(dataApi, TA).map(n => n.id), { timeout: 60_000, intervals: [1_000] }).toHaveLength(1)`, then `id`;
   - `res = allItems(get, \`/notes/${id}/resources\`, 'id,title,mime,size,file_extension')`, sorted by title;
   - `res.map(r => pick(r, ['id', 'title', 'size', 'file_extension']))` equals `[{ id: ids[binary.name], title: binary.name, size: binary.size, file_extension: 'bin' }, { id: ids[image.name], title: image.name, size: image.size, file_extension: 'png' }]`;
   - the image's `mime` is `'image/png'`;
   - an annotation `binary mime: ${…}` (F7);
   - `String(ok(dataApi.get(\`/notes/${id}?fields=body\`)).body)` contains `` `![${image.name}](:/${ids[image.name]})` `` and `` `[${binary.name}](:/${ids[binary.name]})` ``;
   - for each file:
     - `t = Date.now()`;
     - `await expect.poll(() => pick(dataApi.fileDigest(ids[f.name], { timeoutMs: digestTimeoutMs }), ['status', 'sha256', 'size']), { message: \`the headless API returns the bytes of ${f.name}\`, timeout: digestTimeoutMs + 60_000, intervals: [5_000] }).toEqual({ status: 200, sha256: f.sha256, size: f.size })`;
     - a `digest` annotation.
5. **`5. the server holds both encrypted`:**
   - the names contain `.resource/<id>` for both;
   - each `<id>.md` matches `/^encryption_applied: 1$/m`;
   - for each blob, `d = serverItemDigest(…, { headBytes: 5, timeoutMs: digestTimeoutMs })`: status 200, `head` `'JED01'`, `d.sha256 !== f.sha256`, `d.size > f.size`;
   - an `e2ee-overhead` annotation `${f.name}: ${(d.size / f.size).toFixed(3)}`.
6. **`6. through the proxy`:** for each id:
   - `puts = itemContentRequests(webNetwork.entries(), 'PUT', \`.resource/${id}\`)`;
   - `puts.some(e => e.status === 200)` is `true`;
   - `puts.filter(e => (e.status ?? 0) >= 400).map(e => e.status)` is `[]`.
7. **`7. network policy`.**

**The measurement run (MEAS)** comes before any commit of this spec, with the calendar rule.
1. **A temporary edit, never committed:** set the describe's timeout to `40 * 60_000`. `CI-T-03` would reject that number; that is why it is temporary.
2. **Start the sampler:**
   ```sh
   mkdir -p test-results/verify/m2-s3/meas
   ( while :; do date -u +%FT%TZ; podman stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' 2>&1; ps -eo rss=,comm= | awk '$2 ~ /chrom|headless_shell/ {s+=$1} END {print "chromium_rss_kib", s+0}'; free -m | awk 'NR==2{print "host_used_mib", $3, "avail_mib", $7}'; sleep 5; done ) > test-results/verify/m2-s3/meas/mem.log 2>&1 &
   echo $! > test-results/verify/m2-s3/meas/mem.pid
   ```
3. `T=60m run meas/ac7a-meas.log env $IMG corepack yarn playwright test tests/e2e/m2-s3/attachments-upload.spec.ts`, then `kill "$(cat test-results/verify/m2-s3/meas/mem.pid)"`, and copy the junit to `meas/ac7a-meas-junit.xml`.
4. `git checkout -- tests/e2e/m2-s3/attachments-upload.spec.ts` is **not** what you do here, because the spec is new and uncommitted. Revert only the timeout edit: put `longSpecTimeoutMs` back.

**HARD STOPS for MEAS:**
- the run fails at any step;
- the test takes **more than 12.5 minutes** (D7);
- a container is OOM-killed, which shows as a failing step and in `podman stats`/`mem.log`;
- a PUT has status 413 or 5xx.

Evidence: the logs, `mem.log`, the network log and the junit.

**If MEAS passes in 12.5 minutes or less:**
- Record in the plan's §Results, under "M2-AC7a measurement":
  - the test duration;
  - each annotation: `files`, `attach` ×2, `cycle` web and headless, `digest` ×2, `e2ee-overhead` ×2, `settle`, `sync-repress` if any;
  - the peaks from `mem.log` per container, for Chromium and for the host.
- Set the bounds to `max(3 × measured, floor)`, rounded up to whole minutes. The floors are: attach 2 min, web sync 5 min, headless sync 10 min, digest 2 min.
- Comment each constant with its measurement.
- **RECORD** whether the test duration is at most 7.5 min. That number decides D7's withdrawal, which is the planner's call.

**Confirming run:** `T=60m run green/wo21-upload.log env $IMG corepack yarn playwright test tests/e2e/m2-s3/attachments-upload.spec.ts`. It must pass under `longSpecTimeoutMs` with the new bounds.
- If the test takes longer than `longSpecTimeoutMs` (15 min before WO-22), that is not a stop. **RECORD** it, then do WO-22.
- If WO-22 cannot be done (no ci-cd commit yet), **RECORD** "M2-AC7a needs CC-1(b)" and continue. The full run in WO-24 then shows whether it fits 15 min.

**Commit:** `test(e2e): M2-AC7a a 5 MiB image and a 100 MiB binary attached in the web UI, uploaded through the proxy, sha256 equal through headless`. The body gives the measured phase times and the bounds.

## WO-22: CC-1(b), the longest spec and the CI run (conditional; one commit)
**Precondition:**
- `.github/workflows/e2e.yml` has, in the step with `id: e2e`, `timeout-minutes: 60`;
- the last commit touching that file carries `Agent: ci-cd-specialist`. Check with `git log -1 --format='%h %(trailers:key=Agent,valueonly)' -- .github/workflows/e2e.yml`.

**If not:** skip this order, and **RECORD** "WO-22 pending: CC-1(b) needs the ci-cd-specialist's e2e.yml change (plan D7); M2-S3 must not be pushed to CI before it". This is not a stop. Never edit `e2e.yml`.

**If so:**
- **`tests/e2e/support/timeouts.ts`:**
  - `ciGlobalTimeoutMs = 55 * 60_000` and `longSpecTimeoutMs = 25 * 60_000`;
  - their comments name the reason: "M2-S3 D7, CC-1(b): M2-AC7a's 100 MiB attachment measured at X min on the Pi (2 × X ≤ 25); 2 × 25 < 55; 55 ≤ 60 − 4".
- **`playwright.config.ts`:** the comments that say "5 minutes before the 45-minute step" and "the CI run 40 min" now say 60 and 55.
- **`docs/testing/strategy.md` §5, "Everything is bounded":** "Each long spec 25 min" and "the CI run 55 min".

Run `T=5m run green/wo22-acc.log node --test … tests/acceptance/ci-m2-s2/timeouts.test.mts`; 4 of 4 must pass.

**Commit:** `chore(harness): CC-1(b): the longest spec 25 min and the CI run 55 min, for M2-AC7a's 100 MiB attachment (M2-S3 D7)`.

## WO-23: Strategy for the M2-S3 harness (`docs(testing)`)
`docs/testing/strategy.md`:
- **§4, the fixtures paragraph**, a new sub-bullet after "Since M2-S2":
  > **Since M2-S3:**
  > - The test fixture `testFiles` generates files at test time from a per-test seed (`tests/e2e/support/testFiles.ts`). It writes them to a temp dir outside `test-results/`, hashes them as it writes them, and removes the dir at teardown. A failing test attaches only `test-files.json` (names, seeds, sizes, sha256). The generators are a ChaCha20 keystream, and a PNG of pseudo-random pixels in stored deflate blocks, optionally padded to an exact size by a private `nsTt` chunk.
  > - `dataApi.fileDigest(id)` streams `GET /resources/:id/file` into a sha256 inside the headless container. `dataApi.createResource(…)` posts a small file (at most 64 KiB) to `POST /resources` from inside it (`tests/fixtures/m2-s3/in-container/data-api-resource.mjs`). No file body and no token leaves the container.
  > - `serverItemDigest` streams an item's content from the server into a sha256 and keeps its first bytes.
  > - These are proven by `M2-S3-FILES-01` (the browser receives the generator's exact bytes and decodes the PNGs) and `M2-S3-RES-01`.
  > - The contract layer uses a prebuilt `NOTESTEAD_DEVICE_IMAGE` as it is, and otherwise builds its own device tag, so it never untags an image the E2E run kept (F-H1).
- **§5 Rules**, two bullets:
  > - **Large files are generated, never committed (from M2-S3).** The test hashes them as it writes them, and gives them to the browser by path, which has no size limit (Playwright 1.59.1 passes local paths to a local browser). Their bytes are compared through the API by sha256, never pulled into the test process in full.
  > - **A search is retyped like a user until it shows its result (from M2-S3).** Upstream runs a query only when its text changes, and indexes a synced note about 10 s after it changes. So the test clears and retypes the query with real keys until the expected result shows, within a bounded total, and records the attempts. "No results" is proven by a query that the test makes fail from a found state: one character appended to the found word, so the found result disappears exactly when that query has run.

**Commit:** `docs(testing): strategy for the M2-S3 harness (generated files, resource probe, server digest, search retype)`.

## WO-24: Runs and sensitivity (no commit)
Run them in this order, one at a time, keeping to the calendar rule. Logs go under `test-results/verify/m2-s3/`.
1. `T=10m run verify/lint.log corepack yarn lint`. It must exit 0.
2. `T=15m run verify/jest-harness.log corepack yarn jest tests/unit/harness tests/integration/harness`. It must exit 0. List the new IDs and the totals: about 123 tests, 97 before plus `fh1` 3, `press` 5, `seed` 2, `due` 2, `settle` 3, `ci-fail` 4, `files` 5 and `net` 2.
3. **The acceptance checks:** `serial-rule.test.mts` (SER-04 with the new specs), `ac22-e2e-workflow.test.mts` (`tests/e2e/m2-s3/` covered) and `ci-m2-s2/timeouts.test.mts`. All must pass.
4. **The full E2E run:** `T=150m run verify/e2e-full.log env $IMG corepack yarn playwright test`, in the background.
   - Expected: **22 passed**, with no retry and no `[notestead] FAILED` line. Copy the junit.
   - Record in the plan:
     - every annotation of the M2-S3 tests;
     - the `settle` lags;
     - each test's duration against `longSpecTimeoutMs`;
     - the whole run's time.
   - **Any failure is a HARD STOP.** Never retry it blindly.
5. **Sensitivity runs:** temporary local edits, never committed.
   - After each run: `git checkout -- <file>` (or `rm` for a created file), and `git status --short` is clean for it.
   - Use `env $IMG` and `-g "<test ID>"`, with `T=40m` (`T=60m` for S-AC7a).
   - A run that **does not fail at the stated site** is a **RECORD**: write what happened, with the failure line, and continue with the next run. It is not a fix: never adapt the spec so that it fails.

   | Run | Edit | Must fail at |
   |---|---|---|
   | **S-AC6a** | `search.spec.ts` step 3: remove the `syncHeadlessOnce` call and step 3's server checks | step 5: `timed out after 180000 ms waiting for the search to list the note titled …` |
   | **S-AC6b** | step 6: `typeLikeUser(search.field(), W)` instead of `` `${W}x` `` (so nothing is added) | step 6: the result for the word is still listed (`toHaveCount(0)` received 1) |
   | **S-AC7a** | `attachments-upload.spec.ts` step 2: `await webApp.context.setOffline(true);` before `app.openFolder(seedFolder)`. Step 3: replace `cycle(…)` with `await syncHeadlessOnce(stack, headlessService);` (import it) | step 4: the `notesTitled(TA)` poll receives length 0 |
   | **S-AC7b** | `attachments-headless.spec.ts` step 3: remove `syncHeadlessOnce` and step 3's server checks | step 5: the note is never listed in the web app (`openNote(TN)` times out at 60 s on `getByRole('button', { name: … })`) |
   | **S-AC8a** | `trash.spec.ts` step 5: replace everything after `note.waitOpen()` with `await app.backToList();` (no `Restore`) | step 6: the `deleted_time` verdict, `Received: "deleted_time <n>"` |
   | **S-AC8b** | step 2: remove `note.deleteToTrash()` and the list-count poll | step 3: `noteInList(T)` not visible in the trash |
   | **S-C1** | `pages/joplinWebApp.ts` `createFromFab`: pass `'note'` for `'New to-do'` too | `M2-AC5` step 1: `timed out after 60000 ms waiting for the focus to land on the editor …` |
   | **S-C2** | `todos.spec.ts`: `test.use({ webTimezone: 'UTC' })`, and comment out step 0's `Intl` assertion | step 2's in-page control: expected `due`, received `due` + a whole number of hours. Record it: 2 h before 2026-10-25 01:00 UTC, 1 h after |
   | **S-C3** | `notificationSpy.ts`, first statement of `spy`: `if ((globalThis as unknown as { origin?: string }).origin === 'null') return;` | step 4's coverage poll: `Received: "<n> of <m> frames have the spy"` |
   | **S-C4** | `e2ee-unlock.spec.ts` step 9, before the comparison: `reference[0] = { ...reference[0], body: \`${String(reference[0].body)} changed\` };` | step 9: received `[["body"],[],[]]`. Then `grep -c zebracorn sens/s-c4.log` and `grep -c 'Notestead note' sens/s-c4.log` must both print 0 |
   | **S3′** (P3) | M2-S2 S3's edit on the current `notebooks-tags.spec.ts`: in step 5, remove the `editNotebook(C)`, `setParent` and `save` lines and the UI nesting check | record the failure site (expected: the `(level 1)` check). This is not a stop |
   | **S4′** (P3) | M2-S2 S4's edit: in step 5, remove `tags.remove(A)` and keep `apply()` | step 6: `tagNoteIds(aId)` received `[note 1's id]` |
   | **S1c″** (CI-C5) | `notes.spec.ts` step 6: `await webApp.context.setOffline(true);` before `cycle('edit')` | in `syncWebOnce`: `Expected: "completed"`, `Received: "no delta request since the press"`, after at most 3 presses (count them in the trace) |

   For each failing run, check that `network.log`, `browser-console.log`, `trace`, `server.log`, `supervisor.log` and the `[notestead] FAILED` line are present.
6. **Integrity:**
   - `git log --format='%h %an %s%n%b' <merge base of this story>..HEAD -- tests/ playwright.config.ts` must list only `Agent: qa-specialist` commits. A ci-cd commit touches only `.github/workflows/e2e.yml`.
   - Every RED commit (WO-1, 4, 5, 6, 8, 9, 13, 14, 15, 16) must come before its GREEN.
7. **Podman:**
   - save `podman-after.txt` as in WO-0, and compare;
   - only `byparr`'s resources and the kept test images may remain;
   - **remove nothing.** The orchestrator removes the test images after the planner's sign-off.

## WO-25: Plan sections and report (`docs(test-plans)`)
Append to `docs/test-plans/M2-S3.md`, in the M2-S2 format:
- **`## RED (… Pi arm64)`:** one row per RED commit (command, failure reason, log), and one row for the AC specs: "not a RED run (unmodified upstream); evidence: the sensitivity runs".
- **`## Harness validation (… Pi arm64)`:** the WO-10 mutation, the WO-12 contract proof (the device image id before and after), and every sensitivity run with its failure line and log.
- **`## Results (QA executor, … Pi arm64)`:**
  - a **Layers** table: lint, Jest, acceptance, contract (WO-12), the full E2E run, each with its duration and log;
  - a **Per criterion** table with PASS/FAIL, command, duration and evidence for:
    - M2-AC6, its NEG, M2-AC7a, M2-AC7b and M2-AC8;
    - FILES-01 and RES-01;
    - C1 to C5, CI-C1, CI-C2, CI-C4 and CI-C5;
    - F-H1, P2/CI-P2 and P3;
    - the regression of M1-AC21, M2-AC1, M2-AC2, M2-AC3, M2-AC4 and M2-AC5, each with its NEG where one exists, and LOC-01/02;
  - **M2-AC7a measurement:** the WO-21 numbers, the memory peaks, the bounds set, and whether the test took 7.5 min or less;
  - **the `settle` lags** (min, median, max);
  - **CC-1(b) status:** WO-22 done or pending;
  - **Test integrity** and **Podman**;
  - **`## Findings (executor)`**, everything that was RECORDed.

  Leave x64 as PENDING-CI, and write no sign-off line.

**Commit:** `docs(test-plans): M2-S3 RED, harness validation and arm64 results`.

**Report to the orchestrator:**
- the commit hashes per WO;
- the per-criterion status;
- the sensitivity outcomes;
- the M2-AC7a measurement and the CC-1(b) status;
- every RECORD;
- the podman state (images kept).
