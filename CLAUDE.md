# Joplin Web App: project conventions

A self-hosted companion stack for Joplin, built from **existing upstream Joplin components**:
1. **Web UI.** Upstream's official react-native-web build of the Joplin mobile app (`packages/app-mobile`, `yarn web`), served as static files. It syncs with the user's existing self-hosted Joplin Server through a same-origin reverse proxy.
2. **Headless Data API.** The pinned `joplin` CLI (npm) runs under a Node supervisor. It provides the same REST Data API as the desktop app, plus periodic sync and E2EE decryption.
3. **MCP server.** Notes, to-dos, alarms (`todo_due`), notebooks, tags, reorganization and sync for AI clients. It builds on the REST Data API and upstream's built-in `/mcp` tools.

Status and plan: `docs/backlog/STATUS.md`. The bootstrap plan and research are in `docs/research/`. Once Phase A is approved, the architecture is in `docs/architecture/ARCHITECTURE.md` and `docs/adr/`.

## Golden rules
- **Reuse, never fork.** Consume upstream Joplin through its published or documented interfaces only:
  - the npm `joplin` CLI and `@joplin/lib` at pinned versions
  - the app-mobile web build at a pinned ref
  - the REST Data API (`readme/api/references/rest_api.md` upstream)
  - MCP JSON-RPC
  - the Joplin Server sync API, used indirectly through upstream's client

  Never copy upstream source into this repo. If a change to upstream is unavoidable, it becomes a file in `patches/` with a written justification and an upstream PR or issue link. Prefer proposing the change upstream.
- **One version pin.** Upstream versions live only in `upstream/joplin-version.json` (web ref, CLI npm version, `joplin/server` test tag). Stay on the same minor version as the user's server and clients (3.7.x).
- **License: AGPL-3.0-or-later**, the same as upstream. New dependencies must have AGPL-compatible licenses.
- **Trademark.** "Joplin" is a registered trademark of JOPLIN SAS, and upstream logos/icons are all-rights-reserved. Don't ship them in images or bundles we publish (overlay our own icons). Use "for Joplin (unofficial)" style naming.
- **Same language and tooling as upstream.** TypeScript, yarn 4 through corepack (`corepack yarn …`), Jest, Playwright, eslint modeled on Joplin's config. Upstream needs Node >= 22.19; the dev box has Node 24.

## Environment (dev machine)
- Raspberry Pi 4: **arm64**, 8 GB RAM, 2 GB swap, 4 cores, Debian-based Raspberry Pi OS.
- **podman 5.4** with `podman-compose` (no docker). Use `podman compose …`. Images must be multi-arch (amd64 + arm64).
- **There is no `yarn` binary;** always use `corepack yarn`. There is no `gh` CLI.
- Playwright Chromium is installed in `~/.cache/ms-playwright`.

**Resource rules:**
- Run only **one heavy job at a time**: builds, `yarn install` of big trees, the E2E suite, container builds. Use 1 Playwright worker locally.
- Put long jobs in the background with a timeout.
- Never change system configuration (swap, apt packages, sudo, systemd, firewall) yourself. Report the need to the orchestrator, who asks the user.

**Working directories outside the repo** (for large or throwaway things):
- `~/joplin-web-app-work/upstream-joplin`: reference clone of laurent22/joplin (clone it if missing; keep it read-only).
- `~/joplin-web-app-work/spikes/<id>`: spike scratch.

## Agent team and workflow
The main Claude session is the **only orchestrator**. It dispatches one agent at a time and keeps `docs/backlog/STATUS.md` up to date. Agents never dispatch other agents.

| Agent | Owns (writes) |
|---|---|
| `architect` | `docs/architecture/**`, `docs/adr/**`, `docs/spikes/**`, `docs/backlog/M*.md` |
| `qa-specialist` | `docs/testing/**`, `docs/test-plans/**`, `tests/**`, test fixtures and harness config |
| `senior-engineer` | `packages/**`, `deploy/**`, `upstream/**`, `patches/**`, CI workflows, `docs/worklog/**` |
| `lead-engineer` | `docs/reviews/**` (it never edits code) |

**Phase A (architecture):**
1. The architect produces the architecture, ADRs, spike reports and backlog.
2. The orchestrator commits them.
3. **STOP: the user approves** before any QA or engineering work. After approval, tag `plan-approved-v1`.

**Phase B (per story, on branch `feat/<story-id>-<slug>`):**
1. **QA** writes `docs/test-plans/<story>.md`, mapping every acceptance criterion (for example `M2-AC3`) to test IDs per layer, including a negative control where it makes sense. QA commits **failing tests first**.
2. **Senior engineer** implements until QA's tests pass. It may **not** edit `tests/**` or ADRs; disagreements go under `## Disputes` in the test plan, and QA decides. It keeps `docs/worklog/<story>.md` with the approach, exact commands run, ADR deviations and test evidence.
3. **QA** runs every layer and appends per-criterion results, with links to logs and traces, to the test plan.
4. **Lead engineer** writes `docs/reviews/<story>-r<N>.md` with the verdict **APPROVE** or **CHANGES_REQUESTED**, keeping code findings and process findings separate. After 3 rounds without approval, the orchestrator escalates to the user.
5. The orchestrator merges with `--no-ff`, never squashing, so the test-first history stays visible.

**Definition of done:**
- Every acceptance-criterion test passes on arm64 (locally) and x64 (CI when available).
- `corepack yarn lint` and type checks are clean.
- Docs are updated.
- QA has signed off and the lead has approved.

## Commits
- Use small, focused commits with an imperative subject.
- Every commit message ends with a trailer naming the agent, then the attribution line:
  ```
  Agent: <architect|qa-specialist|senior-engineer|lead-engineer|orchestrator>
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  ```
- **Never push, open PRs or publish images** unless the user explicitly approves it.
- Never commit secrets, tokens or real note content.

## Testing conventions
- **Test pyramid:** unit (Jest, mocked Data API client), integration (real CLI profile), contract (a throwaway `joplin/server` container ↔ headless ↔ MCP over real HTTP), E2E (Playwright on a real browser against the web container).
- **Throwaway Joplin Server for tests:** `joplin/server:<pinned tag>` with `APP_ENV=dev` (or `--env dev`) and `JOPLIN_IS_TESTING=1`.
  - Seed with `POST /api/debug {"action":"createTestUsers"}` (`admin@localhost`/`admin`, `user1@example.com`/`111111`).
  - Reset with `clearDatabase`.
  - Readiness: `GET /api/ping` → `{"status":"ok",…}`.
- **Never point automated tests at the user's real Joplin Server.**
- **Assert on data** through the Data API or MCP as well as through the UI. Use `expect.poll`/`waitFor`, never fixed sleeps. Isolate per test (fresh browser context and OPFS, fresh profile). Attach server, headless and browser-console logs to failing tests.
- Keep the good patterns from the user's plugin repo (thescriptingguy/joplin-repeating-todos-plugin): negative controls, "type like a user" input helpers, a hand-written `jest.fn` mock module with a reset helper and pinned fake timers.
- **No `.only`, no skipped tests,** and never weaken an assertion to make a test pass.

## Security rules
- The Data API token travels in the query string (`?token=`), so it must never leave the headless container. Redact query strings in all logs.
- MCP writes must **never** reach `POST /notes` with untrusted bodies. That route downloads `file:`/`http(s):` images, so `file:///…/database.sqlite` would exfiltrate the plaintext secrets. Sanitize bodies; prefer upstream `create_note`/`update_note` (which use `Note.save`).
- Destructive MCP tools default to the trash. Permanent delete sits behind a config flag and carries `destructiveHint`.
- Secrets (sync password, E2EE master password, MCP bearer token) come from env/podman secrets, never from the repo.
