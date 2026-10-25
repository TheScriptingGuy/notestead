# CI-e2e-browser-gate worklog (ci-cd-specialist)

Plan: `docs/test-plans/CI-e2e-browser-gate.md`. Failing tests: a2e89af. Only `.github/workflows/e2e.yml` changed.

## Approach
- CI-AR-10: new always-running step "Keep apt to the Ubuntu archive" before the browser install. It removes every file in
  `/etc/apt/sources.list.d` except `ubuntu.sources` (`sudo rm -f`, nullglob, so a runner without such files is fine, as on
  arm64). Chosen over a restricted `Dir::Etc::sourceparts` because `playwright install --with-deps` calls apt-get itself and
  we cannot pass apt options through it. The runner is ephemeral, so removal has no lasting effect. No retry, no `|| true`.
  The loop is a no-op on a runner that has no such files. Run 39568721933 shows that the arm64 runner also has
  `packages.microsoft.com` (it answered there, `Get:1 ... noble InRelease`), so the guard removes it on both runners.
- CI-BG-10: the contract step's `if:` gained `&& steps.browser.outcome == 'success'` (the E2E step already had it). The
  browser step keeps `id: browser`, no `continue-on-error`. Gate, summary and upload steps are unchanged (`always()`).
- The command `corepack yarn playwright install --with-deps chromium` is unchanged (ADR-0007 A4).

## Commands and evidence (logs in `~/joplin-web-app-work/ci-evidence/gate-impl/`)
- `node --test tests/acceptance/ci-e2e-browser-gate/*.test.mts`: 8 pass, 0 fail (`new.log`).
- `corepack yarn test:acceptance` (whole suite, incl. ac22): 247 of 248 pass (`acceptance.log`). The one failure,
  M1-S1-T04, was `packages/headless/src/supervisor.test.ts` "as PID 1 ..." timing out under load; rerun alone it passes
  (3/3). Unrelated to this change (no packages touched).
- `corepack yarn check:workflows`: OK (`check.log`). `corepack yarn lint`: exit 0 (`lint.log`).
- Not run, per the brief: contract and E2E suites. The fix is verified for real only by the next CI run on both runners.

## Round 2 (QA notes N1, N2)
- N1: wording fixed in the step comment and above. My earlier claim that arm64 has nothing to remove was wrong.
- N2: after the removal loop the step fails with `::error::` and exit 1 unless an Ubuntu archive source remains: an
  active `URIs:` line in `/etc/apt/sources.list.d/ubuntu.sources` that names `apt-mirrors.txt` or `ubuntu.com`, or an
  active `deb` line in a non-empty `/etc/apt/sources.list`. From the run's logs: x64 uses `Get:1
  file:/etc/apt/apt-mirrors.txt Mirrorlist` then `azure.archive.ubuntu.com` (the mirror-list URI sits in ubuntu.sources);
  arm64 uses `ports.ubuntu.com/ubuntu-ports`. The logs do not show the file contents, so the exact `URIs:` lines are
  inferred; the regex accepts both shapes and the `sources.list` fallback. Checked the regex locally against sample
  `URIs:` lines (mirror list: keep; ports.ubuntu.com: keep; a Debian host: fail).
- Re-run: new gate test 8/8 (`new2.log`); workflow acceptance files (ci-e2e-browser-gate, m1-s3 ac8, m1-s8 ac22,
  ac30-ac32, ac33, shellcheck) 75/75 (`workflow-suite2.log`); m1-s8 dir 51/51; `check:workflows` OK (`check2.log`);
  `lint` exit 0 (`lint2.log`). Logs under `~/joplin-web-app-work/ci-evidence/gate-impl/`.

## CI-M2-S2 WO-12 (CC-1): E2E step to 60 minutes

- Approach: in `.github/workflows/e2e.yml`, step `id: e2e`, `timeout-minutes` 45 -> 60, with a comment citing CC-1 and proof run 1 (arm64 E2E 1645 s, 69% of the 40-minute run budget). Nothing else changed. The job-level `timeout-minutes: 150` already covers setup + contract step (75) + E2E step (60), so it stays.
- Order: lands before WO-13 (run budget to 55 minutes; 55 <= 60 - 4 holds).
- Evidence (all pass): `node --test tests/acceptance/ci-m2-s2/timeouts.test.mts` (CI-T-01..04, 4/4, run budget still 40 min); `node --test tests/acceptance/ci-e2e-browser-gate/*.test.mts` and m1-s9 acceptance; m1-s8 ac22, ac30-ac32, ac33; `corepack yarn check:workflows` OK; `corepack yarn lint` exit 0. E2E and contract suites not run.
