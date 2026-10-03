# Bootstrap plan (approved by the user on 2026-10-03)

## Context
`/home/wessell/Joplin-Web-App` is empty apart from an MIT LICENSE; the remote is github.com/TheScriptingGuy/Joplin-Web-App. The goal is a self-hosted project with three parts:
1. **Web UI:** the real Joplin UI in a browser, on x64 and arm64, syncing with the user's **existing self-hosted Joplin Server**, with plugins installable.
2. **Headless Data API:** the same REST API the desktop app exposes.
3. **MCP server:** lets AI clients create and update notes, to-dos, notebooks and tags, set alarms, and reorganize.

It must reuse existing Joplin components and never fork, so it keeps working as Joplin updates. It uses TypeScript and Joplin's own tooling. A team of four Claude Code agents builds it: **architect** (plans first), **QA specialist**, **senior engineer** and **lead engineer** (reviews the engineer).

**User decisions:**
- Relicense to **AGPL-3.0-or-later**.
- Sync with the **existing self-hosted Joplin Server**; tests use a throwaway server.
- **E2EE is enabled.**
- **Pause for user approval** after the architect's plan, before QA and engineering start.

**Environment:** Raspberry Pi 4 (arm64, 8 GB, 4 cores), Node 24.17, podman 5.4, no docker, no yarn (corepack is available), no `gh`.

## Research findings that drive the design
Upstream is laurent22/joplin at cd32d86 (2026-10-03). Latest desktop is v3.7.21. npm `joplin` and `@joplin/lib` are 3.7.1. `joplin/server:3.7.2` is published for both amd64 and arm64.

**Web UI: reuse upstream's official web build.**
- `packages/app-mobile` builds a react-native-web bundle with `yarn web` → `web/dist`. It is the same bundle as app.joplincloud.com, built by the github.com/joplin/web-app workflow.
- **The output is static and architecture-neutral.**
- It needs HTTPS (or localhost) and COOP/COEP headers. It is a PWA, stores data in sqlite-wasm on OPFS, and supports E2EE, sync target 9 (Joplin Server) and plugins whose manifest includes the `mobile` platform (from the repo or by `.jpl` upload).
- Your repeating-todos plugin declares `["desktop","mobile"]`, so it is an acceptance target. It also uses `views.menus`, which doesn't exist on web, so expect the menu entry to be missing there.
- **Gaps:**
  - No alarm notifications on web (`AlarmServiceDriver.web.ts` does nothing).
  - No upstream tests for the web build.
  - Upstream CI deletes app-mobile on ARM64, so a build on the Pi is doubtful.
  - `web/public/environment.js` turns on dev mode for any origin containing "localhost".

**Joplin Server CORS is hard-coded** (`packages/server/src/app.ts`).
- There is no env var for extra origins, so the web app has to reach the server through a **same-origin reverse proxy**.
- `isValidOrigin` compares the Host header with `APP_BASE_URL` and ignores `X-Forwarded-Host`, so the proxy must rewrite Host.
- The sync client builds every URL from its base URL and uses no absolute URLs from the server.

**Headless:**
- The npm `joplin` CLI's `server start` runs the same `ClipperServer` + `Api` as desktop. It binds only to `127.0.0.1` and takes its token from the `?token=` query string.
- Without a GUI it does **not** sync on a timer, start the decryption worker or download resources. The search index is only built at startup.
- Running `joplin sync` in parallel with the server process can clobber settings.
- The CLI can't load plugins.
- Linux keeps secrets in plaintext in the profile's `database.sqlite`.

**Upstream MCP (Joplin 3.7, beta).**
- Served at `POST /mcp` on the Data API port, gated by `mcp.enabled` plus a per-tool `ai.tool.*.enabled` setting. It uses one JSON-RPC request per POST and offers tools only.
- **Tools:** `search_notes`, `read_note`, `read_image`, `list_notebooks`, `list_tags`, `create_note`, `update_note` (including moving a note and completing a to-do), `delete_note` (to trash), `manage_tags`, `create_notebook`.
- **Missing:** alarms/`todo_due`, notebook rename/move/delete, tag rename/delete, ordering, attachments, revisions, trash restore, sync. The REST Data API covers all of these.

**Security finding:** the REST `POST /notes` route downloads images referenced in the body from `file:` and `http(s):` URLs (`routes/notes.ts`). An LLM-written `![](file:///…/database.sqlite)` could therefore attach the profile database, which holds the secrets, and sync it to the server.

**Alarms are per device and not synced.** Setting `todo_due` through the API makes them fire on your desktop or phone after it syncs.

**Tests:**
- **Your plugin repo:** an x64-only AppImage driven over CDP. Good patterns to keep: negative controls and realistic typing. Weaknesses: UI-only assertions, fixed sleeps, per-file isolation.
- **Upstream patterns to reuse:**
  - Playwright fixtures with a fresh profile per test and log attachment.
  - Page objects using `getByRole`.
  - `lib/testing/test-utils.ts`.
  - Joplin Server's `POST /api/debug {"action":"createTestUsers"}` (env=dev), `JOPLIN_IS_TESTING=1`, and the `/api/ping` health check.

## Target architecture (starting point; the architect confirms it in ADRs during M0)
- **Monorepo:** yarn 4 workspaces through corepack, TypeScript, eslint modeled on Joplin's, Jest, Playwright. Language and tooling match upstream.
- **Version pin.** One file, `upstream/joplin-version.json`, pins the web-bundle ref (release branch + commit), the `joplin` CLI npm version and the `joplin/server` test tag.
  - Pin to the same minor version (3.7.x) as your server and clients.
  - No fork. Any unavoidable change goes in `patches/` with a justification and an upstream PR link, and CI fails if it stops applying.
  - CI also fails if upstream source is copied into the repo.
- **Container 1, `web` (Caddy, multi-arch):**
  - Contains the prebuilt bundle (`packages/web-build`).
  - Serves `/` with COOP/COEP headers and the wasm MIME type.
  - Proxies only `/joplin-server/api/*` to your Joplin Server: Host rewritten, prefix stripped, Origin stripped, streaming kept. The server's `/login` and `/admin` pages are not re-published.
  - Optionally exposes `/mcp` to the LAN (opt-in).
  - The build overlay replaces upstream logos, icons and the manifest, and sets `__DEV__=false`.
  - The page links to the exact source at `/source`, as AGPL §13 requires.
  - TLS: plain HTTP behind your existing TLS proxy by default, with ACME DNS-01 as an option. A private CA won't work because phones won't trust it, and OPFS and WebCrypto need a trusted secure context.
- **Container 2, `headless`:** a Node supervisor (`packages/headless`) that runs the pinned `joplin` CLI as a child process. The Data API never leaves the container, so the `127.0.0.1` bind isn't a problem.
  - `SyncStrategy` interface. The default is **stop-the-world**, using only public CLI commands:
    1. Hold a mutex.
    2. Stop the server.
    3. Run `joplin sync`, then `joplin e2ee decrypt`.
    4. Restart the server, which also refreshes the search index.

    It runs on a timer, debounced after MCP writes, or on `sync_now`. The fallback is in-process hooks (`setupRecurrentSync`, `DecryptionWorker`, `scheduleSyncTables`), only if the outage per cycle turns out to be too long.
  - Config comes from env plus podman secrets: Joplin Server URL, user, password and the E2EE master password.
  - Also provides `/healthz`. Runs non-root with a read-only root filesystem, a 0700 profile volume and outbound traffic limited to the Joplin Server.
- **`packages/mcp`:**
  - A library built on `@modelcontextprotocol/sdk`. It is served over streamable HTTP by the headless supervisor and also has a stdio entry point, so it works against a desktop Joplin too.
  - **Gap tools** use only the documented REST Data API:
    - set or clear an alarm/due date, complete or reopen a to-do
    - rename, move or delete a notebook
    - rename or delete a tag, list all tags
    - reorder notes
    - attach a file
    - revisions
    - restore from trash
    - sync now and sync status
  - **Upstream `/mcp` tools are passed through** from an explicit allow-list, if spike S4 proves this works in the CLI. Their `tools/list` output is snapshot-tested on every version bump, so changes are never silent. The fallback is REST-only tools.
  - Upstream `create_note` and `update_note` call `Note.save` directly and don't download remote images, so they are preferred for writing bodies.
  - **Guards:**
    - A body sanitizer allows only `:/resourceId` image and link sources (https only behind a flag).
    - Destructive tools go to the trash by default. Permanent delete sits behind a config flag and carries `destructiveHint`.
    - Bearer token of at least 32 bytes, Origin validation and rate limiting.
    - Query strings are redacted in logs.
- **Upstream-first.** Every gap becomes a proposed upstream PR, so local shims shrink over time:
  - missing MCP tools
  - a headless sync / bind-host option
  - disabling `file:` image downloads
  - web alarm notifications
  - a runtime web config hook

## Agent team and operating procedure
Agent definitions go in `.claude/agents/<name>.md` (frontmatter `name`, `description`, `tools`, `model: inherit`). Shared rules (stack, commands, branch/commit conventions, Pi resource limits) go in `CLAUDE.md`. The **main session is the only orchestrator**: it dispatches agents one at a time and keeps `docs/backlog/STATUS.md` up to date.

| Agent | Produces | Rules |
|---|---|---|
| `architect` | `docs/architecture/ARCHITECTURE.md`, `docs/adr/NNNN-*.md`, `docs/spikes/S*.md` (go/no-go with evidence), `docs/backlog/M<n>.md` (stories with acceptance-criterion IDs such as `M2-AC3`), reuse map, version-skew and rollback policy | Reuse first: every new component must justify why no upstream component fits. Writes only to docs and spike scratch. Tags `plan-approved-v1` after you approve. |
| `qa-specialist` | `docs/testing/strategy.md`; `docs/test-plans/<story>.md` mapping each acceptance criterion to test IDs per layer (fixtures, negative control); **failing tests committed first** on `feat/<story>`; verification results per criterion with links to traces and logs | Owns `tests/` and the harness. Keeps the good patterns from your plugin repo and fixes its weaknesses: data-level assertions through the API/MCP, `expect.poll` instead of sleeps, isolation per test, logs attached. |
| `senior-engineer` | Implementation on the same branch with the commit trailer `Agent: senior-engineer`; `docs/worklog/<story>.md` (approach, commands run, ADR deviations, test evidence on arm64 and x64) | May not edit QA's tests or ADRs. Disagreements go under `## Disputes` in the test plan. |
| `lead-engineer` | `docs/reviews/<story>-r<N>.md`: APPROVE or CHANGES_REQUESTED, with code findings and process findings kept separate | **Code:** correctness, security, ADR conformance, upgrade safety. **Process:** tests committed before the implementation, the engineer didn't touch `tests/`, the worklog matches the real runs, no `sleep`/`.only`/skipped tests, ADR deviations recorded, no upstream code copied, licences of new dependencies are AGPL-compatible, no scope creep. |

**Flow:**
1. **Phase A.** The architect writes the docs and runs the spikes. Commit → **STOP for your approval**.
2. **Phase B, for each story:**
   1. QA writes the test plan and failing tests.
   2. The engineer implements.
   3. QA runs every layer and records the results.
   4. The lead reviews. Up to 3 rounds; then I escalate to you.
   5. Merge with a merge commit (no squash), so the test-first history stays visible.

**Definition of done:** all acceptance tests green on x64 and arm64, lint and type checks clean, docs updated, QA has signed off and the lead has approved. Heavy builds and tests on the Pi run one at a time (single queue, 1 Playwright worker).

## Test strategy (the QA agent owns and expands it)
| Layer | What | How |
|---|---|---|
| **Unit** | MCP tool handlers, sanitizer, supervisor state machine | Jest with a mock Data API client, modeled on your plugin's `test/mocks/api.ts` with `jest.fn` defaults, reset helpers and fake timers |
| **Integration** | Headless supervisor and REST against a real CLI profile | Jest + execa, following upstream `cli-integration-tests.test.ts` |
| **Contract** | Throwaway `joplin/server:3.7.2` (env=dev, `createTestUsers`, `clearDatabase`) ↔ headless ↔ MCP over real HTTP | Snapshots of REST response shapes and the MCP `tools/list`; E2EE account fixture; headless contract suite (sync round trip, decrypt, search finds newly synced notes, attachments) |
| **E2E** | Playwright in a real browser against the `web` container | Fixtures: `joplinServer` and `headless` per worker; `webApp` with a fresh context and OPFS per test; `mcpClient`; `e2eeAccount`. Page objects use `getByRole`. |

**Cross-surface E2E flows:**
- MCP creates a to-do with an alarm → the web UI shows it.
- An edit in the web UI → MCP `read_note` returns it.
- A conflict.
- Installing the repeating-todos plugin on web.
- Negative controls.

CI runs on GitHub Actions with ubuntu-24.04 and ubuntu-24.04-arm; the Pi can be a self-hosted runner if the repo is private. On the Pi, Playwright runs in the official multi-arch Playwright container.

## Milestones (the architect finalizes acceptance criteria)
- **M0 Foundations and spikes**
  - Scaffold, AGPL relicense, agent definitions, `CLAUDE.md`, version pin, CI skeleton, GHCR access.
  - **S1:** build the bundle on the Pi vs on x64 CI.
  - **S2:** same-origin proxy checklist: Host rewrite, prefix strip, Origin, rate limiter behind the proxy, large attachments, share links, E2EE in the browser, sync-target version unchanged.
  - **S3:** headless strategies with E2EE on arm64; measure the outage per sync cycle.
  - **S4:** Playwright with OPFS and COEP on the Pi, plus turning on upstream `/mcp` in the CLI.
  - **S5:** compatibility with your server and client versions.
  - ADRs final → **user gate**.
- **M1 Walking skeleton and harness.** The compose test stack runs on the Pi and on x64 CI. One cross-surface E2E test (REST-created note shows up in the browser) passes on both architectures, with logs and traces attached.
- **M2 Web app.**
  - E2E coverage: sync through the proxy, E2EE unlock, CRUD on notes/notebooks/tags/to-dos, due dates, search, attachments, trash, plugin install (repo and `.jpl`, including repeating-todos), offline reload, upgrading to a new bundle.
  - Branding overlay and `/source` link in place.
- **M3 Headless.** Sync loop, decrypt, re-index, health check, secrets, backups. Tests cover conflicts, E2EE and settings not being clobbered.
- **M4 MCP.** Every required tool works. A negative test for the file:// guard. Auth and Origin checks. Cross-surface E2E in both directions.
- **M5 Release.** Multi-arch images on GHCR (private until the trademark question is settled), podman and docker compose files, TLS and backup/restore docs, a rollback runbook (browser databases only migrate forward; the service worker caches the bundle). You run a manual smoke test against your real server, **after backing up the server database**.
- **M6 Upgrades.** A scheduled workflow opens bump PRs that run the full suite, check that patches still apply, check the sync-version constant and run the headless contract suite.

## Top risks and mitigations
1. **The upstream web build breaks, or can't be built on arm64.** Build on x64 CI; the Pi pulls the arch-neutral image; zero patches; bump PRs run the full suite.
2. **Headless relies on CLI internals.** Default to the public-command strategy, hidden behind `SyncStrategy`, with a contract suite on every bump.
3. **The proxy is rejected or the versions don't match.** Prove it in S2; keep a compatibility matrix for your exact server version.
4. **A database or sync-target upgrade locks out your other devices.** Pin to the same minor version, check the sync-version constant, back up first.
5. **Secret leaks** through file:// downloads, prompt injection or logs. Sanitizer, egress limits, read-only container, redaction, destructive actions behind a flag.
6. **Browser constraints:** secure context, COEP blocking external images or plugins, Safari. Use your existing TLS; test both COEP modes.
7. **Trademark and logos.** Replace the icons, use an unofficial name such as "… for Joplin (unofficial)" with a not-affiliated notice, keep images private, optionally ask JOPLIN SAS for permission. **To decide at the gate.**
8. **Agents drifting** (weakening tests, scope creep, overloading the Pi). Test-ownership check, the lead's process checklist, a serialized job queue, escalation after 3 rounds.

## Execution steps after you approve this plan
1. Write the agent files `architect.md`, `qa-specialist.md`, `senior-engineer.md` and `lead-engineer.md`, plus the initial `CLAUDE.md`, on a branch `chore/agent-team`.
2. Dispatch the **architect** for Phase A: M0 docs, ADRs, spikes S1–S5 (scratch and container work only) and the backlog.
3. **Stop and present the architecture to you.** Decisions for you then: project name/branding, TLS front, the GitHub token for pushing and GHCR (there's no `gh`; I'll ask before the first push), and your Joplin Server URL and version.

## Verification
- **Phase A (this plan's immediate output):**
  - `docs/architecture/ARCHITECTURE.md`, the ADRs, `docs/backlog/M*.md` and `docs/spikes/S1–S5.md` exist, and each spike has a go/no-go with command output as evidence.
  - Every architectural component traces to an upstream reuse decision.
- **Each milestone after that:**
  - `corepack yarn lint && corepack yarn test` (unit + integration).
  - `corepack yarn test:contract`, which starts a throwaway `joplin/server` with podman.
  - `corepack yarn test:e2e` (Playwright), run on the Pi (arm64) and in CI (x64 + arm64).
  - QA's per-criterion results and the lead's APPROVE are committed under `docs/`.
- **End-to-end smoke test (M5):**
  1. Run `podman compose -f deploy/compose.yaml up`.
  2. Open the web app over HTTPS, set sync to `/joplin-server`, unlock E2EE, and check that existing notes appear.
  3. Install repeating-todos from a `.jpl` file.
  4. Run `claude mcp add --transport http joplin https://<host>/mcp --header "Authorization: Bearer …"` and ask Claude to "create a to-do 'Test' due tomorrow 9:00 in notebook X with tag Y".
  5. Check it appears in the web UI, and that the alarm fires on your phone or desktop after it syncs.
  6. Use the Playwright MCP tools in this session for exploratory checks.
