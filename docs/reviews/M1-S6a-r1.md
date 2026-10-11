# Review: M1-S6a Harness hardening ahead of M1-S7 (round 1)

Verdict: APPROVE

- **Scope.** Branch `feat/M1-S6a-harness-hardening` at `e030fe1`, against `main` `e127859`. The story closes follow-ups C1, C2 and C4 of `docs/reviews/M1-S6-r1.md`. QA built C1 and C4 (harness code under `tests/**`); the senior engineer built C2 (R1, `eslint.config.js`).
- **Result.** All three follow-ups are met on arm64, and my re-runs match the worklog and QA's results. No blocker and no major finding.
- **Strengths:**
  - C1 is proven per channel with an automated negative control (`c1-neg` finds leaks in all 7 channels), not by a one-off run.
  - The reporter-API pitfalls found on the way are fixed and covered by unit tests: `onConfigure` is not forwarded, and `test.step` is the only step kind in the JSON report.
  - C4 fails safe on every unknown: an unparsable listing, a legacy descriptor, a reused PID.
  - R1 is precise, with each report on the line where the timer is taken; the QA and engineer probes are kept as evidence.
- **Follow-ups.** Two minors must land in later stories (C1-R1 in M1-S7, C1-R2 in M1-S8). One minor (C4-R3) belongs in the next harness story, or before M1-S8 if CI shares one podman host between concurrent jobs. The remaining items are nits or process minors.

## Rulings on the focus questions
- **C1, ready for M1-S7: yes, with C1-R1 done in M1-S7.**
  - The reporter covers every channel Playwright writes: step titles at begin and end, `titlePath()`, errors (message, stack, value, snippet, cause), stdout/stderr chunks, attachments (body, path, the trace zip entry by entry) and every file under the output dirs. The worker's stdio is redacted at the source, before `list` prints it.
  - Secrets are registered before they can be used: account passwords in `createAccount`, tokens once the service is healthy.
- **Accepted risks, judged one by one:**
  - **Screenshots and video:** acceptable. `playwright.config.ts:34-35` has both off. The only pixels left are the trace's screencast frames: 16 binary JPEGs in the C1 trace, which no text redaction can touch. Those are safe only while every secret goes into an `<input type="password">`. M1-S7 must enforce that (C1-R1).
  - **`html/trace/` excluded from the scans:** acceptable. I compared it with `node_modules/playwright-core/lib/vite/traceViewer`: all 16 files are byte-identical. It is Playwright's viewer app and holds no run data. The run's trace copies live in `html/data/*.zip`, which are scanned. A tighter check is suggested in C1-R4.
  - **Secrets split across two writes on the live console:** acceptable. Node's `console.*` writes each call as one chunk. The harness never pipes child output into the worker's stdout (I grepped: no `stdio: 'inherit'` and no `.pipe(process.stdout)`). The stored chunks are redacted again in `onTestEnd`.
  - **Trace files:** their content is handled well. My scan of the kept C1 run found 0 secret leaks and 112 redaction labels, over 82 text views with the trace zips and the HTML report's embedded zip opened. The remaining risk is **when** redaction happens: it runs after the fact in the runner (C1-R2, M1-S8).
- **C4, safety:**
  - **Unrelated podman resources:** safe. Every listing filters on the namespaced label `io.github.thescriptingguy.notestead.test` with the exact value `contract` or `stack`. A JSON parse failure yields an empty list, and `rm -f` gets only names from those filtered lists.
  - The compose files put the test label and the run label in the same `labels` map for every container, network and volume (`tests/stack/compose.yaml:27-29,60-62,75-83`, `compose.headless.yaml:33-35,53-55`). So no stack resource carries the test label without the run label.
  - `byparr` was untouched: QA's `podman-before-verify.txt` and `podman-after-verify.txt` are identical, and I diffed them.
  - **Dev and live stacks:** they survive once their descriptor exists. Before that there is a start-up window (C4-R3).
- **C2, rule quality:** good. My probe (18 cases) found no false positive in idiomatic test code beyond D1, which QA accepted, and one Jest idiom that needs a different spelling (C2-R5).
  - **FU-S6a-1:** a reasonable deferral. The `require`/`import()` member forms and `scheduler.wait` are unused in the repository. They need a QA fixture first, and code review is the backstop under ADR-0007.
  - **A1:** reasonable. `Reflect.get`, keys held in variables and aliases of the global object take deliberate effort, and syntax alone can't separate them from legitimate code.

## Code findings
**C1-R1 (minor, to do in M1-S7). `tests/harness/selftest/pertest-secrets.spec.ts:32`, `docs/testing/strategy.md:53`.**
- **Problem:** C1 is proven on a synthetic page (`page.setContent` with two password inputs), not on the web app's real flow. Two channels of the real flow are untested:
  - **Pixels:** the strategy's "never type a secret into a visible text field" is a rule, and nothing enforces it.
  - **Network:** the trace's request bodies stored as `resources/*` (the Joplin Server login `POST` carries the per-test account password) and the app's own console logging.
- **Failure scenario:** M1-S7's walking skeleton types the master password into a react-native-web field that renders as a plain text input, or one with a show-password toggle. The trace's screencast JPEGs then show the password in clear in `trace.zip` and `playwright-report/`. No text scan can detect that.
- **Expected fix (QA, in M1-S7):**
  1. The "type like a user" helper refuses to type a registered secret into an element that is not `type="password"`. Assert it before typing, for example with `expect(locator).toHaveAttribute('type', 'password')`.
  2. M1-S7's test plan applies the C1 scan to a deliberately failing variant of its real login or unlock flow: `findLeaks` with the registry's secrets over the trace, including `.network` and `resources/`, the reports and the console. That can be the C1 self-test driven against the web container, or a negative-control spec.

**C1-R2 (minor, to do in M1-S8). `tests/e2e/support/redactingReporter.ts:126-159`, with `.github/workflows/ci.yml:136-143`.**
- **Problem:** the worker writes `trace.zip` and the attachment files unredacted. The runner's reporter redacts them only later, in `onTestEnd` and `onEnd`. If the runner dies before then (a CI job timeout or cancellation that ends in SIGKILL, an OOM kill), the unredacted files stay in `test-results/`. The existing workflows upload `test-results/` with `if: always()`.
- **Failure scenario:** an M1-S8 E2E job hits `timeout-minutes` during a slow headless sync. GitHub sends SIGINT and then SIGKILL before Playwright's interrupted run reaches `onEnd`. The upload step still runs and publishes a trace with the per-test master password as a public artifact. The values are throwaway, but C1's claim ("never reach an artifact") breaks.
- **Expected fix (ci-cd with QA, in M1-S8):** make the upload fail closed for Playwright output.
  - The reporter writes a completion marker in `onExit`, and the upload step includes `test-results/e2e` and `playwright-report` only when the marker exists.
  - Otherwise, a standalone step redacts with the registry file left in `/tmp` (which `onExit` did not remove), or deletes the traces.
  - Optionally, in CI, also emit `::add-mask::` for each registered secret from the runner process, as a second layer for the job log.

**C4-R3 (minor; in the next harness story, or before M1-S8 if CI runs concurrent jobs on one podman host). `tests/stack/stack.ts:272-296` and `:301-309`.**
- **Problem:** `newStack()` does not write the descriptor. The first `saveDescriptor` call comes at the end of `upCore`, after `composeUp` has waited for `server` and `web` to become healthy (the server's `start_period` is 180 s, and on the Pi start-up takes minutes). During that window, the stack's resources carry `test=stack` and a run label that no descriptor claims. The sweep therefore treats them as an orphan and removes them with `rm -f` and `network rm -f`.
  - `tests/unit/harness/descriptors.test.ts:39-53` confirms it: `newStack()` returns without writing a file.
- **Failure scenario:** a developer runs `node tests/stack/cli.ts up` in one terminal and starts `corepack yarn test:contract` in another while the server is still starting. The contract globalSetup's sweep removes the half-started dev stack, and `cli.ts up` fails with a confusing health error. The same applies to a Playwright run's globalSetup on a shared CI host. The "one heavy job at a time" rule makes this unlikely on the Pi, but C4's criterion says "never a stack in use".
- **Expected fix (QA):** call `saveDescriptor(state)` at the end of `newStack()` for an owned stack, before any `compose up`. Extend the unit test to assert that the descriptor exists with `ownerPid` right after `newStack()`.

**C1-R4 (nit). `tests/contract/m1-s6a/c1-pertest-secrets.test.ts:115`, `tests/contract/m1-s6/ac20-attachments.test.ts:119`.**
- **Problem:** both scans skip `html/trace/` by path. Today that directory is byte-identical to Playwright's packaged viewer, which I checked.
- **Failure scenario:** a future Playwright version writes run data under `trace/` in the HTML report. The scans would skip it silently, and a leak there would go unnoticed.
- **Expected fix (QA):** instead of skipping by path, assert that each file under `html/trace/` is identical to the file of the same name in `node_modules/playwright-core/lib/vite/traceViewer`. Scan any file that differs or is missing there.

**C2-R5 (nit). `eslint.config.js:60-73`, `docs/testing/strategy.md` §5.**
- **Problem 1:** my probe (`test-results/review/m1-s6a/lead-probe.log`) shows that `jest.spyOn(globalThis, 'setTimeout'); expect(setTimeout).toHaveBeenCalledTimes(1)` is reported. That is a common way to unit-test code that schedules timers, such as the supervisor's sync interval in `packages/headless`.
  - **Workaround:** `const spy = jest.spyOn(globalThis, 'setTimeout'); expect(spy)…`, which is not reported. It isn't documented.
- **Problem 2:** two fixed-sleep idioms are neither banned nor listed under FU-S6a-1 or A1:
  - `Atomics.wait(…, ms)`;
  - a shell `sleep` through `execSync('sleep 1')`.
- **Failure scenario:** in M1-S7 or M2, an engineer writing a timer unit test meets the lint error, finds no documented spelling and adds an `eslint-disable`. Or a sleep slips through as `Atomics.wait`.
- **Expected fix:**
  - QA: add the spy spelling to strategy §5 beside "Jest fake timers are not sleeps".
  - Add `Atomics.wait` to FU-S6a-1. A selector on `CallExpression[callee.object.name="Atomics"][callee.property.name="wait"]` has no false-positive risk in tests.
  - Leave shell `sleep` to review under A1.

**C1-R6 (nit; relevant from M4). `tests/e2e/support/globalSetup.ts:31`, `tests/e2e/support/fixtures.ts:145`.**
- **Problem:** Data API tokens are registered at fixed points only:
  - the default service's token once, in globalSetup;
  - a per-test service's token when it becomes healthy and again at teardown.

  A CLI restart in the middle of a test rotates the token. The new bare token is unknown to the worker's stdio redaction until teardown, and the default service's new token is never registered. The `?token=` pattern still covers URL forms.
- **Failure scenario:** an M4 test restarts the CLI, for example a settings change, and logs the new token, for example in an MCP config dump. The live console shows it.
- **Expected fix (QA, when M4 or any test restarts the CLI):** register the token after every restart the harness causes, for example from the supervisor-restart helper, and say so in strategy §4.

## Process findings
**P-R1 (minor). Commits `a3cc6dc`, `1f842ba` (`fix(harness): …`) and `e1910f8` (`fix(lint): …`).**
- **Problem:** these change test tooling only, yet they use the `fix` type. release-please (channels D5) turns `fix:` into a patch release and a "Bug Fixes" entry in the user-facing CHANGELOG. Harness changes on `main` have so far used `test(...)` (for example `test(harness)`, `test(stack)`).
- **Failure scenario:** the first release's CHANGELOG lists "redact per-test secrets in traces…" and "ban setTimeout/setInterval used as a value in tests" as product bug fixes, and every harness fix bumps the version.
- **Expected fix:**
  - **Agents (QA, engineer):** use `test(...)` or `chore(...)` for changes to `tests/**`, test-runner config and lint config.
  - **ci-cd:** when release-please is configured (M5-S3), add `exclude-paths` for `tests/` (and test-only config), or a `bootstrap-sha` after this merge, so that test-only commits never cut a release.
  - History is not rewritten: no force-push, and merges use `--no-ff`.

**Process checks that passed:**
- **Test-first:**
  - The RED commits `090c78f` (C2), `fb72b01` (C1) and `dabf839` (C4) and the plan `7cb5876` come before QA's harness fixes `a3cc6dc` and `1f842ba`, and before the engineer's `e1910f8`.
  - The RED logs match the plan: `red-c2.log` 3/7, `red-c1-final.log` exit 1, `red-contract.log` exit 1.
  - The engineer's own RED re-check on the pre-R1 config, `se-red-c2.log`, also shows 3 passed and 7 failed.
- **Test ownership:**
  - The engineer's commits touch only `eslint.config.js` (R1) and `docs/worklog/M1-S6a.md`, and every commit under `tests/` carries `Agent: qa-specialist`.
  - QA writing both the C1/C4 tests and their harness fixes follows the ownership table, and the plan states it. The independent check is this review: my own artifact scan, the probe, and the re-runs.
- **Worklog accuracy:** every claim I checked matches the logs or my re-runs:
  - `se-green-c2.log` 10/10;
  - `se-f1.log` 8/8;
  - `se-lint.log` exit 0;
  - `se-probe-ts.log` 42/42, and `se-probe-espree.log` 36/42 with the 6 misses being TS-syntax parse errors, as stated;
  - the report positions in the worklog table match QA's `verify-c2.log`.
- **M1-S6 P1 closed:** each of the 27 logs in `test-results/verify/m1-s6a/` ends with `exit <code>`, and the codes agree with the stated outcomes.
- **Scope:** the diff touches only `tests/**`, `eslint.config.js`, the plan, the worklog and the strategy. The engineer's three stricter-than-R1 deviations (D1–D3) are declared and were ruled on by QA. Nothing else was added.
- **Discipline:** no `.only`, skipped or `fixme` tests, and no fixed sleeps. Every timer token in the added lines sits in a lint fixture, a comment or an allowed deadline (`test.setTimeout`, `req.setTimeout`).
- **Disputes:** none were raised. QA's rulings on D1–D3, G1–G3 and G2b, and the overwritten-log note, are recorded with reasons. FU-S6a-1 and A1 still need to be added to `docs/backlog/STATUS.md` (orchestrator).
- **Commit hygiene:** small, focused commits with Conventional subjects (types aside, see P-R1) and correct `Agent:` trailers on all 10 commits.

## Verification
All on the Pi (arm64), one heavy job at a time. Logs are under `test-results/review/m1-s6a/` (gitignored), and each ends with `exit <code>`.

| Command | Result |
|---|---|
| `corepack yarn lint` (ESLint, then `tsc` ×3) | **exit 0**, 52 s (`lint.log`); matches `se-lint.log` and `verify-lint.log` |
| `corepack yarn jest` (all unit tests) | 29 suites, **258 passed**, exit 0 (`unit.log`); matches `verify-unit.log` |
| `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s6a/c2-lint-sleep-values.test.mts` | **10 passed**, 0 failed, 33 s, exit 0 (`c2.log`); `git status` clean afterwards |
| `node lead-probe.mjs`: the committed sleep-ban block through ESLint's `Linter` and the TS parser, 18 cases (copied to `lead-probe.mjs`) | Reported: `expect(setTimeout)`, `typeof setTimeout`, `page.evaluate(() => …setTimeout…)`, destructuring from any object (D1), a parameter named `setTimeout`, and `export { setTimeout } from 'node:timers'` (3 reports, cosmetic, as QA found). Not reported: the spy-variable spelling, `{ setTimeout: jest.fn() }`, an import from a non-timers module, `setImmediate`, strings, regexes, comments, `page.clock`; also `Atomics.wait`, `execSync('sleep 1')` and `scheduler.wait` (FU-S6a-1) (C2-R5) |
| `node scan.mts test-results/contract/m1-s6a/c1`: every file of QA's kept C1 run, `html/trace/` included, zips opened, the HTML report's base64 zip decoded, `findLeaks` with `token=`, credential headers and the patterns `nst(pw\|mp)[0-9a-f]{24}` and `nstsecret[0-9a-f]{24}` (copied to `scan.mts`) | **0 secret leaks** in 82 text views, 112 redaction labels; the only hit is the known `cookie=x.value` in the viewer's JS under `html/trace/` (`c1-scan.log`) |
| `cmp` of each file under `c1/html/trace/` with `node_modules/playwright-core/lib/vite/traceViewer/` | 16 files, **0 differ** |
| Entries of the C1 `trace.zip` | 14 text entries (`.trace`, `.network`, `.stacks`, resources), **16 binary JPEG screencast frames** (C1-R1) |
| QA evidence: `verify-contract-m1-s6.log`, `verify-contract-m1-s4.log`, `green-c1-2.log`, `green-c4.log` | 7 suites, 34 passed (every `c1-*` and `c4-*` test is listed as passed); 4 suites, 28 passed; 11/11; 5/5. All match the plan |
| `diff podman-before-verify.txt podman-after-verify.txt` | identical (`byparr` and its network and images only); no `/tmp/notestead-stacks` descriptors and no `/tmp/nst-*` dirs now |
| Not re-run | the contract suites (C1 and C4 need real stacks: about 20 min cold). QA's VERIFY logs and my artifact scan cover them, and nothing in my review needed a specific contract re-check |

**x64:** PENDING-CI (M1-S8), as the plan says.
