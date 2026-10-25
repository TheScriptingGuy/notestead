# Review: CI-M2-S2-x64-arm64 and DNS-1, combined branch, round 5 (final)

Verdict: APPROVE

**Summary.**
- Scope: the commits after `f3261ec` on the combined branch `test/M2-S2-ci-x64-arm64`: `0d5442c` (tie tightening), the merge `cbcf075`, `2cc2932` (V5), `d273371` (V3 on proof run 5), and the architect's `8887f52` and `f5daaa2`. Proof run 5 is e2e `40102184409` and ci `40102184392`, both `success` on head `2cc2932`, both runners.
- I checked the evidence myself against the downloaded artifacts: the arm64 flake lines and hash, the DNS scan on both runners, the merge resolution, and the must-show list. All hold.
- The re-scope (user decision, 2026-10-25) is recorded honestly in the backlog. The two test plans do not record the decision or the QA sign-off yet (C1, P1): a docs follow-up for QA before the merge, not a blocker.
- No blocker, no major. Lint exit 0 and `jest tests/unit` 20 suites, 139 of 139 at HEAD. I did not run contract or E2E suites; proof run 5 and V5 are the evidence for those.

## Code findings

**C1, minor. `docs/test-plans/DNS-1.md` (results section) and `docs/test-plans/CI-M2-S2-x64-arm64.md` (proof-run-5 cross-reference): the user's decision is not recorded in either plan.**
- *Problem:* both plans still say DNS1-AC5 is "FAIL" and "if the user chooses (B)", and the CI plan says "the combined merge is blocked only by DNS1-AC5". The decision of 2026-10-25 (AC5a passes, AC5b is DNS2-AC4) is only in `docs/backlog/M2.md`.
- *Scenario:* someone reading the plan for the sign-off sees an open FAIL and a blocked merge.
- *Fix (QA, one `docs(test-plans)` commit before the merge):* append the decision, the AC5a PASS per runner, and QA's sign-off line to both plans; keep the FAIL for the original AC5 visible as history.

**C2, nit. `tests/harness/tools/scan-proxy-dns.ts`: the `dev1-neg` exclusion is by reading, not by the tool.** The tool lists every device log with `Last error` (`devicesWithLastError`), and QA's rule "exactly one named `device-dev1-neg.log`" is applied by eye. It is correct on both runners (exactly 1 each, `contract/m1-s5/device-dev1-neg.log`), but DNS-2 will rely on the scan every run; a small `expectedControl` check in the tool would make a missing or extra control fail loudly. Follow-up for DNS-2's QA.

### The five things you asked me to check

**1. The M1-AC21 NEG flake (arm64): verified.**
- The file `…/m1-s7-walking-skeleton-M1--28340--and-the-note-never-appears-chromium/browser-console.log` has sha256 `3422e165447f8dc6844eb5144ca99c98b6972262003c09686748ee7a888cc8b5`, matching QA's. Lines 33 to 35 are exactly as quoted: `[warning] sqlite3_step() rc= -1 … SQL = COMMIT` (14:41:18.321), `rc= 1 SQLITE_ERROR … ROLLBACK` (.322), and `[error] … root: Startup failure during task: buildStartupTasks/openDatabase` (.325). The page's first console line is 14:41:15.618, so the failure is 2.7 s after load.
- The attempt's `error-context.md` shows the failing wait (`locator.waitFor` on the Synchronisation dialog, 180 s) and a page snapshot reading "Startup error." That is T2 shape B, and it fits: the app never started.
- No other cause: `web.log` (606 lines) and `web-without-host-rewrite.log` have 0 `lookup` and 0 `dial tcp` lines and no 5xx; the console has 0 `cancelling`; no `SEED SYNC FAILED`. The five proxy lookup failures of the run are at 14:45 to 14:46, after this attempt.
- The job log shows `15 passed, 1 flaky` and `(retry #1)` on this test only.
- *Is "a flaky pass needs no tie" consistent with what I reviewed?* It is consistent with the combined criterion as written ("every test passes", Playwright counts a retry-pass as passed) and with T4, which I reviewed in DNS-1 r1 and did not object to. But it is looser than the CI-M2-S2 rule I accepted in r4 ("flaky 0 with every retry 0 on x64"; "a flake outside the DNS-1 tie blocks"). That r4 rule was written for finding I and replaced by the combined criterion. The outcome is the same either way here: this flake meets every element of the tie (arm64, shape B, S then E 4 ms apart, inside 60 s of load, T5 clean, one test). I accept it as WEB-SQLITE-1's third occurrence, and as using one of the three tie runs (T8). The tie status is "applied" for the record. For the future, the plan should say in one line: **a flake that does not meet the tie shapes is a failure, not a pass**. Otherwise "flaky needs no tie" would let any unrelated flake through on arm64. See P2.

**2. The DNS1-AC5 scan: verified.** I re-ran `node tests/harness/tools/scan-proxy-dns.ts` on both extracted dirs.
- x64: `oldSignature` 0; `otherDurationLines` 2 (10.00065 s and 10.00097 s), both in `contract/m1-s7/c1r1/stack/nst-e2e-mvmhztvr9e525e_web_1.log`; `nxdomainLines` 1 (M1-AC20, which stops `server` on purpose); `devicesWithLastError` exactly 1, `device-dev1-neg.log`.
- arm64: `oldSignature` 0; `otherDurationLines` 3 (10.00110, 10.00159, 10.00806 s) in `e2e/stack/nst-e2e-mvmi7jja11484d_web_1.log`; `nxdomainLines` 1; `devicesWithLastError` exactly 1, `device-dev1-neg.log`.
- So 0 lines under 9 s, none between 3 and 10 s, and the figures equal QA's. AC5a passes on both runners. The count expectations were not tuned: the tool's output is the source and the two lists are the 10 s lines AC5b would fail on.

**3. Merge resolution: lossless.** `git diff cbcf075^2 cbcf075 -- docs/test-plans/DNS-1.md` is empty, so the merged file is the story branch's file whole, including the amendment. The CI branch's own `DNS-1.md` (38 lines) held only the two briefs; both are in the merged file's History section (only the heading level changed). The merge touched nothing else on the CI side: `CI-M2-S2-x64-arm64.md` is unchanged by it, and in `tests/e2e` only `fixtures.ts` changed (the `await enableE2ee`).

**4. The re-scope in the plans and backlog.**
- Backlog (`docs/backlog/M2.md`, `8887f52`): honest and complete. DNS1-AC5a is stated (0 lines under 9 s, 0 device logs with `Last error` apart from `dev1-neg`, the NEG that reproduces the 225 lines) and passes; AC5b is stated as written, with "proof run 5 failed it, 2 lines on x64 and 3 on arm64, all at 10.0 s", and moved to DNS2-AC4. DNS-2 is defined with an owner, goal, a hypothesis labelled as unproven, DNS2-AC1 to AC5 (runner evidence step that writes and installs nothing; a `dns-watch` probe with a NEG; mitigation chosen from evidence; three consecutive `main` runs with 0 lines of any duration; no DNS-1 regression), and the mitigations with their trade-offs. The rule while DNS-2 is open is explicit: the 10 s lines stay visible in every scan, no allowance, no tie, no retry-until-green, and a test failure with a `lookup server` line is a FAIL.
- ADR-0007 A1 note (`f5daaa2`): correct. It says that for `headless`, "healthy" means the supervisor's `/healthz` is 200, which happens only after the first sync and decryption succeed (`compose.headless.yaml:38`, M1-AC15). It points at CI-M2-S2 F to H.
- Plans: see C1 and P1. The DNS-1 plan does say honestly that the 10 s lines remain, that AC5 as written fails, and that no DNS tie exists.

**5. The CI-M2-S2 must-show list on run 5: met.**
- Both runners: contract 16 suites and 100 of 100; E2E x64 16 passed (11.2 m, `junit.xml` 16 tests, 0 failures); arm64 15 passed plus 1 flaky (13.4 m), one `[notestead] FAILED` line (the flake's first attempt); `redaction-complete.json` has `complete: true` on both (x64 0 redacted files, arm64 15 from the failed attempt); `upload-gate.json` is complete for every contract dir; `CI-M2S2-LOC-01/02` pass; M2-AC3 and M2-AC5 pass with no `retry #` marker; `c1-pertest-secrets` passes (203 s x64, 76 s arm64, no 600 s wait).
- The `ci` workflow run `40102184392` is `success` on both jobs. Proof run 2's G (the 600 s headless wait) did not recur in runs 3 to 5.

## Process findings

**P1, minor. Sign-off and decision trail.** QA's sign-off for the merge is conditional in the plan ("subject to the lead's T9 check") and recorded nowhere afterwards. With C1, QA should append: the user's decision, my T9 check result (done, in this review), and the sign-off.

**P2, minor. `docs/test-plans/DNS-1.md` T4 ("a flaky test needs no tie").** As the third bullet of check 1 says, add the guard that a flake not meeting the tie shapes is a failure. Also: QA's remark "the orchestrator's premise is mistaken" is right on the text but should name that it differs from r4's rule, so the change is visible.

**P3, nit. Commit hygiene.** `d273371`, `2cc2932` and `0d5442c` are `qa-specialist` docs-only; `8887f52` and `f5daaa2` are `architect` docs-only; the merge is `orchestrator` with `--no-ff` and the conflict resolved as the plan said. No code, test or ADR-other-than-A1 change in this range. The first-parent history keeps the test-first order of both stories.

**P4, nit. WEB-SQLITE-1 is now three occurrences, all on arm64.** The plan routes it to M2-S3's queue first; I agree it can silently lose a user's edit and should outrank other M2-S3 work.

## Verification
- `corepack yarn lint`: exit 0. `corepack yarn jest tests/unit`: 20 suites, 139 of 139.
- `sha256sum` of the arm64 NEG `browser-console.log`: matches. Lines 31 to 36 read and compared.
- `scan-proxy-dns.ts` on both extracted dirs: outputs as above.
- `git diff cbcf075^2 cbcf075 -- docs/test-plans/DNS-1.md`: empty. CI-side briefs present in the merged file.
- `api/run.json` of both runs: `success`, head `2cc2932`; `jobs.json` of the ci run: both jobs `success`; `junit.xml`, `redaction-complete.json`, `upload-gate.json` and the two job logs read.
- Contract and E2E suites not run by me.
