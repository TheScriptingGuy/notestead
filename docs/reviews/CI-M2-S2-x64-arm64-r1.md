# Review: CI-M2-S2-x64-arm64, fix-forward for e2e run 39663284028 (branch `test/M2-S2-ci-x64-arm64`), round 1

Verdict: APPROVE

**Summary.**
- This is a test-harness-only fix-forward: 16 commits (`bf3832c..d9bf8c3`, cut from `main` `961df09`, which has not moved), all with `Agent: qa-specialist`. No product file, ADR, `.github/**`, `package.json` or `yarn.lock` is touched. The change is a Chromium locale pin (A), bounds on actions, navigations, specs and the CI run (B, D), an immediate redacted failure line (C, D), and a bounded re-press in `syncWebOnce` (F-R2).
- I agree with the diagnosis and the fixes for A, D and F-R2, and with the bounds in B. The locale pin is correct: the browser process gets `LC_ALL`, `LANG` and `LANGUAGE` for en-GB from a copy of the environment, the parent environment is untouched, and the guard spec LOC-01/LOC-02 will test it on the runners' own locale. The failure line did not leak in any probe I tried. The re-press does not weaken the ordering barrier.
- B (the arm64 23-minute stall) and C (the M1-AC21 NEG flake) are not explained, and the plan says so. This branch bounds B and makes B and C diagnosable. It does not close them. The section "CI proof" says what the branch run must show, and why one green run closes neither.
- No blocker and no major finding. One minor code finding (the failure line says almost nothing for matcher failures), one minor docs finding (strategy §5 still says "presses once"), one minor finding on the plan's wording about B, and one minor process finding (the executor changed a shared helper instead of stopping). The rest are nits. None blocks the push to the branch or the later merge.
- I re-ran lint, the Jest harness and the three acceptance files, evaluated the real config under both settings of `CI`, and probed the reporter for leaks. I did not run the E2E or contract suites (instructed); the QA logs are the evidence, and I read them.

## Code findings

**C1, minor. `tests/e2e/support/failureLine.ts:26-30` (first non-blank line of the error) and `tests/e2e/support/redactingReporter.ts:222-230`.**
- *Problem:* the line identifies the failing test but, for the commonest failure in these specs, says nothing about what failed. Every real line in the QA logs is `Error: expect(received).toBe(expected) // Object.is equality`. See `sens/s-e-red.log:4`, `sens/s1c-repress.log:4` and `verify/e2e-full-c-locale-run1-ac3-cancelled-press.log`. The values (`Expected: "completed"`, `Received: "no delta request since the press"`) are on later lines, and so is the locator of a timeout (`waiting for getByRole(...)`). The same holds for `expect(locator).toHaveValue`. Only a thrown `Error` or a `TimeoutError` puts its cause on the first line (S-B shows `locator.click: Timeout 60000ms exceeded.`, still without the locator).
- *Scenario:* the job is lost before the `list` epilogue (runner failure, OOM, or a kill that Playwright's own global timeout does not cover). The log then holds "M2-AC3 failed at 386 s" and nothing else. That is the situation Decisions C and D were written for. With the global timeout in place, a normal run ends with the epilogue, the JUnit file and the HTML report, so the impact is small.
- *Fix (QA):* when the first line is a matcher header (`/^Error: expect\(/`) or a Playwright timeout, append the first `Expected:`, `Received:` or `waiting for` line. Redact first and cut afterwards, as now. The `list` epilogue prints the same text after the same redaction, so this adds no new class of exposure. This extends the planner's F-B3, which only asked for the `waiting for` line.
- *Where:* QA, "Anytime", before the next arm64 diagnosis. Not a blocker.

**C2, minor. `docs/testing/strategy.md:82` (§5, "One web sync, one headless sync").**
- *Problem:* the sentence says `syncWebOnce` "presses `Synchronise` once". Since `78d3c4d` it presses up to three times. The strategy was edited in this branch (`095627e`), but before the F-R2 change, and was not updated afterwards.
- *Scenario:* a reader or the M2-S3 executor takes "once" as the rule and writes a flow that asserts or assumes one press. Or a later change tightens the helper back to one press and loses the fix, with no document to say why it was there.
- *Fix (QA):* name the rule. For example: "presses `Synchronise`; presses again, at most twice more, only when the button is idle again, no delta (200) was seen since the last press and 3 s have passed (the press cancelled the app's own sync, CI-M2-S2 F-R2); each re-press is a `sync-repress` annotation; completion still needs a delta after the last press".
- *Where:* QA, one `docs(testing)` commit on this branch before the push (docs-only, no re-run). If it is missed, the next touch of the strategy.

**C3, minor. `docs/test-plans/CI-M2-S2-x64-arm64.md:259` and `:300` (F-R2 "is not B's cause").**
- *Problem:* the plan rules F-R2 out as the trigger of B because "a cancelled press fails within 3 minutes and can't explain a 23-minute silence". That is true of the poll, but it does not rule out F-R2 as the trigger.
  - The arm64 stall sits exactly where F-R2 fails locally. The headless log is silent after the `move` cycle was ready (20:04:04Z) and before the `delete` cycle's restart. F-R2's local failure is the `delete` cycle's `syncWebOnce` in step 10, right after a quick edit.
  - The `syncWebOnce` poll would fail at 3 minutes and the test would move to fixture teardown. A hang in the failure path (trace stop, attach, container logs) up to the 25-minute test timeout gives the same picture as an unbounded click: the attempt lasted exactly 25.0 m, and the headless log is silent in both cases.
  - The evidence cannot tell the two apart.
- *Scenario:* the proof run is green and someone closes B with "unbounded action, fixed". If the cause was a failure-path hang after F-R2, the 60-second action bound did nothing for it. The 15-minute test timeout and the 40-minute global timeout are then its only bounds, and the same hang could repeat.
- *Fix (planner):* reword both lines to say that F-R2 is a candidate trigger and that the 23-minute tail is unexplained. Apply the closure rule in "CI proof" below. The instrumentation already tells the cases apart on the next occurrence: a stuck action fails at 60 s naming its locator; a stuck teardown ends with Playwright's `Test timeout of 900000ms exceeded while tearing down "<fixture>"`.
- *Where:* QA planner, one docs line, before or after the push. Not a blocker.

**C4, nit. Small items in the new static check and the reporter.**
- `tests/acceptance/ci-m2-s2/timeouts.test.mts:104`: the CI-T-02 message still says the 4-minute margin covers "globalTeardown's stack removal". F-B1 and WO-8 corrected the same reason in `timeouts.ts`, but not here. Say "the reporters' onEnd/onExit and the upload gate".
- `timeouts.test.mts:77-78`: CI-T-03 finds `describe.configure({ timeout })` and `.setTimeout(...)`, not a per-test option such as `test('...', { timeout: 30 * 60_000 }, ...)`. A spec could exceed `longSpecTimeoutMs` that way. The check does fail closed on an expression it cannot evaluate, which is good; it just needs a third pattern.
- `redactingReporter.ts:261`: `printsToStdio()` still returns `false` although the reporter now writes failure lines to stdout. Harmless while `list` is configured; set it to `true` for honesty.
- *Where:* QA, next touch of these files.

**C5, nit. `tests/e2e/support/flows.ts:76-104` (the re-press wiring has no committed test).**
- Only the pure decision `pressAgain` is unit-tested (`press-01…03`). The wiring is covered by S-E and S1c, which are temporary edits and not committed. That is the same position as the M2-S2 `syncWebOnce` completion rule (M2-S2 r1 P2).
- A concrete wiring risk: if `pressedAt` were not reset at a re-press, `msSincePress` would stay large and the loop would press three times in three seconds, cancelling the sync each time and turning a race into a failure.
- *Fix:* when `syncWebOnce` is next touched, split the loop into a function that takes the press, idle, delta and clock as parameters, and give it a fake-driven unit test. This fits the §8 wording the M2-S2 review suggested.
- *Where:* QA, next touch of `flows.ts`. Not urgent.

### Assessment of the points you asked about

**Locale pin: correct.**
- *How Chromium is launched:* `playwright.config.ts:54` passes `launchOptions.env = browserLocaleEnv(process.env)`. The function copies the defined entries, then sets `LC_ALL` and `LANG` to `en_GB.UTF-8` and `LANGUAGE` to `en_GB:en`. `webApp`'s `locale` and the env both come from the single constant `browserLocale`. I evaluated the real config with `LC_ALL=C.UTF-8 LANG=C.UTF-8` and with `CI=1`: the launch env holds the three variables, and the parent `process.env` is identical before and after.
- *User env untouched:* it is a copy. `ci-loc-01` asserts the input is unchanged. Everything else in the environment (`PATH`, `HOME`, `DISPLAY`, `PLAYWRIGHT_BROWSERS_PATH`) passes through, so the browser sees what it saw before. The sole difference is the three locale variables.
- *Full and headless-shell builds:* the plan's experiments cover both. E1 to E3 used the full build, E4, E5 and E9 the headless shell, with and without the glibc locale generated (E3 and E6: `en_US.UTF-8` is not generated on the Pi, yet it was followed, so Chromium reads the name through ICU and the runner needs no generated locale). The local harness runs used the full build (explicit `executablePath`). **Neither the Pi nor my probes have run the exact CI binary, headless shell r1217, through the harness.** The proof run is the first test of that. LOC-01 and LOC-02 exist for this.
- *Both runners:* nothing in the mechanism depends on the architecture. The proof run confirms it.
- *Not leaked into reports:* the env copy is in `launchOptions`. The Playwright JSON report (read by the contract self-tests and uploaded) does not serialise `use`: the CI artifact's `report.json` has no `launchOptions`, `executablePath` or `actionTimeout`, and the config keys it lists do not include `use`. JUnit and the HTML report do not either. I grepped the local `test-results` and `playwright-report` for `LC_ALL`: no hit outside a RED unit-test log.
- *Other launch sites:* none. `tests/harness/playwright.cn3.config.ts` launches its own Chromium without the pin, but it tests the overridden built-in fixtures and no date field. `playwright.selftest.config.ts` spreads the base config and so inherits the pin and the bounds.

**Timeouts: sensible, with one forward note.**

| Bound | Value | Assessment |
|---|---|---|
| `use.actionTimeout` | 60 s | The Pi, the slowest box, passed 16 of 16 under it. Waits that are legitimately longer already pass their own `timeout:` (`appStartTimeoutMs` and `firstSyncTimeoutMs` 3 min, `syncWebOnce` 3 min, `titleField().waitFor` 60 s, the `waitFor` helper's `timeoutMs`), and an explicit `timeout:` overrides the default. S-B shows the bound firing in 63 s and naming the locator, so the context created by `browser.newContext` in the `webApp` fixture does inherit `actionTimeout` |
| `use.navigationTimeout` | 120 s | The app's first start on the Pi takes about 15 s; `appStartTimeoutMs` (3 min) governs the wait for the app itself |
| M2-S2 spec timeout | 15 min (was 25) | The slowest took 406 s on the Pi (45%), one worker. On the 2-worker runners x64 took 135 s for M2-AC3; arm64 is unknown until the proof run |
| `globalTimeout` (CI only) | 40 min | CI-T-02 reads the real step (`id: e2e`, 45 min) and keeps at least 4 minutes of margin. S-C shows Playwright ending itself, the reporters finishing and the gate keeping `output/` (`complete: true`). F-B1 is a correct find: the deadline also covers `globalTeardown`, so after a global timeout the stack stays up, which is harmless on a discarded runner. The comment in `timeouts.ts` is now right |
| CI-T-04 | 2 × 15 < 40 | A test plus its retry fits. Playwright may give teardown after a test timeout a fresh budget, so the global timeout, not CI-T-04, is the real backstop |

- *Can 60 s cut an M2-S3 attachment upload?* Not as the plan is written. The 60 s default applies to a Playwright call. Per its plan, M2-AC7a attaches with `attachFile(path)` and waits with `waitForAttachmentLink(fileName, timeoutMs)`, which takes its own bound (D7). The encryption and upload of 100 MiB happen in the page after the call returns. If the M2-S3 measurement shows the call itself near 60 s, that call gets an explicit `timeout`. The rule is: a wait longer than 60 s names its own timeout, as the existing long waits do. Nobody raises the default.
- *Forward note for the orchestrator and the M2-S3 planner (not a defect of this branch):* the untracked M2-S3 plan sets `test.describe.configure({ timeout: 25 * 60_000 })` for M2-AC6, M2-AC7b and M2-AC8, and D7 sizes the attachment test at "at least 25 min". After this branch merges, **CI-T-03 fails on any spec above `longSpecTimeoutMs` (15 min), and CI-T-04 fails if two attempts do not fit the global timeout.** The pairing the plan's CC-1(b) already names covers it: `longSpecTimeoutMs` 25 min, `ciGlobalTimeoutMs` 55 min, the step at 60 min, changed together (QA for the constants, the ci-cd-specialist for `e2e.yml`). The M2-S3 plan must say so, or keep every spec at 15 min or less.

**The failure line: redaction holds; two caveats.**
- *Redaction:* the message is redacted before it is cut, and it is redacted twice, because `printFailure` runs after `redactError` has already rewritten `result.error.message` in place. Colour codes are stripped first. I drove the real `RedactingReporter.onTestEnd` with a stack that registers an account password and a master password, and with six messages. Registered passwords came out as `[account0_password]` and `[account0_master_password]`. `?token=<40 hex>&fields=id` became `?token=[REDACTED]&fields=id`. An `X-API-AUTH:` header value and an `Authorization: Bearer` value became `[REDACTED]`. A message with a token after 285 characters was cut with no half-secret. A message with leading blank lines took the first real line. No registered or realistic secret survived.
- *Not redacted by design:* a bare `token=value` without `?` or `&` is not touched, because the shared pattern (`tests/support/redact.ts:28`) is `[?&]token=`. That is the project-wide rule for every artifact, the Data API token is also registered by value, and nothing here changes it.
- *Seeded values:* only the first line is printed. It can hold a per-run synthetic title or body when a spec uses `expect(x, 'message ${title}')` or throws an `Error` that quotes one (M2-S2 r1 C4). That is the class `list` already prints in its epilogue. It adds no new class of exposure, and it never contains an account secret.
- *Gap:* `ci-fail-04` has no secret in its error, so no committed unit test shows that the reporter path (not just `failureLine`) redacts a registered secret. The contract self-tests do scan the inner run's `playwright-console.log`, which now holds the failure line, and the regression run passed. But the first line of each deliberate failure is generic (`C1: this failure is deliberate`; the planted master password is in the received value on a later line), so that scan proves no leak without exercising the redaction of the line. Because the message is redacted in place just before, the risk is low. Add a secret to `ci-fail-04`'s error when C1 is next touched.

**F-R2: the re-press does not weaken the barrier.** I agree with the planner's analysis, and I checked it against the code.
- *Why the barrier holds:* completion still needs a delta (200) after the **last** press, an idle button, and a report with `Completed:` and no `Last error:`. The first press comes after the caller's change, so any sync that starts after it began after the change. The sync's own order (`update_remote` before `delta`) then means a delta request after the press implies an upload after the change. This holds even if the delta belonged to the app's own sync that the press cancelled, because that sync started after the change too.
- *What can trigger a re-press:* `pressAgain` needs an idle button (so no running sync is cancelled), no delta since the last press, at least 3 s gone, and fewer than 3 presses. The cap is inside the pure function, which `press-03` pins. A web app that never syncs still fails at the 3-minute poll.
- *Fail-closed evidence:* S1c on the new code (`sens/s1c-repress.log`) fails in `syncWebOnce` at the 3-minute poll with `Received: "no delta request since the press"` after exactly 3 presses (traced clicks 22 s apart). The failed run leaves no `sync-repress` annotation, since it is pushed only after completion. S-E fails before the fix and passes after, with 2 presses in each of the four cycles.
- *Residual race:* an auto-sync starting between the idle check and the click is the race M2-S2 already accepted. A re-press now recovers from it instead of failing the test.

**Test strength: nothing weakened.**
- The only edits to existing specs are the three timeouts (25 → 15 min, a tightening) and the `webApp` locale constant. The two GREEN commits that edit a RED test (`a7d8d0e`, `78d3c4d`) only remove the second argument of Jest's `expect`, a form that does not exist. The messages became comments and every assertion is unchanged. The F-R1 fix added tests (`ci-fail-04`, `ci-fail-05`).
- No `.only`, `.skip`, `fixme`, `waitForTimeout`, `.fill(` or sleep in the diff. The one grep hit is the CI-T-03 guard `doesNotMatch(/\bslow\(\)/)` itself.
- `pressSettleMs` (3 s) is a threshold compared with elapsed time inside a poll, not a sleep. It is a stabilisation window of the kind M2-S2 r1 C1 accepted with caveats: its reason is written (a sync the press started shows its first requests well within it), and its failure mode is safe (a late sync only causes an extra press, bounded at 3, and a late failure is still a failure).
- LOC-01 and LOC-02 are a real pair: under the C locale RED, LOC-01 got `""` and LOC-02 got exactly the value, so the control can tell the two orders apart.

## Process findings

**P1, minor. WO-5 said "stop and report"; the executor fixed `syncWebOnce` instead (the third time the executor has acted beyond an instruction).**
- *What happened:* WO-5 says that if M2-AC3 fails in the full run, "stop and report it" as finding B's root cause. The executor found F-R2 and fixed it in place: a RED commit (`2a906c9`), a GREEN commit (`78d3c4d`), and the S-E validation. The planner reviewed it afterwards and accepted it, with a process note. I agree with the technical outcome: the change is harness-only, test-first, bounded, annotated, and S1c was re-run.
- *Why it still counts:* a shared barrier helper (the M2-S2 F9 design) was changed outside the written work orders, with the decision taken by the executor and ratified afterwards. Earlier occurrences: M2-S1 r1 P1 (a running stack removed before reporting) and M2-S2 r1 P1 (kept images removed against a hold).
- *Fix:* the planner words a stop point as a hard stop ("write the finding in the plan, make no commit, end the turn"); the executor treats "stop and report" the same way, even when the fix looks small. The planner then decides, as here.
- *Where:* planner and executor, the M2-S3 work orders. Not a blocker.

**P2, nit. Two history and RED hygiene points.**
- `91d6256` (the failure line GREEN) leaves six existing Jest tests failing until `86aeb98`, two commits later: `test.titlePath is not a function` in `secrets.test.ts`, `uploadGate.test.ts` and `derivedCredentials.test.ts`. The executor found it in WO-5, owned it as F-R1, and fixed it test-first. A `--no-ff` merge keeps that commit visible to `git bisect`. The lesson ("run the whole harness Jest set at every GREEN that touches a shared harness module") is in the plan only. Add it to strategy §8.
- Two RED commits again carry the one-argument `expect(x, message)` slip: `1976aa2` and `2a906c9`, corrected in their GREEN commits (and `7c886b6` in M2-S2). Jest's `expect` takes one argument (`node_modules/expect/build/index.d.ts:56`), so those RED tests did not type-check. The RED failure was still the stated one. A `corepack yarn lint` before each RED commit would catch it.
- *Where:* QA, next touch of strategy §8 and the RED checklist.

**P3, nit. `docs/test-plans/CI-M2-S2-x64-arm64.md:312` (the sign-off condition is not marked as met).**
- The sign-off says "arm64: YES, on condition that WO-8's S1c fails as stated". The S1c row in the validation table shows it did (`d9bf8c3`, press count 3). The sign-off line was not updated, so the file still reads as conditional.
- *Fix:* add "condition met: S1c, `d9bf8c3`". *Where:* QA, with the CI proof results.

Checks that came out clean:
- **Ownership:** all 16 commits have `Agent: qa-specialist` (14 name Sonnet as co-author, the two planner commits `bf3832c` and `a6bc167` name Opus). Every file in the diff is `tests/**`, `playwright.config.ts`, `docs/testing/strategy.md` or `docs/test-plans/CI-M2-S2-x64-arm64.md`. The engineer made no commit. `.github/**` is untouched, as the plan says (CC-1 is conditional and belongs to the ci-cd-specialist). `docs/test-plans/M2-S3.md` is untracked and absent from every commit.
- **Test-first:** RED before GREEN for all five pairs: `1976aa2` → `a7d8d0e` (locale), `f9af122` → `d88b36c` (bounds), `449673a` → `91d6256` (failure line), `49104f9` → `86aeb98` (the F-R1 fix), `2a906c9` → `78d3c4d` (re-press). I read the RED logs: `browserLocaleEnv is not a function`; `tests/e2e/support/timeouts.ts does not exist` (4 of 4); `Cannot find module '.../failureLine.ts'`; `Cannot find module '.../syncPress.ts'`; `test.titlePath is not a function` (the regression). LOC-01 got `Received: ""` and the S-D reproduction under `C.UTF-8` printed CI's message (`timed out after 10000 ms waiting for the date input to hold ...`).
- **Commit types (P-R1):** 10 `test(harness)`, 4 `docs(test-plans)`, 1 `docs(testing)`, 1 `chore(harness)`; no `fix(...)` or `feat(...)`. Trailers and the session line are on all 16.
- **Worklog accuracy:** the plan's numbers match my re-runs (lint exit 0, Jest 16 suites and 97 tests, CI-T 4 of 4, ac22 13 of 13, serial-rule 4 of 4) and the logs I read (final run 16 of 16 in 2025 s with no `[notestead] FAILED` line; contract regression 8 suites and 45 tests; S1c and S-E at the stated failure sites; S-C `9 passed`, `7 did not run`, `Timed out waiting 600s`). The executor reported its own regression (F-R1), the unmet S-C expectations (F-B1, F-B2) and the untagged device image honestly.
- **Podman:** `podman ps -a` shows only `byparr`; the four test-labelled images are kept as the plan says; no stack is left.
- **Scope and disputes:** every change maps to A, B, C, D or F-R2. No unrequested feature. No dispute was needed.

Good decisions, briefly:
- The locale pin is the faithful emulation (a real en-GB user's browser has an en-GB UI locale), with a guard that fails loudly on any runner. The planner rejected `--lang` (no effect, E7), a workflow-only setting (local runs unguarded) and a locale-aware `enterLocal` (it would hide a wrong browser locale).
- The experiments E1 to E9 were run before the plan was written, and E3 and E6 showed that no generated glibc locale is needed on the runner.
- CI-T-02 reads the real step's `timeout-minutes` from `e2e.yml` and fails closed on an unreadable timeout expression. A mutation (42 min) made it fail.
- The failure line is redacted before it is cut, and cannot break the reporter's redaction (the `try`/`catch` and the partial-object test `ci-fail-05`).
- The executor ran S-C, found that `globalTeardown` does not run after a global timeout (F-B1) and that the interrupted test gets no line (F-B2), and reported both instead of bending the plan to fit.

## CI proof: what the branch run must show

After this approval the orchestrator pushes `test/M2-S2-ci-x64-arm64`. `e2e.yml` runs on it (non-docs files changed; the bundle job should restore `main`'s cache entry, as in the last run). The merge to `main` follows only after a green run on **both** runners. QA downloads the evidence read-only, as for 39663284028, and appends the results to the plan.

**To merge, on each runner, from the job log, `junit.xml`, the HTML report, `redaction-complete.json` and `upload-gate.json`:**
1. The E2E step is green, with `16 passed` (the 14 M2-S2 tests and LOC-01/02), `tests=16 failures=0 errors=0 skipped=0`, `flaky 0`, and every result at `retry 0`. No `[notestead] FAILED` line in the log.
2. `CI-M2S2-LOC-01` and `-02` pass. This is the only evidence that the pin holds for headless shell r1217 on the runners' own locale. If LOC-01 fails, A is not fixed, whatever else passes.
3. `M2-AC5` passes: the first CI run past its step 2, so the epoch, the NEG window and the `done` cycle are new on CI.
4. `M2-AC3` passes on its first attempt. Record its duration (Pi 333 s, x64 135 s) and its annotations: the four `cycle` entries and any `sync-repress`.
5. The reporters finished: `junit.xml`, `playwright-report/` and `redaction-complete.json` (`complete: true`) exist, `upload-gate.json` has `complete: true` and `removed: []`, and the E2E step finished well under 40 minutes.
6. `ci.yml` is green on the branch.
7. The leak scan over both artifacts and the three job logs finds 0 hits. The failure line is new log content, so scan the logs too.

**B (the arm64 stall):**
- *The class is already closed* by construction and does not wait for CI. No action, navigation, spec or run is unbounded: CI-T-01…04, S-B and S-C show it.
- *The trigger is "contained", not "explained", if* items 1 to 5 hold on arm64 with M2-AC3 first-try in a normal time. One green run cannot show that an intermittent stall is gone. I would call B **explained** only if arm64's M2-AC3 shows a `sync-repress` annotation (then F-R2 is the probable trigger and CI recovered from it; the 23-minute tail would still be unexplained).
- *Keep B on the STATUS watch list* until the branch run, the merge push and the next push to `main` are all green on arm64 with M2-AC3 first-try, then close it.
- *B is reopened by* any `Timeout 60000ms` failure, any test that reaches its 15-minute limit, or any global timeout. Each now carries a named locator or fixture in the failure line, JUnit, HTML and trace. That is the instrumentation working and a new finding for QA to analyse. It is never retried until it passes.

**C (the M1-AC21 NEG flake):**
- *C stays open after one green run.* The cause is unknown, and a pass shows only that it did not recur.
- M1-AC21 NEG must pass at `retry 0` on arm64. If it flakes again, that is the second flake in the week (the first was 2026-10-21), and strategy §6 makes it a bug with a root cause. QA analyses it from the failure line, the JUnit error, the HTML report and the trace, which now exist. It does not raise retries or skip it.
- Otherwise C stays on the watch list until 2026-10-28, then closes as "not reproduced, cause unknown", recorded as exactly that.

**Also record:**
- **CC-1:** the arm64 E2E wall time. Over 20 minutes means CC-1(a), the step to 60 minutes with `ciGlobalTimeoutMs` at 55 minutes in the same change. CC-1(b) (M2-S3's attachment specs) is needed in any case before M2-S3's first CI run, as the forward note above explains.
- **DST:** run before Sunday 2026-10-25 01:00 UTC. The repeated hour at the end of summer time makes `datetime-local` ambiguous (M2-S2 r1 C2); no schedule triggers E2E, so only an on-demand run in that hour is affected.
- **If the run is red for a new, unrelated reason,** QA records it as a finding. A new round from me is needed only if the fix changes the harness beyond what this review approves.

## Follow-ups
| Item | Severity | Blocks | Goes to |
|---|---|---|---|
| C1 failure line: add the first `Expected:`, `Received:` or `waiting for` line for matcher and timeout errors (redact, then cut) | minor | no | QA, anytime; before the next arm64 diagnosis |
| C2 strategy §5 line 82 still says "presses once" | minor | no | QA, one `docs(testing)` commit before the push, or the next touch |
| C3 reword the plan: F-R2 is a candidate trigger of B, the 23-minute tail is unexplained, and apply the closure rule above | minor | no | QA planner, a docs line |
| C4 CI-T-02 message wording; CI-T-03 per-test `{ timeout }` pattern; `printsToStdio()` | nit | no | QA, next touch of those files |
| C5 `syncWebOnce` wiring: extract the loop and add a fake-driven unit test | nit | no | QA, next touch of `flows.ts` |
| `ci-fail-04`: plant a registered secret in the error, so the reporter path is tested end to end | nit | no | QA, with C1 |
| P1 hard stops in work orders ("stop and report" means no commit) | minor | no | QA planner and executor, M2-S3 work orders |
| P2 §8: run the whole harness Jest set at every GREEN that touches a shared harness module; lint before a RED commit | nit | no | QA, next touch of the strategy |
| P3 mark the sign-off condition as met | nit | no | QA, with the CI proof results |
| Forward note: M2-S3's 25-minute specs conflict with CI-T-03/T-04 | observation | no | Orchestrator and M2-S3 planner: use `longSpecTimeoutMs`, or raise it with `ciGlobalTimeoutMs` 55 min and the step 60 min (CC-1(b)) |
| CI proof (both runners), B watch list, C watch until 2026-10-28, CC-1 from the arm64 wall time | carried | merge | QA after the push; the orchestrator merges `--no-ff` only after a green run on both |

None blocks the push or the merge.

## Verification
| Command | Result |
|---|---|
| `git log --format='%h %an %(trailers:key=Agent,valueonly,separator=) %(trailers:key=Co-Authored-By,valueonly,separator=) %(trailers:key=Claude-Session,valueonly,separator=)' main..HEAD`, `git merge-base main HEAD`, `git log -1 main` | 16 commits, all `Agent: qa-specialist`; Co-Authored-By names Sonnet (14) or Opus (2, the planner); session trailer on all 16; base `961df09` equals `main` |
| `git diff --name-only main...HEAD`, `git show --stat` per commit | only `tests/**`, `playwright.config.ts`, `docs/testing/strategy.md`, `docs/test-plans/CI-M2-S2-x64-arm64.md`; no `.github/`, `packages/`, `deploy/`, `upstream/`, `patches/`, ADR, backlog, `package.json`, `yarn.lock`; `M2-S3.md` is not in any commit |
| `corepack yarn lint` (eslint plus 3 tsc configs) | exit 0 (68 s) |
| `corepack yarn jest tests/unit/harness tests/integration/harness` | 16 suites, 97 of 97 pass (`ci-loc` 2, `ci-fail` 5, `press` 3 among them) |
| `node --test --test-concurrency=1 --test-reporter=spec` on `tests/acceptance/ci-m2-s2/timeouts.test.mts`, `tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts`, `tests/acceptance/m2-s1/serial-rule.test.mts` | 4 of 4, 13 of 13, 4 of 4 |
| Import of the real `playwright.config.ts` with `LC_ALL=C.UTF-8 LANG=C.UTF-8`, and with `CI=1` | launch env `LC_ALL=LANG=en_GB.UTF-8`, `LANGUAGE=en_GB:en`; parent env unchanged; local: `actionTimeout` 60000, `navigationTimeout` 120000, `globalTimeout` 0, 1 worker, 0 retries; CI: `globalTimeout` 2400000, default workers, 1 retry, no `executablePath` |
| A script driving the real `RedactingReporter.onTestEnd` (stack secrets from `NOTESTEAD_E2E_STACK`) with six error messages: registered passwords, a `?token=` URL, `X-API-AUTH` and `Bearer` headers, leading blank lines, colour codes, a token past the 300-character cut | registered secrets, `?token=` values and header values redacted; nothing cut into half a secret; a bare `token=` without `?` or `&` is not redacted, which is the shared pattern's existing rule (`redact.ts:28`) |
| grep of `report.json` in the 39663284028 contract artifact, and of local `test-results` and `playwright-report`, for `launchOptions`, `executablePath`, `actionTimeout`, `LC_ALL` | no hit: the JSON report does not serialise `use`; the env copy reaches no report |
| grep of the diff and of `tests/e2e`, `tests/unit/harness`, `tests/integration/harness`, `tests/stack`, `tests/acceptance/ci-m2-s2` for `.only`, `.skip`, `fixme`, `waitForTimeout`, `sleep(`, `.fill(`, `setTimeout(` | no hit, except the CI-T-03 guard `doesNotMatch(/\bslow\(\)/)` |
| Read `red/*.log`, `green/*.log`, `sens/s-b`, `s-c`, `s-c-gate`, `s-e-red`, `s-e-green`, `s1c-repress`, `t02-mutation`, `verify/e2e-full-c-locale.log` and its JUnit, `verify/contract-regression.log` under `test-results/verify/ci-m2-s2/` | each RED fails for the stated reason; S-B 63 s naming the locator; S-C stops at 600 s with `complete: true` and the teardown not run (F-B1); S-E: 2 presses in each of the 4 cycles after the fix; S1c: 3 presses, then the stated failure; final run 16 of 16 in 2025 s with 0 `sync-repress`; contract regression 8 suites, 45 tests |
| grep of `test-results/verify/ci-m2-s2/**` for `token=` values, `nst(pw|mp)` secrets, `X-API-AUTH`, `Bearer`, `masterPassword` | no secret; only test-source text in an error-context snapshot and the AC20 test title |
| Read `e2e.yml` (step `id: e2e`, `timeout-minutes: 45`, `FORCE_COLOR: '0'`, `push: branches ['**']`, `paths-ignore: docs/**`) and `docs/testing/strategy.md` diff | CI-T-02 reads the real step; the strategy additions are accurate except C2 |
| `podman ps -a`, `podman images`, `podman network ls`, `podman volume ls` | only `byparr`; the four kept test images; no stack left |
| Read the 39663284028 evidence `index.md` (arm64 and x64 tables, M2-AC3 stall site, upload gate) | the stall site matches F-R2's location (C3); the globalSetup took 74 s; the x64 M2-AC3 took 135 s |
| E2E and contract suites | not run (instructed); the QA logs above are the evidence |
| x64 and arm64 on the runners | PENDING-CI; see "CI proof" |
