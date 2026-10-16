# Review: M1-S8 follow-up, `ac12-s7` portable to podman 4.9 (round 1)

Verdict: APPROVE

- **Scope.** Branch `fix/M1-S8-ac12-podman49` at `6b7fd0d`, against `main` `cf053b4` (also the merge base). There are two QA commits, `358ad72` (the harness fix and its negative control) and `6b7fd0d` (the first `e2e.yml` run recorded as X1–X9). Only `tests/**` and QA-owned docs changed. There is no product, deploy, workflow or ADR change.
- **Result.** The assertion is **stronger**, not weaker:
  - Before, the test checked only "no process uid is 0".
  - Now it checks that every process runs as exactly the image's USER on the container side, and that none maps to host root or the podman user on the host side.
  - Every check from before is still there: `Config.User` is not root, and `ReadonlyRootfs=true`.
  - The host-side predicate is sound for rootless podman. I probed it myself on the Pi (below).
  - The negative control fails every one of `ac12-s7`'s predicates.
- **Evidence.** The recorded X1–X9 match the evidence I re-read, with one counting nit (X6).
- **Findings.** No blocker or major. There are two nits, both follow-ups. X1, X3 and X4 still need to be re-verified on the first `e2e.yml` run after the push, as the plan already says.

## Rulings on the focus questions
**1. Not weakened; the host-side check is sound.**
- Every check from the old test is still there (`static.test.ts:169-174`, `:181`). The container-side check is now an allow-list, which is stricter than "no 0": `!identity.names.has(p.user)` at `:178`. It still covers root, because `configuredIdentity` rejects a USER whose uid resolves to 0 (`:174`).
- The host-side check (`:180`, set at `:69`) flags host `root`/`0`, plus the username and uid of the user running Jest, which is the user running podman.
- My probe on the Pi (podman 5.4.2, rootless, uid 1000), with `caddy:2-alpine`:
  - `--user 65532:65532` gives `USER 65532`, `HUSER 165531`, a subuid. Not flagged.
  - `--user 0:0` gives `USER root`, `HUSER 1000`. Flagged through `String(userInfo().uid)`.
- On the runners (rootless, the `runner` user), the same mapping applies. On a rootful host, container root is host `0`/`root`, which is also in the set.
- huser prints numerically when the host has no passwd entry. The set holds both the name and the uid, so either form matches.
- `processUsers` validates the header and the column count (`:48-53`). A podman failure becomes a harness error naming the command, with redacted stderr (`:43-46`), so it can't pass as an image finding.
- `pid`/`user`/`huser` are portable: the old `uid` descriptor still works on 5.4.2 (I checked), and QA's psgo 1.7.1 analysis matches the CI error text.

**2. The negative control really fails `ac12-s7`'s predicates.** `ac12-s7-neg` (`:184-197`) starts the same image, with the same hardening plus `--user 0:0`, and asserts three things:
- no process is the image's USER (the inverse of `:178`);
- every process is `root`/`0`;
- every `huser` is in `hostRootLike` (the inverse of `:180`).

Because `processes.length > 0` is asserted, both of `ac12-s7`'s predicates would fail on this container. It passed in my run, so the probe really detects root on podman 5.4. `extraArgs` (`services.ts:72-82`) defaults to `[]` and is appended after `hardening`, so the positive tests still run the image's defaults. The `web-root` container goes through `startContainer`, so `teardownStack` removes it. After my run, no `nst` container or image was left.

**3. No product code changed.** `git diff main...HEAD --name-only` lists only `tests/contract/m1-s4/static.test.ts`, `tests/contract/support/services.ts`, `docs/test-plans/M1-S4.md`, `docs/test-plans/M1-S8.md` and `docs/testing/strategy.md`. All of these are QA-owned.

**4. Commit types.**
- `358ad72 test(contract): …` is correct.
- `6b7fd0d test(contract): …` is acceptable, though it touches only `docs/test-plans/M1-S8.md`. See nit N2.

Neither type affects release-please versioning. Both commits carry `Agent: qa-specialist`.

**5. X1–X9 against the evidence** (`~/joplin-web-app-work/ci-evidence/38874722165`, `…/38874722136`, `…/38874722176`):

| ID | QA's claim | My check | Match |
|---|---|---|---|
| X1 | bundle success; both test jobs fail at step 8 only | `api/jobs.json`: the only non-success step in each test job is 8 (contract layer) | yes |
| X2 | `tests="3" failures="0" skipped="0" errors="0"` on both; C1-R1-guard, M1-AC21, M1-AC21 NEG | both `e2e/junit.xml` | yes |
| X3 | `success:false`, 15 suites, 86 tests, 85 passed, 1 failed (`ac12-s7`, `podman top … uid exited 125 … unsupported option (BSD syntax)`), 0 pending, 0 todo; ac18 3/3 | both `jest-results.json` | yes |
| X4 | open | follows from X3 | yes |
| X5 | `33e7aa62…f21d`, `b7e468ea…6045` in all three summaries | `run-page-snapshot.yml:163,205,361`; I re-ran `sha256sum -c` and both files are OK | yes |
| X6 | "16 NEG/control tests passed" | I count 17 passing: 14 `-neg`/NEG titles plus 3 positive controls (`c1r1-planted`, `c1-planted`, `ac20-content`) | **nit N1** |
| X7 | gate success, 10 runs, nothing removed | both `upload-gate.json`: `runs 10`, all removal and redaction counters 0. I did not repeat QA's own leak scan | yes |
| X8 | `/dev/root 145G, 71G used, 74G avail (50%)`; Mem 15989/14639 | `38874722136` log at 08:43:42 | yes |
| X9 | `ci.yml` success; 236 acceptance testcases each, 0 failures and 0 skipped; Jest 33/290 | `jobs.json`, both `acceptance-*.xml`, both step logs | yes |

## Code findings
No blocker, major or minor.

- **nit N3**, `tests/contract/m1-s4/static.test.ts:43-46`. The new harness-error branch for a failing `podman top` has no test.
  - **Failure scenario:** a future refactor turns this branch back into an assertion failure, or drops the command name from the message. Nothing notices until the next podman divergence on CI.
  - **Expected fix (optional follow-up):** a small test that runs `processUsers` against a nonexistent container and expects the "harness/podman problem" message. Not needed for this round. The branch is simple and was reviewed by reading.

## Process findings
No blocker, major or minor. This is a QA-owned harness fix with no implementer step, so the test-first ordering doesn't apply. The trigger was a red CI result, and the fix adds its own negative control. QA's local results and its note about the first attempt's syntax error are honest and match my re-run. The strategy doc now records the podman-version rule (`docs/testing/strategy.md` §7), so the lesson outlasts this fix.

- **nit N1**, `docs/test-plans/M1-S8.md` §First CI run, row X6. "16 NEG/control tests passed" doesn't match the Jest JSON. Both runners show 17 passing tests whose titles mark them as negative or positive controls: `ac15-neg`, `ac10-c1-neg`, `ac13-neg`, `c1r1-planted`, `c1r1-neg`, `c1-planted`, `c1-neg`, `ac12-neg`, `ac19-neg`, `ac19-neg-canary`, `ac19-neg-foreign-container`, `ac20-content`, `pid1-neg`, `ac23-neg`, `ac11-r3-neg`, `ac11-r5-neg`, `ac18-neg`.
  - **Failure scenario:** a reader comparing the re-run (which adds `ac12-s7-neg`) against "16" finds an unexplained off-by-one.
  - **Expected fix:** when X1/X3/X4 are re-verified, state the counting rule, and give the count for the new run.
- **nit N2**, commit `6b7fd0d`. This commit records results only in `docs/test-plans/M1-S8.md`. Recent precedent for that kind of commit is `docs(test-plans): …` (`b4e6330`, `329a11a`, `e030fe1`). Harmless for release-please. Use `docs(test-plans)` next time; don't rewrite the commit.

## Verification
Run on the Pi, one heavy job at a time, on `fix/M1-S8-ac12-podman49` at `6b7fd0d`:

| Command | Result |
|---|---|
| `git log --format='%h %an %s%n%b' main..HEAD` | 2 commits, both `Agent: qa-specialist` |
| `git diff main...HEAD --name-only` | 5 files, all `tests/**` or QA-owned docs |
| `podman run --user 65532:65532` / `--user 0:0` `caddy:2-alpine`, then `podman top <ctr> pid user huser` | `65532 / 165531` and `root / 1000`. Probe containers removed |
| `NOTESTEAD_WEB_ARTIFACT=~/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21 corepack yarn test:contract --verbose tests/contract/m1-s4` (the extracted real bundle from `web-bundle-v3.7.21.zip`) | exit 0: 4 suites, 29/29, including `ac12-s7` (782 ms) and `ac12-s7-neg` (1497 ms); 93.6 s. Afterwards only the user's `byparr` container exists, and no `nst` image is left |
| `corepack yarn lint` (eslint plus the three `tsc` projects) | exit 0 |
| `corepack yarn jest` | 33 suites, 290/290 |
| Evidence checks for X1–X9 (`jobs.json`, `jest-results.json`, `junit.xml`, `upload-gate.json`, `SHA256SUMS` with `sha256sum -c`, the job-summary snapshot, the bundle and `ci.yml` logs, the acceptance JUnit) | as in the table above; the only mismatch is N1 |

## Follow-ups
- After the push, re-verify X1, X3 (expect 87 contract tests, all passed on both runners) and X4 on the new `e2e.yml` run, and confirm X2 and X5–X9 still hold. Then append the x64 closures to the M1-S4 to M1-S7 story plans.
- N1: fix the X6 count and state the counting rule at that re-verification.
- N2: use `docs(test-plans)` for results-only commits.
- N3 (optional): a test of the harness-error branch of `processUsers`.
