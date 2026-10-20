# M2-S1 work orders (QA executor)

These orders implement `docs/test-plans/M2-S1.md`. Read that plan first: the AC table, Findings F1 to F4 and Interpretations 1 to 5 are the design. Each order says which files to touch, the signatures, the exact assertions, the commit, the commands and the expected outcome.

## Rules for every order
- **Branch:** `feat/M2-S1-sync-e2ee`. One commit per order, unless the order says otherwise.
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat`, never `fix` (P-R1). Never push.
- **Paths:** write only `tests/**`, `playwright.config.ts`, `docs/testing/**` and `docs/test-plans/M2-S1*.md`. Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**` or ADRs.
- **Tests:**
  - No `.only`, `.skip`, `fixme` or fixed sleeps.
  - Wait with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only through `typeLikeUser`. Secrets get `{ secret: true }` and go into password fields only.
  - Never weaken an assertion, and never change an asserted upstream string to make a test pass. If an asserted upstream behaviour differs from this plan, stop that order and report what you saw: the exact text, a DOM excerpt, and the test's `error-context.md`.
- **Pi rules:**
  - Run only one heavy job at a time: E2E, contract, a full `yarn lint`, or an image build.
  - Run long jobs in the background with `timeout`, and use one Playwright worker (the default locally).
  - Never touch `byparr` or any podman resource without the label `io.github.thescriptingguy.notestead.test`.
  - Before the first heavy run, save `podman ps -a; podman network ls; podman volume ls` to `test-results/verify/m2-s1/podman-before.txt`. Save them again at the end to `podman-after.txt`, and compare.
- **Logs:** save every command's output under `test-results/verify/m2-s1/<phase>/<name>.log`, where `<phase>` is `red`, `green`, `sens` or `verify`. Use this wrapper (the bundle dir is set once):
  ```sh
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  # e.g.  T=100m run test-results/verify/m2-s1/verify/e2e-full.log corepack yarn playwright test
  ```
  - The bundle dir is the extracted, verified CI artifact that M1-S7 used. `NOTESTEAD_WEB_ARTIFACT` takes a dir, not the zip.
  - First E2E run: add `NOTESTEAD_KEEP_IMAGE=1`. Later runs: add `NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1`.
  - Never add `--trace on`: the Node 24 trace workaround (M1-S7 F2) means the `webApp` fixture records traces itself.
- **Light checks after each order:**
  - `corepack yarn eslint --max-warnings 0 <changed files>`
  - `corepack yarn tsc -p tsconfig.json`, plus `corepack yarn tsc -p tests/acceptance/tsconfig.json` if you touched `.mts` files
  - Run the full `corepack yarn lint` once, in WO-12.

---

## WO-0: Leftover diff (decision: keep it, adjust it, and split it into WO-1 and WO-2)
The uncommitted changes in `tests/contract/m1-s6/ac20-attachments.test.ts` and `tests/contract/support/leakScan.ts` are a correct start on C1-R4 and M1-S8 C2. They are kept, with one change: `leakScan.ts` must not carry a second copy of the trace-viewer comparator, because `tests/support/uploadGate.ts` already has one (`isPackagedViewerFile`).
1. Save the diff for reference: `git diff -- tests/contract/m1-s6/ac20-attachments.test.ts tests/contract/support/leakScan.ts > <your scratchpad>/m2s1-leftover.patch` (outside the repo; delete it after WO-2).
2. Carry on with WO-1, then WO-2. No commit of its own.

## WO-1: C1-R4, scan `html/trace/` files that differ from the packaged viewer
**Files:**
- `tests/support/uploadGate.ts`: export the existing `isPackagedViewerFile(path: string, data: Buffer): boolean` (add `export`; no other change).
- `tests/contract/support/leakScan.ts`: keep the leftover's `scannedFiles` and its use in `fileViews`. Replace the leftover's `viewerDir`/`isPackagedViewerCopy` with:
  ```ts
  import { isPackagedViewerFile } from '../../support/uploadGate.ts';
  // The files of the run's dir that are scanned: all of them except unchanged copies of Playwright's trace viewer
  // under html/trace/ (review M1-S6a-r1 C1-R4; the comparator is the upload gate's).
  export const scannedFiles = (out: string): string[] => {
  	const viewer = join(out, 'html', 'trace') + sep;
  	return filesUnder(out).filter(f => !(f.startsWith(viewer) && isPackagedViewerFile(f, readFileSync(f))));
  };
  ```
  Drop the now unused `findRepoRoot` import if nothing else uses it.
- `tests/contract/m1-s6/ac20-attachments.test.ts`: keep the leftover's import of `scannedFiles`, its use for the file sources, and the removal of the local `filesUnder`. **Revert only the last assertion** to `expect(leaks).toEqual([]);`. WO-2 changes that line.
- `tests/unit/harness/leakScan.test.ts` (new), describe `leak scan file selection`:
  - `C1-R4-unit-1 skips an unchanged trace-viewer copy and scans a changed or unknown file under html/trace/`.
    - In a `mkdtempSync` dir `out`, write:
      - `html/trace/<name>`: a byte copy of one real file from `node_modules/playwright-core/lib/vite/traceViewer/` (the first regular file of `readdirSync`, sorted; assert that one exists);
      - `html/trace/<name2>`: a copy of a second real viewer file (the second regular file, sorted) with `\n// nst-c1r4` appended (a changed copy);
      - `html/trace/run-data.json`, which is not in the viewer;
      - `html/data/x.zip` (any bytes);
      - `output/a.txt`.
    - Expect `scannedFiles(out).map(f => relative(out, f)).sort()` to equal `['html/data/x.zip', 'html/trace/<name2>', 'html/trace/run-data.json', 'output/a.txt']`.
    - Remove `out` in `afterEach`.
  - `C1-R4-unit-2 scans every file when there is no html/trace/`: `out` holds only `output/a.txt` and `junit.xml`; both are returned.
- `docs/testing/strategy.md` §4, the "Harness self-tests" bullet: replace "Leak scans skip `html/trace/`, which is Playwright's trace-viewer app, copied verbatim into every HTML report." with "Leak scans skip a file under `html/trace/` only while it is byte-identical to the file of the same name in playwright-core's packaged trace viewer (`isPackagedViewerFile`, shared with the upload gate; review M1-S6a-r1 C1-R4); a changed or unknown file there is scanned."

**RED first:**
1. `git stash push tests/contract/support/leakScan.ts tests/support/uploadGate.ts`.
2. Write the unit test, then `run test-results/verify/m2-s1/red/wo1-unit.log corepack yarn jest tests/unit/harness/leakScan.test.ts`. Expect a failure because `scannedFiles` is not exported (`is not a function`).
3. `git stash pop`, apply the changes above, and run it again into `green/wo1-unit.log`. Expect it to pass.

**Commit:** `test(harness): scan html/trace files that differ from the packaged trace viewer (C1-R4)`. Include `uploadGate.ts`, `leakScan.ts`, `ac20-attachments.test.ts` (without the C2 line), the unit test and the strategy line. Run the contract regression in WO-12.

## WO-2: M1-S8 C2, value-free leak assertions
**Files:**
- `tests/contract/support/leakScan.ts`: add
  ```ts
  // Value-free lines for a leak assertion (review M1-S8 C2): where and what kind, never the excerpt around the value.
  export const leakLines = (leaks: Leak[], out?: string): string[] => leaks.map(l => `${out ? l.where.split(out).join('<run>') : l.where}: ${l.kind}`);
  ```
- `tests/contract/m1-s6/ac20-attachments.test.ts:last assertion` → `expect(leakLines(leaks, out)).toEqual([]);`, with a one-line comment citing M1-S8 C2.
- `tests/contract/m1-s6a/c1-pertest-secrets.test.ts:116,124` and `tests/contract/m1-s7/c1r1-realflow-secrets.test.ts:125`: replace the inline `.map(l => …)` with `leakLines(…, <run out>)`. Behaviour stays the same; this is the "check the other leak assertions" part of C2.
- `tests/unit/harness/leakScan.test.ts`: add `C2-unit-1 leak lines name the place and kind, never the leaked text`. Given `[{ where: '/x/run/a.txt', kind: 'token=', excerpt: 'before nstmarker0123 after' }]` and `out = '/x/run'`:
  - expect `['<run>/a.txt: token=']`;
  - expect `JSON.stringify(result)` not to contain `nstmarker0123`.

**RED first:** write `C2-unit-1` before `leakLines` exists and log it to `red/wo2-unit.log` (`leakLines is not a function`). Then implement it and log to `green/wo2-unit.log`.

**Commit:** `test(contract): report leaks without the leaked text (M1-S8 C2)`. Then delete the saved `m2s1-leftover.patch`. `git status` must show no leftover changes to those two files.

## WO-3: C-N1, the secret guard checks the element
**Files:**
- `tests/e2e/support/typeLikeUser.ts`: replace `fieldType`/`requireMasked` with
  ```ts
  // What the element is, not what its attribute says (review M1-S7-r1 C-N1): a <textarea type="password"> or a custom
  // element with that attribute renders its text in clear.
  const describeField = async (field: Locator): Promise<{ masked: boolean; what: string }> => field.evaluate(e => {
  	const el = e as unknown as { localName?: unknown; type?: unknown };
  	return { masked: el.localName === 'input' && el.type === 'password', what: `<${String(el.localName)}> of type "${String(el.type)}"` };
  });
  const requireMasked = async (field: Locator, what: string, when: string): Promise<void> => {
  	const f = await describeField(field);
  	if (!f.masked) throw new SecretInVisibleFieldError(`C1-R1: refusing to type ${what} into ${f.what} (${when}): a secret is only ever typed into an <input type="password">, because the trace's screencast frames cannot be redacted`);
  };
  ```
  `localName` and the `type` *property* both come from the DOM. A textarea's `type` is `textarea`, and an input with an unknown `type` attribute reports `text`.
- `tests/unit/harness/typeLikeUser.test.ts`:
  - In `fakeField`, give `element` a `localName` (new option `tag?: string`, default `'input'`) and a `get type()` that returns the fake's current `type` variable, so `typeAfterTyping` keeps working.
  - Existing tests keep their meaning: a `type: 'text'` or `null` fake is not masked.
  - Add to the `c1r1` describe:
    - `C-N1-unit-1 refuses a textarea that carries type="password", before any key` (`tag: 'textarea', type: 'password'`): rejects with `SecretInVisibleFieldError`, and `keys(fake)` equals `[]`.
    - `C-N1-unit-2 refuses a custom element that carries type="password"` (`tag: 'x-secret-field', type: 'password'`): same assertions.
    - `C-N1-unit-3 types a secret into an input of type password in one go` (`tag: 'input', type: 'password'`): resolves, with exactly one `pressSequentially` call.
- `tests/e2e/harness/type-like-user.spec.ts`: add `<label>Fake masked <textarea type="password" name="fakemasked"></textarea></label>` to `form`, and add `'Fake masked'` to the refused loop.

**RED first:** write the tests before the code change and log `corepack yarn jest tests/unit/harness/typeLikeUser.test.ts` to `red/wo3-unit.log`. C-N1-unit-1 and C-N1-unit-2 must fail, because the guard reads the attribute (`password`) and types. Then make the change and log to `green/wo3-unit.log`. The E2E part runs in WO-12.

**Commit:** `test(harness): the secret guard checks the rendered element, not the type attribute (C-N1)`.

## WO-4: C-N3, built-in `page` and `context` fail and point to `webApp`
**Files:**
- `tests/e2e/support/fixtures.ts`: add to `TestFixtures`-level overrides (inside `base.extend`):
  ```ts
  // Playwright's built-in page and context have no trace and no console log in this harness (use.trace is off; the
  // webApp fixture records both; review M1-S7-r1 C-N3, docs/testing/strategy.md §4).
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
  page: async ({}, _use) => { throw new Error(builtinFixtureMessage('page')); },
  // eslint-disable-next-line no-empty-pattern -- as above
  context: async ({}, _use) => { throw new Error(builtinFixtureMessage('context')); },
  ```
  with `export const builtinFixtureMessage = (name: 'page' | 'context'): string => \`the built-in \\\`${name}\\\` fixture is disabled in this harness: it records no trace and no browser console (use.trace is off). Use the \\\`webApp\\\` fixture (webApp.page, webApp.context) instead.\``. If the fixture types reject the override, type it as `page: [async ({}, _use) => { … }, { scope: 'test' }]`. Never cast to `any`. If neither form type-checks, report the tsc error.
- `tests/harness/playwright.cn3.config.ts` (new), modelled on `playwright.c1r2.config.ts`:
  - `testDir: 'cn3'`, `workers: 1`, `retries: 0`, `forbidOnly: true`, `timeout: 60_000`, `outputDir: join(out, 'output')`;
  - reporters `list` plus `['json', { outputFile: join(out, 'report.json') }]`;
  - `use: { trace: 'off', screenshot: 'off', video: 'off', launchOptions }` from `chooseChromium()`, as in `playwright.config.ts`;
  - no globalSetup;
  - `out = process.env.NST_CN3_OUT`, and throw if it is unset.
- `tests/harness/cn3/builtin-fixtures.spec.ts` (new): imports `{ expect, test }` from `../../e2e/support/fixtures.ts`. Three tests:
  - `C-N3 inner page`: `async ({ page }) => { expect(page).toBeTruthy(); }`
  - `C-N3 inner context`: `async ({ context }) => { expect(context).toBeTruthy(); }`
  - `C-N3 inner control`: `async ({ browserName }) => { expect(browserName).toBe('chromium'); }`
- `tests/integration/harness/cn3-builtin-fixtures.test.ts` (new, Jest; spawn as `c1r2-killed-run.test.ts` does):
  - `env`: `process.env` minus `CI`, `JEST_WORKER_ID`, `NODE_OPTIONS`, `NST_SELFTEST_*` and `JOPLIN_SERVER_URL`, plus `FORCE_COLOR=0`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `NST_CN3_OUT=<mkdtemp>/run` and a fake stack (the worker fixtures need one, and no service is touched):
    ```
    NOTESTEAD_E2E_STACK={"project":"nst-cn3","run":"cn3","owned":false,"overrides":[],"images":{"server":"","web":"","headless":"","device":"","built":[]},"workDir":"<tmp>","logsDir":"<tmp>/logs","frontNetwork":"","backNetwork":"","containers":{},"accounts":[],"headless":[]}
    ```
  - Run `corepack yarn playwright test -c tests/harness/playwright.cn3.config.ts` with a 3-min test timeout. Read `report.json`.
  - `C-N3-01 the inner run fails (exit 1) with exactly one passed and two failed tests`.
  - `C-N3-02 a test asking for page fails with the message naming webApp`: its result error message contains `` the built-in `page` fixture is disabled `` and `` Use the `webApp` fixture ``.
  - `C-N3-03 a test asking for context fails the same way` (`` `context` ``).
  - Remove the temp dir in `afterAll`.
- `docs/testing/strategy.md` §4, the attachments bullet: add one sentence: "Playwright's built-in `page` and `context` fixtures are overridden to throw and point to `webApp`, since they would record no trace (review M1-S7-r1 C-N3; `tests/integration/harness/cn3-builtin-fixtures.test.ts`)."

**RED first:** write the spec, the config and the Jest test before the override, and log `corepack yarn jest tests/integration/harness/cn3-builtin-fixtures.test.ts` to `red/wo4.log`. Expect C-N3-01 to fail: before the override all three inner tests pass, so the exit code is 0. Expect C-N3-02 and C-N3-03 to fail with no error message. Then add the override and log to `green/wo4.log`.

**Commit:** `test(harness): built-in page and context fixtures fail and point to webApp (C-N3)`.

## WO-5: ADR-0007 A3, the serial project and its guard
**Files:**
- `tests/e2e/support/projects.ts` (new; no Playwright import, so `node:test` can load it):
  ```ts
  // The E2E projects (ADR-0007 A3, docs/test-plans/M2-S1.md §Disruptive tests): a spec that stops, restarts or
  // reconfigures a shared service of the run's stack is named *.serial.spec.ts and runs in `chromium-serial`: one
  // worker, after the parallel project has finished (`dependencies`), so nothing runs beside it.
  export const serialSpecPattern = '**/*.serial.spec.ts';
  export interface E2eProject { name: string; use: Record<string, unknown>; testIgnore?: string; testMatch?: string; workers?: number; fullyParallel?: boolean; dependencies?: string[] }
  export const e2eProjects = (desktopChrome: Record<string, unknown>): E2eProject[] => [
  	{ name: 'chromium', use: { ...desktopChrome }, testIgnore: serialSpecPattern },
  	{ name: 'chromium-serial', use: { ...desktopChrome }, testMatch: serialSpecPattern, workers: 1, fullyParallel: false, dependencies: ['chromium'] },
  ];
  ```
- `playwright.config.ts`: `projects: e2eProjects(devices['Desktop Chrome'])`, and extend the header comment by one line about the serial project. If `defineConfig` rejects the `E2eProject` type, adjust `E2eProject` (not the config) until tsc passes without casts.
- `tests/acceptance/support/serialRule.mts` (new):
  ```ts
  // A spec line that disrupts a shared service: a shared handle and a disruptive verb on the same line.
  export const sharedHandle = /\bstack\.(containers\.(server|web)|defaultHeadless|defaultAccount)\b/;
  export const disruptiveVerb = /\b(stop|restart|kill|pause|rm|down|removeContainer|downHeadless|syncHeadlessOnce|upHeadless|upCore|composeSync)\b|['"](stop|restart|kill|pause|rm)['"]/;
  export const disruptiveLines = (source: string): number[] => source.split('\n').flatMap((line, i) => (sharedHandle.test(line) && disruptiveVerb.test(line)) || /\bdownStack\s*\(/.test(line) ? [i + 1] : []);
  ```
- `tests/fixtures/m2-s1/serial/disruptive.spec.ts.fixture`: one line per form, each marked `// NEG`:
  - `podmanSync(['restart', stack.containers.server ?? '']);`
  - `podmanSync(['stop', stack.containers.web ?? '']);`
  - `removeContainer(stack, stack.containers.web ?? '');`
  - `await syncHeadlessOnce(stack, stack.defaultHeadless as HeadlessService);`
  - `downHeadless(stack, stack.defaultHeadless);`
  - `downStack(stack);`
- `tests/fixtures/m2-s1/serial/readonly.spec.ts.fixture`:
  - `containerLog(stack, stack.containers.web ?? '', since)`
  - `await webRequest(stack, '/app.bundle.js')`
  - `await serverRequest(stack, '/api/ping')`
  - `await syncHeadlessOnce(stack, headlessService)`
  - `const s = stack.defaultHeadless?.container;`
- `tests/acceptance/m2-s1/serial-rule.test.mts` (new, `node:test`):
  - `M2-S1-SER-01 the parallel project ignores *.serial.spec.ts and the serial project runs them alone`: `e2eProjects({})` deep-equals the two projects above (names, `testIgnore`, `testMatch`, `workers: 1`, `fullyParallel: false`, `dependencies: ['chromium']`).
  - `M2-S1-SER-02 playwright.config.ts uses e2eProjects`: the file text matches `/projects:\s*e2eProjects\(devices\['Desktop Chrome'\]\)/`.
  - `M2-S1-SER-03 the scanner flags every disruptive form and no read-only one`: `disruptiveLines` of the disruptive fixture equals the line numbers of its `// NEG` lines, and of the read-only fixture equals `[]`.
  - `M2-S1-SER-04 every disruptive E2E spec is a serial spec`: for every `tests/e2e/**/*.spec.ts` (recursive `readdirSync`), if `disruptiveLines(text)` is non-empty, the name must end with `.serial.spec.ts`. The assertion lists `file:line` of offenders, so `[]` is expected today. Also assert that at least 3 spec files were scanned (a positive control against an empty glob).
- `docs/testing/strategy.md` §4: one bullet: "**Serial rule (ADR-0007 A3, from M2-S1).** A spec that stops, restarts or reconfigures a shared service is named `*.serial.spec.ts`. It runs in the `chromium-serial` project (one worker, after `chromium` has finished). A failing `chromium` test then leaves the serial specs not run, which is accepted, since the run is already red. To run one serial spec alone, use `--project chromium-serial --no-deps`. `M2-S1-SER-04` flags disruptive calls on shared handles in any other spec."

**RED first:** write the fixtures, `serialRule.mts` and the test before `projects.ts` exists and before the config change, and log to `red/wo5.log` with `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s1/serial-rule.test.mts`. Expect SER-01 to fail on import (missing module), and SER-02 to fail. To keep SER-03 and SER-04 visible in RED, import `projects.ts` dynamically inside SER-01. Then implement and log to `green/wo5.log`. Afterwards `corepack yarn playwright test --list` must list the same tests as before under project `chromium`; save it to `green/wo5-list.log`.

**Commit:** `test(harness): serial Playwright project and a guard for specs that disrupt shared services (ADR-0007 A3)`.

## WO-6: The network recorder and policy classifier
**Files:**
- `tests/e2e/support/network.ts` (new):
  ```ts
  import type { BrowserContext, Request } from '@playwright/test';
  export interface NetEntry { at: string; method: string; url: string; resourceType: string; fromServiceWorker: boolean; status?: number; failure?: string }
  export interface NetVerdict {
  	syncTraffic: NetEntry[];      // same-origin, path under /joplin-server/api/
  	sameOriginOther: NetEntry[];  // same-origin, not under /joplin-server/
  	allowedExternal: NetEntry[];  // exactly HEAD https://joplinapp.org/connection_check/
  	ignored: NetEntry[];          // data:, blob:, about: (local)
  	violations: { entry: NetEntry; why: string }[];
  }
  export const connectionCheckUrl = 'https://joplinapp.org/connection_check/';
  export const classifyRequests = (entries: NetEntry[], appOrigin: string): NetVerdict
  export const violationLines = (v: NetVerdict): string[] // `${method} ${origin}${pathname}: ${why}`, no query string
  export interface NetworkRecorder { entries: () => NetEntry[]; text: () => string }
  export const recordNetwork = (context: BrowserContext): NetworkRecorder
  ```
  - **Classification:** parse with `new URL(url)`.
    - The protocol is `data:`, `blob:` or `about:` → `ignored`.
    - `url.origin === appOrigin` (http only):
      - `decodeURIComponent(pathname)` starts with `/joplin-server/api/` → `syncTraffic`;
      - the path is `/joplin-server` or starts with `/joplin-server/` (and is not under `/api/`) → violation `'same-origin request to the sync target outside /joplin-server/api/'`;
      - else → `sameOriginOther`.
    - `method === 'HEAD' && url === connectionCheckUrl` → `allowedExternal`.
    - Anything else → violation `'cross-origin request'`. That covers `ws:`/`wss:` and the server's own port.
  - **`recordNetwork`:**
    - `context.on('request')` pushes an entry with `fromServiceWorker: !!r.serviceWorker()`, and keeps a `Map<Request, NetEntry>`;
    - `context.on('response')` sets `status`;
    - `context.on('requestfailed')` sets `failure: r.failure()?.errorText`.
    - `text()` gives one line per entry: `at method url-with-the-query-replaced-by-?[query] resourceType sw|page status failure`.
- `tests/e2e/support/fixtures.ts`: test fixture `webNetwork: NetworkRecorder`, `async ({ webApp, stack }, use, testInfo) => { const rec = recordNetwork(webApp.context); await use(rec); if (failed(testInfo)) await attachText(testInfo, 'network.log', redactText(rec.text(), workerSecrets(stack))); }`. Add it to the header comment's fixture list.
- `tests/unit/harness/network.test.ts` (new). `app = 'http://127.0.0.1:41234'`, `server = 'http://127.0.0.1:41235'`. Each case builds one `NetEntry` and asserts the bucket, and for violations the `why`:

  | ID | Method | URL | Bucket |
  |---|---|---|---|
  | `NET-01` | GET | `${app}/app.bundle.js` | `sameOriginOther` |
  | `NET-02` | POST | `${app}/joplin-server/api/sessions` | `syncTraffic` |
  | `NET-03` | PUT | `${app}/joplin-server/api/items/root:/info.json:/content` and its `%3A`-encoded form | `syncTraffic` |
  | `NET-04` | HEAD | `https://joplinapp.org/connection_check/` | `allowedExternal` |
  | `NET-05` | GET | `https://joplinapp.org/connection_check/` | violation |
  | `NET-06` | HEAD | `https://joplinapp.org/connection_check/?x=1` | violation |
  | `NET-07` | GET | `https://joplinapp.org/other` | violation |
  | `NET-08` | GET | `${server}/api/ping` (the server's own port) | violation `cross-origin request` |
  | `NET-09` | GET | `${app}/joplin-server/shares/abc`; also `${app}/joplin-server` | violation, the sync-target `why` |
  | `NET-10` | GET | `wss://127.0.0.1:41234/x` | violation |
  | `NET-11` | GET | `data:text/plain,x`; also `blob:${app}/uuid` | `ignored` |
  | `NET-12` | | `violationLines` of a violation whose URL has `?token=abc` | the line has no `token` and no `abc` |

**RED first:** write `network.test.ts` before `network.ts` and log `corepack yarn jest tests/unit/harness/network.test.ts` to `red/wo6-unit.log` (module not found). Then implement and log to `green/wo6-unit.log`.

**Commit:** `test(harness): network-policy recorder and classifier for the web app (M2-AC1)`.

## WO-7: Accounts, seeds, page objects and flows for M2-S1
**Files:**
- `tests/stack/stack.ts`:
  - `Account` gains `seedTag?: string`.
  - `enableE2ee(state, account, label, seed: { notes?: number } = {})`. With `n = seed.notes ?? 1` and the existing `tag`:
    - the folder is unchanged;
    - note 1 is unchanged: `Notestead note ${tag}` / `Seeded body ${tag} zebracorn`;
    - note `i` (2…n): title `Notestead note ${i} ${tag}`, body `Seeded body ${i} ${tag} zebracorn Δ ✓ ünïcödé`. These titles are not prefixes of each other, and there are no quotes, backslashes or newlines (`device.mjs` refuses those);
    - set `account.seedTag = tag`.
  - Do not change `device.mjs`. If the CLI batch refuses the non-ASCII body, stop and report the device log. Do not drop the characters.
- `tests/e2e/support/fixtures.ts`:
  - option `e2eeSeed: [{ notes: 1 }, { option: true }]` (type `{ notes: number }`); `e2eeAccount` passes it to `enableE2ee`;
  - test fixture `plainAccount: Account` = `await createAccount(stack)`;
  - update the header comment.
- `tests/e2e/support/pages/joplinWebApp.ts`. All locators are role-based where upstream gives a role; strings are upstream's (plan §Page objects table).
  - **`JoplinWebApp`:**
    - `syncReport()`: match `this.page.getByText(/\bCompleted: /)` (Finding F2), with the rest unchanged.
    - `syncIdle(): Locator` → `getByRole('button', { name: 'Synchronise', exact: true })`.
    - `encryptedNotesInList(): Locator` → `getByRole('button', { name: '🔑 Encrypted', exact: true })`.
    - `folderInSideMenu(title: string): Locator` → `getByRole('button', { name: title, exact: true })`. The folder item is `role='button'`, and its text has `accessibilityLabel` = the title at depth 0 (`side-menu-content.tsx:286-305`).
    - `openNote(title)` clicks `noteInList(title)`.
    - `backToList()` clicks `getByRole('button', { name: 'Back', exact: true })` and waits for `sidebarButton()`.
    - `frameHtml(): Promise<string>`: `page.frames()` mapped to `frame.evaluate(() => document.documentElement.outerHTML)`, with frames that throw (detached) mapped to `''`, joined. This is for absence checks: it holds attributes such as `aria-label`, and hidden text.
    - `frameText(): Promise<string>`: the same with `document.body?.innerText ?? ''`, for presence of the rendered body (the note viewer is a sandboxed `srcdoc` iframe, `ExtendedWebView/index.web.tsx`).
  - **`SyncSettings`:**
    - `checkButton()` → `getByRole('button', { name: 'Check synchronisation configuration', exact: true })`.
    - `configCheckStatus(): Promise<'success' | 'error' | 'checking' | 'none'>` from the counts of `getByText('Success! Synchronisation configuration appears to be correct.', { exact: true })`, `getByText(/^Error\. Please check that URL, username, password, etc\. are correct/)` and `getByText('Checking... Please wait.', { exact: true })`.
    - `configCheckError(): Promise<string>`: the `innerText` of the status container. That is the nearest `div` that holds the error heading; take `locator('div').filter({ has: heading }).last()`. It holds both message lines.
  - **`EncryptionSettings`:**
    - `encryptionStatus()` → the `innerText` of `getByText(/^Encryption is: /)`.
    - `decryptedStats(): Promise<{ done: number; total: number } | undefined>` parses `/Decrypted items: (\d+) \/ (\d+)/` from `getByText(/^Decrypted items: /)`. It returns `undefined` while upstream shows `-`.
    - `invalidMasterPasswordText()` → `getByText('The master password is not set or is invalid. Please type it below:', { exact: true })`.
    - `masterPasswordLoaded()` → `getByText('Loaded', { exact: true })`.
    - `masterPasswordState(): Promise<'accepted' | 'rejected' | 'pending'>`:
      - `rejected` if `invalidMasterPasswordText()` count > 0;
      - `accepted` if `acceptedMarker()` is visible and `masterPasswordLoaded()` is visible;
      - else `pending`.
    - `masterPasswordField()` → `getByRole('textbox', { name: 'The master password is not set or is invalid. Please type it below:' })`. It is `accessibilityLabelledBy` that text. If the role query finds nothing, use `getByLabel(…, { exact: true })`.
    - `saveMasterPassword(password)`: `typeLikeUser(masterPasswordField(), password, { secret: true })`, then click the `Save` button of the innermost `div` holding the field (`locator('div').filter({ has: field }).filter({ has: getByRole('button', { name: 'Save', exact: true }) }).last()`).
- `tests/e2e/support/flows.ts`:
  - `unlockE2ee`: after `enterMasterPassword`, keep the `acceptedMarker` check, then `await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000, intervals: [500] }).toBe('accepted')` (Finding F1), then `back()`. Keep its signature.
  - New `configureAndCheckJoplinServerSync(app, origin, syncUrl, account, opts: { password?: string } = {}): Promise<SyncSettings>`:
    - `app.open(origin)` → `chooseOtherSyncTarget()` → `selectJoplinServer()` → `enterJoplinServer(syncUrl, account.email, opts.password ?? account.password)`;
    - click `checkButton()`;
    - `await expect.poll(() => settings.configCheckStatus(), { timeout: 60_000, intervals: [500] }).not.toMatch(/^(none|checking)$/)`;
    - return `settings`, still on the configuration screen. The caller asserts the outcome.

**Check:** lint and tsc on the changed files. The page objects are exercised by WO-8, WO-9 and the M1-S7 regression in WO-12.

**Commit:** `test(harness): plain and seeded accounts, sync-check and encryption page objects (M2-S1)`. The commit body names Findings F1 and F2.

## WO-8: `tests/e2e/m2-s1/sync-through-proxy.spec.ts` (M2-AC1 and its NEG)
**Header comment:** the AC, Interpretations 1 to 3, and the plan path. Reuse `requireUpstreamBundle` by moving it from the M1-S7 spec into `tests/e2e/support/bundle.ts` (export it, and import it in both specs). `test.describe('M2-S1 sync through the proxy', …)`.

**`M2-AC1 configures Joplin Server at <origin>/joplin-server, the check succeeds and a full sync completes, with only same-origin sync traffic and info.json version 3`**, with fixtures `{ stack, joplinServer, plainAccount, webApp, webNetwork }`:
1. `1. configure the sync target like a user and check the configuration`:
   - `expect(joplinServer.proxiedUrl).toBe(\`${new URL(webApp.baseURL).origin}/joplin-server\`)`;
   - `settings = await configureAndCheckJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, plainAccount)`;
   - `expect(await settings.configCheckStatus()).toBe('success')`.
2. `2. the successful check saved the settings`: `await expect(page.getByRole('button', { name: 'Save changes', exact: true, disabled: true })).toBeVisible()`, then click `Back`.
3. `3. a full sync completes`:
   - `app.openSidebar()`;
   - `await expect.poll(async () => ({ idle: await app.syncIdle().isVisible(), report: await app.syncReport() }), { timeout: firstSyncTimeoutMs, intervals: [1_000] })` until `idle === true` and the report matches `/Completed: /` and does not match `/Last error:/`. Use a probe that returns a string verdict, and `toBe('completed')`, so a failure prints the report.
4. `4. the sync went through the proxy`, on `classifyRequests(webNetwork.entries(), new URL(webApp.baseURL).origin)`:
   - `syncTraffic` has `POST /joplin-server/api/sessions` with status 200;
   - `syncTraffic` has a `PUT` whose decoded pathname is `/joplin-server/api/items/root:/info.json:/content`, with a 2xx status.
5. `5. data level: the server's info.json has version 3`:
   - `serverItemContent(stack, plainAccount, 'info.json')` has status 200;
   - `JSON.parse(text).version` is 3 and equals `readVersionPin().syncVersion`.
6. `6. network policy`:
   - `expect(violationLines(verdict)).toEqual([])`;
   - `expect(webNetwork.entries().filter(e => e.url.startsWith(joplinServer.url)).map(e => e.method + ' ' + new URL(e.url).pathname)).toEqual([])`;
   - `expect(verdict.syncTraffic.length).toBeGreaterThan(0)`;
   - `expect(webNetwork.entries().some(e => e.fromServiceWorker), 'the recorder sees service-worker requests').toBe(true)`.
7. `7. control: a planted cross-origin request is seen and flagged`:
   - `await webApp.page.evaluate(() => fetch('https://notestead-control.invalid/m2-ac1', { mode: 'no-cors' }).then(() => 'sent', () => 'failed'))`;
   - `await expect.poll(() => violationLines(classifyRequests(webNetwork.entries(), origin)).some(l => l.includes('notestead-control.invalid/m2-ac1'))).toBe(true)`.
   - Step 6 has already been evaluated, so this control cannot hide a real violation.

**`M2-AC1 NEG a wrong sync password fails the check with upstream's error, and nothing is saved or synced`**, with fixtures `{ stack, joplinServer, plainAccount, webApp, webNetwork }`:
1. `wrong = \`nstwrong${randomBytes(12).toString('hex')}\``, then `registerSecrets([{ label: 'm2_ac1_wrong_password', value: wrong }])`.
2. `settings = await configureAndCheckJoplinServerSync(…, plainAccount, { password: wrong })`, then `expect(await settings.configCheckStatus()).toBe('error')`. `configCheckError()` contains `The reported error was:` and `Invalid email or password`.
3. `Save changes` is **enabled**: `await expect(page.getByRole('button', { name: 'Save changes', exact: true, disabled: false })).toBeVisible()`.
4. Network:
   - `syncTraffic` has `POST /joplin-server/api/sessions` with status 403;
   - no `syncTraffic` entry has a pathname starting with `/joplin-server/api/items/`;
   - `violationLines` is `[]`.
5. Data level: `expect(await serverItemNames(stack, plainAccount)).toEqual([])`.

**Expected outcome:** both tests pass on the existing product (plan §Requirements). They are proven able to fail by the sensitivity runs in WO-12.

**Commit:** `test(e2e): M2-AC1 sync through the proxy with network policy and info.json, with NEG`.

## WO-9: `tests/e2e/m2-s1/e2ee-unlock.spec.ts` (M2-AC2 and its NEG)
**Setup:** `test.describe('M2-S1 E2EE unlock in the web app', () => { test.use({ e2eeSeed: { notes: 3 } }); … })`. Helpers in the file:
- `seedOf(account)` → `{ folder: account.folder!, tag: account.seedTag!, notes: account.notes! }`. Assert `notes.length === 3`.
- `noSeedIn(html, seed)` → the first of `[tag, folder, ...titles, ...bodies]` contained in `html`, or `undefined`.
- `encryptedCountAtLeast(app, n)`.
- `md(names)` → the names matching `/^[0-9a-f]{32}\.md$/`.

**`M2-AC2 the web app reports the seeded items as encrypted, and after the master password shows every seeded title and body as the headless REST API has them`**, with fixtures `{ stack, joplinServer, e2eeAccount, headlessService, dataApi, webApp, webNetwork }`:
0. `0. data level before: info.json`: `version === 3`, `e2ee.value === true` (written by the CLI device).
1. `1. configure the web app`: `configureJoplinServerSync(app, webApp.baseURL, joplinServer.proxiedUrl, e2eeAccount)`. Expect `app.decryptionBanner()` visible within `firstSyncTimeoutMs`.
2. `2. data level: the headless REST API has the seed decrypted`. For each seeded note:
   - `GET /notes/:id?fields=id,title,body,parent_id,encryption_applied,is_conflict` → title, body equal the seed, `encryption_applied: 0`, `is_conflict: 0`;
   - all three share one `parent_id`, and `GET /folders/<parent_id>?fields=id,title` → `title === seed.folder`.
   - Keep these values as `reference`.
3. `3. the app reports encrypted items`:
   - `await expect.poll(() => app.encryptedNotesInList().count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(3)`;
   - `expect(noSeedIn(await app.frameHtml(), seed)).toBeUndefined()`;
   - `screen = await app.openEncryptionSettingsFromBanner()`;
   - `expect(await screen.encryptionStatus()).toBe('Encryption is: Enabled')`;
   - `await expect.poll(async () => { const s = await screen.decryptedStats(); return s ? s.total - s.done : -1; }, { timeout: 30_000 }).toBeGreaterThanOrEqual(4)`.
4. `4. enter the master password`:
   - `screen.enterMasterPassword(e2eeAccount.masterPassword)`;
   - poll `masterPasswordState()` until `'accepted'` (60 s);
   - poll until `decryptedStats()` gives `done === total`, with `total ≥ 4` (3 min; probe returns `'all'` or a string such as `'3 / 7'`);
   - `screen.back()`.
5. `5. every seeded title is in the note list and the folder in the side menu`:
   - for each title, poll `app.noteInList(title).isVisible()` (3 min);
   - `expect(await app.encryptedNotesInList().count()).toBe(0)`;
   - `app.openSidebar()`;
   - `await expect(app.folderInSideMenu(seed.folder)).toBeVisible()`;
   - `app.closeSidebar()`.
6. `6. every seeded body is shown decrypted`. For each note: `app.openNote(title)`, then `await expect.poll(() => app.frameText(), { timeout: 60_000 }).toContain(reference body)`, then `app.backToList()`.
7. `7. network policy` (as M2-AC1 step 6, without the service-worker and control assertions): `violationLines` is `[]`, no URL starts with `joplinServer.url`, and `syncTraffic.length > 0`.
8. `8. data level after`:
   - `syncHeadlessOnce(stack, headlessService)`;
   - each seeded note again equals `reference`, and `notesTitled(title)` has exactly one id. Move `notesTitled`/`ok`/`pick` from the M1-S7 spec into `tests/e2e/support/dataApi.ts` and import them in both specs;
   - `info.json` still has `version === 3` and `e2ee.value === true`.

**`M2-AC2 NEG a wrong master password leaves every seeded item encrypted and shows upstream's error; nothing is decrypted`**, with fixtures `{ stack, joplinServer, e2eeAccount, webApp, webNetwork }`:
1. `before = map of md(serverItemNames) → serverItemContent text`, taken before configuring.
2. Configure as in AC2 step 1, then AC2 step 3 (encrypted, with the same assertions).
3. Stage 1:
   - `wrong1 = \`nstwrong${hex}\``, registered;
   - `screen.enterMasterPassword(wrong1)`;
   - `await expect.poll(() => screen.masterPasswordState(), { timeout: 60_000 }).toBe('rejected')`;
   - `await expect(screen.invalidMasterPasswordText()).toBeVisible()`.
4. Stage 2:
   - `wrong2` likewise;
   - `const dialog = webApp.page.waitForEvent('dialog', { timeout: 60_000 })`;
   - `screen.saveMasterPassword(wrong2)`;
   - `const d = await dialog; expect(d.message()).toBe('Password is invalid. Please try again.'); await d.dismiss();`.
5. `screen.back()`, then `holdsFor('every seeded item stays encrypted', probe, { windowMs: 60_000, intervalMs: 1_000 })`. The probe returns a message:
   - if `noSeedIn(await app.frameHtml(), seed)` finds anything;
   - if `app.decryptionBanner()` is not visible;
   - if `encryptedNotesInList().count() < 3`.
6. Open the encryption screen from the banner. `decryptedStats()` has `total - done ≥ 4`, and `masterPasswordState()` is `'rejected'`.
7. Data level:
   - `md(serverItemNames)` equals `Object.keys(before)` (sorted);
   - every item's content equals `before[name]`;
   - `violationLines` is `[]`.

**Expected outcome:** both tests pass on the existing product. The NEG is proven able to fail by sensitivity run S1 (WO-12).

**Commit:** `test(e2e): M2-AC2 E2EE unlock decrypts every seeded note, with wrong-password NEG`. If you moved helpers out of the M1-S7 spec, say so in the body. The M1-S7 spec's assertions must not change.

## WO-10: Strategy update
`docs/testing/strategy.md`: one commit with what WO-1, WO-4 and WO-5 did not already add:
- §4 fixtures list: `plainAccount`, `e2eeSeed`, `webNetwork` (with the policy rule of Interpretation 2, and that the recorder observes and never routes, Interpretation 3).
- §5 Rules: "Per-test evidence comes from per-test sources: the context's network log, the test's own account on the server, its own headless service. Never a shared container's log, which other workers write to in CI (M2-S1 F3)."

**Commit:** `docs(testing): strategy for the M2-S1 harness (network policy, plain and seeded accounts)`.

## WO-11: C2-R5 closure (no commit)
Check that `docs/testing/strategy.md` §5 has the spy spelling (`const spy = jest.spyOn(globalThis, 'setTimeout')`) and `Atomics.wait` in the ban list, and that `eslint.config.js` bans `Atomics.wait` (`2e68c17`). Record "C2-R5: closed by `b3c0cd9` and `2e68c17`; the `html/trace/` sentence by WO-1" in the Results section (WO-12). If anything is missing, stop and report; do not edit `eslint.config.js`.

## WO-12: Runs, sensitivity, and the plan's RED, validation and Results sections
Run these in order, one at a time. Logs go under `test-results/verify/m2-s1/`.
1. `podman-before.txt`.
2. `T=10m run verify/lint.log corepack yarn lint`. Must be exit 0.
3. `T=15m run verify/jest-harness.log corepack yarn jest tests/unit/harness tests/integration/harness`. Must be exit 0. List the new IDs and their counts.
4. `T=10m run verify/acceptance-m2-s1.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s1/serial-rule.test.mts`. Must be exit 0.
5. `T=100m run verify/e2e-full.log env NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test`, in the background. Expected: everything passes, which is:
   - `C1-R1-guard` (with the textarea);
   - `M1-AC21` and its NEG (regression for F1 and F2);
   - `M2-AC1` and its NEG;
   - `M2-AC2` and its NEG.
   A failure is analysed, not retried blindly. A harness bug is fixed test-first in a new `test(...)` commit. An upstream difference is reported to the planner.
6. **Sensitivity runs.** Make temporary local edits, never committed, and `git checkout -- <file>` after each one. `git status` must then be clean for that file.
   - **S1:** in `e2ee-unlock.spec.ts`, the NEG's stage 1 uses `e2eeAccount.masterPassword` instead of `wrong1`. `T=30m run sens/s1.log <reuse images> corepack yarn playwright test tests/e2e/m2-s1/e2ee-unlock.spec.ts -g "M2-AC2 NEG"`. It must fail at the `'rejected'` poll, with `Received: "accepted"`.
   - **S2:** in `sync-through-proxy.spec.ts`, the NEG uses `plainAccount.password` instead of `wrong`. Run `-g "M2-AC1 NEG"` into `sens/s2.log`. It must fail at `configCheckStatus()` being `'error'` (`Received: "success"`).
   - **S3:** in `e2ee-unlock.spec.ts`, comment out the `enterMasterPassword` call of step 4 in the positive test. Run `-g "M2-AC2 the web app"` into `sens/s3.log`. It must fail at the `'accepted'` poll or the `done === total` poll.
   For each failing run, check that `network.log`, `browser-console.log`, `server.log` and `trace` were attached.
7. `T=90m run verify/contract-regression.log <reuse images> corepack yarn test:contract --verbose tests/contract/m1-s6 tests/contract/m1-s7` (C1-R4 and M1-S8 C2: `ac20-*`, `c1-*`, `c1r1-*`). Must be exit 0.
8. Integrity: `git log --format='%h %s%n%b' b615653..HEAD -- tests/ playwright.config.ts` must list only `Agent: qa-specialist` commits.
9. `podman-after.txt`, and compare it with the before file. Only `byparr` resources may be present besides kept test images. Remove the kept images with `podman rmi localhost/notestead-web:stack-test localhost/notestead-headless:stack-test` only after the planner's review.
10. Append to `docs/test-plans/M2-S1.md`, in the M1-S7 format:
    - `## Harness validation (… Pi arm64)`: S1 to S3, with the failure lines;
    - `## RED (… Pi arm64)`: the `red/*.log` results of WO-1 to WO-6. Say that the AC specs pass on the existing product, with the M2 convention that tests cover unmodified upstream;
    - `## Results (QA executor, … Pi arm64)`: a Layers table and a Per criterion table with PASS/FAIL, command, duration and log links, for M2-AC1, M2-AC1 NEG, M2-AC2, M2-AC2 NEG, C1-R4, M1-S8 C2, C-N1, C-N3, the serial rule and C2-R5. Include Test integrity. Leave x64 as PENDING-CI.

    Commit: `docs(test-plans): M2-S1 RED, harness validation and arm64 results`.
11. Report to the orchestrator: the commit hashes per WO, the per-criterion status, any stop/report items, and the podman before/after result.
