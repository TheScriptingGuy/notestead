# Review: M1 close-out (branch `docs/M1-S8-ci-verify`), round 2

Verdict: APPROVE

**Summary.**
- Every r1 finding is fixed, and I checked each fix against the evidence or the code:
  - C1: the x64 records for M1-AC1–AC4 and M1-AC30–AC33 (QA, `98b80a8`).
  - C3 and C4: the superseded lines and the M1-AC12 count (QA, `a6682aa`).
  - C2: the ADR-0007 and ADR-0003 amendments and the M1.md wording (architect, `55a4be9`, `21389c2`).
  - P1: the STATUS rewrite (orchestrator, `3c532ca`).
- QA's correction is right. M1-AC30–AC33 have 26 W/P testcases per leg, not 36: `W00` + 16 `W-ac3*` + 9 `P0*`. The "36" in r1 was my arithmetic error.
- M1 now meets the definition of done:
  - every M1 acceptance criterion passes on arm64 and x64, and each one is recorded in its story plan;
  - lint and type checks are clean (r1);
  - the docs describe what was built;
  - QA has signed off every story, and the lead has approved every story and this close-out.
- Two nits remain, listed below as follow-ups.

## Code findings
None at blocker, major or minor level.

How each r1 finding was closed:
- **C1, closed.**
  - `M1-S1.md` §x64 (CI) gives M1-AC1–AC4 per AC on 37285783659 and 38881804157. I re-counted 50 `M1-S1-*` testcases per leg in both runs, and the `check:no-upstream-copy` log shows the stated "311 tracked file(s)".
  - `M1-S8.md` §x64 (CI) for M1-AC30 to M1-AC33 gives 26/26 per leg. I counted 26 on both legs of 38881804157, and 0 in 37285783659, which is consistent because these tests didn't exist yet. The step-outcome rule (M1-S3 finding 1) is applied too.
- **C2, closed.** Each statement in the amendments matches the code:
  - **ADR-0007 A1:** `tests/e2e/support/globalSetup.ts` and `NOTESTEAD_E2E_STACK` exist, and `tests/e2e` and `tests/stack` never call `clearDatabase`. `webWithoutHostRewrite` is in the spec and the fixtures.
  - **A3:** `playwright.config.ts:22` is `workers: ci ? undefined : 1`, so CI does use more than one worker. `tests/harness/playwright.selftest.config.ts:19` is `workers: 1`.
  - **A4:** `e2e.yml:192` is `playwright install --with-deps chromium`, `@playwright/test` is pinned at 1.59.1, `M1-S8-E07` exists, and no workflow sets `NOTESTEAD_CHROMIUM`.
  - **ADR-0003 A1:**
    - The ping runs before the sync, and a failed ping returns early (`stopTheWorldStrategy.ts:110-113`).
    - The exit code and signal are checked (`syncOutcome.ts:28`).
    - The `Completed:`/`Last error:` patterns are matched (`:22-23`).
    - The ping runs again after the sync (`:32`).
    - `locale: 'en_GB'` is set (`stopTheWorldStrategy.ts:53`), and the retry delay is 30 s (`:76`).
    - The ping checks `{"status":"ok"}`, and `JoplinClipperServer` is checked in `probes.ts`.
  - Both amendments keep the original text as history, say which section wins, and state their upgrade impact. The residual window and the upstream-first route in ADR-0003 are stated honestly.
  - **M1.md:** M1-AC21 step 3 and the M1-S6 fixture name are amended with dated notes.
- **C3 and C4, closed.** Every older PENDING or pending x64 line in M1-S1 to S9 now points to the section that closed it, and the history is kept. The M1-AC12 Tests column reads 9/9 and says where `ac12-s7-neg` was added.

**N1, nit:** `docs/backlog/STATUS.md`, §CI verification, first bullet. It reads "QA verified the first CI run (`d550c16`)". `d550c16` is the commit that recorded the verification. The run's head was `dc515fa` (`M1-S3.md` §2026-10-05). This wording predates this round. *Fix:* "the first CI run (head `dc515fa`, recorded in `d550c16`)".

**N2, nit:** `docs/backlog/STATUS.md`, follow-ups, the first item under "M2-S1 QA". It says "Since ADR-0007's serial rule, CI's Playwright runs with more than one worker". That reads as if the rule caused the worker count. *Fix:* "CI's Playwright already runs with more than one worker (`playwright.config.ts:22`), so ADR-0007 A3 applies: …".

On the coordinator's correction: the multi-worker note is filed under "M2-S1 QA (the next harness change)". That is the right place. M2-S1 is the first story to add E2E specs to the shared stack, and ADR-0007 A3 binds them.

## Process findings
None.
- Each commit touches only files its agent owns:
  - QA: `docs/test-plans/**`;
  - architect: `docs/adr/**` and `docs/backlog/M1.md`;
  - orchestrator: `docs/backlog/STATUS.md`.
- Subjects use `docs(test-plans)`, `docs(adr)`, `docs(backlog)` and `docs(status)`, each with the correct `Agent:` trailer.
- Each commit body names the r1 finding it closes.
- QA flagged and explained the reviewer's arithmetic error instead of padding the count to 36. That was the right call.

## Follow-ups
- N1 and N2: the orchestrator, at its next STATUS edit. They don't block the close-out.
- **Before M2-S1:** nothing more is owed. The M1 close-out items from r1 are done. Everything else in STATUS stays as classified in r1, and STATUS now groups it by due story. The "M2-S1 QA" group is work for M2-S1 itself (the A3 serial rule for new specs, the `ac20` leak printing, the harness nits), not a precondition for starting it.

## Verification
| Command | Result |
|---|---|
| `git log --format='%h %an %s%n%b' 335467e..HEAD` and `git show --name-only` per commit | 5 commits; the file sets and `Agent:` trailers are as listed above |
| `grep -c` of `M1-S1-*` and `M1-S8-(W\|P)*` testcases in `acceptance-{X64,ARM64}.xml` of 37285783659 and 38881804157 | S1: 50 / 50 / 50 / 50. S8 W/P: 0 / 0 (37285783659, before M1-S8), 26 / 26 (38881804157) |
| `check-no-upstream-copy-*.log` (38881804157) | `OK. 311 tracked file(s) …` and `OK. No tracked file … carries upstream's licence header` on both legs |
| `grep` of `playwright.config.ts`, `tests/harness/playwright.selftest.config.ts`, `tests/e2e/support/{globalSetup,fixtures}.ts`, `.github/workflows/e2e.yml`, `package.json`, `tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` | match ADR-0007 A1–A4 as quoted above |
| `grep` of `packages/headless/src/{syncOutcome,stopTheWorldStrategy,probes}.ts` | match ADR-0003 A1 conditions 1–5, `en_GB`, the 30 s retry and `JoplinClipperServer` |
| `git log -1 d550c16` | `test(m1): record first CI run verification` (N1) |
| Lint and type checks | not re-run: this round changes only Markdown under `docs/`. `corepack yarn lint` passed at `0066c91` (r1) |
