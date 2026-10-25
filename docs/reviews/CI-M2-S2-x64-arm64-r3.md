# Review: CI-M2-S2-x64-arm64, fix-forward after CI proof run 2 (e2e 39957733152), round 3

Verdict: APPROVE

**Summary.**
- Round 3 covers the 9 commits after `4344f69`: plan `2e92c31`, WO-15 (`fa7fa50` RED, `99e4cc4` GREEN, `7777acc` lint fix), WO-16 (`e9a8ab4` RED, `c229df3` GREEN), WO-17 (`5249aa0`), and the plan results and sign-off (`72450b2`, `8f47878`). All code is under `tests/**`, all by QA; nothing in `packages/`, `deploy/` or ADRs.
- G is diagnosed from the evidence (fixture timeout equal to the test timeout, so no log), and fixed twice over: readiness no longer depends on podman's health status, and the fixture now fails at 7 min with logs. Both are sound.
- No blocker, no major. Two minors and some nits. I did not run E2E or contract suites (instructed), and did not push.

## Code findings

**C1, minor. `tests/e2e/support/fixtures.ts:107-122` and `:208-214` (cleanup can mask the original error).**
- *Problem:* `keepStartLogs` is documented "nothing here throws", but `mkdirSync`, `writeFileSync` and `attachText` can; `downHeadless` also calls `writeFileSync`/`composeDown`. An exception in either replaces the `upHeadless` error, which is the diagnostic G was about.
- *Scenario:* a full disk or an attach error on the runner during the failure path; the test then reports an I/O error instead of "not healthy within 420 s".
- *Fix (QA):* wrap the cleanup in `try { ... } catch { /* keep the original */ }` before `throw error`, or use `finally`-style ordering so the original is always rethrown.

**C2, minor. `tests/e2e/support/fixtures.ts:107-122` (token not yet registered on the failure path).**
- *Problem:* `registerToken(service)` runs only after `composeUp` succeeds, so on a failed start the Data API token is not among `workerSecrets`. Redaction then relies on the `?token=` pattern, not on the known value.
- *Assessment:* acceptable today. `supervisor.log` comes from `podman logs` (stdout/stderr), not `log-clipper.txt`, and the token appears there only in query strings, which `redactText` covers. S-G2's evidence (14 `ECONNREFUSED` lines, no value) fits. The throwaway passwords are in `workerSecrets` and `compose-up.log` is redacted twice (`redactText` in `composeUp`, again in the fixture). `readiness.log` holds status, state, timestamps and elapsed time only. The redacting reporter and upload gate see the same files.
- *Fix (QA, next touch):* add a unit or gate check that a `token=` value in a failed-start log is redacted, so this does not depend on the log format.

**C3, nit.** `tests/stack/stack.ts` names the local `extra_` (collides in spirit with the `extra` parameter); rename to `failureExtras`.

**C4, nit.** The `timeouts.ts` comment says "ready in under 1.5 minutes on every runner"; run 2 had arm64 at 10 min in G, which is the unexplained case. Reword to "normally".

### Assessment of the points you asked about

- **`/healthz` readiness cannot pass on a stale sync, and is headless-only.** `upHeadless` passes `headlessReady` to `composeUp`; `server` and `web` pass nothing and keep the default rule (compose exit 0 and every service podman-healthy). A per-test project is new (`-hl-<id>`) with its own named volume, torn down with `down -v`, so there is no earlier sync to be stale. `headlessHealthz` runs inside the container, and 200 needs state `ready`, which means the initial cycle finished. `startVerdict` also requires `composeExit === 0`. Podman health only fails fast (`exited`, or `unhealthy` with `/healthz` not 200). `start-01…04` pin it and I re-ran them.
- **Fixture bound.** `headlessUpTimeoutMs` = 7 min against the 10 min test timeout, a 3 min margin; CI-T-05 requires at most test timeout minus 2 min, parses the timeout from `playwright.config.ts` and checks `fixtures.ts` passes the constant to `upHeadless`. The S-G2 run failed at 447 s inside `upHeadless` (420 s plus teardown), well below 600 s. The 7 min is a bound on the wait only; the 27 s overrun to 447 s is margin-consistent.
- **Log attachment and secrets:** see C2. No secret reaches the logs dir or the attachments by my reading.
- **Cleanup of the half-started project.** `upHeadless` pushes the service into `stack.headless` before `composeUp`, so `find` by project locates it; `downHeadless` writes the container log (if the container id is known), runs `compose down -v -t 0`, removes `secretsDir`, and deregisters. The original error is rethrown (`throw error`). Safe, apart from C1.
- **S-G2 deviation.** The edit was limited to non-default labels because the default headless service uses the same compose file; it was reverted and the run still failed in the fixture with the three logs. Handled properly and recorded in the plan.
- **F-H1.** The shared device tag removed by the contract `globalTeardown` is a harness-order hazard on the local box (CI builds per job), has a workaround recorded, and is routed to M2-S3's QA before its heavy runs. Non-blocking for CI, correctly routed.

## Process findings

**P1, nit.** RED precedes GREEN for both pairs: `fa7fa50` then `99e4cc4` (`7777acc` only fixes lint nesting), and `e9a8ab4` then `c229df3`. WO-17 is a single commit as ordered. All commits are `Agent: qa-specialist`, touch only `tests/**` and `docs/test-plans`, and use Conventional types (`test`, `docs`). No `.only`, skips, sleeps or weakened assertions.

**P2, nit.** WO-17's fixture change has no automated test of its own; it is proven by the S-G2 sensitivity run only. Acceptable for harness code, and C1/C2 would be a natural place to add one.

**P3, nit.** The plan records proof run 3 as PENDING; nothing is claimed beyond local evidence. Correct.

## Proof run 3 must show
On both runners: E2E 16 of 16 with no retry, contract `c1-pertest-secrets` 11 of 11, and the redaction and upload gates clean. If G recurs, it must now fail at about 7 min with `supervisor.log`, `compose-up.log` and `readiness.log` in the artifact.

## Verification
- `corepack yarn lint`: exit 0.
- `corepack yarn jest tests/unit/harness`: 16 suites, 107 of 107 (includes `start-01…04`).
- `node --test tests/acceptance/ci-m2-s2/*.test.mts`: 5 of 5 (CI-T-01…05).
- `git diff 4344f69..HEAD --stat`: only `tests/**` and `docs/test-plans`; `git log` of `packages deploy docs/adr` over the range: empty.
- E2E and contract suites not run (not requested); I rely on QA's logs in the plan.
