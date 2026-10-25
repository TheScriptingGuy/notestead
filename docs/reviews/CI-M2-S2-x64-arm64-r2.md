# Review: CI-M2-S2-x64-arm64, fix-forward after CI proof run 1 (e2e 39768694985), round 2

Verdict: APPROVE

**Summary.**
- Round 2 covers 11 commits since r1 (`1739167..HEAD`): WO-9 (E, the trashed note), WO-10 (F, restart readiness), WO-12 (ci-cd, E2E step 60 min), WO-13 (run budget 55 min), WO-14 and the planner sign-off. Everything is test-harness or docs except the one `e2e.yml` line, which is the ci-cd-specialist's.
- E is a good diagnosis with a sound fix: the page object accepts both upstream behaviours, bounds the wait, records which one happened, and now also checks the target notebook's heading. F's fix is correct: readiness is read from the supervisor's own `/healthz` with a `lastSync` newer than the restart, and cannot take a stale sync for fresh.
- The 60/55-minute pair is consistent with CI-T-02 and CI-T-04. Nothing is weakened. No blocker, no major; two minors and some nits.
- I re-ran lint, the Jest harness and the three acceptance files. I did not run E2E or contract suites (instructed), and did not push.

## Code findings

**C1, minor. `tests/e2e/support/pages/joplinWebApp.ts:193-207` and `tests/e2e/support/trashExit.ts:18-20` (the `stayed` branch).**
- *Problem:* `trashExit` returns `stayed` once the note screen has shown for 3 s with Back visible; the page object then clicks Back. If upstream leaves the screen late (after 3 s, as E showed it can do on its own), the Back click waits for a button that is gone and fails after 60 s with the same symptom as E. Also, only `left` has run end to end (the Pi and the runners both left by themselves); `stayed` is covered by `trash-02/03/05` only.
- *Scenario:* a loaded arm64 runner delays the reducer past 3 s; the poll answers `stayed` a moment before the screen changes.
- *Fix (QA):* in the `stayed` branch, wait for Back or the list with `Promise.race`-style polling instead of a bare click, or re-check `onList` right before the click and report `left`. Keep the annotation honest about which happened.
- *Where:* QA, next touch of `trashOpenNote`; or at the first recurrence. Not a blocker.

**C2, minor. `tests/stack/restartReady.ts:2-4` (the comment states F's mechanism as fact).**
- The comment says podman's health timer "was lost". The plan itself (planner sign-off `2aa81ba`) says `health-lag` fired on every cycle on the Pi too and the mechanism is unproven. Reword to "stayed `starting` ... (cause not established)". Planner already noted it. QA, next touch.

**C3, nit.** `trashOpenNote` can answer `left` without proving the note was trashed; that is fine only because the spec still asserts the trash in data (`noteInList(T2)` count 0 and the later REST `deleted_time`). Keep those assertions; do not let a later refactor rely on the return value.

### Assessment of the points you asked about

- **Two-outcome handling cannot pass falsely.** `left` needs the list showing (Sidebar button) and no title field, which cannot be true while the note is still open before Delete. `stayed` needs the title field, Back visible and 3 s. Neither answer is the test's evidence of deletion: the spec still polls the list to 0 and asserts the trash and the old note's absence in REST, and it now also asserts the target notebook's heading, which is stronger than before (the old step only clicked Back). A failed Delete leaves the note in the list or REST, and the test fails there. The `trash-exit` annotation records the branch taken.
- **`/healthz` readiness cannot declare a stale sync ready.** `lastSync` is set in memory in the new process when its sync ends (`stopTheWorldStrategy.ts:127`), is not persisted, and `/healthz` answers 200 only in state `ready` (`healthServer.ts:10`). The check is `Date.parse(lastSync) > startedMs`, with `started` taken before `podman restart`. So a sync of the old process is never accepted, and a 200 from the new process means its own sync finished after the restart. This is no weaker than before (healthy plus the same check) and independent of podman's health lag. Podman status is used only to fail fast (`exited`, `unhealthy` with `/healthz` not ready); the timeout message carries the last observation, value-free (status, state, timestamps; no token). `restart-01…06` pin the verdicts; S-F is the sensitivity run.
- **60/55-minute bounds are consistent.** `e2e.yml` step `id: e2e` is 60; `ciGlobalTimeoutMs` is 55 = step minus 5, so CI-T-02's 4-minute margin holds; CI-T-04 (2 x 15 = 30 < 55) holds; the job limit (150) still covers setup, the 75-minute contract step and 60. CC-1(a)/(b) is satisfied in the order the ci-cd-specialist stated (step first, budget second). The M2-S3 specs at 25 min still need `longSpecTimeoutMs` raised (2 x 25 = 50 < 55 would then hold).

## Process findings

**P1, nit.** Ownership and order are correct. All `tests/**` and `docs/testing` commits are `qa-specialist`; `607942c` and `12d8272` are `ci-cd-specialist` and touch only `e2e.yml` and its worklog; no `packages/`, `deploy/` or ADR change. RED before GREEN for both pairs (`252103c` then `e393033`, `2c1064f` then `f536a69`). Commit types follow P-R1 (`test`, `docs`, `ci`). No `.only`, `.skip`, sleeps or weakened assertions in the diff. Lint exit 0, Jest 18 suites and 108 of 108, acceptance 4/4, 13/13, 4/4.

**P2, nit.** My r1 asked that B not be called explained after one green run. The planner now says run 2 "closes B". I accept that for this reason: E is evidenced from run 1's own trace (the screen left about 35 ms after Delete, the Back click timed out at 60 s) and fits the arm64 stall site, so B is explained, not just contained. Keep it on the watch list for the next `main` run all the same.

## CI proof run 2: what it must show

On **both** runners (job log, `junit.xml`, HTML report, `redaction-complete.json`, `upload-gate.json`):
1. E2E green: 16 passed, `flaky 0`, every result `retry 0`, no `[notestead] FAILED` line, step well inside 55 minutes (record the arm64 wall time; run 1 took 1645 s).
2. `CI-M2S2-LOC-01/02` pass; M2-AC5 passes with no retry and no 600 s headless wait.
3. M2-AC3 passes first attempt with a `trash-exit` annotation (record which branch each runner took, and that the target-notebook heading assertion held).
4. List every `health-lag` annotation. Zero or many proves nothing by itself; a recurrence of a headless wait timeout with the new diagnostics would be F's real cause.
5. JUnit, HTML report, traces present; gate `complete: true`; `ci.yml` green; leak scan of artifacts and logs 0 hits.
6. B: closed if items 1 and 3 hold on arm64; reopened by any `Timeout 60000ms`, 15-minute test timeout or global timeout. C: closes if M1-AC21 NEG passes first time here and in the next `main` run (watch to 2026-10-28); a second flake makes it a bug needing a root cause.

## Follow-ups
| Item | Severity | Blocks | Goes to |
|---|---|---|---|
| C1 late-leave race in the `stayed` branch; no E2E run of `stayed` | minor | no | QA, next touch of `trashOpenNote` |
| C2 `restartReady.ts` comment states an unproven mechanism | minor | no | QA, next touch |
| C3 keep the data assertions independent of the return value | nit | no | QA |
| r1 follow-ups C1 to C5, P1 to P3 | as in r1 | no | unchanged |
| Proof run 2 on both runners, then merge `--no-ff` | carried | merge | QA after the push; orchestrator |

None blocks the push or the merge.

## Verification
| Command | Result |
|---|---|
| `git log --format='%h %s' 1739167..HEAD`, trailers, `git diff --stat` | 11 commits; QA and ci-cd only; files: `e2e.yml`, specs, support, `tests/stack`, unit tests, docs |
| `corepack yarn lint` | exit 0 |
| `corepack yarn jest tests/unit/harness tests/integration/harness` | 18 suites, 108 of 108 |
| `node --test` on `timeouts.test.mts`, `ac22-e2e-workflow.test.mts`, `serial-rule.test.mts` | 4/4, 13/13, 4/4 |
| Read diff of `e2e.yml`, `trashExit.ts`, `restartReady.ts`, `stack.ts`, `joplinWebApp.ts`, specs, strategy; read `healthServer.ts`, `stopTheWorldStrategy.ts:127` | as assessed above |
| grep of the diff for `.only`, `.skip`, `waitForTimeout`, `sleep(` | no hit |
| E2E and contract suites; push | not run (instructed) |
