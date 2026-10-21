# Review: CI-e2e-browser-gate, browser gate and apt guard in `e2e.yml` (branch `ci/e2e-browser-gate`), round 1

Verdict: APPROVE

**Summary.**
- This is a small pipeline fix: seven commits on `main` 7b19554. QA wrote the failing tests first (`a2e89af`, `f11b7a9`), the ci-cd-specialist changed `.github/workflows/e2e.yml` only (`1e58941`, `0aa81a9`), and QA verified (`7e3c139`). The diff outside the workflow is the test, its checker, the plan and the worklog.
- The fix answers both causes of run 39568721933. The contract step now requires `steps.browser.outcome == 'success'`, like the E2E step. A new guard step removes every non-`ubuntu.sources` file in `/etc/apt/sources.list.d` before the unchanged `playwright install --with-deps chromium`.
- I ran the guard's script against simulated runner layouts (x64 mirror list, arm64 `ports.ubuntu.com`, legacy `sources.list`, and four failure layouts). It behaves as intended, and a real install failure still fails visibly.
- There are no blockers or majors. The findings are one minor risk (the N2 check rests on layouts inferred from logs, and the keep rule is by name), one minor test-strength gap, and three nits. CI-EBG-4 (proof on both runners) is PENDING-CI, as expected.

## Code findings

**C1, minor.** `.github/workflows/e2e.yml:198-215`. The keep rule is by file name, and the N2 check rests on inferred layouts.
- *Problem:* the loop keeps exactly `ubuntu.sources`, and the N2 check accepts `URIs:` lines that name `apt-mirrors.txt` or `ubuntu.com`, or an active `deb` line in `sources.list`. The worklog says the exact lines were inferred. The run log shows hosts, not file names:
  - x64 shows `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist`, then `azure.archive.ubuntu.com`.
  - arm64 shows `ports.ubuntu.com/ubuntu-ports`, read after `packages.microsoft.com` (so it is in `sources.list.d`, not in `sources.list`).
- *Risk judgement:* low. Both plausible shapes are accepted (checked below), and the fallback covers a legacy `sources.list`. The check is fail-closed with a clear message, and the first post-merge run needs to be looked at anyway for CI-EBG-4.
- *Failure scenario:* the arm64 image keeps its archive in another file name, for example `ubuntu-ports.sources`. The loop removes it, the check fails with `::error::no Ubuntu archive source is left`, and the arm64 cell goes red. That cell was green before this change (the Microsoft source answered there), so this would be a regression caused by the guard. My simulation of that layout fails as designed.
- *Fix (optional hardening):* decide by content, not name. Remove a file only if it names no Ubuntu archive, for example `grep -Eqi 'ubuntu\.com|apt-mirrors\.txt' "$f" || sudo rm -f -- "$f"`. Then a renamed archive file is never removed, and the N2 check can only fail when apt is really left without a source. Alternatively accept the risk and read the first run's `ls -l` output.
- *Minor extra:* the `URIs:` match does not look at `Enabled: no`. It is a diagnostic only, so this is acceptable.
- *Orchestrator note:* `e2e.yml` also runs on `push` to any branch. If the user approves pushing `ci/e2e-browser-gate` (a branch push is not covered by the standing approval of 2026-10-05), CI-EBG-4 can be seen before the merge. Otherwise a wrong layout guess lands on `main` first.

**C2, minor.** `tests/acceptance/support/browserGate.mts:106-109` (`neutralisesSources`) and `:131`. The static checker can be satisfied by something that does not guard.
- *Problem:* a step passes if its script mentions `/etc/apt/sources.list(.d)` and contains any of the words `rm|mv|sed|tee|cp|truncate|find`, anywhere (comments and `echo` included). It also accepts a script that removes `ubuntu.sources` itself.
- *Verified with an inline workflow* (scratch script, not committed). The checker accepted each of these:
  - `ls /etc/apt/sources.list.d | tee /dev/null`
  - `echo ok # find /etc/apt/sources.list.d`
  - `sudo rm -f /etc/apt/sources.list.d/ubuntu.sources`
  - `echo "/etc/apt/sources.list.d" && rm -f /tmp/x`
  - `mv a b # /etc/apt/sources.list.d`
- *Scenario:* a later refactor turns the guard into a no-op, or removes the Ubuntu archive, and CI-AR-10 stays green. The plan does state the limit ("a static test cannot prove this; review and CI evidence do"), and CI-AR-02's last NEG covers only a bare `ls`. So this is not a defect of the delivered fix, only a weak spot in the regression net.
- *Fix (QA, follow-up):* strip `#` comments before matching. Require the destructive word at a command position (`rm`, `mv`, `sed -i`, `truncate`) targeting a path under `sources.list.d`. Add NEG cases for `tee` after `ls`, a comment-only match, and a guard that removes `ubuntu.sources`. The optional fault-injection job in the plan would also close the gap.

**C3, nit.** `.github/workflows/e2e.yml:199-203`. `sudo rm -f -- "$f"` on a directory fails the step ("Is a directory").
- apt ignores directories in `sources.list.d`. The simulation with a sub-directory exits 1.
- Real runners have no sub-directory there, as far as the logs show, so this is theoretical.
- *Fix:* `[ -f "$f" ] || continue`, or skip non-regular files.

**C4, nit.** `.github/workflows/e2e.yml:196-203`. The step deletes system files with `sudo` on whatever runner it lands on.
- Today `runs-on` is a fixed pair of GitHub-hosted runners, so it is safe. The comment says "ephemeral".
- *Hardening:* skip the removal unless `"${RUNNER_ENVIRONMENT:-}" = github-hosted`, so a later switch to a self-hosted runner cannot wipe persistent apt configuration. Not needed for this merge.

Checks that came out clean (correctness and safety of the guard):
- **Shell semantics.** The run log of the old step shows `shell: /usr/bin/bash -e {0}` on both runners (no `pipefail`). The script has no pipe. `shopt -s nullglob` makes an empty directory a no-op. `"$f"` is quoted and `--` is used. The `if { …; } || { …; }; then` is a condition, so `-e` does not trip on a false branch. A failing `rm` or `ls` fails the step (loud). `check:workflows` (actionlint with the pinned shellcheck) is clean.
- **Scope of `sudo rm`.** Only direct children of `/etc/apt/sources.list.d`, matched by a fixed glob. No untrusted input reaches it, and the job has `contents: read` and no secrets, so fork PRs gain nothing.
- **Simulation** (the real step script, with `/etc/apt` redirected to a temp tree and `sudo` removed; scratch only):

  | Layout | Result |
  |---|---|
  | x64: `ubuntu.sources` with `URIs: mirror+file:/etc/apt/apt-mirrors.txt`, plus `microsoft-prod`, `google-chrome` and `mono` lists | the three lists removed, `ubuntu.sources` kept, exit 0 |
  | arm64: `ubuntu.sources` with `URIs: http://ports.ubuntu.com/ubuntu-ports/`, plus `microsoft-prod.list` | the Microsoft list removed, exit 0 |
  | arm64 with nothing to remove | no removal, exit 0 |
  | archive only in an active `deb` line of `sources.list` | exit 0 |
  | `ubuntu.sources` pointing at a Debian host | `::error::`, exit 1 |
  | archive file renamed to `ubuntu-ports.sources` | removed, `::error::`, exit 1 (see C1) |
  | empty `sources.list.d` | `::error::`, exit 1 |

- **No later step needs a removed source.**
  - `.github/actions/setup` runs before the guard (Node, yarn) and uses no apt.
  - `.github/actions/podman` runs before the guard too (pip wheels, `loginctl`, `podman`) and uses no apt.
  - After the guard, the browser step is the only apt user. The rest is Jest, Playwright, `node` scripts, `podman`, `upload-artifact`, `df` and `free`.
  - The `bundle` job has no apt, and `--with-deps` appears nowhere else under `.github`. Container builds run apt inside the container, with the container's own sources.
- **A real install failure stays visible.**
  - `playwright install` has `id: browser`, no `continue-on-error`, no `|| true`. The guard has no `continue-on-error` either.
  - A real failure fails the job at the install step. The contract and E2E steps require `steps.browser.outcome == 'success'`, so they show as *skipped*, not as noise failures.
  - A guard failure also skips the install and both layers. I ran the gate and the summary in an empty directory: the gate exits 0 and the summary prints "missing: the contract step did not run…". So the failure is reported in the summary.
- **Reporting steps stay `always()`.** The diff touches only the contract `if:` and the new step. At HEAD the upload gate (`:246`) and the leftovers step (`:269`) use `if: always()`, and the summary and upload use `always() && steps.gate.outcome == 'success'`.
- **ADR-0007 A4.** The install command is byte-identical, `corepack yarn playwright install --with-deps chromium` (`M1-S8-E07` passes). The ADR's own upgrade note says an apt problem is fixed in CI, which is what this does.
- **Workflow conventions.** No new actions, so nothing to pin. No permission, trigger or `uses` changes. `corepack yarn check:workflows` is OK.
- **Comment accuracy against the evidence.** The step comment says the x64 run saw `403 … no longer signed`, exit 100, and that arm64 had the same source and answered. Both match the run log (`Get:1 … packages.microsoft.com … InRelease` on arm64, `Err:6 … 403` on x64). N1 is correctly fixed.

Good decisions, briefly:
- Removing the broken source instead of retrying: a 403 or an unsigned repository fails every attempt.
- Gating on `steps.browser.outcome`, which is consistent with the E2E step, and leaving the install unmasked.
- Making the guard fail loudly (N2) instead of leaving apt with nothing.
- The step comment records the run id and the evidence it relies on, and the worklog owns up to "inferred".
- QA's tests prove each rule on inline positive and negative controls first, and the plan states honestly what a static layer cannot show.

## Process findings

**P1, nit.** QA's VERIFY results in the plan were recorded at `0d8ed41` (`7e3c139`). The guard changed afterwards in `0aa81a9` (N1 comment, N2 check), and no QA record covers it.
- *Mitigation:* the ci-cd-specialist re-ran the gate test (8/8), the workflow suites (75/75) and `check:workflows` after the change, and I re-ran the static layer at HEAD (below). The changes answer QA's own notes.
- *Fix:* QA adds one line when it records CI-EBG-4: "static layer re-run at 978d165". No action now.

**P2, nit.** Worklog evidence: `~/joplin-web-app-work/ci-evidence/gate-impl/lint.log` and `lint2.log` are empty, so "lint exit 0" has no recorded exit code. "Checked the regex locally against sample `URIs:` lines" has no log. Both are true (I re-ran lint, exit 0, and re-created the sample cases), but the worklog should name evidence a reader can open. Worth a line next time.

Checks that came out clean:
- **Test-first.** `a2e89af` (test and checker) and `f11b7a9` (plan with the RED output, 6 of 8 controls pass, `CI-BG-10` and `CI-AR-10` fail for the stated reasons) precede `1e58941`. The RED reasons match the real cause.
- **Ownership.** `git log main..HEAD -- tests/` shows one commit (`a2e89af`, `Agent: qa-specialist`). `git log main..HEAD -- .github/` shows only `1e58941` and `0aa81a9`, both `Agent: ci-cd-specialist`. `docs/test-plans` is touched only by QA, `docs/worklog` only by the ci-cd-specialist. No file outside these areas changed (`git diff --name-only main...HEAD` lists five paths).
- **Commit types (P-R1).** `test(ci)` for the tests, `ci(e2e)` for both workflow changes (correct: a pipeline fix, not a product `fix`), and `docs(...)` for plan, worklog and results. Trailers are correct (Opus for QA planner, Sonnet for the ci-cd-specialist), imperative subjects, small commits.
- **Scope.** Only the contract `if:`, the new guard and its comments changed in `e2e.yml`. No unrequested refactor.
- **Discipline.** No `.only`, no skips, no sleeps, no weakened assertions. The plan has an empty `## Disputes`.
- **Worklog accuracy.** The approach, commands and counts match the logs (8 of 8, 75 of 75, 51 of 51, `check:workflows` OK, acceptance 247 of 248). The one failure, M1-S1-T04 (a PID-1 supervisor test timing out under load), is reported honestly. QA analysed it and filed a follow-up for M3-S1.
- **Dependency and license.** No new dependency. Nothing copied from upstream.

## Follow-ups
| Item | Severity | Goes to |
|---|---|---|
| C1 content-based keep rule, or read the first run's `ls -l` and the `::error::` line | minor | ci-cd-specialist, at the next touch of `e2e.yml` or if the first run is red |
| C2 harden `neutralisesSources` (comments, command position, no `ubuntu.sources` removal) | minor | QA, next touch of `browserGate.mts` |
| C3 skip non-regular files; C4 `RUNNER_ENVIRONMENT` check | nit | ci-cd-specialist, next touch |
| P1, P2 | nit | QA, ci-cd-specialist, as noted |
| CI-EBG-4 on both runners, plus M2-S1's missing x64 rows | pending | QA, after the post-merge `e2e.yml` run |

None blocks the merge.

## Verification
| Command | Result |
|---|---|
| `git log --format='%h %an %s%n%b' main..HEAD`; `git diff --name-only main...HEAD`; `git log main..HEAD -- tests/` and `-- .github/` | 7 commits; order, ownership, types and trailers as above |
| `node --test --test-concurrency=1 tests/acceptance/ci-e2e-browser-gate/e2e-browser-gate.test.mts` | 8 of 8 pass (matches the worklog and QA's 8/8) |
| `node --test --test-concurrency=1 tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` | 13 of 13 pass (includes `M1-S8-E07`) |
| `corepack yarn check:workflows` | OK: 3 workflow files, 2 action files, actionlint clean, every `uses` pinned |
| `corepack yarn lint` | exit 0 |
| The step script run under `bash -e` against 8 simulated `/etc/apt` layouts (scratch dir, `sudo` removed) | as in the table under "Code findings" |
| Inline-workflow runs of the checker with 5 non-guarding scripts | all 5 accepted (C2) |
| `upload-gate.ts` and `e2e-summary.ts` in an empty directory (with a private `--secrets-dir`) | gate exit 0; summary reports the missing files |
| Read the evidence under `~/joplin-web-app-work/ci-evidence/39568721933/` (run log lines for the install step on both runners) and `gate-impl/*.log` | the comment and worklog claims match; the lint logs are empty (P2) |
| Not run (instructed) | contract and E2E suites; the full acceptance suite (the worklog's 247 of 248, with the unrelated M1-S1-T04 timeout, is taken from `acceptance.log`) |
| x64 and arm64 on real runners | PENDING-CI (CI-EBG-4); QA records the run ids and step outcomes after the post-merge run |
