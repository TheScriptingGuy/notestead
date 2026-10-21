# CI-e2e-browser-gate worklog (ci-cd-specialist)

Plan: `docs/test-plans/CI-e2e-browser-gate.md`. Failing tests: a2e89af. Only `.github/workflows/e2e.yml` changed.

## Approach
- CI-AR-10: new always-running step "Keep apt to the Ubuntu archive" before the browser install. It removes every file in
  `/etc/apt/sources.list.d` except `ubuntu.sources` (`sudo rm -f`, nullglob, so a runner without such files is fine, as on
  arm64). Chosen over a restricted `Dir::Etc::sourceparts` because `playwright install --with-deps` calls apt-get itself and
  we cannot pass apt options through it. The runner is ephemeral, so removal has no lasting effect. No retry, no `|| true`.
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
