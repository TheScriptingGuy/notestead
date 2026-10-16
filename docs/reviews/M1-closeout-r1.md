# Review: M1 close-out (branch `docs/M1-S8-ci-verify`), round 1

Verdict: CHANGES_REQUESTED

**Summary.**
- The four QA commits (`a06f0c5`..`0066c91`) record the second CI run accurately. I re-derived every spot-checked number from the evidence: 87/87 contract on both runners, `ac12-s7` and `ac12-s7-neg` by name, 3/3 E2E with no retry, the gate counts, SHA256SUMS, 236/290 in `ci.yml`, and the X6 control counts of 17 and 18 under the stated rule. I found no mismatch.
- Every M1 acceptance test passes on arm64 and x64. That includes M1-AC1–AC4 and M1-AC30–AC33, which I confirmed in the x64 JUnit of `ci.yml` 38881804157.
- **M1 does not yet meet the definition of done as written**, for two reasons. (1) Eight ACs have no recorded x64 sign-off, and `M1-S1.md` still says "x64: pending". (2) Several as-built M1 deviations that earlier reviews accepted "pending architect" are still not in the ADRs or `M1.md`, so "Docs are updated" doesn't hold.
- Both gaps are documentation only, small, and owned by QA, the architect and the orchestrator. Credit to QA: M1-AC12 was held at "pending" in `8b9d25e` until the per-test JSON confirmed it in `0066c91`. QA also read retries from the report data rather than trusting the exit code, and documented W1 carefully.

## M1 acceptance criteria: arm64 and x64

| AC | Story | arm64 | x64 | x64 recorded in plan? |
|---|---|---|---|---|
| M1-AC1–AC4 | S1 | PASS (Pi 2026-10-04) | PASS: M1-S1 testcases 50/50 in `acceptance-X64.xml` of 37285783659 (M1-S3 V2) and of 38881804157 (re-checked by me: T0* 15, T1* 27, T2* 5, T3* 3) | **No.** `docs/test-plans/M1-S1.md:62` says "x64: pending" (C1) |
| M1-AC5 | S2 | PASS, packaging half (the full build is x64 by design) | PASS, T90 in 37285783648 | yes, M1-S2.md §2026-10-05 |
| M1-AC6, AC7 | S2 | PASS | PASS | yes |
| M1-AC8, AC9, AC27 | S3 | PASS | PASS (V1–V8) | yes, M1-S3.md §2026-10-05 |
| M1-AC10–13, AC28 | S4 | PASS | PASS, 38881804121 | yes (this branch) |
| M1-AC14–17, AC23 | S5 | PASS | PASS (amd64 for AC23) | yes (this branch) |
| M1-AC18–20, AC34 | S6 | PASS | PASS | yes (this branch) |
| M1-AC21 + NEG | S7 | PASS (Pi, 1 worker) | PASS, no retry | yes (this branch) |
| M1-AC22 | S8 | PASS static; CI arm runner PASS | PASS, X1–X9 | yes (this branch) |
| M1-AC30–AC33 | S8 | PASS | PASS: `W-ac3*` 16 and `P0*` 9 testcases on both legs of 38881804157 | **No.** The per-AC rows at `M1-S8.md:236-239` and the sign-off at `:282`/`:372` are arm64 only (C1) |
| M1-AC24–26, AC29 | S9 | PASS | PASS | yes, M1-S9.md §2026-10-05 |
| S6a C1/C2/C4 (non-AC) | S6a | PASS | PASS | yes (this branch) |

M1 exit criteria: all ACs green on the Pi (yes); the CI workflows exist and pass actionlint (M1-AC8, yes); CI started only after the user approved the first push (2026-10-05, yes).

## Code findings

**C1, major: the per-AC x64 sign-off is missing for M1-AC1–AC4 and M1-AC30–AC33.**
- `docs/test-plans/M1-S1.md:62`
- `docs/test-plans/M1-S8.md:236-239`, `:282`, `:372`

*Problem.* The close-out claims every M1 AC is signed off on x64. M1-S1's plan still states "x64: pending" and has no CI section. M1-S8's AC30–AC33 rows and sign-off cover arm64 only, and the X4 table lists M1-S8 as "M1-AC22" alone. The tests themselves are green on x64 (verified above), so this is a gap in the record, not in the product.

*Failure scenario.* Anyone auditing the DoD, for example at the M5 pre-publish gate or after a pin bump, finds a plan saying x64 is pending for the scaffold and pin checks, and can't tell whether that was ever closed.

*Expected fix.* QA appends an `### x64 (CI)` section to `M1-S1.md` citing 37285783659 (V2) and 38881804157, per AC with test IDs and counts. QA adds an x64 column or rows for M1-AC30–AC33 in `M1-S8.md` (36 W-/P- testcases on both legs of 38881804157) and puts them in the X4 table's M1-S8 row.

**C2, major (milestone; owner architect): as-built M1 deviations are still undocumented in the ADRs and the backlog.**
- `docs/adr/0007-test-strategy-and-harness.md`: no amendment after 2026-10-04.
- `docs/adr/0003-headless-cli-supervisor-and-sync-strategy.md`: no sync-success rule.
- `docs/backlog/M1.md:177`: still says "as `user1`".

These are tracked as open in `docs/backlog/STATUS.md:77`, `:94`, `:121` and `:142`.

*Problem.* Earlier reviews accepted these as "pending architect":
- the harness runs one compose stack per run in globalSetup;
- the fixture is named `headlessService`;
- tests that stop a shared service run serially when there is more than one worker;
- Chromium is installed on the CI runner (ADR-0007 §CI);
- the supervisor decides sync success from `joplin sync`'s `Completed:`/`Last error:` lines, the `locale` setting and `/api/ping` (ADR-0003);
- M1-AC21 actually uses a fresh per-test E2EE user.

The DoD says "Docs are updated", and the lead checklist forbids undocumented architectural change. M1 can't be closed while its own as-built design differs from its ADRs.

*Failure scenario.*
- M2-S1's QA writes the new E2E specs from ADR-0007 as written, without the serial rule. When CI moves to more than one worker, a test that stops the shared headless service breaks its neighbours.
- An M3 engineer changes the CLI locale or the sync parsing without knowing that readiness depends on English output lines.

*Expected fix.* One architect `docs(adr)` / `docs(backlog)` commit: amend ADR-0007 (C3 and §CI Chromium) and ADR-0003 (the sync-success rule), and reword M1-AC21 step 3.

**C3, minor: sign-off lines that the new sections supersede were left unannotated.**
- `docs/test-plans/M1-S4.md:213`
- `docs/test-plans/M1-S5.md:136`, `:199`
- `docs/test-plans/M1-S6.md:123`, `:210`
- `docs/test-plans/M1-S7.md:114`
- `docs/test-plans/M1-S6a.md:124`
- `docs/test-plans/M1-S8.md:96`, `:240`, `:282`

*Problem.* These still say "x64 PENDING-CI" or "pending first CI run". The S6a and S7 sign-offs were updated in place; S4, S5 and S6 were not.

*Failure scenario.* A reader who greps for `PENDING` or reads only the "Sign-off" paragraph concludes that x64 is still open.

*Expected fix.* Append "(superseded 2026-10-16: see §x64 (CI))" to each line. Keep the history; don't delete it.

**C4, nit: the Tests column of the M1-AC12 row is stale.** `docs/test-plans/M1-S4.md:176` still says "`ac12-s1`–`s7`, `ac12-neg`: 8/8", while its own x64 cell reports 9/9 including `ac12-s7-neg`. Add `ac12-s7-neg` and make the column 9/9.

## Process findings

**P1, minor (owner orchestrator): `docs/backlog/STATUS.md` is stale for the close-out.**
- `:11`: "next: re-verify X1/X3/X4 …".
- `:47`: "Still open: M1-S4 … M1-S8 x64".
- Many follow-ups that are done are not struck through:
  - M1-S3 C1–C5 (now M1-AC30–33);
  - "before the first push" `ci.yml` checks;
  - the M1-S9 AC26 lockfile source and the licence exceptions;
  - M1-S5 "M1-S8: x64 evidence";
  - M1-S6 C5 and the M1-S8 items;
  - M1-S6a C1-R2, C4-R3 and FU-S6a-1;
  - M1-S7 hand-over, C1-R1a and C1-R1b;
  - M1-S8 "first CI run" and "run results".

*Failure scenario.* M2 planning reads closed items as open, or misses the real open ones among them.

*Expected fix.* Update the M1 row and close the "Pending CI verification" block once C1 and C2 land. Strike the done items, and keep the deferrals below.

Credit, and no finding:
- All four commits touch only `docs/test-plans/**` and are owned by QA.
- Each has a `docs(test-plans)` subject, which adopts the nit from M1-S8-fix-ac12-r1, and the correct `Agent: qa-specialist` trailer.
- The commits are small and focused, and no test or config was touched.
- The X6 counting rule is reproducible: applying it mechanically to the Jest JSON gives 17 (14 + 3) for 38874722165 and 18 (15 + 3) for 38881804121.

## Follow-up classification (STATUS.md open items)

**Blocks the M1 close-out** (documentation only):
1. QA: C1, the x64 records for M1-AC1–AC4 and M1-AC30–AC33. C3 and C4 go in the same commit.
2. Architect: C2, the ADR-0007 amendments (C3 harness rules, §CI Chromium), the ADR-0003 sync-success rule, and the M1-AC21 step 3 wording.
3. Orchestrator: P1, the STATUS update. Then tag M1 done.

**Must land before M2-S1 starts:** the close-out items above, especially the ADR-0007 amendment. M2-S1 is a QA E2E story that extends the same harness, the `headlessService` fixture and the compose stack. Nothing else in STATUS gates M2-S1.

**Deferrable to the named later story:**
- **M2-S2/S3, when needed:**
  - `e2eeAccount` seeds a to-do with `todo_due`, a tag and an attachment (M1-S6 C3 note).
  - C-N2: check in the UI that the body is decrypted (M2-AC2 covers it).
- **Next QA harness touch (M2-S1 is fine):**
  - M1-S8 C2: report `ac20` leaks without the surrounding text. The values are throwaway, but CI logs of a public repo are public.
  - C-N1, C-N3, C1-R4, C2-R5.
- **Before M3/M4 mix sync and MCP:**
  - the "one headless sync" helper moves to M3's manual trigger;
  - the M3-AC1 test where ping answers but sync fails;
  - the architect's decision for accounts without E2EE;
  - the optional "no init" in `/status`.
- **M4:** C1-R6 (token rotation mid-test).
- **Before M5-S4 (tunnel) / M5 pre-publish:**
  - `Cache-Control` on static 404s;
  - the architect's ruling on stripping `Cf-Access-Client-Id`/`-Secret`;
  - the OCI label override;
  - the `provenance.ts` source-URL bug;
  - recording the sqlite3 prebuilt-binary checksum gap and choosing its remedy (ADR-0009 A4);
  - `verify` hash-checking screenshots and other replaced binaries;
  - the tarball reproducibility;
  - the release-please `bootstrap-sha`/`exclude-paths` for P-R1 and P1 (M5-S3).
- **M6 or any pin-tooling story:** M1-S9 C1 (`check:pin` alias hole), C2 (ADR-0010 exception-text wording), C3, C4/P1.
- **Anytime, low priority:**
  - the optional Jest JUnit reporter;
  - M1-S8 C1 (podman action lingering and network backend);
  - the e2e timeout tuning;
  - the harness-error path when `podman top` fails;
  - M1-S2 cache cleanup and the T90 note wording;
  - the M1-S4 nits;
  - the M1-S8 nits C3–C5;
  - the upstream issue proposals (user or orchestrator).
- **Standing:** accepted risk A1; the Node 24 trace workaround stays; watch item W1 (profile the headless restart if an x64 run comes within 20% of a bound).

## Verification
All commands ran on the Pi, read-only against the evidence, with scripts in the session scratchpad.

| Command | Result |
|---|---|
| `sha256sum -c --quiet MANIFEST.sha256` in `ci-evidence/38881804121` and `…/38881804157` | OK (677 and 403 entries) |
| `sha256sum artifacts/*.zip` vs `api/artifacts.json` digests (38881804121) | all 3 match |
| Jest JSON parse, `contract/jest-results.json`, both runners | `success: true`, 15 suites, 87/87, 0 failed, pending or todo; every file fully passed (S4 29, S5 13, S6 18, S6a 16, S7 11); all `invocations: 1`; `ac12-s7` 284/235 ms, `ac12-s7-neg` 492/405 ms |
| `git ls-tree -r 4dc0cf5 tests/contract \| grep -c .test.ts` | 15, so every committed contract file ran |
| X6 rule applied to the Jest JSON | 38881804121: 15 neg + 3 pos = 18; 38874722165: 14 + 3 = 17; all passed |
| `e2e/junit.xml`, both runners | `tests="3" failures="0" skipped="0" errors="0"`; x64 M1-AC21 204.0 s, NEG 294.2 s |
| Playwright HTML report, base64 data zip decoded | `flaky: 0, unexpected: 0`; each test has a single result with `retry: 0`, on both runners |
| Step-9 logs | `3 passed (9.9m)` and `3 passed (6.6m)` |
| W1 step data | x64 `headlessService` 76 s, "one headless sync" 76 s and 108 s; arm 42 s and 8 s, as recorded |
| `upload-gate.json`, both runners | 10 runs, all complete, 0 removed; planted, dirs, files redacted and files removed all 0 |
| `image-import.log`, both runners | `verify: OK`, `import: OK. 64 files (29765121 bytes)` |
| `sha256sum -c` of `extracted/web-bundle-x64/SHA256SUMS` | OK. `33e7aa62…f21d` and `6b7ded31…973f` appear 3× in the run-page snapshot and equal the SHA256SUMS of 38874722136. The bundle job log shows a cache hit on the `web-bundle-9f6f…-c5f0…` key |
| `api/run.json` `head_sha`, both runs | `4dc0cf5ecdee…` (= `main`) |
| `acceptance-{X64,ARM64}.xml` (38881804157) | 236 testcases each, 0 failure, skipped or error; identical name sets |
| `ci.yml` step logs | node:test `tests 236, pass 236, fail 0`; Jest `33 passed`, `290 passed` on both runners. The extra `tests 1 / fail 1` block is the arm64 interlock NEG (step 11), which ends `OK: the T90 interlock refused (exit 1)` as designed |
| First-run figures quoted in the plans (38874722165) | `m1-s5/headless` 447 s, `c1-pertest` 90 s, `c1r1` 144 s, M1-AC21 69.4/129.7 s, `3 passed (4.9m)`, E2E step 4m 57s: all match |
| `git diff --name-only cf053b4 4dc0cf5` | docs, `tests/contract/m1-s4/static.test.ts` and `tests/contract/support/services.ts` (a no-op `extraArgs = []` default, imported by M1-S4 and `ac34`, not by M1-S5). The plans' "no product change" claims hold |
| `corepack yarn lint` (eslint and `tsc --noEmit`) at `0066c91` | exit 0, 60 s |
| `git show --name-only` for each commit in `main..HEAD` | only `docs/test-plans/*.md`; 4/4 have `Agent: qa-specialist` |
