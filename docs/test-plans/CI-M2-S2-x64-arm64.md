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
- **Decision:** keep the 45-minute step for this fix, with `globalTimeout` 40 min. `CI-T-02` locks the 5-minute margin, which covers `globalTeardown`'s stack removal and the reporters' `onEnd`.
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
