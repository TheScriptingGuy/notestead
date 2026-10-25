# ADR-0007: Test strategy and harness

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`), amended the same day and on 2026-10-16 for M1 as built (see Amendments). Proposed in Phase A (2026-10-03). The QA specialist owns and expands it in `docs/testing/strategy.md` once the plan is approved.

## Context
- **Upstream has no tests for the web build and no CI job builds it** (findings §1). Our suite is therefore the only gate between an upstream bump and the user's notes.
- **The user's plugin repo shows what to keep and what to fix.**
  - Keep: negative controls, "type like a user" helpers, a hand-written `jest.fn` mock module with a reset helper, fake timers with a pinned clock.
  - Fix: UI-only assertions, fixed sleeps, per-file isolation, logs never attached, x64 only.
- **Upstream patterns worth reusing as patterns:**
  - Playwright fixtures with a fresh profile per test and log attachment (`upstream:packages/app-desktop/integration-tests/util/test.ts`)
  - page objects built on `getByRole` (`…/models/*.ts`)
  - the CLI process tests (`upstream:packages/app-cli/app/cli-integration-tests.test.ts`, execa + `--profile`)

  We reuse them as patterns only, never by copying the code.
- **The Joplin Server test hooks** (`POST /api/debug {createTestUsers|clearDatabase}`, `JOPLIN_IS_TESTING=1`, `GET /api/ping`) were exercised in S2/S3.
- **S2 finding:** `APP_ENV=dev` is ignored by the `joplin/server:3.7.2` image, because its CMD runs env=prod and the env comes from `--env`. The working recipe is `node dist/index.js --env dev --env-file /dev/null`.
- **The Pi** has 8 GB and 4 cores, and the desktop session (Chromium, Claude) already uses ~2.5 GB.

## Decision
### Layers
| Layer | Scope | Tooling | Runs where |
|---|---|---|---|
| **Unit** | MCP tool handlers, body sanitizer, supervisor state machine and `SyncStrategy` scheduling, Data API client, config parsing, redaction | Jest + ts-jest. A hand-written mock Data API module (`tests/mocks/dataApi.ts`, `jest.fn` defaults plus `resetDataApiMock()`). Fake timers with a pinned clock. | every commit, Pi + CI |
| **Integration** | Supervisor ↔ real `joplin` CLI child process on a temp profile. No Joplin Server unless the test needs sync. Covers config import, server start/stop, token rotation, redaction, guards on the real REST API. | Jest + execa; temp profile per test | Pi + CI |
| **Contract** | Real HTTP between real components: a throwaway `joplin/server:<pin>` ↔ `web` proxy ↔ `headless` ↔ MCP | Jest + `podman`/`docker` CLI via a small `tests/stack` helper | Pi + CI |
| **E2E** | A real browser against the real `web` container (served bundle + proxy) with server and headless running | Playwright, Chromium (1 worker on the Pi) | Pi + CI |

**Contract suites:**
- **`proxy`:** the S2 checklist C1–C8 plus R1–R3, and since gate 1 C9/C10 and the tunnel-mode client-IP check with R5-neg (S6), including the negative controls (no Host rewrite → `Invalid origin`; passing `X-Real-IP` through → limiter bypass; `CF-Connecting-IP` from an untrusted peer → ignored). A fixture container at the trusted address stands in for cloudflared, so no Cloudflare account is needed in tests.
- **`rest-shape`:** snapshots of response *shapes* (keys and types, not values) for every route we use.
- **`mcp-upstream`:** `tools/list` snapshot of the upstream allow-listed tools (names, descriptions and input schemas).
- **`headless`:**
  - sync round trip
  - E2EE decrypt
  - search finds newly synced notes
  - attachments
  - no settings clobbered
  - `syncVersion` check

**E2E cross-surface flows** (the M1 walking skeleton grows into these):
- REST/MCP creates → web shows.
- Web edits → MCP `read_note` returns the edit.
- Conflict: both sides edit → conflict note visible on both.
- E2EE unlock in the web app.
- Plugin install (repo and `.jpl`), including the user's repeating-todos plugin.
- Offline reload; bundle upgrade.

### Fixtures and isolation
*Amended 2026-10-16: the E2E stack is one per run, the fixture is `headlessService`, and a serial rule applies. See Amendments (2026-10-16).*

- **`joplinServer`** (per worker): a container from the pinned tag, run with the command `node dist/index.js --env dev --env-file /dev/null` and `JOPLIN_IS_TESTING=1`.
  - The rate-limiter contract tests (M1-AC11) start a second server **without** `JOPLIN_IS_TESTING`.
  - **Per test:** a fresh user is created through the admin API (`admin@localhost`, created by `createTestUsers`). This isolates tests without restarting the server.
  - `clearDatabase` runs only in worker teardown.
- **`headless`** (per test that needs it): a fresh profile directory and a fresh supervisor process (integration) or container (contract/E2E). It is configured for the test's user.
- **`e2eeAccount`:** a CLI "other device" profile that runs `e2ee enable --password` **inside `joplin batch` together with `sync`** and seeds notes. S3 found that a standalone `e2ee enable` doesn't persist the key in CLI 3.7.1. The fixture also seeds a to-do with `todo_due`, a tag and an attachment, then syncs. It is rebuilt per test (~9 s on the Pi, measured in S3), or once per worker for read-only tests.
- **`webApp`:** a fresh browser context per test (fresh OPFS/service worker), with a page object for the app. It is served on `127.0.0.1` (not `localhost`), because `environment.js` turns on dev mode for any origin containing "localhost" (`upstream:packages/app-mobile/web/public/environment.js:2`).
- **`mcpClient`:** `@modelcontextprotocol/sdk` client over streamable HTTP with the test bearer token.

### Rules (enforced by lint and the lead's process checklist)
- Assert on **data** through the Data API or MCP in addition to the UI.
- Use `expect.poll`/`waitFor` only. ESLint bans `page.waitForTimeout`, `setTimeout`-based sleeps in tests, `.only` and `.skip`/`test.fixme`.
- Every acceptance criterion with a meaningful failure mode has a **negative control**.
- **On failure, attach:**
  - server logs (`podman logs`)
  - supervisor logs (already redacted)
  - browser console
  - Playwright trace
  - Caddy access log (redacted)
- **No retries locally.** CI uses `retries: 1` with a flaky report, and a test that is flaky twice in a week becomes a bug.
- **Never point a test at the user's real server.** The harness refuses any `JOPLIN_SERVER_URL` that isn't a container it started.

### Where things run
- **CI (GitHub Actions):** `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64) run lint, unit, integration, contract and E2E. The web bundle is built **once on x64** (ADR-0001) and both architectures consume it as an artifact.
- **Pi:** the same commands, one heavy job at a time, Playwright with `workers: 1`.
  - Locally, Playwright uses the installed Chromium (`~/.cache/ms-playwright`). An explicit `executablePath` is allowed when the revision differs, which S4 proved works.
  - CI uses the official multi-arch Playwright container image at the pinned Playwright version. *(Superseded 2026-10-16: Chromium is installed on the runner. See Amendments (2026-10-16).)*

## Alternatives considered
- **Reuse upstream tests as-is (run upstream's Jest/Playwright suites against our build).** Upstream has no web-build tests. Its lib tests are coupled to the monorepo (hard-coded `app-cli/tests` paths, findings §5), and the desktop Playwright suite targets Electron. Only the patterns transfer.
- **UI-only E2E (as in the plugin repo).** Brittle and blind to data loss. Rejected.
- **Mocked Joplin Server.** Fast, but it would not catch the proxy, CORS and origin behaviour that S2 showed to be the riskiest interface. A real server container is cheap (213 MB RSS; Caddy 12 MB; measured in S2).

## Consequences
- The contract and E2E layers need podman/docker. The Pi runs them serially and in full, but slowly (minutes).
- Per-test users keep the server warm and tests independent.

## Upgrade impact
- The suite is the bump gate (ADR-0005). Snapshot diffs in `rest-shape` and `mcp-upstream` make upstream interface changes visible in the bump PR, so they are never silent.

## Verification
- **S2:** the proxy checks are scripted and reproducible (`docs/spikes/S2/`).
- **S3:** the CLI integration patterns and timings.
- **S4:** Playwright on the Pi with OPFS/COEP.
- **M1 acceptance criteria:** the walking skeleton on both architectures.

## Amendments (2026-10-04, gate 1)
- The `proxy` contract suite gains C9 (Cloudflare Access headers not forwarded), C10 (`no-store, no-transform`) and the tunnel-mode client-IP test with negative control R5-neg (ADR-0002 rule 4, S6). Real-Cloudflare checks happen only in the user's manual smoke test (M5-AC11); automated tests never need a Cloudflare account.

## Amendments (2026-10-16, M1 as built)
These record deviations that the M1 reviews accepted "pending architect" (`docs/reviews/M1-S6-r1.md` C3, `M1-S8-r1.md` §5, `M1-closeout-r1.md` C2). The 2026-10-04 text above stays as history. Where they disagree, this section wins.

### A1. One compose stack per Playwright run (replaces the per-worker `joplinServer` and `clearDatabase` in worker teardown)
- **Playwright's globalSetup** (`tests/e2e/support/globalSetup.ts`) runs the real-server guard (M1-AC19). It then brings up **one compose stack for the whole run** (`tests/stack/`): `server`, `web`, a default E2EE account and its headless service. Every service must be `healthy` before any test starts, or the run aborts and names the service (M1-AC18 and its NEG). *(Note 2026-10-25, CI-M2-S2 F to H: for `headless`, "healthy" means its supervisor's `/healthz` returns 200, which happens only after the first sync and decryption succeed (`tests/stack/compose.headless.yaml`, M1-AC15).)* Its teardown removes everything the run created.
- **The workers never own the stack.** They attach to it through `NOTESTEAD_E2E_STACK` (worker fixture `stack`, which re-runs the guard). `joplinServer` stays a worker fixture, but it is a view of the shared server (`url`, `proxiedUrl`, `publicUrl`, `request`), not a container per worker.
- **`clearDatabase` is not used.** The whole stack is thrown away at the end of each run.
- **Reuse mode.** A `JOPLIN_SERVER_URL` that names a stack the harness started attaches to that stack and never tears it down. Any other value aborts before a request is made (unchanged rule).
- **Isolation stays per test.** Each test gets a fresh server user (`e2eeAccount`), a fresh headless compose project and profile volume (`headlessService`), and a fresh `BrowserContext` and OPFS (`webApp`). A test that needs a differently configured service gets its **own extra container** next to the shared ones. The example is `webWithoutHostRewrite` for the M1-AC21 NEG, which never touches the shared `web`.
- **The contract layer is separate and unchanged in spirit.** `jest.contract.config.js` uses one worker. Its globalSetup builds the images once, and suites start their own labelled containers (`tests/contract/support/`). Harness self-tests run an inner Playwright process with `tests/harness/playwright.selftest.config.ts` (`workers: 1`).
- **Why:** "healthy before any test starts" can only hold literally if the stack exists before the workers do, and one stack is cheaper on the Pi. Per-test users and per-test headless projects keep the tests independent.

### A2. The headless fixture is named `headlessService`
Playwright reserves `headless` for its own browser option, so a fixture with that name breaks the fixture types. Read every `headless` fixture reference in this ADR and in `docs/backlog/M*.md` as `headlessService`. It depends on `e2eeAccount`, re-registers the Data API token in teardown (a CLI restart rotates it), and attaches `supervisor.log` on failure. `dataApi` is built on it.

`e2eeAccount` currently seeds a folder and one note only, not the to-do with `todo_due`, tag and attachment that §Fixtures promises. QA adds those when the first story asserts on them (M2-S2/S3 or M4). Until then, tests must not assume them.

### A3. Serial rule for tests that disrupt shared services
- A test that **stops, restarts or reconfigures a shared service** of the run's stack (`server`, `web`, or the default headless service) must do one of two things. Either it runs in a **serial Playwright project** (its own `projects` entry with `workers: 1`, or `fullyParallel: false` plus `test.describe.configure({ mode: 'serial' })`, and with no other project running at the same time), or it brings up **its own containers or its own stack**.
- Prefer its own containers (the `webWithoutHostRewrite` pattern). Use the serial project only when the shared service itself is under test.
- **This already matters in CI.** `playwright.config.ts` sets `workers: 1` only locally. In CI (`CI` set) it uses Playwright's default worker count, which is more than one on the GitHub runners.
- In M1 no `tests/e2e` spec disrupts a shared service. The one test that stops the server, the M1-AC20 self-test (`tests/harness/selftest/attachments.spec.ts`), runs under the single-worker self-test config.
- **Enforcement:** the QA test plan names each disruptive test and how it is isolated, and the lead checks it in review. Writing a lint rule for this is not worth it yet.

### A4. CI installs Playwright's pinned Chromium on the runner (replaces "the official Playwright container image" in §Where things run)
- **As built** (M1-S8, `.github/workflows/e2e.yml`, step "Playwright's Chromium"): the contract and E2E jobs run directly on `ubuntu-24.04` and `ubuntu-24.04-arm`. They install the browser with `corepack yarn playwright install --with-deps chromium`. That is the browser revision that the repo's pinned `@playwright/test` (`package.json`, 1.59.1) expects, with the OS packages from Playwright's own dependency list. It is the same revision the matching container image would carry.
- **`NOTESTEAD_CHROMIUM` is never set in CI.** With `CI` set, `tests/e2e/support/chromium.ts` uses the pinned Playwright browser and never falls back to another revision. The acceptance test `M1-S8-E07` checks that the workflow installs only Playwright's own Chromium and sets no `NOTESTEAD_CHROMIUM`. Locally, the S4 rule is unchanged: the installed revision, through `executablePath` when it differs.
- **Why not the container image:** the harness's globalSetup starts the stack with rootless podman compose. A job container can't host nested rootless podman unless we grant it privileges we must not grant (`docs/worklog/M1-S8.md` §ADR deviations).
- **Upgrade impact:** a Playwright bump changes the CI browser revision in the same commit, because it's tied to the lockfile. `--with-deps` also pulls apt packages at job time, which is a moving input. If that breaks a run, the fix is in CI, not in the product.
- **Verification:** M1-S8 X1–X9 on runs 38874722165 and 38881804121 (`docs/test-plans/M1-S8.md`). Both runners showed 3/3 E2E with no retry.
