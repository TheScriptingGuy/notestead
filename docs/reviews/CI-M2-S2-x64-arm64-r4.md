# Review: CI-M2-S2-x64-arm64, fix-forward after CI proof run 3 (e2e 40020973008), round 4

Verdict: APPROVE

**Summary.**
- Round 4 covers 5 commits after `b9951dd`: `ca576e0` (run-3 results, H, I, WO-20/21), `d953a1d` RED, `3e499ae` GREEN, `a1170c2` results, `7752875` (sign-off, merge criterion, DNS-1 split, `docs/test-plans/DNS-1.md`). Code changes are `tests/**` only, all by QA.
- H is a correct diagnosis: round 3 made headless ready on `/healthz`, so the AC18 self-test requiring podman `healthy` for headless contradicted it. The fix applies one rule to both the inner spec and the outer assertion without weakening `server` and `web`.
- I (the DNS 502s) is rightly kept out of the harness: M1-AC21 NEG is untouched and nothing waits or retries around it. The merge criterion is workable, with two wording minors.
- No blocker, no major. I re-ran lint (exit 0) and the Jest harness (110 of 110). No E2E or contract runs, and no push.

## Code findings

**C1, minor. `docs/test-plans/CI-M2-S2-x64-arm64.md`, merge criterion 3(a) (shape wording).**
- *Problem:* "an `Invalid origin`-free proxy error" is unclear, and "any E2E/contract step whose error names HTTP 502" is broader than the one known shape (M1-AC21 NEG's ping). Together with 3(b) it is still tight, because a same-second `lookup server` line is required.
- *Scenario:* a different step fails with a 502 from a real server fault that happens to share a second with a lookup line. It would be passed off as DNS-1.
- *Fix (QA, plan text):* list the allowed shapes as (i) M1-AC21 NEG's ping and (ii) a 502 that comes from `web` itself (response header or body from the proxy, not `server`'s own 502), and require the request time to come from the trace or network log, not from the test's error time.

**C2, minor. Criterion 3(b) clock basis.** "Same second" compares the request time with a Caddy log timestamp. A dial that fails with `i/o timeout` was started seconds before the log line (the resolver waits its timeout first). A real tie may then miss the same-second rule, which is the safe direction (it blocks rather than excuses), but QA should say so and say what happens then: the user decides, not QA.

**C3, nit.** `tests/harness/selftest/health.spec.ts` and `ac18-stack.test.ts` no longer look at podman health for headless at all. The `CMD-SHELL` check assertion remains, so the healthcheck definition is still required; that is enough.

### Assessment of the points you asked about

- **AC18 for server and web, and headless with a missing probe.** `selfTestHealthy` is `podmanHealth === 'healthy'` for `server` and `web`, exactly as before, and `healthz?.status === 200` for headless. A missing probe (`headlessHealthz` returns `undefined`, stored as `null`, read back as `undefined`) gives `false`, and so does a 503; `ac18-health-03` pins both. The outer assertion reads the same recorded values, so it is as independent of the inner run as before. The deviation from WO-20 ("outer unchanged") was needed, because the outer would otherwise still fail on podman lag, and it was recorded and accepted. `ac18-neg` is untouched.
- **Is the DNS-1 tie tight?** Mostly. Each failed attempt needs all of (a) shape, (b) a same-second `lookup server: i/o timeout` line in that test's `web.log`, and (c) a plan entry with test ID, attempt, request time and log line. Failures stay red and are not skipped, retried away or annotated. A flake outside the tie blocks; a retry-pass counts as flaky. See C1 and C2. Residual risk: (c) is QA's self-attestation; the lead should check the cited line against the artifact when run 4 is reviewed.
- **M1-AC21 NEG untouched.** No `walking-skeleton.spec.ts` or other E2E file is in the diff.
- **Test-first and the S-H2 attempt.** `d953a1d` (3 failed: `selfTestHealthy is not a function`) precedes `3e499ae`. S-H1 and S-H2 were temporary edits, reverted. The first S-H2 attempt did not apply its edit; it is kept as `sens/unedited-pass.log`, labelled a plain run, and not counted as the sensitivity result. That is honest. S-H1 is a weak sensitivity by nature (the rule ignores podman for headless), but S-H2 is the meaningful one and it failed with `/healthz 503 starting` in the message.
- **DNS-1 briefs.** Both are investigation only. The senior engineer's brief says "Options to evaluate, without implementing any yet" and "no fix without a decision"; the ci-cd brief is read-only, "propose, and do not apply". Starting the stack on the Pi and bringing it down again is covered by the leftover-stack rule. The briefs also keep the test changes with QA ("QA writes the regression test once a fix is chosen").
- **Round 3's Jest counts.** The difference between 18 suites/112 tests and 44/357 is explained (different commands). Accepted.

## Process findings

**P1, nit.** All five commits are `Agent: qa-specialist`, in `tests/**` and `docs/test-plans`; Conventional types are correct. No `packages/`, `deploy/` or ADR edits, no `.only`, skips or sleeps, no weakened assertion.

**P2, nit.** Accepting a known red on `main` departs from the Definition of Done. It rests on the user's recorded decision of 2026-10-24, which the plan states. The architect's note (ADR-0007 A1: for headless, "healthy" means `/healthz` 200) is correctly left as a non-blocking follow-up.

**P3, nit.** The merge criterion's item 3 puts the evidence entry on QA. Keep the DNS-1 failures listed in the plan's run-4 section with the artifact links, so the next review can verify them.

## Verification
- `corepack yarn lint`: exit 0.
- `corepack yarn jest tests/unit/harness`: 110 of 110.
- `git diff b9951dd..HEAD --name-only`: `tests/**` and `docs/test-plans/**` only; no walking-skeleton file.
- E2E and contract suites not run; I rely on QA's logs under `test-results/verify/ci-m2-s2/r4/`.
