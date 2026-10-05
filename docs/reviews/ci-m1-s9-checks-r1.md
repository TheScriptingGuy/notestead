# Review: ci-m1-s9-checks, round 1

Verdict: APPROVE

**Summary**
- `ci.yml` now runs `check:licenses` (M1-AC24) next to `check:workflows`, `check:pin` and `check:no-upstream-copy` on both `ubuntu-24.04` and `ubuntu-24.04-arm`. Each check tees its output to `test-results/checks/<check>-<RUNNER_ARCH>.log`, and the always-on upload carries those logs plus the licence JSON report.
- `set -o pipefail` is present in every step that pipes. My own NEG and control show the line is load-bearing.
- No triggers, permissions, actions or pins changed. All my re-runs match the worklog.
- **Nothing in this diff blocks the first push.** Two pre-push decisions for the user are listed under "Push readiness".
- Credit:
  - the pipefail NEG and its control
  - per-architecture licence evidence
  - known_hosts verified against two independent published fingerprint sources instead of TOFU
  - `origin` left alone until the renamed repo and the deploy key exist
  - nothing outward-facing changed without a logged-in, user-approved session

## Code findings

1. **minor**, `.github/workflows/ci.yml:93`: the step name `Acceptance suites (M1-S1, M1-S2 default, M1-S3)` is stale.
   - **Problem:** the step's glob `tests/acceptance/**/*.test.mts` now also runs M1-S9. That is 151 tests, not 105; M1-S9's own results record 151 with 46 from M1-S9 (`docs/test-plans/M1-S9.md:151`). The implementer flagged this and kept the name on purpose, because QA's V1 matches steps by name.
   - **Failure scenario:** someone reading the first run sees an "M1-S3" step reporting 151 tests and suspects stray tests. Every later story makes the name more wrong.
   - **Expected fix (recommendation):**
     - **Do not rename it for the first push.** A rename now, without QA, would make V1 fail on a technicality on the very run used as evidence.
     - As a follow-up, rename the step to something story-agnostic, such as `Acceptance suites (default)`, in the same change in which QA updates V1. Then the name stops going stale with each story.

## Process findings

1. **minor**, `docs/worklog/ci-m1-s9-checks.md:64` (first introduced in commit `9c1515f`): the worklog names the user's personal SSH host (the hostname of an existing `~/.ssh/config` entry; deliberately not repeated here).
   - **Problem:** it appears nowhere else in the history. It isn't a secret, but it names private infrastructure that may host the user's real Joplin Server.
   - **Failure scenario:** the repo is public, and the first push publishes all of `main`'s history at once. After that, the hostname stays public even if a later commit removes it.
   - **Expected fix:** **the user decides before the push.** If they don't want it public, reword the line (for example, "the existing entry is kept") and rewrite `9c1515f` on this branch, which is still unpushed, before merge and push. A follow-up commit alone leaves the hostname in history. If the user doesn't mind, no action is needed.
2. **minor (follow-up for QA, not the implementer)**, `docs/test-plans/M1-S3.md:113-114`: V2 expects "105 tests (M1-S1 50, M1-S2 default 31, M1-S3 24)", and V1's step list doesn't include `check:licenses`.
   - **Failure scenario:** QA evaluates the first green run against V2 and either records a false FAIL (151 ≠ 105) or passes it without checking M1-S9's 46.
   - **Expected fix:** before evaluating the first run, QA amends:
     - V1: add the `check:licenses` step, plus `test-results/checks/*-{X64,ARM64}.log` and `licenses-report-{X64,ARM64}.json` in the artifacts
     - V2: 151 tests = 50 + 31 + 24 + 46

   Then QA records the results as usual. This is QA's file, so this belongs in QA's next dispatch and doesn't block the push.

No `tests/**` or test-plan changes on the branch (`git log main..HEAD -- tests/ docs/test-plans/` is empty). Trailers are correct: `ci-cd-specialist` on 59052e3, 9c1515f and c68e0b1, and `orchestrator` on d1a5a18. The commits are small and focused, with imperative subjects.

## CI/CD checklist (static, against the diff)
- **pipefail:** the steps containing a pipe are `check:workflows`, `check:pin`, `check:no-upstream-copy` and `check:licenses`. All four start with `set -o pipefail`.
  - The only other `|` in the job is `||` in the T90 NEG step, which is not a pipe.
  - No workflow- or job-level `defaults.run.shell` exists, so GitHub uses `bash -e {0}`, which has no pipefail. The explicit `set` is the right fix.
  - `shell: bash` is not needed. The implementer's reason, that the extracted script then behaves the same locally, is sound.
- **Triggers, permissions, actions:** unchanged. The workflow keeps `permissions: {}` and the job keeps `contents: read`. The fork-PR guard, `persist-credentials: false`, and the SHA pins for `actions/checkout` and `actions/upload-artifact` are intact. `check:workflows` confirms every `uses` is pinned.
- **Upload:** still `if: always()`, `path: test-results/`. It now carries `test-results/checks/**`. The hidden `.cache` stays excluded.
- **Contents of the new logs:**
  - `FORCE_COLOR=0`, so no ANSI codes.
  - No tokens or secrets are in play in these steps.
  - The licence report lists package names, versions and paths only.
- **`check:no-upstream-copy` vs the new untracked logs:** it scans `git ls-files` only (`packages/web-build/src/upstreamCopy.ts:58`), so the logs can't trigger it.
- **x64:** the claim that the licence verdict is architecture-independent rests on `@img/sharp*` being the only platform-conditional entries. The reasoning is plausible, and it stays PENDING-CI on the first run, as stated.
- **Approval trail:** nothing outward-facing changed. The rename was not done, and the deploy key is not registered. GitHub was used read-only (anonymous API). The deploy key is repo-scoped, which is the narrowest write credential available. The private key is mode 600 and was never printed.

## Push readiness
- **From this diff: no blocker.** The workflow is correct and statically clean.
- **Decide before the push (user):**
  1. The hostname in the worklog: process finding 1.
  2. All 153 author/committer entries in the 77 commits use the user's personal email address, which becomes public with the history. If the GitHub account has "Block command line pushes that expose my email" enabled, the push is rejected with GH007. This is not new and is the user's call. I note it only because this push is the irreversible one.
- **Sequencing (recommendation, not a blocker):** do the rename to `notestead` before the push.
  - Then the history is never published under the "Joplin-Web-App" name (CLAUDE.md trademark naming).
  - The planned deploy-key remote (`git@github-notestead:TheScriptingGuy/notestead.git`) assumes the new name anyway.
  - GitHub would redirect the old name, so this is about naming, not about the push working.
- A scan of the full history to be published found no private keys or common token patterns (`git log -p HEAD`, PEM private-key headers, `ghp_`/`gho_`/`github_pat_`, `AKIA…`, `xox[bp]-`). The only tracked images are our own overlay icons under `packages/web-build/overlay/icons/`.

## Verification
All runs were on the Pi (arm64), Node v24.17.0, branch `ci/m1-s9-checks-in-ci` at `c68e0b1`, one job at a time. Logs are in `/tmp/lead-ci-s9/`.

| Command | Result | Worklog claim |
|---|---|---|
| `corepack yarn check:workflows` | exit 0, 2.6 s. actionlint 1.7.12 and shellcheck 0.11.0 clean, every `uses` pinned, every job declares permissions (2 workflows, 1 composite action) | matches (#3) |
| `ci.yml` parsed with `yaml`; listed the steps containing `\|` with their `shell`/pipefail, plus `defaults` | 4 piped check steps, all `shell=default` with `set -o pipefail`. No `defaults` at workflow or job level | n/a |
| The `check:licenses` step's `run:` extracted from `ci.yml`, run as `RUNNER_ARCH=… bash -e <script>` with `--exceptions <{"exceptions":[]}>` (NEG) | **exit 1**, `check:licenses: FAILED. 3 problem(s)`: DENIED `@joplin/onenote-converter@3.7.1`, `node-bitmap@0.0.1`, `tkwidgets@0.5.27`. The JSON report is still written | matches (#5) |
| The same NEG with the `set -o pipefail` line removed (control) | **exit 0**, although the log contains `FAILED`. pipefail is load-bearing | matches (#6) |
| The `check:licenses` step as committed (POS) | exit 0: 1078 packages, 1075 allowed, 3 by reviewed exception | matches (#1, #4) |
| `corepack yarn lint` | exit 0, 36.4 s | matches (#7) |
| `node --test --test-concurrency=1 --test-reporter=spec 'tests/acceptance/m1-s3/*.test.mts'` | exit 0: 24 tests, 24 pass, 0 fail, cancelled, skipped or todo, 43.8 s. `git status --porcelain` identical before and after | matches (#8) |
| `git log main..HEAD -- tests/ docs/test-plans/` | empty | n/a |
| `git log -p HEAD` scanned for key and token patterns; `git log -S '<that hostname>' HEAD` | no key or token hits. The hostname was first added in `9c1515f` | n/a |

I did not re-run the full 151-test acceptance glob. QA recorded it in `docs/test-plans/M1-S9.md:151` (151/151, 46 from M1-S9), and the step's command is unchanged by this diff. My scratch outputs under `test-results/checks/` were removed.
