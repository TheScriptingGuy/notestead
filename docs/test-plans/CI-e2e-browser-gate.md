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
