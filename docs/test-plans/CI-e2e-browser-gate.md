# Test plan: CI-e2e-browser-gate (browser gate and apt resilience in `e2e.yml`)

- **Trigger:** `e2e.yml` run [39568721933](https://github.com/TheScriptingGuy/notestead/actions/runs/39568721933) on `main` at `7b19554`, the M2-S1 merge. Evidence is in `~/joplin-web-app-work/ci-evidence/39568721933/`.
  - On x64, the step `Playwright's Chromium` (`id: browser`, `corepack yarn playwright install --with-deps chromium`) failed after 6 s. Playwright's `apt-get update` got `403 Forbidden` from the runner's preinstalled source `https://packages.microsoft.com/ubuntu/24.04/prod`, with "The repository … is no longer signed", and the install exited with code 100.
  - The contract step's `if:` (`e2e.yml:198`) does not require the browser step, unlike the E2E step (`:208`). So the contract layer ran 21 min without Chromium and gave 18 noise failures (`Executable doesn't exist`).
  - The E2E step was skipped, so M2-S1 has no x64 result. arm64 was green (contract 87/87, E2E 7/7).
- **Branch:** `ci/e2e-browser-gate`, from `main` `7b19554`.
- **Owners:** QA writes this plan and the tests. The **ci-cd-specialist** implements, in `.github/**` only, and keeps `docs/worklog/CI-e2e-browser-gate.md`. ADR-0007 A4 stays as it is (see criterion 3).

## Criteria
1. **CI-EBG-1 (gate).** In `e2e.yml`, every step that needs Playwright's browser runs only if the browser install succeeded. That covers the E2E layer (`playwright test`) and the contract layer (`test:contract`; its harness self-tests run inner Playwright runs against Chromium).
   - "Runs only if it succeeded" means one of: no `if:` (implicit `success()`); a top-level `success()`; or a top-level `&&` term `steps.<browser id>.outcome == 'success'`.
   - That term must not sit under a top-level `||`.
   - The browser install has an `id`, and has no `continue-on-error`, which would make `success()` true after a failed install.
   - The contract layer then shows as *skipped*, not as 18 browser failures, when the browser is missing. The upload gate, the summary and the upload keep `if: always()`, so a failed install is still reported.
2. **CI-EBG-2 (apt resilience).** A broken, unrelated, preinstalled third-party apt source on the runner must not fail the browser install.
   - When the install (or any step before it) uses apt (`--with-deps`, `install-deps`, `apt-get update|install`), a step that runs **whenever the install runs** takes third-party apt sources out of apt's way first. That step is the install itself, or an earlier step with no `if:` (when the install has none), `always()` or `!cancelled()`, and with no `continue-on-error`.
   - "Out of apt's way": it edits, moves or removes entries under `/etc/apt/sources.list.d` (or `sources.list`), or it runs apt with a restricted source list (`Dir::Etc::sourcelist`/`sourceparts`).
   - **A retry does not satisfy this.** A 403 or an unsigned repository fails every attempt.
   - The install must still fail visibly when it really fails: no `continue-on-error` and no `|| true`.
   - The step must keep the Ubuntu archive sources (`ubuntu.sources`), or Playwright's OS packages cannot be installed. A static test cannot prove this; review and the CI evidence (criterion 4) do.
3. **CI-EBG-3 (scope).** The install stays `corepack yarn playwright install --with-deps chromium` with the repo's pinned Playwright (ADR-0007 A4, M1-S8-E07).
   - Dropping `--with-deps` would also pass CI-AR-10, since no apt is used then.
   - But it changes A4 (the OS packages from Playwright's own dependency list), so it needs the architect first. It is not the expected fix.
4. **CI-EBG-4 (evidence; CI half).** After the fix is merged and pushed, an `e2e.yml` run on both runners has:
   - the browser step `success`;
   - the contract and E2E layers run.

   QA records the run id per runner, the step outcomes, and the M2-S1 x64 rows (`docs/test-plans/M2-S1.md` §x64). Those are the x64 sign-off M2-S1 is still missing.

## Tests
`tests/acceptance/ci-e2e-browser-gate/e2e-browser-gate.test.mts` (`node:test`, part of `corepack yarn test:acceptance`), with the checker in `tests/acceptance/support/browserGate.mts`. The checker functions are pure, over the `yaml` parse. Each rule is first proven on small inline workflows (positive and negative controls), then applied to `e2e.yml`.

| Criterion | Test ID | What it proves |
|---|---|---|
| CI-EBG-1 | `CI-BG-00` | The condition parser: top-level `&&` terms; a top-level `||` means no required term; parentheses and quoted `&&` are respected |
| CI-EBG-1 | `CI-BG-01` | Positive control: a contract and an E2E step gated on `steps.browser.outcome == 'success'`, or with no `if:`, pass |
| CI-EBG-1 | `CI-BG-02` | NEG: the run-39568721933 condition (no browser term), the term under `\|\| always()`, `always()` alone, and a browser-needing step before the install are each flagged |
| CI-EBG-1 | `CI-BG-03` | NEG: an install with `continue-on-error`, without an `id`, or missing is flagged |
| CI-EBG-1 | **`CI-BG-10`** | `e2e.yml` itself: it has a contract and an E2E step, and every browser-needing step is gated |
| CI-EBG-2 | `CI-AR-01` | Positive controls: a guard step (no `if:`, or `!cancelled()`) before the install; the guard inside the install's own script; `Dir::Etc::sourceparts`; no apt at all |
| CI-EBG-2 | `CI-AR-02` | NEG: no guard; a retry loop only; a guard after the install; a guard conditional on another step; a guard with `continue-on-error`; an install masked with `\|\| true`; a script that only lists `/etc/apt/sources.list.d` |
| CI-EBG-2 | **`CI-AR-10`** | `e2e.yml` itself: its apt-using browser install is protected as in CI-EBG-2 |
| CI-EBG-3 | `M1-S8-E07` (existing, `tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts`) | The install stays Chromium only, through `corepack yarn playwright install` (regression; must stay green) |
| CI-EBG-4 | CI evidence | §Results after the run |

**Limit of the static layer:** it checks that a guard exists, where it sits and when it runs, not what it does on a real runner. The CI run (CI-EBG-4) and the review of the guard's script cover that. A fault-injection self-test, a `workflow_dispatch`-only job that plants a broken source before the guard, is optional for the ci-cd-specialist and not required.

## How to run
```sh
node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/ci-e2e-browser-gate/e2e-browser-gate.test.mts
node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts   # regression (E01–E12)
corepack yarn check:workflows                                                                            # pins and permissions
```

## RED (2026-10-21, Pi arm64)
On branch `ci/e2e-browser-gate` with `e2e.yml` unchanged from `7b19554`. Log: `test-results/verify/ci-e2e-browser-gate/red.log` (gitignored), exit 1. 8 tests: the 6 checker controls pass, and the 2 `e2e.yml` checks fail for the stated reasons:
- **`CI-BG-10`:** `test step 7 (contract) needs Playwright's browser but its if: does not require steps.browser.outcome == 'success' (if: ${{ !cancelled() && steps.setup.outcome == 'success' && steps.bundle-check.outcome == 'success' && steps.podman.outcome == 'success' }})`
- **`CI-AR-10`:** `test step 6 (browser): uses apt (test step 6 (browser)) but no step at or before it, run whenever it runs, takes third-party apt sources out of the way; a broken preinstalled source (run 39568721933: packages.microsoft.com 403 "no longer signed") then fails the install`

Step numbers count the job's `steps:` list from 1. The Actions UI adds "Set up job", so there the browser step is 7.

`corepack yarn eslint` on both new files and `tsc -p tests/acceptance/tsconfig.json`: clean.

## Disputes
None.

## Results (QA VERIFY, 2026-10-21, Pi arm64)
Branch `ci/e2e-browser-gate` at `0d8ed41`. The implementation is `1e58941` (ci-cd-specialist: `e2e.yml` only), and the worklog is `0d8ed41`. Logs are under `test-results/verify/ci-e2e-browser-gate/verify/` (gitignored), each ending with `# duration … s; exit <code>`. The ci-cd-specialist's own logs are in `~/joplin-web-app-work/ci-evidence/gate-impl/`.

### Layers (static; light)
| Command | Result | Duration | Log |
|---|---|---|---|
| `node --test … tests/acceptance/ci-e2e-browser-gate/e2e-browser-gate.test.mts` | **PASS 8/8** (RED: 6/8) | 1 s | `verify/gate.log` |
| `node --test … tests/acceptance/m1-s8/ac22-e2e-workflow.test.mts` (E01–E12, incl. `M1-S8-E07`) | PASS 13/13 | 1 s | `verify/ac22.log` |
| `node --test … tests/acceptance/m1-s8/ac30-ac32-check-workflows.test.mts` | PASS 17/17 | 39 s | `verify/ac30-32.log` |
| `node --test … tests/acceptance/m1-s3/ac8-check-workflows.test.mts` | PASS 24/24 | 53 s | `verify/ac8.log` |
| `corepack yarn check:workflows` (actionlint with the pinned shellcheck over the new step) | OK, 3 workflows, 2 actions | 4 s | `verify/check-workflows.log` |

### Per criterion
| Criterion | Status | Evidence |
|---|---|---|
| **CI-EBG-1** gate | **PASS (static)** | `CI-BG-10`. The contract step's `if:` now ends `&& steps.browser.outcome == 'success'`, like the E2E step's. The browser step keeps `id: browser` and has no `continue-on-error`. Upload gate, summary and upload keep `if: always()` |
| **CI-EBG-2** apt resilience | **PASS (static)**, with review notes N1 and N2 | `CI-AR-10`. The new step "Keep apt to the Ubuntu archive" sits right before the browser install. It has no `if:` (like the install) and no `continue-on-error`, and it runs under the default `bash -e`, so a failed `rm` fails the step. It removes every entry in `/etc/apt/sources.list.d` except `ubuntu.sources`, with `nullglob`. No retry, and no `\|\| true` on the install. **Review of "can removing them break a later step":** after the guard, no step on either runner uses apt or a package from a removed source. The only apt user is Playwright's `--with-deps` in the browser step. The steps after it are Jest, Playwright, `node` scripts, `podman`, `upload-artifact`, `df`/`free`. The podman action runs before the guard and uses pip wheels and `loginctl`, not apt. The guard is only in the `test` job, not in `bundle`. Packages already installed from those sources stay installed; only apt's index for them goes. **Ubuntu archive kept:** run 39568721933's apt output shows the x64 archive (`azure.archive.ubuntu.com`) comes in through `mirror+file:/etc/apt/apt-mirrors.txt`. That file is outside `sources.list.d`, so it is kept, and it is the standard `ubuntu.sources` of the runner image. arm64 uses `ports.ubuntu.com`. Its file name can't be read from the log, so see N2 |
| **CI-EBG-3** scope | **PASS** | The install is still `corepack yarn playwright install --with-deps chromium` (`M1-S8-E07` green). ADR-0007 A4 is unchanged |
| **CI-EBG-4** CI evidence | **PENDING-CI (x64 and arm64)** | The first `e2e.yml` run after the merge must show, on both runners: the guard's `removing third-party apt source: …` lines and its `ls -l` (the remaining file must be `ubuntu.sources`), the browser step `success`, and the contract and E2E layers run. That run also supplies M2-S1's missing x64 rows (`docs/test-plans/M2-S1.md` §x64) |

### Review notes (non-blocking)
- **N1 (comment and worklog accuracy; ci-cd).** The comment at `e2e.yml:190-193` says "Harmless where there is nothing to remove (the arm64 image)", and the worklog repeats it. Run 39568721933's arm64 browser step **did** use `https://packages.microsoft.com/ubuntu/24.04/prod` (`Get:1 … noble`). It just answered there. So the guard removes it on arm64 too. That is intended and harmless, but the comment should say so. Fix it the next time the file is touched.
- **N2 (fail-safe; ci-cd, recommended).** The guard keeps exactly the file name `ubuntu.sources`. That is right for the standard Ubuntu 24.04 images, but on arm64 it rests on the partner image following that layout (unverifiable from the log). If an image ever keeps its archive under another name, the guard removes it. Then apt fails or installs nothing new, visibly in the browser step, but with a misleading message. Recommendation: after the loop, check that an Ubuntu archive source remains (`/etc/apt/sources.list.d/ubuntu.sources`, or an active `deb` line in `/etc/apt/sources.list`). If none does, fail with an `::error::` that names the cause. CI-EBG-4 covers this risk in the meantime.
- **Accepted residual:** a third-party entry in the legacy `/etc/apt/sources.list` is not removed. That file is a stub on Ubuntu 24.04 runners. It is out of scope unless a run shows it.

### M1-S1-T04 under load (the ci-cd-specialist's `test:acceptance`, 247/248)
- **What failed:** `packages/headless/src/supervisor.test.ts:109`, "as PID 1 … carries on to ready". It reported `Exceeded timeout of 5000 ms for a test` inside T04's full `corepack yarn test` (Jest with several workers on the Pi's 4 cores, `acceptance.log:365-384`), and passed 3/3 alone.
- **Cause:** this is a timing budget, not a product defect, and it is unrelated to this change, which touches `e2e.yml` only.
  - The test, and its sibling at `:70`, run a whole supervisor cycle with real child processes of the fake CLI (config import, sync, decrypt, server start).
  - They use Jest's default 5 s timeout, which leaves no margin on a loaded Pi.
- **Not recorded before:** M1-S5 fixed a race in this file, which is a different thing. Under the flake policy, a test that is flaky twice is a bug. This is the first recorded occurrence, and the cause is known.
- **Follow-up, story M3-S1 (Supervisor process manager)**, which rewrites the supervisor and its tests (M3-AC1):
  - QA's M3-S1 test plan moves the full-cycle tests to the integration layer, or gives them an explicit, measured timeout (for example `test(…, 30_000)`, with the Pi's measured cycle time recorded);
  - the state-machine tests themselves use fake timers.
  - The tests are co-located in `packages/headless`, so the senior engineer makes the change.
- **Until then:** it does not block this fix or M2-S2.

### Test integrity
`git log --format='%h' f11b7a9..HEAD -- tests/ docs/test-plans/` is empty. The ci-cd-specialist changed only `.github/workflows/e2e.yml` and its worklog. Subjects `ci(e2e): …` and `docs(worklog): …` both carry `Agent: ci-cd-specialist`.

### Verdict
**QA VERIFY: PASS on the static layer** for CI-EBG-1 to CI-EBG-3. N1 and N2 are non-blocking. **CI-EBG-4: PENDING-CI on x64 and arm64** until the post-merge `e2e.yml` run. QA signs off fully once that run shows the guard's output, the browser step `success` and both layers run on both runners.
