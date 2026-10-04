# ADR-0007: Test strategy and harness

## Status
Proposed (Phase A, 2026-10-03). The QA specialist owns and expands it in `docs/testing/strategy.md` once the plan is approved.

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
- **`proxy`:** the S2 checklist C1–C8 plus R1–R3, including the negative controls (no Host rewrite → `Invalid origin`; passing `X-Real-IP` through → limiter bypass).
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
  - CI uses the official multi-arch Playwright container image at the pinned Playwright version.

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
