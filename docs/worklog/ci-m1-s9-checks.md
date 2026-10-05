# Worklog: ci-m1-s9-checks (first-push preparation)

- **Agent:** ci-cd-specialist. **Branch:** `ci/m1-s9-checks-in-ci`.
- **Scope:** three tasks before the first push, approved by the user on 2026-10-05 (relayed by the orchestrator):
  - **A.** `ci.yml` runs `check:licenses`, `check:pin` and `check:no-upstream-copy` on both architectures. This is the M1-S9 story goal; see test plan Interpretation 8, the worklog follow-up and the follow-up in `STATUS.md`.
  - **B.** Rename the GitHub repo `TheScriptingGuy/Joplin-Web-App` to `TheScriptingGuy/notestead` through Playwright, and do a read-only check of Settings → Actions → General.
  - **C.** A repo-scoped, write-enabled SSH deploy key generated on the Pi, with `origin` switched to it.
- **Not approved, so not done:** push, any other repo setting, Dependabot, environments, secrets. The orchestrator does the push itself after the lead reviews task A.
- **ADRs:** 0009 (A6, A7), 0007. **Machine:** Raspberry Pi 4 (arm64), Node v24.17.0, yarn 4.16.0 via corepack.

## A. `ci.yml`: the repo checks on both architectures
### Approach
- `ci.yml` already ran `check:workflows`, `check:pin` and `check:no-upstream-copy` on `ubuntu-24.04` and `ubuntu-24.04-arm`. Their default invocations already include the M1-S9 extensions:
  - `check:pin` checks the headless manifest (`--headless-manifest` defaults to `packages/headless/package.json`) and the lockfile protocol rule.
  - `check:no-upstream-copy` checks the licence header.
  - So only **`check:licenses` (M1-AC24)** was missing.
- **Change** (`.github/workflows/ci.yml`; commit `59052e3`):
  - New step `check:licenses` after `check:no-upstream-copy`, with the same `if: !cancelled() && setup succeeded` guard, so one run still reports every result.
  - Each of the four repo checks now also writes its output to `test-results/checks/<check>-<RUNNER_ARCH>.log`.
  - `check:licenses` also writes `--report test-results/checks/licenses-report-<RUNNER_ARCH>.json`. QA can compare the x64 report with the arm64 one, as in T120.
  - The existing `if: always()` upload of `test-results/` carries all of it in the artifact `test-results-ci-<runner>`.
  - The header comment names the four checks and the new evidence path.
- **Unchanged:** triggers, the fork-PR guard, `permissions` (workflow `{}`, job `contents: read`), every `uses:` pin, step names and the upload step. No new action.
- **Decisions:**
  - **`set -o pipefail` in each step that pipes into `tee`.** GitHub's default `run` shell on Linux is `bash -e {0}`, which has no pipefail, so a failing check piped into `tee` would leave the step green. The NEG below shows that this line is load-bearing. I chose an explicit line over `shell: bash` (which implies `-o pipefail`) so the step script behaves the same when extracted and run locally.
  - **Both architectures run `check:licenses`, because the installed tree differs per architecture.** The only platform-conditional entries in `yarn.lock` are the `@img/sharp*` packages. The Pi has `@img/sharp-libvips-linux-arm64@1.2.4` (LGPL-3.0-or-later) and `@img/sharp-linux-arm64@0.34.5` (Apache-2.0). The x64 leg installs `@img/sharp-libvips-linux-x64@1.2.4` (`npm view`: LGPL-3.0-or-later) and `@img/sharp-linux-x64@0.34.5` (Apache-2.0), both allow-listed. So x64 should get the same verdict. T120 matches `@img/sharp-libvips-*` by prefix, so it is not tied to an architecture.
  - **Step names are unchanged,** because QA's V1 procedure (`docs/test-plans/M1-S3.md`) lists them by name.
  - **The step `Acceptance suites (M1-S1, M1-S2 default, M1-S3)` keeps its name, although its glob `tests/acceptance/**` now also runs M1-S9 (151 tests on the Pi, not V2's 105).** QA owns V1/V2. Renaming the step and updating V1/V2 should happen together; this is raised in the report.

### Commands run (Pi, arm64)
Logs are in `test-results/verify/ci-m1-s9/` (gitignored).

| # | Command | Outcome |
|---|---|---|
| 1 | `corepack yarn check:licenses --report /tmp/ci-lic-report.json` (before the change) | exit 0: 1078 packages, 1075 allowed, 3 by exception |
| 2 | `grep conditions: yarn.lock`; `npm view @img/sharp-libvips-linux-x64@1.2.4 license`, `npm view @img/sharp-linux-x64@0.34.5 license` | Only `@img/sharp*` is platform-conditional. x64 licences: `LGPL-3.0-or-later`, `Apache-2.0` |
| 3 | `corepack yarn check:workflows` | exit 0, 2.6 s: actionlint 1.7.12 and shellcheck 0.11.0 clean, every `uses` pinned, every job declares permissions (2 workflows, 1 composite action). `check-workflows.log` |
| 4 | The four check steps' `run:` scripts extracted from `ci.yml` with `yaml`, run as GitHub does (`RUNNER_ARCH=ARM64 bash -e <script>`) | All exit 0, about 2 s each. They wrote `test-results/checks/check-{workflows,pin,no-upstream-copy,licenses}-ARM64.log` and `licenses-report-ARM64.json` (197 KB) |
| 5 | **NEG:** the extracted `check:licenses` script with `--exceptions <empty list>` | **exit 1**, `check:licenses: FAILED. 3 problem(s)`: DENIED `@joplin/onenote-converter@3.7.1`, `node-bitmap@0.0.1`, `tkwidgets@0.5.27` |
| 6 | **Control for the NEG:** the same script without `set -o pipefail` | exit 0, which is the masked failure that `pipefail` prevents |
| 7 | `corepack yarn lint` | exit 0, clean, 36 s. `lint.log` |
| 8 | `node --test --test-concurrency=1 --test-reporter=spec 'tests/acceptance/m1-s3/*.test.mts'` (QA's M1-S3 suite: M1-AC8, T00–T12 incl. the NEGs and the independent data check T11) | exit 0: 24 tests, 24 pass, 0 fail/cancelled/skipped/todo, 43.7 s. `git status` identical before and after. `m1-s3-acceptance.log` |

x64 is PENDING-CI: the first run after the push (M1-AC9, V1–V2).

## B. Repo rename and Actions settings (Playwright)
- 2026-10-05 03:41 (Pi time): opened `https://github.com/TheScriptingGuy/Joplin-Web-App/settings`. Result: HTTP 404, and the header shows "Sign in" / "Sign up". The browser profile is **not logged in to GitHub**, and GitHub serves a private repo as 404 to anonymous visitors.
  - Evidence: `test-results/evidence/ci-m1-s9/00-settings-logged-out-404.png` (gitignored).
- I opened `https://github.com/login?return_to=…/Joplin-Web-App/settings` for the user and stopped. The user logs in themselves (HANDOFF). **Status: pending.**
- 04:37: the user reported a login, but the Playwright-driven page still shows the settings URL as 404 with "Sign in" in the header, and `https://github.com/` shows the logged-out landing page.
  - The Playwright MCP attaches over CDP (`localhost:9222`) to the Chromium started with `--user-data-dir=/home/wessell/.chromium-debug`. That process has been up about 16.5 h, so it wasn't restarted.
  - `GET localhost:9222/json/list` shows exactly **one** page, the Playwright tab.
  - So the login went into another browser window or profile, not this Chromium. I opened the sign-in page in the Playwright tab again (title "Sign in to GitHub") and stopped (HANDOFF).
- **Read-only findings from the public API (no login needed):**
  - `GET api.github.com/repos/TheScriptingGuy/Joplin-Web-App` returns **200 to an anonymous client: the repo is public.** Other fields: `default_branch: main`, created 2026-10-03, no tags, licence detected as MIT, description "Frontend and API for Joplin Web App with sync and MCP capabilities". `TheScriptingGuy/notestead` returns 404 (the name is free).
  - The remote `main` is `4af1d3a` "Initial commit" (only `LICENSE`, MIT, made by GitHub at repo creation). It is the **root commit of our local `main`**, so the first push of `main` is a fast-forward and needs no force. Our `5b7bded` relicenses to AGPL-3.0-or-later.
  - Because the repo is public, the push publishes the full history immediately.

## C. Deploy key and remote
- `~/.ssh/notestead_deploy` and `.pub` did not exist beforehand.
- Generated the key with `ssh-keygen -t ed25519 -N "" -C "notestead-deploy@raspberry" -f ~/.ssh/notestead_deploy`.
  - The private key is mode 600 and was never read or printed.
  - Public key fingerprint: `SHA256:1NXEfJrJcM7sQmTtMA45K564i4X4plog8+lRVGRtBqQ notestead-deploy@raspberry (ED25519)`.
- `~/.ssh/config`: appended the `Host github-notestead` block exactly as specified; the existing `<personal SSH host>` entry is kept.
  - Backup: `~/.ssh/config.bak-2026-10-05`.
  - `ssh -G github-notestead` resolves `hostname github.com`, `user git`, `identityfile ~/.ssh/notestead_deploy`, `identitiesonly yes`.
- **known_hosts, verified rather than trust-on-first-use.** `github.com` was not in `~/.ssh/known_hosts` (`ssh-keygen -F` returned nothing). Published fingerprints from two independent TLS sources agree:
  - docs.github.com, "GitHub's SSH key fingerprints"
  - `https://api.github.com/meta` `ssh_key_fingerprints`

  | Type | Fingerprint |
  |---|---|
  | Ed25519 | `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` |
  | ECDSA | `SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM` |
  | RSA | `SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s` |

  - `ssh-keyscan -t ed25519,ecdsa,rsa github.com` was fingerprinted with `ssh-keygen -l`. A key is appended only on an exact match, and the step fails closed on any mismatch: 3 matched, 0 mismatched, 3 appended.
  - Backup: `~/.ssh/known_hosts.bak-2026-10-05`.
  - The first attempt counted `ssh-keyscan`'s `# github.com:22 SSH-2.0-…` banner comments as mismatches and appended nothing. The second attempt drops comment lines.
- **Pre-check** (before the key was registered): `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -T git@github-notestead` gave `git@github.com: Permission denied (publickey).` (exit 255). The host key verified without a prompt; authentication fails as expected.
- **`origin` is left at `https://github.com/TheScriptingGuy/Joplin-Web-App.git` until the rename and the deploy key exist,** so it never points at a repo that doesn't exist.
- **Pending (after the user logs in):**
  - add the public key at `https://github.com/TheScriptingGuy/notestead/settings/keys/new` as "notestead-deploy (raspberry pi)" with write access
  - `git remote set-url origin git@github-notestead:TheScriptingGuy/notestead.git`
  - `ssh -T git@github-notestead`
  - `git ls-remote origin`

## Notes for the orchestrator
- **`.playwright-mcp/` is not gitignored.** The Playwright MCP writes page snapshots and console logs to `/home/wessell/Joplin-Web-App/.playwright-mcp/`, and only paths inside the repo are allowed. I move them to `~/joplin-web-app-work/evidence/ci-m1-s9/playwright-mcp/` and commit by explicit path only. Adding `.playwright-mcp/` to `.gitignore` is outside my paths.
- `~/.ssh/config` is mode 664, as it was before. `ssh -G` and `ssh -T` used it without a permissions error. I left it unchanged; tightening it to 600 is the user's call.
