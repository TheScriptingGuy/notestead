# Test plan: fix-forward for e2e run 39663284028 (M2-S2 on x64 and arm64)

- **Trigger:** `main` is red after the M2-S2 merge. The e2e run is 39663284028, head `961df09`. Evidence is in `~/joplin-web-app-work/ci-evidence/39663284028/index.md`; the green baseline is `39583324634/`. `ci.yml` is green.
- **Branch:** `test/M2-S2-ci-x64-arm64`, from `main` `961df09`. The untracked `docs/test-plans/M2-S3.md` belongs to the M2-S3 planner: never stage, edit or remove it.
- **Owners:**
  - **QA (planner):** this plan.
  - **QA (executor):** WO-0 to WO-7: the harness, the specs, `playwright.config.ts`, `docs/testing/strategy.md`, and the Results section here.
  - **ci-cd-specialist:** CC-1 only, which is conditional (§Budget).
  - **senior-engineer:** none. No product defect was found.

## Diagnosis
| # | Symptom | Root cause | Confidence | Evidence |
|---|---|---|---|---|
| **A** | x64 M2-AC5 fails on both attempts in `AlarmDialog.enterLocal`: the `datetime-local` value stays `''` | **Chromium lays out the date and time fields by the browser process's OS locale (`LC_ALL`, else `LANG`), not by Playwright's emulated context `locale`.** The runner's C locale gives US order with a 12-hour clock (`mm/dd/yyyy, hh:mm AM/PM`). Our en-GB keys (`21102026`, `ArrowRight`, `2204`) therefore never complete the value. The Pi passes because its shell has `LANG=en_GB.UTF-8`, which the browser inherits. | **High.** Reproduced locally (table below) | trace: 94 polls of `''`; local experiment E1 to E9 |
| **A′** | arm64 M2-AC5 fails on both attempts, about 1.1 min each | the same as A (inferred: same duration, and it stops before the first cycle, since its headless log has one start per attempt) | high (inference) | `index.md` arm64 table; `…-hl-e90e0e11*` logs |
| **B** | arm64 M2-AC3 attempt 1 runs into the spec's 25-minute timeout. Its last headless restart (the move cycle) was ready at 20:04:04Z; there is no 5th restart | **No Playwright action is bounded.** `playwright.config.ts` sets no `actionTimeout` or `navigationTimeout`, and Playwright Test's default for both is 0 (none). Every other wait in steps 8 to 10 has a bound of 3 minutes or less: `expect.poll` 60 s, the Data API probe 120 s, server requests 60 s, `syncWebOnce`'s poll 3 min, `syncHeadlessOnce` 10 min, and that one never even started. So only a `click()` or `locator.waitFor()` on an element that never became actionable can have waited 23 minutes. Candidates: `openNote(T2)`, `menuAction('Delete')`, `backToList`, `openSidebar`. **Which locator, and why it stuck on arm64, is unknown:** the arm64 trace was lost (D). | **Class: high. Locator and trigger: low** | `…-hl-803d774f_headless_1.log`: 4 starts, silent after 20:04:04Z; no `actionTimeout` in `playwright.config.ts` or `tests/e2e/support/**` |
| **C** | arm64 M1-AC21 NEG fails once at 29.2 s and passes on retry | **Unknown.** Its headless sync was ready at 19:59:00Z and the stack was torn down at 19:59:06Z. The NEG web container's access log holds only its readiness `GET /` (19:58:53.6Z), so the test failed in steps 1 to 2 or at the "only difference" pings, before the browser made any request. The error text is lost (D). | low | NEG web log `…-web-nohost-be3526f4.log`; the headless logs |
| **D** | arm64 has no JUnit, no HTML report and no traces | the 45-minute step limit killed Playwright before its reporters' `onEnd`. So `redaction-complete.json` was never written, and the upload gate (correctly, C1-R2) removed the unredacted `test-results/e2e/output`. The `list` reporter prints error details only at the end of a run, so the job log holds no failure messages either. | high | `upload-gate.json` `complete:false`, `removed:["test-results/e2e/output"]` |
| — | `[error] Synchronizer: … Master key is not loaded` in the x64 console about 18 s before `Set alarm` | unrelated. It is the web app's first sync before the master password (L18, M2-S1 F4); the test unlocks afterwards. | high | console timestamps vs. the unlock step |

### Local experiment (planner, 2026-10-22, Pi; not committed)
One page with `<input type="datetime-local">` in a context with `locale: 'en-GB'` and `timezoneId: 'Europe/Amsterdam'`. The keys are typed as `AlarmDialog.enterLocal` types them. The browser binaries are Playwright's `chromium-1223` (full) and `chromium_headless_shell-1223` (CI runs headless shell 1217).

| # | Binary | Browser process env | Keys | `inputValue()` |
|---|---|---|---|---|
| E1 | full | `LANG=LC_ALL=en_GB.UTF-8` | `21102026` → `ArrowRight` → `2204` | `2026-10-21T22:04` |
| E2 | full | `LANG=LC_ALL=C.UTF-8` | same | `''` |
| E3 | full | `LANG=LC_ALL=en_US.UTF-8` | same | `''` |
| E4 | headless shell | `en_GB.UTF-8` | same | `2026-10-21T22:04` |
| E5 | headless shell | `C.UTF-8` | same | `''` |
| E6 | headless shell | `C.UTF-8` (no `LC_ALL`) | US order `10212026` → `ArrowRight` → `1004P` | `2026-10-21T22:04` (US order, 12-hour clock) |
| E7 | headless shell | parent `C.UTF-8`, launched with `args: ['--lang=en-GB']` | en-GB keys | `''`: `--lang` has no effect on Linux |
| E8 | headless shell | parent `LC_ALL=C.UTF-8`, `launch({ env: { …, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB' } })` | en-GB keys | `''`: an inherited `LC_ALL` wins |
| E9 | headless shell | parent `LC_ALL=C.UTF-8`, `launch({ env: { …, LANG, LANGUAGE, LC_ALL: 'en_GB.UTF-8' } })` | en-GB keys | **`2026-10-21T22:04`** |

`navigator.language` and `Intl` reported `en-GB` in **every** case, so the emulated locale does reach JavaScript, just not the date fields. `en_US.UTF-8` is not a generated glibc locale on the Pi, yet E3 and E6 followed it. So Chromium reads the locale name through ICU, and the CI runner needs no glibc locale for E9's fix.

## Decisions
- **A: pin the browser process's locale to the context's.** `playwright.config.ts` launches Chromium with `env: browserLocaleEnv(process.env)`, which sets `LC_ALL` and `LANG` to `en_GB.UTF-8` and `LANGUAGE` to `en_GB:en`. `webApp`'s `locale` and this env come from one constant, `browserLocale = 'en-GB'`. A real en-GB user's browser has an en-GB UI locale, so this is the faithful emulation and not a workaround. `AlarmDialog` keeps typing en-GB order. A harness spec guards the pin on every runner. Rejected alternatives:
  - `--lang` has no effect (E7);
  - setting the locale in the workflow would leave local runs and other runners unguarded;
  - a locale-aware `enterLocal` would hide a wrong browser locale instead of failing on it.
- **B: bound everything.**
  - `use.actionTimeout` 60 s: the Pi, the slowest box, does each UI action in seconds.
  - `use.navigationTimeout` 120 s.
  - `globalTimeout` 40 min in CI, so Playwright ends itself before the 45-minute step limit, its reporters finish and the gate keeps the traces (this also fixes D).
  - The M2-S2 spec timeout goes from 25 to 15 min. The slowest M2-S2 test took 417 s on the Pi; and a test plus its CI retry (30 min) must fit inside `globalTimeout`.

  A stuck action then fails within a minute and names its locator. The next arm64 run tells us which element B was.
- **C: no change to the test.** Two instrumentation changes make the next occurrence diagnosable:
  - a failure line printed at once, so the job log holds every failure even if the step is killed;
  - `globalTimeout`, so reports exist.

  Flake policy (strategy §6): if M1-AC21 NEG fails again within a week, it becomes a bug with a root cause.
- **D:** fixed by B's `globalTimeout` plus the immediate failure line. The upload gate's rule (remove output whose redaction did not finish) is a security rule and **stays**.

## Budget (the 45-minute E2E step, W1, M2-S3)
- **Measured:**
  - green, 7 tests: arm64 451 s, x64 321 s;
  - this run, 14 tests: x64 568 s, with one failing test retried.
- **Expected:** a healthy 14-test arm64 run with 2 workers takes roughly 12 to 18 min. That is an estimate; the CI proof run measures it.
- **Runner resources** at the end of the arm64 job: 13.6 GB of 16 GB available, no swap used. 2 workers are not the problem, so **workers stay at Playwright's default (2)**.
- **Decision:** keep the 45-minute step for this fix, with `globalTimeout` 40 min. `CI-T-02` locks the 5-minute margin, which covers the reporters' `onEnd`/`onExit` and the upload gate. *(Corrected 2026-10-22, F-B1: Playwright's one global deadline also bounds `globalTeardown`, so after a global timeout the stack stays up. On CI that is harmless, because the runner VM is discarded.)*
- **CC-1 (ci-cd-specialist, conditional): raise the step to 60 min**, with QA moving `ciGlobalTimeoutMs` to 55 min in the same change (`CI-T-02` enforces the pairing), if either:
  - (a) the healthy arm64 E2E wall time in the proof run is over 20 min (half of 40); or
  - (b) M2-S3's attachment specs (5 MiB and 100 MiB, M2-AC7) are about to merge. Their upload, encryption and download times on the Pi decide it; M2-S3's plan names the number.

  Nothing else in `.github/**` changes: no workers change, no artifact handling change.

## Acceptance → tests
| Item | Test ID (file) | Layer | RED | Sensitivity | Assertion |
|---|---|---|---|---|---|
| **A** browser locale pin | `ci-loc-01…02` (`tests/unit/harness/browserLocale.test.ts`) | unit | module missing | — | `browserLocaleEnv(base)` keeps the other variables, drops `undefined` ones, and sets `LC_ALL` and `LANG` to `en_GB.UTF-8` and `LANGUAGE` to `en_GB:en`. Its locale name (`en_GB`) is `browserLocale` (`en-GB`) with `_` |
| **A** date fields follow en-GB on any host | `CI-M2S2-LOC-01`, `CI-M2S2-LOC-02` (`tests/e2e/harness/browser-locale.spec.ts`) | E2E harness | `LANG=C.UTF-8 LC_ALL=C.UTF-8` run before the fix: LOC-01 gets `''` | **S-A:** the same run after the fix passes; the CI proof run passes it on the runners' own locale | LOC-01: the en-GB keys give `2026-10-21T22:04`. LOC-02 (control): the US-order keys don't give it, so the spec can tell the orders apart |
| **A** M2-AC5 under the CI locale | `M2-AC5` (existing) | E2E | **S-D:** `LANG=C.UTF-8 LC_ALL=C.UTF-8 … -g M2-AC5` before the fix reproduces CI: `timed out after 10000 ms waiting for the date input to hold …` | after the fix the same command passes | unchanged |
| **B, D** bounded actions and run | `CI-T-01…04` (`tests/acceptance/ci-m2-s2/timeouts.test.mts`) | acceptance (static) | the config has no `actionTimeout` or `globalTimeout`; the specs say `25 * 60_000` | **S-B** (stuck action), **S-C** (global timeout end to end) | T-01: the config uses `actionTimeoutMs`, `navigationTimeoutMs`, and `globalTimeout: ci ? ciGlobalTimeoutMs : 0`. T-02: `ciGlobalTimeoutMs ≤ (e2e step timeout-minutes − 4) min`, read from `e2e.yml`. T-03: no spec sets a timeout above `longSpecTimeoutMs`, and the three M2-S2 specs use it. T-04: `2 × longSpecTimeoutMs < ciGlobalTimeoutMs` |
| **C, D** failures visible at once | `ci-fail-01…03` (`tests/unit/harness/failureLine.test.ts`) | unit | module missing | **S-B** shows the line in the job-style output before the summary | one line: `[notestead] FAILED <title> (<file>:<line>) attempt <n>, <s> s: <first error line>`. Registered secrets and `token=` values are redacted, only the first line is kept, at most 300 characters |

## Work orders (QA executor)
The rules of `docs/test-plans/M2-S2-work-orders.md` §Rules apply unchanged: trailer, `test`/`chore`/`docs` subjects only, P2 RED commits, one heavy job at a time, the `run` log wrapper, the P1 leftover-stack rule, never `--trace on`. Logs go under `test-results/verify/ci-m2-s2/`. The images are kept from the M2-S2 sign-off (`$IMG` works); check with `podman images` first, and rebuild with `NOTESTEAD_KEEP_IMAGE=1` if they are gone. **`docs/test-plans/M2-S3.md` must not appear in any commit** (`git add` by path only).

### WO-0: Pre-flight (no commit)
- `podman-before.txt`, as in M2-S2 WO-0.
- `git status`: the only untracked file is `docs/test-plans/M2-S3.md`.

### WO-1: Pin the browser locale (A) (RED commit)
- **RED:**
  - `tests/unit/harness/browserLocale.test.ts` holds `ci-loc-01` and `ci-loc-02` as above; they import `browserLocale` and `browserLocaleEnv` from `../../e2e/support/chromium.ts`.
  - `tests/e2e/harness/browser-locale.spec.ts`, fixtures `{ webApp }`:
    - `page.setContent('<input type="datetime-local" aria-label="When">')`;
    - `f = page.getByLabel('When')`;
    - LOC-01: `f.pressSequentially('21102026')`, `page.keyboard.press('ArrowRight')`, `page.keyboard.type('2204')`, then `await expect(f).toHaveValue('2026-10-21T22:04')`;
    - LOC-02: on a fresh `setContent`, the keys `10212026`, `ArrowRight`, `1004P`, then `expect(await f.inputValue()).not.toBe('2026-10-21T22:04')`;
    - a header comment citing this plan (Diagnosis A, E1 to E9).
  - Logs:
    - `red/wo1-unit.log`: the module export is missing;
    - `red/wo1-loc-c.log`: `T=30m run … env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/harness/browser-locale.spec.ts`. LOC-01 fails with `Received: ""`;
    - **S-D**, `red/wo1-ac5-c.log`: `T=40m run … env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m2-s2/todos.spec.ts`. It fails at step 2 with CI's message.
  - **Commit 1:** `test(harness): failing checks that the browser's date fields follow the en-GB context on any host locale (CI 39663284028 A)`.
- **GREEN:**
  - `tests/e2e/support/chromium.ts`: `export const browserLocale = 'en-GB';` and `export const browserLocaleEnv = (base: NodeJS.ProcessEnv): Record<string, string>`. It copies the defined entries, then sets `LC_ALL` and `LANG` to `en_GB.UTF-8` and `LANGUAGE` to `en_GB:en`. Add a comment: "Chromium lays out date and time fields by the browser process's locale env, not by the context's emulated locale; `--lang` does nothing on Linux (docs/test-plans/CI-M2-S2-x64-arm64.md E1–E9)."
  - `playwright.config.ts`: `launchOptions: { ...(chromium.executablePath ? { executablePath: chromium.executablePath } : {}), env: browserLocaleEnv(process.env) }`.
  - `tests/e2e/support/fixtures.ts`: `webApp`'s `newContext` uses `locale: browserLocale`, with the comment kept.
  - Re-run all three RED commands into `green/`; all pass.
  - **Commit 2:** `test(harness): launch Chromium in the en-GB locale of the browser contexts (CI 39663284028 A)`.

### WO-2: Bound every action and the CI run (B, D) (RED commit)
- **RED:**
  - `tests/acceptance/ci-m2-s2/timeouts.test.mts` holds `CI-T-01…04` as above. It imports `tests/e2e/support/timeouts.ts` dynamically inside each test, so every RED is visible. It reads the step with `id: e2e` of `.github/workflows/e2e.yml` with the `yaml` parser, as `ac22-e2e-workflow.test.mts` does.
  - Log `red/wo2.log` (`node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/ci-m2-s2/timeouts.test.mts`). All four fail: the module is missing, or there is no `actionTimeout`/`globalTimeout`, or `25 * 60_000` is still there.
  - **Commit 1:** `test(harness): failing checks that every action, every spec and the CI run are bounded (CI 39663284028 B, D)`.
- **GREEN:**
  - `tests/e2e/support/timeouts.ts` (no Playwright import): `actionTimeoutMs = 60_000`, `navigationTimeoutMs = 120_000`, `ciGlobalTimeoutMs = 40 * 60_000`, `longSpecTimeoutMs = 15 * 60_000`. Each gets a one-line reason, citing this plan's Decisions B.
  - `playwright.config.ts`:
    - `globalTimeout: ci ? ciGlobalTimeoutMs : 0`;
    - `use.actionTimeout: actionTimeoutMs`, `use.navigationTimeout: navigationTimeoutMs`;
    - a header bullet.
  - The three M2-S2 specs: `test.describe.configure({ timeout: longSpecTimeoutMs })`.
  - Log `green/wo2.log`; 4 of 4 pass. Also run `tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` and `tests/acceptance/m2-s1/serial-rule.test.mts`; both must pass.
  - **Commit 2:** `test(harness): bound actions (60 s), navigations (120 s), the CI run (40 min) and the M2-S2 specs (15 min) (CI 39663284028 B, D)`.

### WO-3: Print each failure at once (C, D) (RED commit)
- **RED:** `tests/unit/harness/failureLine.test.ts`:
  - `ci-fail-01`: the format above, for `{ title: 'T', file: 'tests/e2e/x.spec.ts', line: 7, retry: 1, status: 'failed', durationMs: 72_049, error: 'Error: boom\n    at …' }`, gives `[notestead] FAILED T (tests/e2e/x.spec.ts:7) attempt 2, 72 s: Error: boom`;
  - `ci-fail-02`: a registered secret and `?token=abc123def456` in the error are redacted;
  - `ci-fail-03`: a 1000-character first line is cut to at most 300 characters plus `…`.

  Log `red/wo3-unit.log`. **Commit 1:** `test(harness): failing unit tests for an immediate, redacted failure line (CI 39663284028 C, D)`.
- **GREEN:**
  - `tests/e2e/support/failureLine.ts` holds `failureLine(input, secrets: KnownSecret[]): string`, using `redactText` from `tests/support/redact.ts`.
  - In `redactingReporter.ts` `onTestEnd`, after its redaction: when `result.status` is neither `passed` nor `skipped`, write `failureLine(…)` to `process.stdout`. Use the title from `test.titlePath().slice(-1)` and the location relative to the repo root.
  - Log `green/wo3-unit.log`. **Commit 2:** `test(harness): the redacting reporter prints each failure as it happens, so a killed run keeps its errors (CI 39663284028 C, D)`.

### WO-4: Sensitivity S-B and S-C (no commit)
Make temporary edits, never committed, and `git checkout --` each one afterwards.
- **S-B:**
  - The edit: in `tests/e2e/harness/type-like-user.spec.ts`, append `await page.getByRole('button', { name: 'nst-never-there' }).click();` to the test.
  - Run: `T=30m run sens/s-b.log env $IMG corepack yarn playwright test tests/e2e/harness/type-like-user.spec.ts`.
  - It must fail in about 60 s with `Timeout 60000ms exceeded` naming that locator, not at the 10-minute test timeout.
  - The log must hold the `[notestead] FAILED C1-R1-guard …` line **before** the summary block.
- **S-C:**
  - The edit: in `timeouts.ts` set `ciGlobalTimeoutMs = 10 * 60_000`, and in `playwright.config.ts` use it unconditionally. `globalTimeout` also counts `globalSetup`, and the Pi's stack start takes about 4 min.
  - Run: `T=40m run sens/s-c.log env $IMG corepack yarn playwright test`.
  - Playwright must stop itself at 10 minutes (`Timed out waiting 600s for the test suite to run`), with tests still pending, and globalTeardown must still run (the stack is removed).
  - Then:
    - `test-results/e2e/junit.xml` and `test-results/e2e/redaction-complete.json` exist;
    - the `[notestead] FAILED` lines name the interrupted tests;
    - `T=5m run sens/s-c-gate.log node tests/harness/upload-gate.ts` reports `complete: true` and keeps `test-results/e2e/output`.

    Record the `upload-gate.json` summary (value-free).

### WO-5: Full local run under the CI locale (no commit)
1. `T=10m run verify/lint.log corepack yarn lint`
2. `T=15m run verify/jest.log corepack yarn jest tests/unit/harness tests/integration/harness`
3. The three acceptance files of WO-2.
4. `T=120m run verify/e2e-full-c-locale.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test`, in the background. **All 16 tests pass** (14 plus LOC-01 and LOC-02), with no retry (local `retries: 0`). Copy the `cycle` annotations.

A failure is analysed; never retry it blindly. If M2-AC3 fails now, the 60 s action timeout names the locator. Then stop and report it, with the trace, as finding B's root cause.

### WO-6: Strategy (`docs(testing)`)
`docs/testing/strategy.md`:
- **§4, the fixtures paragraph:** "The browser process runs in the contexts' locale (`browserLocaleEnv`: `LC_ALL` and `LANG` `en_GB.UTF-8`), because Chromium lays out date and time fields by the process locale, not the emulated one (CI 39663284028 A)."
- **§5 Rules:** "**Everything is bounded:**
  - actions 60 s, navigations 120 s;
  - each long spec 15 min;
  - the CI run 40 min, which ends Playwright at least 4 minutes before the E2E step limit, so reports and traces survive (`CI-T-01…04`).

  The redacting reporter prints each failure as it happens."

**Commit:** `docs(testing): browser locale pin and bounded actions and runs (CI 39663284028)`.

### WO-7: Results and report (`docs(test-plans)`)
Append `## RED`, `## Harness validation` (S-A to S-D) and `## Results (… Pi arm64)` to this plan, in the M2-S2 format. Include test integrity (`git log` since `961df09`, `qa-specialist` only) and podman before/after. Leave **CI proof: PENDING** and no sign-off line.

**Commit:** `docs(test-plans): CI-M2-S2 fix-forward RED, validation and arm64 results`.

## CI proof
After QA's review and the lead's approval, the orchestrator asks the user to approve **pushing `test/M2-S2-ci-x64-arm64`**. The standing approval covers only `main`. `e2e.yml` runs on any branch push that changes non-docs files (`push: branches: ['**']`, `paths-ignore: docs/**`). QA then downloads the evidence, read-only, into `~/joplin-web-app-work/ci-evidence/<run>/`. It passes when, on **both** runners:
- E2E is green;
- `CI-M2S2-LOC-01/02` pass (the pin works on the runners' own locale);
- M2-AC5 passes;
- M2-AC3 passes on arm64;
- flaky is 0, with every result `retry: 0`;
- JUnit and the HTML report exist;
- the arm64 E2E wall time is recorded for CC-1.

If M2-AC3 or M1-AC21 NEG fails, the run now leaves a named locator, a failure line and a trace. QA analyses it as a new finding; it is never retried until it passes. The merge to `main` follows only after a green branch run.

## Disputes
None.

## RED (2026-10-22, Pi arm64)
Logs are under `test-results/verify/ci-m2-s2/` (gitignored); each ends with `# duration <s> s; exit <code>`. Each RED commit came before its GREEN commit (P2). The C locale is `LANG=C.UTF-8 LC_ALL=C.UTF-8`.

| WO | Test | Command | RED outcome | Log |
|---|---|---|---|---|
| 1 | `ci-loc-01…02` | `corepack yarn jest tests/unit/harness/browserLocale.test.ts` | 2 failed: `browserLocaleEnv is not a function` | `red/wo1-unit.log` |
| 1 | `CI-M2S2-LOC-01…02` | `env LANG=C.UTF-8 LC_ALL=C.UTF-8 NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test tests/e2e/harness/browser-locale.spec.ts` (the first heavy run: it built the three images; 473 s) | **LOC-01:** `Expected: "2026-10-21T22:04"`, `Received: ""`. **LOC-02 (control):** `Expected: not "2026-10-21T22:04"`, and it received exactly that value: the US-order keys fill the fields. So Chromium lays them out by the process locale, as diagnosed | `red/wo1-loc-c.log` |
| 1 (S-D) | `M2-AC5` under the C locale | `env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m2-s2/todos.spec.ts` | fails at step 2 with CI's message: `timed out after 10000 ms waiting for the date input to hold 2026-10-22T02:23` (261 s) | `red/wo1-ac5-c.log` |
| 2 | `CI-T-01…04` | `node --test … tests/acceptance/ci-m2-s2/timeouts.test.mts` | 4 failed: `tests/e2e/support/timeouts.ts does not exist` | `red/wo2.log` |
| 3 | `ci-fail-01…03` | `corepack yarn jest tests/unit/harness/failureLine.test.ts` | suite failed to run: `Cannot find module '../../e2e/support/failureLine.ts'` | `red/wo3-unit.log` |
| 3 (regression, see F-R1) | six existing tests, `ci-fail-05` | `corepack yarn jest tests/unit/harness` | after the GREEN `91d6256`: 6 failed in `secrets.test.ts`, `uploadGate.test.ts`, `derivedCredentials.test.ts` (`test.titlePath is not a function`); `ci-fail-05` pins it, `ci-fail-04` passes as the positive control | `red/wo3-regression-jest.log`, `red/wo3-reporter-unit.log` |
| 5 (finding F-R2) | `press-01…03` | `corepack yarn jest tests/unit/harness/syncPress.test.ts` | suite failed to run: `Cannot find module '../../e2e/support/syncPress.ts'` (E2E evidence of the same defect: `verify/e2e-full-c-locale-run1-ac3-cancelled-press.log`, and the deterministic S-E below) | `red/wo5-press-unit.log` |

## Harness validation (2026-10-22, Pi arm64)
Temporary local edits, never committed (reverted after each; `git status` clean). Images reused (`$IMG`).

| Run | Edit / command | Expected | Observed | Log |
|---|---|---|---|---|
| **S-A** | the WO-1 RED commands after the fix | LOC-01 and LOC-02 pass under the C locale | **As expected**: 2 passed (97 s). The CI proof run repeats it on the runners' own locale | `green/wo1-loc-c.log` |
| **S-D** | the S-D RED command after the fix | M2-AC5 passes under the C locale | **As expected**: 1 passed (517 s) | `green/wo1-ac5-c.log` |
| **S-B** | `type-like-user.spec.ts`: append `await page.getByRole('button', { name: 'nst-never-there' }).click();` | fails in about 60 s naming the locator, with the `[notestead] FAILED C1-R1-guard …` line before the summary | **As expected**: `TimeoutError: locator.click: Timeout 60000ms exceeded.` after 63 s (not the 10-minute test timeout); the error block shows `waiting for getByRole('button', { name: 'nst-never-there' })`; the `[notestead] FAILED C1-R1-guard … attempt 1, 63 s: TimeoutError: locator.click: Timeout 60000ms exceeded.` line is line 4 of the log, the summary starts at line 8. See F-B3 | `sens/s-b.log` |
| **S-C** | `ciGlobalTimeoutMs = 10 * 60_000` and `globalTimeout: ciGlobalTimeoutMs` unconditionally; full suite | Playwright stops itself at 10 min, tests pending; globalTeardown still runs; `junit.xml` and `redaction-complete.json` exist; the `FAILED` lines name the interrupted tests; the gate reports `complete: true` and keeps `test-results/e2e/output` | **Partly as expected.** Stops itself: `Timed out waiting 600s for the test suite to run` (610 s; 9 passed, 7 did not run). `junit.xml` (16 tests, 7 skipped) and `redaction-complete.json` (`complete: true`) exist. The gate: `test-results/e2e: redaction complete`, `removed: []`, `output` kept (`filesRedacted: 0`, `artifactDirsRemoved: 1`, one raw `.playwright-artifacts` dir, which is the gate's normal rule). **Two expectations did not hold:** (1) globalTeardown did not run, see F-B1; (2) no `[notestead] FAILED` line names the interrupted test, see F-B2 | `sens/s-c.log`, `sens/s-c-gate.log`, `sens/s-c-upload-gate.json`, `sens/s-c-junit.xml` |
| **T-02 mutation** | `ciGlobalTimeoutMs = 42 * 60_000` | CI-T-02 fails | **As expected**: CI-T-02 failed, T-01, T-03 and T-04 passed | `sens/t02-mutation.log` |
| **S-E** (added, F-R2) | `flows.ts`: right after the first press in `syncWebOnce`, click the button's "Cancel" state (every first press is lost); `-g M2-AC3` | before the fix: fails like the local failure; after: passes | **Before the fix** (`2a906c9`): `Expected: "completed"`, `Received: "no delta request since the press"` at step 4 (437 s). **After** (`78d3c4d`): passes (426 s), each of the four cycles with a `sync-repress` annotation (2 presses) | `sens/s-e-red.log`, `sens/s-e-green.log`, `sens/s-e-green-junit.xml` |
| **S1c on the new `syncWebOnce`** (WO-8, M2-S2 WO-20's edit) | `notes.spec.ts` step 6: `await webApp.context.setOffline(true);` before `cycle('edit')`; `env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m2-s2/notes.spec.ts` | fails in `syncWebOnce` at the 3-minute poll, `Received` `"no delta request since the press"` or `"pressed again (press 3): …"`, after at most 3 presses | **As expected**: `Expected: "completed"`, `Received: "no delta request since the press"`, `Timeout 180000ms exceeded while waiting on the predicate`, at `tests/e2e/support/flows.ts:85` in `syncWebOnce` (step 6; 492 s). **Press count: 3**, from the trace: `Synchronise` clicked at 10:52:20.6, 10:52:43.0 and 10:53:05.9 (about 22 s apart: with the browser offline the app's sync retries for that long before the button is idle again), and no fourth click before the poll expired. A failed run records no `sync-repress` annotation (it is pushed only after a completed sync). So the barrier is still fail-closed after the re-press. `network.log`, `browser-console.log`, `trace`, `supervisor.log`, `server.log`, `web.log` attached; the `[notestead] FAILED M2-AC3 …` line printed at once. The edit was reverted (`git status` clean). Commit of WO-8 step 1 (the margin comment): `6381e72` | `sens/s1c-repress.log` |

## Results (QA executor, 2026-10-22, Pi arm64)
**CI proof: PENDING** (x64 and arm64 on the runners, after the orchestrator pushes the branch with the user's approval; §CI proof). Branch `test/M2-S2-ci-x64-arm64`, from `main` `961df09`; all commits by `qa-specialist`; `docs/test-plans/M2-S3.md` was never staged.

### Layers
| Layer | Command | Result | Duration | Log |
|---|---|---|---|---|
| Lint, tsc (3 configs) | `corepack yarn lint` | PASS (exit 0), after the last code commit `78d3c4d` | 64 s | `verify/lint.log` |
| Jest harness (unit + integration) | `corepack yarn jest tests/unit/harness tests/integration/harness` | PASS: 16 suites, **97 tests** (87 before + `ci-loc` 2 + `ci-fail` 5 + `press` 3) | 23 s | `verify/jest.log` |
| Acceptance, new | `node --test … tests/acceptance/ci-m2-s2/timeouts.test.mts` | PASS 4 of 4 | 2 s | `verify/acc-timeouts.log` |
| Acceptance, M1-AC22 workflow coverage | `node --test … tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` | PASS 13 of 13 | 1 s | `verify/acc-ac22-e2e-workflow.log` |
| Acceptance, serial rule | `node --test … tests/acceptance/m2-s1/serial-rule.test.mts` | PASS 4 of 4 | under 1 s | `verify/acc-serial-rule.log` |
| E2E, everything under `C.UTF-8`, run 1 | `env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test` | 15 passed, **1 failed**: `M2-AC3` at step 10 (F-R2) | 2172 s | `verify/e2e-full-c-locale-run1-ac3-cancelled-press.log`, `verify/e2e-full-c-locale-ac3-failure/`, `verify/e2e-full-c-locale-run1-junit.xml` |
| **E2E, everything under `C.UTF-8` (final)** | same command, after `78d3c4d` | **PASS 16 of 16**: the 14 of M2-S2 plus `CI-M2S2-LOC-01`, `-02`; no retry (`retries: 0` locally); no `[notestead] FAILED` line | 2025 s (33.7 min) | `verify/e2e-full-c-locale.log`, `verify/e2e-full-c-locale-junit.xml` |
| Contract regression (the reporter changed) | `env $IMG corepack yarn test:contract --verbose tests/contract/m1-s6 tests/contract/m1-s6a tests/contract/m1-s7` | PASS: 8 suites, 45 tests (`c1-pertest-secrets`, `c1r1-realflow-secrets`, `ac20-*` among them) | 1175 s | `verify/contract-regression.log` |

### Per item
| Item | Status | Evidence |
|---|---|---|
| **A** browser locale pin | **PASS on the Pi under the C locale** | `ci-loc-01…02` pass; `CI-M2S2-LOC-01…02` pass under `C.UTF-8` (S-A); M2-AC5 passes under `C.UTF-8` (S-D, and 406 s in the final full run). CI proof: PENDING |
| **B** bounded actions, specs and run | **PASS** (static and S-B); S-C partly (F-B1, F-B2) | `CI-T-01…04` pass; a stuck click fails in 63 s naming its locator (S-B); `playwright.config.ts` bounds are read from the real config by CI-T-01 |
| **C, D** failure visible at once | **PASS** | `ci-fail-01…05` pass; the line appears before the summary (S-B); reporters finish and the gate keeps the output after a global timeout (S-C) |
| **M2-AC3** | **PASS** in the final run (333 s); run 1 failed on the cancelled press (F-R2, fixed) | `verify/e2e-full-c-locale.log`; S-E |
| **M2-AC4**, **M2-AC5** | **PASS** (259 s, 406 s) | same |

### Full-run timings (final run, Pi, one worker)
The per-test durations from `verify/e2e-full-c-locale-junit.xml`; the limit of each M2-S2 spec is now 15 min (900 s).

| Test | Duration | Cycles (web ms + headless ms) |
|---|---|---|
| M2-AC3 | **333 s** | create 5250 + 34903, edit 12223 + 32152, move 4201 + 31381, delete 5086 + 29868 |
| M2-AC4 | 259 s | create 5562 + 34217, change 4615 + 30346 |
| M2-AC5 | **406 s** | create 6173 + 34243, done 4231 + 30485 |
| M2-S2-SEED-01 | 68 s | |
| M1-AC21, M1-AC21 NEG | 199 s, 236 s | |
| M2-AC2, M2-AC2 NEG | 188 s, 142 s | |
| M2-AC1, M2-AC1 NEG | 55 s, 38 s | |
| LOC-01, LOC-02, SPY-01…03, C1-R1-guard | 0.6 to 1.4 s each | |

The whole 16-test run took 2025 s (33.7 min) on one worker. The slowest M2-S2 test (M2-AC5) used 45% of its new 15-minute limit; run 1's failed M2-AC3 took 468 s.

### Findings (executor, for the planner)
- **F-R2 (harness race; fixed in `78d3c4d`): a press can cancel the app's own sync.** The first full run under `C.UTF-8` failed M2-AC3 at step 10 (the delete cycle) after `syncWebOnce` waited its 3 minutes: `Received: "no delta request since the press"`; the page showed an idle button and `Completed: … (885ms)`. From the console log and the trace (UTC): the delete was clicked at 01:24:30.058; the test's `Synchronise` click began at 31.757; the app started a sync **of its own** at 31.871 (about 1.8 s after the edit, F9); `Sync: cancelling` follows at 32.062 and `Synchronisation was cancelled.` at 32.760. The click was dispatched after the button had flipped to "Cancel", so it cancelled that sync, and nothing started another. The structure repeats after every quick edit followed at once by a cycle, so it is a flake, not a one-off. `syncWebOnce` now presses again (at most three presses) when the button is idle again, no delta request was seen since the last press and 3 s have passed (`syncPress.ts`, unit tests `press-01…03`); a re-press is recorded as a `sync-repress` annotation. Proof: S-E. **This is not finding B's 23-minute stall:** here the poll bounds the wait at 3 minutes and the test fails, so the stall in the arm64 run is still unexplained; with `actionTimeout` the next occurrence names its locator.
- **F-R1 (my regression; fixed in `86aeb98`).** The WO-3 GREEN made the reporter call `test.titlePath()` for every non-passing result, and three existing suites call `onTestEnd` with a partial `{}` test object, so six existing tests failed. I had only run `failureLine.test.ts` at that GREEN; the full Jest run in WO-5 found it. Process lesson: after a change to `redactingReporter.ts`, run the whole `tests/unit/harness tests/integration/harness` set at the GREEN, and the contract self-tests (done here). `ci-fail-04…05` now cover the reporter path.
- **F-B1 (plan expectation that does not hold): the global timeout also bounds `globalTeardown`.** In S-C, Playwright printed `Timed out waiting 600s for the test suite to run` and then `Timed out waiting 600s for the teardown for test suite to run`: one deadline covers setup, tests and teardown, so the teardown has no time left and the stack stayed up (four containers, mine; I removed them with `node tests/stack/cli.ts down <project>`, `sens/s-c-cleanup.log`). On a CI runner that is harmless (the VM goes away), and the reporters' `onEnd` and `onExit` did run (`junit.xml`, `redaction-complete.json` written, `complete: true`), which is what the margin is needed for. But the plan's reason for the margin ("covers `globalTeardown`'s stack removal", §Budget, `CI-T-02`) is not accurate: the margin covers the reporters and the gate. Locally the global timeout is off, so developers do not meet this.
- **F-B2: an interrupted test gets no `[notestead] FAILED` line.** The test in flight when the global timeout hit (M2-AC2) is marked skipped in `junit.xml`, but Playwright never calls `onTestEnd` for it, so the job log does not name it. A fix would track `onTestBegin` and print `[notestead] INTERRUPTED <title>` for tests without a result in `onEnd`; not done, since the order is fixed. Planner decision.
- **F-B3: the failure line does not name the locator.** It keeps only the first line of the error (`TimeoutError: locator.click: Timeout 60000ms exceeded.`); the locator is in the `Call log` below (`waiting for getByRole(…)`). In a run that finishes, the summary shows it (S-B); in a run killed before the summary, the line alone does not. The format is the plan's. Planner decision: add the first `waiting for` line to the failure line.
- **Contract teardown untags the device image.** As in M2-S1, the contract run left the device image untagged (dangling); I re-tagged it as `localhost/notestead-test-device:3.7.1` (entrypoint `node /fixture/device.mjs`, label `stack`, checked first).

### Test integrity
`git log --format='%h %an %s%n%b' 961df09..HEAD -- tests/ playwright.config.ts`: **10 commits**, all with the trailer `Agent: qa-specialist` (counted with `%(trailers:key=Agent)`); the engineer made none; `.github/**` was not touched (CC-1 is the ci-cd-specialist's). RED before GREEN, in order: `1976aa2`→`a7d8d0e` (locale), `f9af122`→`d88b36c` (bounds), `449673a`→`91d6256` (failure line), `49104f9`→`86aeb98` (the F-R1 fix), `2a906c9`→`78d3c4d` (the F-R2 fix). Two docs commits (`095627e`, and the plan `bf3832c` before this work). `docs/test-plans/M2-S3.md` is still untracked and untouched. No `.only`, `.skip`, `fixme`, `waitForTimeout` or `fill()`; the three Jest slips (a message passed to `expect`) were corrected in the GREEN commits.

### Podman
`podman-before.txt`: `byparr` (exited), `byparr_default`, the default `podman` network, no volumes, and the five pre-existing unlabelled images (`caddy`, `cloudflared`, `node` ×2 tags, `joplin/server:3.7.2`) plus `byparr`'s. `podman-after.txt`: containers, networks and volumes identical to before. **The test-labelled images are kept** until the sign-off:

| Image | Id | Label (`io.github.thescriptingguy.notestead.test`) | Size |
|---|---|---|---|
| `localhost/notestead-test-device:3.7.1` | `5d1a82bfa27a` | `stack` | 518 MB |
| `localhost/notestead-headless:stack-test` | `1ba8748a155a` | `stack` | 525 MB |
| `localhost/notestead-web:stack-test` | `f8dfe49b2c6b` | `contract` | 142 MB |
| `<none>:<none>` (headless build stage) | `827060fff071` | `stack` | 1.03 GB |

The S-C run left a stack of its own (project `nst-e2e-mvitf1wm1697d5`, started by that run); I removed exactly that project with `node tests/stack/cli.ts down`. No stack that I had not started was found at any point.

## Planner review and decisions (2026-10-22, after `c3dc4f0`)
Reviewed `bf3832c..c3dc4f0` (12 commits, all `qa-specialist`). Every RED commit precedes its GREEN commit:
- `1976aa2`→`a7d8d0e` locale;
- `f9af122`→`d88b36c` bounds;
- `449673a`→`91d6256` failure line;
- `49104f9`→`86aeb98` its partial-object fix;
- `2a906c9`→`78d3c4d` re-press.

The locale pin, the timeouts module and its static checks, the failure line (redacted before it is cut, and never able to break the reporter's redaction) and the guard spec all match the plan. Nothing is weakened.
- **F-B1: accepted.** The margin's reason above is corrected. The comment in `timeouts.ts` says the same wrong thing, and WO-8 fixes it. No change to the bounds.
- **F-B2: accepted, no change.** With the global timeout, the run ends cleanly, so the `list` epilogue, JUnit and HTML report name the interrupted test (S-C: `junit.xml` with 7 skipped). The immediate line only matters for a hard kill, which the global timeout now prevents.
- **F-B3: accepted. Routed to "Anytime, low priority":** the failure line could add the call log's first `waiting for …` line, to name the locator. The epilogue already does that whenever the run ends normally.
- **F-R2: the re-press is accepted. It does not weaken `syncWebOnce` as an ordering barrier (F9), and fixing it test-first instead of stopping was right in this case.**
  - **Why the barrier holds:** completion still needs a `delta` (200) after the **last** press, then an idle button and a report with `Completed:` and no `Last error:`. Every press comes after the caller's change, so the sync that completes still started after it.
  - **What may trigger a re-press:** only an idle button, no delta since the last press, and at least 3 s gone. So it can't fire during a running sync. It allows at most 3 presses in all, so a web app that never syncs still fails, at the 3-minute poll.
  - **Upstream behaviour:** the cancelled auto-sync is the residual race the M2-S2 design accepted (an auto-sync starting between the idle check and the click). It is upstream UI behaviour: the same button means `Cancel` while a sync runs.
  - **Why accepting was right:** S-E reproduces the race deterministically (unfixed fails, fixed passes). The fix is harness-only and test-first, every re-press leaves a `sync-repress` annotation, and the change touches no assertion.
  - **Process note:** WO-5 said to stop and report, and the executor should have reported before fixing. Accepted this time for the reasons above.
  - Because the change touched `syncWebOnce`'s failure path, **S1c must be re-run** (WO-8). The M2-S2 fail-closed proof has to hold for the new code.
  - **Not B's cause:** a cancelled press fails within 3 minutes and can't explain a 23-minute silence. B stays open until the CI proof run, which now has bounded actions and traces.
- **Device image untagged by the contract teardown (twice): a harness defect, F-H1. Routed to M2-S3's QA**, to be fixed before M2-S3's heavy runs. The contract layer builds `localhost/notestead-test-device:3.7.1` under the tag the E2E run kept, then removes "its" image at teardown, which leaves the kept one untagged. Either the contract layer reuses `NOTESTEAD_DEVICE_IMAGE`, or it never removes a tag it didn't create. Until then: pass `$IMG` to contract runs too, or re-tag after them.

### WO-8: S1c on the new `syncWebOnce`, and the margin comment (one `chore` commit plus a sensitivity log)
1. `tests/e2e/support/timeouts.ts`, the comment above `ciGlobalTimeoutMs`: replace "globalTeardown removes the stack and onEnd writes the reports in those minutes" with "the reporters' onEnd/onExit and the upload gate run in those minutes; the global deadline also bounds globalTeardown, so after a global timeout the stack stays up, which is harmless on a discarded CI runner (F-B1)". **Commit:** `chore(harness): the CI run margin covers the reporters and the gate, not teardown (CI-M2-S2 F-B1)`.
2. **S1c again:** the same temporary edit as M2-S2 WO-20, `webApp.context.setOffline(true)` before `cycle('edit')` in `notes.spec.ts`. Run `T=40m run test-results/verify/ci-m2-s2/sens/s1c-repress.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m2-s2/notes.spec.ts`, then `git checkout --` the file.
   - It must fail in `syncWebOnce` at the 3-minute poll, with `Received` either `"no delta request since the press"` or `"pressed again (press 3): …"`, after at most 3 presses.
   - Record the press count from the log or annotation in §Harness validation.
   - If it passes, stop and report: the barrier would then not be fail-closed.
3. Append the S1c row and the commit hash to this plan (`docs(test-plans)`).

## QA sign-off
**arm64 (Pi, local): YES**, on condition that WO-8's S1c fails as stated. It covers:
- **A:** the locale pin, `CI-M2S2-LOC-01/02`, and M2-AC5 under `C.UTF-8`;
- **B and D:** the bounds, `CI-T-01…04`, S-B and S-C;
- **C and D:** the immediate failure line;
- **F-R2:** the re-press, with S-E;
- the full local suite under the CI locale, 16/16 with no retry, plus lint, Jest 97/97, acceptance and the contract regression.

**CI proof: PENDING.** It needs the user's approval to push `test/M2-S2-ci-x64-arm64`, then the §CI proof criteria on both runners. Diagnosis B (the arm64 23-minute stall) and C (the M1-AC21 NEG flake) stay open until that run. CC-1 is decided from its arm64 wall time.

## CI proof run 1: e2e 39768694985 (head `1739167`), red. Planner diagnosis (2026-10-23)
**What it proved:**
- A is fixed: LOC-01/02 pass on both runners, and M2-AC5 gets past the date input in about 1 s.
- D is fixed: no step or run timeout; JUnit, the HTML report, the traces and `redaction-complete` are all present; the gate is OK.
- C did not recur: M1-AC21 NEG passed first time on both runners.
- No `sync-repress` annotation.

The two failures below are new findings. Facts are from the coordinator's summary of `~/joplin-web-app-work/ci-evidence/39768694985/`.

| # | Symptom | Root cause | Confidence |
|---|---|---|---|
| **E** | M2-AC3 fails on both runners and both attempts at step 9: `backToList`'s `Back` click goes "not stable", then "detached", and times out at 60 s | **The page object assumed upstream stays on the trashed note (M2-S2 F4). Upstream can also leave it on its own, about 35 ms after `Delete`.** <br>• **How:** the trash updates the note (`deleted_time`), and the shared reducer removes it from the folder's note list. `updateSelectedNotesFromExistingNotes` (`packages/lib/reducer.ts:601`) then empties `selectedNoteIds`; the console shows `EditorPluginHandler … effectiveNoteId: null`. With no selected note, the app shows the notebook's list, which has no `Back` button. <br>• **Timing-dependent:** in the green x64 run 39663284028 the `Back` click landed after 0.311 s, so the screen had stayed. Whether it leaves depends on the timing of that list update, so both outcomes are upstream behaviour. <br>• **Not ours:** the timeouts and the locale pin don't change navigation. The proof run only made the race consistent. | **Behaviour: high** (4 of 4 traces). **Exact trigger of each outcome: medium** |
| **B** (watch item) | the arm64 23-minute stall in run 39663284028 | **Very probably E:** the same gap (after the move cycle, before the delete-cycle restart), the same `Back` click, and at the time no action timeout, so it waited for ever. **Still to prove:** an arm64 run after WO-9 passes M2-AC3 and records its `trash-exit` annotation. Until then B stays open. | high (probable) |
| **F** | M2-AC5 attempt 1 on arm64: `syncHeadlessOnce` waits 600 s after a restart, although the supervisor logged `ready … last sync 11:43:35.817Z` 7 s in. The retry and x64 pass | **The readiness check also requires podman's health status to read `healthy`.** After `podman restart`, that status is reset and only updated when podman's health-check timer runs. Under rootless podman 4.9 (the runners' version) those timers are systemd transient units recreated on restart, and that recreation can fail without a word, leaving the status at `starting`. `start_period: 600s` keeps it from ever turning `unhealthy`, so `failFast` never fires either. Meanwhile the supervisor's own `/healthz` already said ready. The other half of the check, `lastSync` after the restart, compares the same kernel clock on both sides (the container shares the host's), so a clock skew is ruled out. **Which half stayed false is not in the artifacts:** that is the gap WO-10's diagnostics close. | **Mechanism: medium** (podman's lost health timer fits every fact; it isn't observed directly). **That the podman-status half is redundant: high:** the healthcheck command is a `GET /healthz` == 200, exactly what the check reads itself |

**Durations and CC-1.** The arm64 E2E step took 1645 s (27 min), 69% of the 40-minute run budget. That includes the 10 minutes lost to F and M2-AC3's two failed attempts. Restarts take up to 85.8 s on arm64 (W1: 90 s). Even a healthy run would sit near CC-1's 20-minute line, and M2-S3 adds the 100 MiB attachments. **CC-1 is triggered now** (WO-12, WO-13).

## Work orders, addendum 2 (WO-9 to WO-14)
The rules of §Work orders apply, and every "stop" is a **HARD STOP**:
- **Allowed at a HARD STOP:** read traces and logs; copy evidence under `test-results/verify/ci-m2-s2/`; write the finding, with its log paths, into this plan's §Findings; report to the orchestrator.
- **Forbidden at a HARD STOP:**
  - changing an assertion, a timeout, a bound or an upstream string;
  - changing page-object or harness logic beyond the order;
  - re-running to get a green;
  - any fix not ordered here.

### WO-9: Leave the trashed note however upstream does it (E) (RED commit)
- **RED:** `tests/unit/harness/trashExit.test.ts` holds `trash-01…05` for the pure `trashExit(s: { onList: boolean; onNote: boolean; backVisible: boolean; msSinceDelete: number }): 'left' | 'stayed' | undefined`:
  - `trash-01`: `{ onList: true, onNote: false }`, at any `msSinceDelete` (0 and 10 000), gives `'left'`;
  - `trash-02`: `{ onNote: true, backVisible: true, msSinceDelete: 3_000 }` gives `'stayed'`;
  - `trash-03`: the same at `2_999` gives `undefined`, because upstream may still leave;
  - `trash-04`: a screen in transition (`onList: false, onNote: false`) gives `undefined`;
  - `trash-05`: `{ onNote: true, backVisible: false, msSinceDelete: 10_000 }` gives `undefined`.

  Log `red/wo9-unit.log` (module missing). **Commit 1:** `test(harness): failing unit tests for leaving a trashed note either way upstream does it (CI-M2-S2 E)`.
- **GREEN:**
  - `tests/e2e/support/trashExit.ts`, no Playwright import, with a comment citing E: `export const stayedAfterMs = 3_000;` and `trashExit`.
  - `JoplinWebApp.trashOpenNote(note: NoteScreen): Promise<'left' | 'stayed'>` replaces the separate `deleteToTrash()` + `backToList()`:
    - `deletedAt = Date.now()`; `note.menuAction('Delete')`;
    - `outcome = await waitFor('the note screen to leave by itself, or to settle on the trashed note', probe, { timeoutMs: 30_000, intervalMs: 100 })`. The probe reads `onList` (`sidebarButton().isVisible()` and `note.titleField().count() === 0`), `onNote` (`note.titleField().isVisible()`) and `backVisible` (the `Back` button visible), then calls `trashExit`;
    - on `'stayed'`, call `backToList()`;
    - in either case, `await this.sidebarButton().waitFor()`;
    - return the outcome.
  - Delete `NoteScreen.deleteToTrash`, and correct the F4 comment to say upstream either stays or leaves (E).
  - `notes.spec.ts` step 9 becomes:
    ```ts
    const exit = await app.trashOpenNote(note);
    test.info().annotations.push({ type: 'trash-exit', description: exit === 'left' ? 'the app left the trashed note by itself' : 'the app stayed on the trashed note; Back pressed' });
    ```
    then `await expect(app.notesHeading(target), 'the list of the note\'s notebook').toBeVisible()`, then the existing count-0 poll. Every other assertion of steps 9 and 10 stays as it is.
  - **HARD STOP** if `trashOpenNote` times out in any run.
  - Log `green/wo9-unit.log`. **Commit 2:** `test(harness): leave a trashed note whether upstream stays on it or leaves by itself (CI-M2-S2 E, B)`.

### WO-10: Headless readiness from the supervisor's own `/healthz` (F) (RED commit)
- **RED:** `tests/unit/harness/restartReady.test.ts` holds `restart-01…06` for the pure `restartVerdict(o: { running: boolean; health: string; healthz?: { status: number; lastSync?: string }; startedMs: number }): 'done' | 'wait' | { fail: string }`. Here `t0 = Date.UTC(2026, 9, 23, 11, 43, 32)`.
  - `restart-01`: `running`, health `starting`, `healthz { 200, lastSync: t0 + 3.8 s }` gives `'done'`. This is F: today's check needs `healthy`, which is the RED.
  - `restart-02`: health `healthy`, `lastSync` equal to `t0` gives `'wait'`. It must be strictly after.
  - `restart-03`: health `healthy`, `healthz` undefined (the exec failed) gives `'wait'`.
  - `restart-04`: `running: false` gives `{ fail }`, and the message names `exited`.
  - `restart-05`: health `unhealthy` with `/healthz` not ready gives `{ fail }`.
  - `restart-06`: `healthz { 503 }` with a fresh `lastSync` gives `'wait'`.

  Log `red/wo10-unit.log` (module missing). **Commit 1:** `test(harness): failing unit tests for headless readiness after a restart that ignore a lagging podman health status (CI-M2-S2 F)`.
- **GREEN:**
  - `tests/stack/restartReady.ts`, no Playwright import, Jest-safe like `tests/stack/*`, with a comment citing F.
  - `syncHeadlessOnce`:
    - the probe calls `healthOf` and `headlessHealthz`, keeps the last observation, and maps `restartVerdict` to a `waitFor` result. `{ fail }` aborts through `failFast`;
    - the timeout message appends the last observation, value-free: `podman health <s>, /healthz <status> <state>, lastSync <iso or none>, restart at <iso>`;
    - it returns `{ lastSync, durationMs, healthAtReady }`.
  - `syncWebThenHeadless` passes `healthAtReady` through.
  - Each M2-S2 spec's `cycle` helper adds `{ type: 'health-lag', description: \`${label}: podman health ${healthAtReady} while /healthz was ready\` }` when `healthAtReady !== 'healthy'`. This confirms F's mechanism on CI.
  - Log `green/wo10-unit.log`. **Commit 2:** `test(harness): a headless restart is ready when the supervisor's /healthz is ready with a fresh sync, whatever podman's health status says (CI-M2-S2 F)`.
- **Sensitivity S-F**, a temporary edit that is never committed:
  - make `syncHeadlessOnce`'s probe pass `health: 'starting'` to `restartVerdict` always, mimicking the lost timer;
  - `T=30m run sens/s-f.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m1-s7/walking-skeleton.spec.ts -g "M1-AC21 a note"`;
  - it must **pass in normal time** (about 200 s on the Pi), so the check can't miss a ready service;
  - then `git checkout --`.
  - The opposite case (a stale `lastSync` must never count) is `restart-02`.
  - **HARD STOP** if S-F fails.

### WO-11: Full local run under the CI locale (no commit)
1. `corepack yarn lint`
2. The Jest harness (`trash-*` and `restart-*` included)
3. The three acceptance files
4. `T=120m run verify/e2e-full-c-locale-2.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test` in the background. All 16 tests must pass with no retry.
5. List every `trash-exit`, `health-lag`, `sync-repress` and `cycle` annotation from the JSON or HTML report.

**HARD STOP** on any failure.

### WO-12 (ci-cd-specialist): CC-1, the E2E step to 60 minutes
`.github/workflows/e2e.yml`, step `id: e2e`: `timeout-minutes: 45` becomes `60`, with a comment citing CC-1 and this run (arm64 1645 s). Nothing else changes: no workers change, no artifact change. Run `corepack yarn check:workflows`, and `node --test tests/acceptance/ci-m2-s2/timeouts.test.mts` (CI-T-02 still holds with 40 min). **Commit:** `ci(e2e): allow the E2E step 60 minutes (CC-1, CI-M2-S2)`. It goes on this branch **before** WO-13.

### WO-13 (QA executor, after WO-12): the CI run budget to 55 minutes
- `tests/e2e/support/timeouts.ts`: `ciGlobalTimeoutMs = 55 * 60_000`, with the comment updated (WO-12, CC-1).
- `CI-T-01…04` must pass: 55 ≤ 60 − 4, and 2 × 15 < 55.
- **Commit:** `test(harness): the CI run ends itself at 55 minutes, inside the 60-minute step (CC-1)`.

### WO-14: Strategy and plan (`docs(testing)`, `docs(test-plans)`)
- **Strategy §5:** "Readiness after a restart is read from the supervisor's own `/healthz` with a fresh `lastSync`; podman's health status is used only to fail fast (it can lag after `podman restart`, CI-M2-S2 F)."
- **Strategy §5:** "Where upstream may do either of two things (for example stay on a trashed note or leave it), the page object accepts both, with a bound, and the test records which one happened as an annotation."
- **This plan:** append `## RED`, `## Harness validation` (S-F) and `## Results` for WO-9 to WO-13, with podman before and after. Leave the CI proof as PENDING.

Two commits:
- `docs(testing): readiness from /healthz and two-outcome upstream steps (CI-M2-S2 E, F)`;
- `docs(test-plans): CI-M2-S2 addendum 2 RED, validation and results`.

### CI proof run 2
The same criteria as §CI proof, plus:
- M2-AC3 passes on arm64, which closes B, with a `trash-exit` annotation on each runner;
- M2-AC5 passes on both runners with no retry;
- every `health-lag` annotation is listed. A count above 0 confirms F's mechanism, and the planner then decides whether to report it to the ci-cd-specialist as a runner podman issue;
- the arm64 E2E wall time is recorded against the new 55-minute budget.

**C** (the M1-AC21 NEG flake) closes if it doesn't recur in this run and the next `main` run.

## RED (addendum 2, WO-9 to WO-11; 2026-10-23, Pi arm64)
Logs under `test-results/verify/ci-m2-s2/`; the C locale is `LANG=C.UTF-8 LC_ALL=C.UTF-8`.

| WO | Test | RED outcome | Log |
|---|---|---|---|
| 9 | `trash-01…05` | `Cannot find module '../../e2e/support/trashExit.ts'` (commit `252103c`) | `red/wo9-unit.log` |
| 10 | `restart-01…06` | `Cannot find module '../../stack/restartReady.ts'` (commit `2c1064f`); `restart-01` is F | `red/wo10-unit.log` |

## Harness validation (addendum 2)
| Run | Edit | Expected | Observed | Log |
|---|---|---|---|---|
| **S-F** | `syncHeadlessOnce` passes `health: 'starting'` to `restartVerdict` always (the lost health timer); `-g "M1-AC21 a note"` under the C locale | passes in normal time | **As expected**: passed (294 s including the stack start). Reverted. The stale-sync case is `restart-02` | `sens/s-f.log` |

## Results (addendum 2, WO-9 to WO-13; 2026-10-23, Pi arm64)
**CI proof: PENDING** (run 2 after the planner and the user approve the push). No sign-off line: the planner writes it.

| Item | Commit(s) | Result |
|---|---|---|
| WO-9 `trashOpenNote` (E) | RED `252103c`, GREEN `e393033` | `trash-01…05` pass (`green/wo9-unit.log`); M2-AC3 passes in the full run |
| WO-10 `/healthz` readiness (F) | RED `2c1064f`, GREEN `f536a69` | `restart-01…06` pass (`green/wo10-unit.log`); S-F passes |
| WO-11 full run under `C.UTF-8` | none | **16 of 16**, no retry, 2031 s (33.8 min), `verify2/e2e-full-c-locale-2.log`, `verify2/e2e-full-c-locale-2-junit.xml`; lint clean; Jest 18 suites, 108 tests; acceptance 4/4, 13/13, 4/4 |
| WO-13 CI run budget | `919f607` | `ciGlobalTimeoutMs` 55 min; CI-T-01…04 pass (55 <= 60 - 4; 2 x 15 < 55) against the 60-minute step of `607942c` |
| WO-14 strategy | `bde2dae` | readiness from `/healthz`, two-outcome upstream steps, 55-minute budget |

Light checks after WO-13 and WO-14 (no E2E re-run): `verify3/lint.log`, `verify3/jest.log`, `verify3/acc-*.log`.

### Full-run timings and annotations (WO-11 run)
| Test | Duration | Annotations |
|---|---|---|
| M2-AC3 | 334 s | cycles create 5261 + 33922, edit 13372 + 31452, move 4102 + 31206, delete 4518 + 30575 ms; **`trash-exit`: the app left the trashed note by itself**; `health-lag` on all four cycles |
| M2-AC4 | 262 s | create 4769 + 36491, change 4408 + 30311; `health-lag` on both |
| M2-AC5 | 413 s | create 5440 + 35529, done 4225 + 30285; `health-lag` on both |
| M1-AC21, NEG | 200 s, 226 s | |
| M2-AC2, NEG | 189 s, 141 s | |
| M2-AC1, NEG | 58 s, 39 s | |
| SEED-01, LOC-01/02, SPY-01…03, C1-R1-guard | 67 s; 0.6 to 1.1 s | |

- `health-lag` appeared on **all 8** headless cycles, each `podman health starting while /healthz was ready`: F's mechanism (podman's health status lagging after `podman restart`) also occurs on the Pi, so the old check would have waited for a status that /healthz had already beaten.
- `trash-exit` was `left` on the Pi too, so the `stayed` branch was exercised only by the unit tests.
- No `sync-repress` annotation.

### Podman
Before and after (`podman ps -a`, networks, volumes): only `byparr`, `byparr_default`, the default network, no volumes. Kept test-labelled images: `localhost/notestead-test-device:3.7.1` (`5d1a82bfa27a`), `localhost/notestead-headless:stack-test` (`1ba8748a155a`), `localhost/notestead-web:stack-test` (`f8dfe49b2c6b`, label `contract`), and the dangling headless build stage (`827060fff071`).


## Planner review of addendum 2 and QA sign-off (2026-10-23)
- **Reviewed:**
  - WO-9 `252103c`→`e393033`;
  - WO-10 `2c1064f`→`f536a69`;
  - WO-12 `607942c` (ci-cd), with its worklog `12d8272`;
  - WO-13 `919f607`;
  - WO-14 `bde2dae` and `a53d8ea`.

  They match the orders, every RED comes before its GREEN, and nothing is weakened.
  - `trashOpenNote` accepts both upstream outcomes within a bound.
  - Step 9 gained the target-notebook heading check; steps 9 and 10 are otherwise unchanged.
  - `restartVerdict` still requires `/healthz` 200 with a `lastSync` strictly after the restart, and still fails fast on exited or unhealthy.
  - The step and run timeouts are now 60 and 55 minutes, and CI-T holds.
- **Correction to finding F (planner):** `health-lag` fired on **all 8** headless cycles on the Pi. The annotation therefore does not single out a lost podman health timer.
  - Podman's status normally trails `/healthz`, because its check runs every 2 s and our probe runs every 1 s.
  - So the fix stands: podman's status was never a sound readiness signal after a restart. But **F's specific mechanism (a lost timer) is still unproven**, and the `restartReady.ts` comment states it as fact. That is a nit, fixed at the next touch.
  - Run 2's `health-lag` count is therefore expected to be above 0 and **proves nothing by itself**. Only a recurrence of F's 600 s timeout, with WO-10's diagnostics, would.
- **Coverage note:** only the `left` outcome of `trashOpenNote` has run end to end. The Pi left the trashed note by itself too. The `stayed` branch is covered by `trash-02/03/05` only.

**QA sign-off on arm64 (Pi): YES** for E, F, CC-1 (QA part) and the full local suite under `C.UTF-8` (16 of 16, no retry, 2031 s), plus S-F. **CI proof run 2: PENDING.** It must show, on **both** runners:
- E2E green, with flaky 0 and every result `retry: 0`;
- `CI-M2S2-LOC-01/02` passing;
- M2-AC3 passing, which **closes B** on arm64, with a `trash-exit` annotation on each runner;
- M2-AC5 passing with no retry, and no 600 s headless wait anywhere. If one occurs, it is analysed from WO-10's timeout diagnostics as F's real cause;
- JUnit, the HTML report, traces and `redaction-complete` present, and the upload gate OK;
- the arm64 E2E wall time, recorded against the 55-minute budget.

C closes if M1-AC21 NEG passes first time in run 2 and in the next `main` run.

## CI proof run 2: e2e 39957733152 (head `4344f69`). Planner decision (2026-10-23)
### Run 2 E2E against the must-show list (both runners; ci-cd evidence `~/joplin-web-app-work/ci-evidence/39957733152/`)
| Must show | Result |
|---|---|
| E2E green, flaky 0, every `retry: 0` | **MET.** 16 of 16 on each runner, 0 flaky, every retry 0, 0 `[notestead] FAILED` lines |
| `CI-M2S2-LOC-01/02` pass | **MET** |
| M2-AC3 passes, with `trash-exit` on each runner (closes B on arm64) | **MET.** First try on both runners; `trash-exit`: "the app left the trashed note by itself"; arm64 104.3 s |
| M2-AC5 passes with no retry and no 600 s headless wait | **MET.** arm64 284.8 s, x64 300.4 s |
| JUnit, HTML report, traces, `redaction-complete`, upload gate OK | **MET, with a note.** `redaction-complete` and the gate are `complete: true`, and the leak scan has 0 hits. **There are no E2E traces on either runner, which is by design:** the `webApp` fixture keeps a trace only for a failed test (M1-S7 F2), and every test passed. Nothing is missing |
| arm64 E2E wall time against the 55-minute budget | **MET.** 671 s (11.2 min, 20% of 55); x64 835 s |
| `health-lag` count (informational) | 13 (arm64 6, x64 7). As addendum 2 predicted, this is no evidence by itself |

**The E2E layer is proven on both runners.** C: M1-AC21 NEG passed first time; it closes after the next `main` run.

### G: the arm64 contract step fails (`tests/contract/m1-s6a/c1-pertest-secrets.test.ts`, 9 of 11)
- **(a) Same class as F? The readiness path: yes, confirmed by reading the code. The cause: not yet shown.**
  - `upHeadless` → `composeUp` (`tests/stack/stack.ts:162-202`) waits for `compose up` to exit 0 **and** for podman's health status to read `healthy` (line 182). WO-10 changed only `syncHeadlessOnce`. So a first start of a per-test headless service (the `headlessService` fixture, and therefore the inner self-test run) still waits on podman's status, which can stay `starting` (`start_period: 600s` means it never turns `unhealthy`).
  - `upHeadless`'s default `timeoutMs` is 10 min, equal to the test timeout. So the inner test was killed while the fixture was still being set up (`Test timeout of 600000ms exceeded while setting up "headlessService"`), and no diagnostic or log was written. The cascade (c1-planted false, c1-redacted-* empty) follows from that one inner timeout.
  - **A second candidate is just as possible:** the supervisor itself was not ready for 10 min. The default headless logged `initial cycle failed … HTTP 502` three times (the supervisor retries every 30 s), and `web` logged 11 `dial tcp: lookup server: i/o timeout` lines (3 to 43 in passing runs). So the sync target was intermittently unreachable through `web`'s resolver.
  - Without the per-test headless log, the two can't be told apart. Round 3 makes the next occurrence decide it.
- **Watch item B:** the M2-AC3 stall is closed by run 2's arm64 E2E. Per lead r2 item 6, any timeout keeps the watch open, so **B's watch stays open until G is diagnosed.** G is recorded as its own finding.
- **(b) Decision: a round-3 fix-forward, then proof run 3.** A plain re-run would turn green or red without telling us why.
  - **The `/healthz` part removes the podman-lag cause.** Readiness means the supervisor's own `/healthz` returns 200 after its initial cycle. It is the signal podman's health check reads anyway.
  - **The bound and the logs explain any remaining cause.** This covers the 502 / DNS one.
  - **No SE or ci-cd change is needed for round 3.** If proof run 3 shows `web`'s resolver failing to find `server` as the cause, that is a `deploy/web` (SE) or runner podman/aardvark-dns (ci-cd) finding, decided then.

### Work orders, round 3 (WO-15 to WO-19; executor)
The rules of §Work orders and the HARD STOP definition of addendum 2 apply unchanged. Logs go under `test-results/verify/ci-m2-s2/r3/`.

**WO-15: Readiness of a fresh headless service from `/healthz` (RED commit).**
- **RED:** `tests/unit/harness/restartReady.test.ts`, add `start-01…04` for a new pure `startVerdict(o: { composeExit?: number | null; running: boolean; health: string; healthz?: { status: number } }): 'done' | 'wait' | { fail: string }`:
  - `start-01`: compose exit 0, running, health `starting`, healthz 200 gives `'done'` (the RED; today's check needs `healthy`);
  - `start-02`: health `healthy`, healthz undefined gives `'wait'`;
  - `start-03`: a compose exit other than 0 gives `{ fail }` naming the exit code;
  - `start-04`: `running: false`, or health `unhealthy` with healthz not 200, gives `{ fail }`.

  **Commit 1:** `test(harness): failing unit tests for a fresh headless service ready on /healthz (CI-M2-S2 G)`.
- **GREEN:**
  - `startVerdict` goes in `tests/stack/restartReady.ts`.
  - `upHeadless` stops relying on `composeUp`'s podman-health wait for the `headless` service, by either of:
    - a `ready` option on `composeUp`: `(containers) => Promise<'done' | 'wait' | { fail }>`, defaulting to today's health rule, so the core `server` and `web` keep theirs;
    - or by polling `startVerdict` with `headlessHealthz(container)` after `compose up` has exited 0.

    Whichever is used, the core services' readiness stays exactly as it is.
  - **Commit 2:** `test(harness): a per-test headless service is ready when its /healthz is, whatever podman's health status says (CI-M2-S2 G)`.

**WO-16: The fixture's bound sits strictly below the test's (RED commit).**
- **RED:** add `CI-T-05` to `tests/acceptance/ci-m2-s2/timeouts.test.mts`. It requires:
  - `tests/e2e/support/timeouts.ts` to export `headlessUpTimeoutMs`;
  - `headlessUpTimeoutMs ≤ playwright.config.ts`'s test timeout (read it, 10 min) − 2 min;
  - `fixtures.ts`'s `headlessService` to pass it to `upHeadless`.

  **Commit 1:** `test(harness): failing check that the headless fixture's bound is below the test timeout (CI-M2-S2 G)`.
- **GREEN:** `headlessUpTimeoutMs = 7 * 60_000` (a fresh headless service is ready in under 1.5 min on every runner; 7 min also covers about ten of the supervisor's 30 s retries). The fixture passes it to `upHeadless`. **Commit 2:** `test(harness): the headless fixture gives up at 7 minutes, three before the test does, so its failure is reported (CI-M2-S2 G)`.

**WO-17: Logs of a per-test headless service that failed to start (one commit).**
- In the `headlessService` fixture, when `upHeadless` throws:
  - the container may already exist, so look it up with `projectContainers(project)` (the project is `${stack.project}-hl-${label}`);
  - attach `supervisor.log` (`containerLog`, redacted with `workerSecrets`) and `compose-up.log` (the redacted `compose up` output, which `composeUp` must put on the error it throws: add `output` to `StackHealthError` or to a new error type);
  - attach `readiness.log`: the last observation, value-free (podman health, `/healthz` status and state, `lastSync`, the elapsed time);
  - then rethrow.
- Also write the same files into `stack.logsDir`, so the contract layer's artifact holds them even when the inner run's attachments aren't kept.
- **Commit:** `test(harness): attach the logs of a per-test headless service that did not start (CI-M2-S2 G)`.

**WO-18: Sensitivity and local proof (no commit).**
- **S-G1 (readiness):**
  - the temporary edit: in `upHeadless`'s readiness, force `health: 'starting'`;
  - `T=40m run r3/s-g1.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test tests/e2e/m1-s7/walking-skeleton.spec.ts -g "M1-AC21 a note"`;
  - it must pass in normal time; then `git checkout --`.
- **S-G2 (bound and logs):**
  - the temporary edit: in `compose.headless.yaml`, point the headless service at an unreachable sync target, for example its URL env with a wrong port, so the supervisor never becomes ready;
  - run the same command into `r3/s-g2.log`;
  - it must fail at about 7 min **in the fixture**, with a message naming `/healthz` not ready, and attach `supervisor.log` (holding the `initial cycle failed` lines), `compose-up.log` and `readiness.log`. They must also be in the stack's logs dir;
  - then `git checkout --`.
- **Contract regression:** `T=60m run r3/contract-m1-s6a.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn test:contract --verbose tests/contract/m1-s6a` must pass (c1-pertest-secrets 11 of 11).
- **Full E2E:** `T=120m run r3/e2e-full.log env LANG=C.UTF-8 LC_ALL=C.UTF-8 $IMG corepack yarn playwright test` must pass 16 of 16 with no retry.
- Then lint and the Jest harness.
- **HARD STOP** on any failure that the sensitivity edit didn't cause.

**WO-19: Plan results (`docs(test-plans)`).** Append RED, validation (S-G1, S-G2) and results to this plan, with podman before and after. Leave proof run 3 as PENDING. **Commit:** `docs(test-plans): CI-M2-S2 round 3 RED, validation and results`.

### Proof run 3 must show
- **E2E:** everything run 2 showed, again.
- **Contract:** the arm64 and x64 contract steps green, with `c1-pertest-secrets` 11 of 11.
- **If G recurs:** it must now fail at 7 min in the fixture, with `supervisor.log`, `compose-up.log` and `readiness.log` in the artifact. The planner then decides between podman lag (excluded by WO-15), the supervisor's 502 retries, and `web`'s resolver (`lookup server: i/o timeout`) as G's cause.
- **B's watch** closes when G is either absent or explained.

## RED (round 3, WO-15 and WO-16; 2026-10-23, Pi arm64)
Logs under `test-results/verify/ci-m2-s2/r3/`; the C locale is `LANG=C.UTF-8 LC_ALL=C.UTF-8`.

| WO | Test | RED outcome | Log |
|---|---|---|---|
| 15 | `start-01…04` | 4 failed, 6 passed: `startVerdict is not a function` (commit `fa7fa50`) | `red/wo15-unit.log` |
| 16 | `CI-T-05` | CI-T-01…04 pass, CI-T-05 fails: `tests/e2e/support/timeouts.ts exports headlessUpTimeoutMs` (commit `e9a8ab4`) | `red/wo16-acc.log` |

## Harness validation (round 3)
| Run | Edit (temporary, reverted) | Expected | Observed | Log |
|---|---|---|---|---|
| **S-G1** | `headlessReady` passes `health: 'starting'` to `startVerdict` always | `-g "M1-AC21 a note"` passes in normal time | **As expected**: passed, 307 s including the stack start | `r3/s-g1.log` |
| **S-G2** | `compose.headless.yaml` takes the sync port from `NST_SYNC_PORT` (default 8089); `upHeadless` passes `8088` for every label but `default` (the default service must start, so the edit spares it) | fails at about 7 min in the fixture, naming `/healthz`, with the three logs attached and in the stack's logs dir | **As expected**: failed after 447 s in `headlessService` (`upHeadless`, `stack.ts`): `stack services not healthy within 420 s: … is starting; … last observation: compose exit 0, podman health starting, /healthz 503 starting, lastSync none`. Attached: `supervisor.log` (14 `initial cycle failed: the sync target did not answer /api/ping before the sync (ECONNREFUSED); retrying in 30 s` lines), `compose-up.log`, `readiness.log` (`elapsed 421 s`). The same three are in `test-results/e2e/stack/<project>-hl-<id>-*.log`. Copies: `r3/sg2-evidence/` | `r3/s-g2.log` |

## Results (round 3, WO-15 to WO-18; 2026-10-23, Pi arm64)
**CI proof run 3: PENDING.** No sign-off line: the planner writes it.

| Item | Commit(s) | Result |
|---|---|---|
| WO-15 fresh start from `/healthz` (G) | RED `fa7fa50`, GREEN `99e4cc4`, lint nesting fix `7777acc` | `start-01…04` pass (`green/wo15-unit.log`); `composeUp` has an optional `ready`; the core services keep the default rule; S-G1 passes |
| WO-16 fixture bound | RED `e9a8ab4`, GREEN `c229df3` | `CI-T-05` passes, with CI-T-01…04 (5 of 5, `green/wo16-acc.log`, `acc-timeouts.log`); `headlessUpTimeoutMs` = 7 min |
| WO-17 logs of a failed start | `5249aa0` | `StackHealthError` carries `output` and `readiness`; the fixture attaches and writes `supervisor.log`, `compose-up.log`, `readiness.log`, then removes the half-started project; proven by S-G2 |
| WO-18 contract regression | none | `tests/contract/m1-s6a`: 2 suites, 16 of 16, `c1-pertest-secrets` 11 of 11, 339 s (`r3/contract-m1-s6a.log`) |
| WO-18 full E2E under `C.UTF-8` | none | **16 of 16**, no retry, no flaky, 2095 s (34.9 min), `r3/e2e-full.log`, `r3/e2e-full-junit.xml`; lint clean; Jest 18 suites, 112 tests |

Annotations of the full run: `cycle` on all 8 headless cycles (web 3.3 to 11.3 s, headless 30 to 37 s); `health-lag` on 6 of them; `trash-exit`: the app left the trashed note by itself; no `sync-repress`.

### Findings (executor, for the planner)
- **Contract run untags the shared device image.** `tests/contract/support/globalTeardown.ts` removes the lazy images with `rmi -f`, and `tests/contract/support/headless.ts:143` uses the same tag as the E2E stack (`localhost/notestead-test-device:3.7.1`). After the WO-18 contract run the tag was gone (image `5d1a82bfa27a` kept, untagged), and the first full E2E aborted in globalSetup (`r3/e2e-full-aborted-device-untagged.log`, exit 125, a registry pull of `localhost/...`). I re-tagged `5d1a82bfa27a` and re-ran: green. Order for later runs: run the contract layer before restoring the tag, or give the contract layer its own device tag (a QA change, not made here).
- S-G2's message names the sick service by podman health; `/healthz 503 starting` sits in the `last observation` part and in `readiness.log`.

### Podman
Before and after (`r3/podman-before.txt`, `r3/podman-after.txt`): only `byparr`, `byparr_default`, the default network, no volumes, no stack containers. Kept test-labelled images: `localhost/notestead-test-device:3.7.1` (`5d1a82bfa27a`), `localhost/notestead-headless:stack-test` (`1ba8748a155a`), `localhost/notestead-web:stack-test` (`f8dfe49b2c6b`), plus the untagged build stages.
