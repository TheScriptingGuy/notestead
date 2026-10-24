# Review: DNS-1, the web proxy fails to resolve `server` (502), round 1

Verdict: APPROVE

**Meaning.** Per the plan, APPROVE here means "approved to combine" into `test/M2-S2-ci-x64-arm64`. It is not "done": DNS-1's E2E regression evidence (V5) and DNS1-AC5 (proof run 5) still have to come from the combined branch. Nothing goes to `main` before them.

**Summary.**
- Scope `main..HEAD`, 19 commits: SE investigation, ci-cd runner section, QA plan and RED tests and harness, the SE fix `385718b` (5 lines in `deploy/web/Caddyfile`, 3 in the README), the worklog and the VERIFY results.
- The diagnosis is sound and was reproduced with fault injection (Go's resolver waits 5 s per nameserver, Caddy's default dial timeout is 3 s, so one silent first nameserver gave a 502 at 3.00 s, the same duration as CI). The fix is the smallest one, in `deploy/web/` only, and it is proven by tests that were red first.
- No blocker, no major. Three minors, some nits. The most useful follow-up is tightening the WEB-SQLITE-1 tie (C3) before the user grants it.
- I re-ran lint (exit 0) and `jest tests/unit` (15 suites, 111 of 111). I did not run the contract or E2E suites (not requested); I rely on the QA logs for those, and on V5 and proof run 5 to confirm them on the combined branch.

## Code findings

**C1, minor. `deploy/web/Caddyfile:70-74` (the fix masks the symptom; the cause of the CI silence is unproven).**
- *Problem:* `docs/worklog/DNS-1.md` says why the first nameserver is silent on podman 4.9.3 (aardvark-dns) is a hypothesis. The fix lets Caddy wait for one silent nameserver (about 5 s). It does not help if the first server is silent longer than 10 s, or if both are silent (5 s + 5 s equals the 10 s dial timeout, a coin flip that fails as a 502 either way).
- *Scenario:* a CI runner where aardvark stops answering for 15 s: still a 502, now after 10 s.
- *Assessment:* acceptable. That is exactly what DNS1-AC5 (the scan's rule DNS1-C5 on proof run 5) is for, and the plan retires the finding-I tie so any `lookup server` line is a regression. The README says "up to about 5 s instead of a 502", which is honest. Keep AC5 decisive; do not close DNS-1 on the contract tests alone.

**C2, nit.** The `dns1-c1`/`c1-neg`/`c2-neg` timing windows (neg 2.5 to 4.5 s, fixed under 9 s) are tight on a loaded arm64 runner. Everything on the Pi is far inside them (5011 ms, 3008 ms). Watch them in proof run 5; if one flakes, discuss with QA rather than widening, because the bounds are planner-owned.

**C3, minor. `docs/test-plans/DNS-1.md`, WEB-SQLITE-1 tie (conditions 1 to 5).** Applying the same scrutiny as r4:
- *Tight enough:* it requires every failed attempt, first run and retry, to carry the evidence; it excludes DNS (`lookup` and 5xx), F-R2 and `SEED SYNC FAILED`; at most one tied test per runner; the failure stays red or flaky; and the tie expires.
- *Gap 1, symptom is not constrained.* Condition 1 asks only for a SQLite failure line "before the failing assertion". A test that fails for another reason (a timeout, a different UI regression) after an unrelated `rc=` warning earlier in the same run would qualify. Fix: require the failure to be a data or title/body mismatch consistent with a lost write (as V1c was), or the `openDatabase` IOERR shape, and the line to be within about 60 s before the failing step, in the same test.
- *Gap 2, the line shape of the first occurrence.* The CI occurrence (run 40075823250, `SQLITE_IOERR` on `CREATE TABLE migrations`) may not print as `sqlite3_step() rc=`. Say which exact lines count, with one example per known occurrence, so the tie neither misses the real failure nor accepts a lookalike.
- *Gap 3, expiry is ambiguous.* "After the next 3 proof runs" should say whether proof run 5 is the first of them. Count from 5.
- *Gap 4, x64.* The planner says the defect is "not arm64-CI-only", yet x64 gets no allowance. Stricter is safe; say that it is deliberate.
- *Gap 5, evidence is QA's attestation again.* As in r4, I will check the quoted console lines against the artifact in the next review.
- None of these blocks the combine; they matter when run 5 is judged. QA: amend the criterion before the user is asked to grant it.

### Assessment of the points you asked about

- **The fix.** `transport http { dial_timeout 10s }` sits in the shared `reverse_proxy` snippet, so both listeners get it. Caddy's dial timeout covers name resolution, which `c1` (200 at 5011 ms) proves. 10 s is right: it covers one silent server (5 s) with margin, stays under the AC3 ceiling of 15 s, and `c3d` (a dead server) answered 502 at 10006 ms. A refused connection still fails at once (`c3a` 15 ms). Dial retries are off by default (`lb_try_duration` 0), so nothing is resent and a POST is safe; `c2-neg` shows a 502 at the lookup means the server saw nothing. The Caddyfile comment, the README sentence ("within about 10 s (it was 3 s)") and the test bounds agree. `s1` pins 6 to 15 s.
- **Fault injection.** Podman writes the container's `resolv.conf`, so the harness derives its variants from podman's own file (via a throwaway probe container) and prepends a UDP sink that never answers. That exercises Go's first-nameserver path regardless of podman version, since the Go resolver's behaviour does not depend on who wrote the file; it does not prove why aardvark is silent on 4.9.3. Each fault case self-checks that the mounted file is what `web` sees and that the sink received queries (`delta > 0`). The Pi runs podman 5.4.2; the 4.9.3 coverage comes from CI proof run 5, which is the right place for it.
- **c1-neg and c2-neg.** Meaningful negative controls: the image's own Caddyfile with only the `dial_timeout` transport block removed (brace matched, `removedBlocks` recorded), same sink, same resolv.conf. They fail with 502 at about 3 s and the `lookup server: i/o timeout` line, which is the CI signature, and they went green on unfixed code and stay green on fixed code. If the block were reformatted so the strip missed it, the neg would fail loudly (200 instead of 502), not pass silently.
- **D1 for c2.** The note is compared field by field (title and body exact, every uploaded property present with the same value, `id` included; extra server keys `is_locked`, `extracted_resource_ids` recorded, not asserted), because Joplin Server re-serializes notes. The 256 KiB blob is compared by length and sha256, and both are checked as exactly once (listing, or blob metadata). Strength is kept where it can exist: byte-exact for the blob, complete property equality for the note. The parser has its own negative tests (`joplinItem.test.ts`).
- **`dns1-s1`.** The five-state matrix is recorded: unfixed is red only at `transport`, 10 s green, 3 s red at the lower bound, 20 s red at the upper bound, a transport block in an unrelated `reverse_proxy` red. The first red was declared void because the regex stopped at the `{` of the placeholder, which is honest.
- **The scan tool.** The planner independently recounted the unique `lookup server: i/o timeout` lines per run (4, 23, 47, 60, 91 = 225) and showed ci-cd's 233 included 8 NXDOMAIN lines; the expectation was corrected to the data, not the data to the expectation. Dedupe keys on the whole raw line (Caddy's `ts` is sub-millisecond), and the tool reports each file's contribution. Four single mutations were each caught by a named test; none survived.
- **WO-4 device hardening.** `enableE2ee` is now async; its only two callers (`upDefault`, the `e2eeAccount` fixture) both `await` it, and lint/tsc are clean. The device exits 3 with `SEED SYNC FAILED: <line>` if the output lacks `Completed:` or has `Last error:`, never retries (a retry would hide a 502), and the harness reads `info.json` directly from the server and requires a master key and `e2ee.value: true`. The error message carries the reason and a log path only; the device log is redacted with the known secrets. Safe for every caller. `dev1-neg` was red before the hardening and green after.
- **V1c, V1c' and the m1-s7 deviation.** Honest, and not hiding a DNS-1 regression. V1c's failure shows a lost title save with a browser SQLite write failure 1.4 s after typing, and 0 `lookup` lines and 0 5xx with every proxied request 200; V1c' shows the F-R2 signature (`Starting scheduled sync`, then `Sync: cancelling` 137 ms later), whose fix `78d3c4d` is on the CI branch. Neither is counted as a pass, and the verdict line says the E2E regression moves to V5. The m1-s7 failure was the planner's command omitting `NOTESTEAD_WEB_ARTIFACT`; the re-run alone was 11 of 11, recorded as a deviation. The WEB-SQLITE-1 title-loss mechanism is a hypothesis and is labelled one.

## Process findings

**P1, nit.** Test-first holds. `0be311d` (c-tests RED), `8e00acb` (device RED) and the s1 test precede the fix `385718b`, and `630507f`/`625b1d2`/`266c0ed` are QA's own test and harness commits. The SE's three commits (`8513a0d`, `385718b`, `5d59f5c`) touch only `docs/worklog`, `deploy/web/Caddyfile` and `deploy/web/README.md`; none touches `tests/**` or ADRs. All `tests/**` commits are `qa-specialist`.

**P2, nit.** The WO-7 stop and its planner decisions (D1 to D3) were handled as disputes in the plan, with accepted deviations listed (stub in the RED commit, `<id>.md` names, dedupe, nested describe). No assertion was weakened; the two test bugs were fixed in the tests and re-proven.

**P3, nit.** The `fix(web)` subject will trigger a release-please patch note, which is right: it is user-facing.

**P4, nit.** The SE's optional `dns_opt` hardening for the test stack and the M5 user compose is correctly left as a follow-up, not smuggled into this story.

## Verification
- `corepack yarn lint`: exit 0.
- `corepack yarn jest tests/unit`: 15 suites, 111 of 111.
- `git diff main..HEAD -- deploy`: Caddyfile +5, README +3, nothing else under `deploy/`, `packages/` or ADRs.
- `git log main..HEAD -- tests`: only `qa-specialist` commits; the SE's commits touch no test file.
- Contract and E2E suites not run by me; V1b (15 of 16, then m1-s7 11 of 11) and V1c/V1c' are QA's, read from the plan.

## What the combined branch must still show
V5 on the Pi: lint and unit, the full contract layer (`dns-1` 13 of 13), the full E2E suite (16 tests, LOC specs included). Then proof run 5: DNS1-AC5 on both runners (no `lookup server` line, no 5xx), x64 fully green, arm64 green except a WEB-SQLITE-1 failure that meets the amended tie, if the user grants it.
