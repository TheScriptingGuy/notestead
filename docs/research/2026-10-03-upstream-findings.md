# Upstream research findings (2026-10-03)

**Sources:**
- laurent22/joplin `dev` at `cd32d862c46bc2f70578c6f4b6eb41514b65e329` (2026-10-03).
- npm `joplin` and `@joplin/lib` 3.7.1 (2026-09-07).
- Docker Hub `joplin/server:3.7.2` (amd64 + arm64).
- Desktop release v3.7.21: Linux AppImage is **x64 only**; there is no Linux arm64 desktop build.

Paths are relative to the upstream repo root. Anything marked UNVERIFIED was read from code but not run.

## 1. Web UI: upstream app-mobile web build
- **Build:** `packages/app-mobile/package.json`:
  - `web`: `webpack --mode production --config ./web/webpack.config.ts --progress && cp -r ./web/public/* ./web/dist/`
  - `serve-web`: dev server on port **8088**, with COOP/COEP headers.

  Output goes to `packages/app-mobile/web/dist`. The webpack config exports two configs, a service-worker config and an app config (`index.web.ts`), and aliases `react-native` → `react-native-web`.
- **Prerequisite:** a full monorepo install and build. Root `postinstall` runs `gulp build`, which runs `yarn buildParallel`, then `tsc`. app-mobile's `build` runs `compilePackageInfo`, `buildInjectedJs`, `copyWebAssets` and `encodeAssets`. `SKIP_ONENOTE_CONVERTER_BUILD=1` skips the Rust build. Root `engines`: node >= 22.19, yarn 4.16.0 (via corepack).
- **Official deploy recipe** (github.com/joplin/web-app `.github/workflows/deploy-github-pages.yml`):
  1. Check out laurent22/joplin.
  2. Switch to the newest `release-X.Y` branch.
  3. `corepack enable && yarn install && cd packages/app-mobile && yarn web`.
  4. Upload to GitHub Pages. The result is hosted at https://app.joplincloud.com.
- **ARM64:** `.github/scripts/run_ci.sh` says "nothing works properly with the ARM64 architecture" and removes app-mobile before `yarn install` on ARM64. A native Pi build is doubtful (spike S1).
- **Serving needs:**
  - **Static files only.**
  - **A secure context** (HTTPS or localhost).
  - **Cross-origin isolation** for sqlite-wasm on OPFS. `web/serviceWorker.ts` is a coi-serviceworker fork that injects COEP `credentialless` or `require-corp`, then reloads. Also send the headers from the server, and serve `.wasm` as `application/wasm`.
  - **PWA:** `web/public/manifest.json`; the service worker caches network-first.
  - **Single tab:** a second tab is redirected to `just-one-client.html`.
  - **Sub-path hosting** appears to work.
- **Gotcha:** `web/public/environment.js` sets `window.__DEV__ = location.origin.includes('localhost')`. Dev mode changes the database name, runs startup self-tests and points the Joplin Cloud URLs at `joplincloud.local`. Overlay this file after the build.
- **Storage:**
  - Database: `utils/database-driver-react-native.web.ts` (`@sqlite.org/sqlite-wasm` on OPFS in a worker).
  - Files: `utils/fs-driver/fs-driver-rn.web.ts` (OPFS `joplin-web/`).
  - No keychain; secrets live in the OPFS database.
  - Database upgrades are one-way: an older build refuses a newer profile.
- **Sync:**
  - Targets are registered in `utils/buildStartupTasks.ts`. OneDrive is unsupported on web. Filesystem needs `showDirectoryPicker` (Chromium only).
  - A self-hosted instance **cannot** sync with Joplin Cloud (`components/SyncWizard/SyncWizard.tsx`).
  - E2EE works (WebCrypto; RSA v2/v3 in `services/e2ee/RSA.react-native.web.ts`). Sync runs only while the tab is open.
- **Plugins:**
  - Enabled with `plugins.pluginSupportEnabled` (off by default).
  - Installed from the repo (`lib/services/plugins/RepositoryApi.ts`, which fetches `plugin.jpl` from raw.githubusercontent.com) or uploaded as a `.jpl` (`PluginUploadButton.tsx`).
  - Web counts as `AppType.Mobile`, so the manifest `platforms` must include `mobile`.
  - Sandbox: nested sandboxed iframes (`lib/utils/dom/makeSandboxedIframe.ts`).
  - Unsupported on web: `joplin.require` native modules, `joplin.fs`, `joplin.imaging`, `views.menus`/`menuItems`/`noteList`, `dialogs.showOpenDialog`, `joplin.ai`, and more.
  - The user's repeating-todos plugin declares `platforms: ["desktop","mobile"]` and uses `views.menus` (expect that part to be missing on web).
- **Alarms:** `services/AlarmServiceDriver.web.ts` does nothing, so due dates are stored but **no notifications fire on web**.
- **No runtime config hook** (for example, prefilling the server URL); that needs a source patch.
- **No upstream tests** for the web bundle, and no CI job builds it.
- **Docs:** `readme/dev/BUILD.md` (Web), `readme/dev/spec/web_app.md`, `readme/apps/web.md`.

## 2. Joplin Server (`packages/server`)
- **CORS** (`src/app.ts` ~129-228, `@koa/cors`):
  - The allow-list is **hard-coded**: `https://joplinapp.org` and `https://app.joplincloud.com`.
  - `localhost:8077` and `localhost:8088` are added only with env=dev; the `USER_CONTENT_BASE_URL` host and its parent are also allowed.
  - There is **no env var** for extra origins. Other origins get `https://joplinapp.org` back.
- **`isValidOrigin`** (`src/utils/routeUtils.ts`) compares the request Host with the `APP_BASE_URL`/`API_BASE_URL` host. `app.proxy` is not set, so `X-Forwarded-Host` is ignored. **A proxy must rewrite Host.**
- **Auth:** `X-API-AUTH` session header plus `X-API-MIN-VERSION`; no cookies. The client (`lib/JoplinServerApi.ts`) builds every URL as `${baseUrl}/${path}`.
- **APIs:** sync, admin and share only (`/api/items/:id[/content|/delta|/children]`, `/api/batch_items`, `/api/locks`, `/api/sessions`, users, shares, events, ping). There is **no note-editing API**.
- **Test helpers:**
  - `POST /api/debug` (env=dev only) with actions `createTestUsers` (`admin@localhost`/`admin`, `user1..3@example.com`/`111111`), `clearDatabase`, `clearKeyValues` and `populateDatabase`.
  - `JOPLIN_IS_TESTING=1` disables the brute-force limiter.
  - Health: `GET /api/ping` → `{"status":"ok","message":"Joplin Server is running"}`.

## 3. Data API and the headless CLI
- **API code:** `packages/lib/services/rest/Api.ts`; routes are in `routes/*.ts`.
  - **Routes:** `/ping`, `/auth`, `/notes`, `/folders` (`as_tree=1`), `/tags` (`/:id/notes`), `/resources` (multipart), `/search`, `/events` (cursor), `/revisions`, `/master_keys`, `/services/:name` (desktop only), `/mcp`.
  - **Token:** `?token=` query parameter only (`Api.checkToken_`), stored in the `api.token` setting.
  - **CORS:** `*` (`lib/ClipperServer.ts:165-175`).
  - **Pagination:** limit ≤ 100; responses look like `{items, has_more}`.
  - **Reference doc:** `readme/api/references/rest_api.md`.
- **Notes:**
  - POST accepts `is_todo`, `todo_due`, `todo_completed`, `parent_id`, `tags` (comma-separated titles) and more, but drops `order`.
  - PUT merges any non-read-only field, including `parent_id` (move), `order`, `todo_due` and `tags` (replaces the set).
  - DELETE moves to the trash unless `permanent=1`.
  - **Security:** `routes/notes.ts` (~line 521) downloads body images from `http:`, `https:`, `file:` and `data:` URLs on POST.
- **Folders:** PUT `parent_id` moves or nests a notebook; DELETE sends it to the trash or deletes permanently. **Tags:** POST/PUT/DELETE, plus `POST /tags/:id/notes {id}` and `DELETE /tags/:id/notes/:noteId`.
- **CLI `server start`** (`packages/app-cli/app/command-server.ts`) starts `ClipperServer`. It is bound to **`127.0.0.1` (hard-coded, `ClipperServer.ts:284`)**; the port is `api.port`, scanning upward from 41184. `/auth` pairing can never be accepted in the CLI; read `api.token` instead.
- **In command mode the CLI does not run** recurrent sync, sync-on-change, the decryption worker, resource auto-download, ResourceService or RevisionService (`BaseApplication.ts` `hasGui()` gates, ~451-453, 522-524, 649-655). The search index is built once at startup (`SearchEngine.scheduleSyncTables`).
- **`joplin sync`** (`command-sync.ts`) takes a per-profile lock file in the OS temp directory, fetches all resources when there is no GUI, and never starts the DecryptionWorker.
  - Running it in parallel with a live server process on the same profile risks `Setting.saveAll` clobbering (`sync.9.context`, `syncInfoCache`), and the server won't load new master keys.
- **Configuration:**
  ```
  joplin --profile <dir> config sync.target 9
  joplin --profile <dir> config sync.9.path <url>
  joplin --profile <dir> config sync.9.username <email>
  joplin --profile <dir> config sync.9.password <password>
  joplin --profile <dir> config --import-file <json>
  ```
  For E2EE: `config encryption.masterPassword <pw>`, then `e2ee decrypt` (`findMasterKeyPassword` checks that setting first; UNVERIFIED at runtime).
- **Secrets on Linux are plaintext** in the profile `database.sqlite`; keytar is only used on Windows and macOS.
- **Native dependencies:** sqlite3 5.1.6 (N-API, prebuilt for x64 and arm64 on glibc and musl); sharp is optional (arm64 prebuilt); keytar is not loaded on Linux.
- **The CLI does not run plugins.**
- **Alarms:**
  - The `alarms` table is local and not synced. `Note.needAlarm` = `is_todo && !todo_completed && todo_due >= now`.
  - The CLI has no AlarmService. Setting an alarm through the API is `PUT /notes/:id {"is_todo":1,"todo_due":<epoch ms>}`, and it fires on the user's devices after they sync.
- **Existing community headless/MCP images** run a separate `joplin sync` loop next to `server start`: jspiers/headless-joplin, gelse/joplin-mcp, jordanburke/joplin-mcp-server. Other MCP servers: alondmnt/joplin-mcp (Python), thereisnotime/joplin-mcp (Go), happyeric77/mcp-joplin (TS, has `todo_due` tools).

## 4. Upstream built-in MCP server (Joplin 3.7, beta)
- **Code:**
  - `packages/lib/services/mcp/McpServer.ts`: JSON-RPC `initialize`, `tools/list`, `tools/call`, `ping`; protocol `2025-06-18`; server name `joplin-mcp`.
  - `services/rest/routes/mcp.ts`: POST only; returns 202 for notifications; supports batches.
  - Tools: `services/ai/tools/global/*` via `ToolIndex`.
- **Gating:** `mcp.enabled` plus `ai.tool.<id>.enabled`, all **false by default** (`models/settings/builtInMetadata.ts` ~676, ~904-1036). These settings are `appTypes: [Desktop]`, which only filters what the settings UI lists. `Setting.setValue` doesn't check app type, so `joplin config mcp.enabled true` should work in the CLI (`command-config.ts` calls `Setting.setValue`; UNVERIFIED at runtime). Disabled tools still appear in `tools/list` with a "(Disabled tool)" prefix.
- **Tools:**
  - `search_notes` (full filter syntax)
  - `semantic_search_notes` (desktop only, needs ONNX; fails in the CLI)
  - `read_note`, `read_image`
  - `list_notebooks`, `list_tags` (only tags that have notes)
  - `create_note` (title, body, notebook_id, is_todo)
  - `update_note` (title, body, append, prepend, replace_text, notebook_id move, todo_completed)
  - `delete_note` (to trash)
  - `manage_tags` (add/remove by title, auto-create)
  - `create_notebook`
  - The tools use `Note.save` directly, so they **don't** download remote images.
- **Missing:** `todo_due`/alarms, notebook rename/move/delete, tag rename/delete, ordering, attachment upload, revisions, trash restore/permanent delete, sync.
- **Transport:** single JSON-RPC request/response; no streaming or SSE; no stdio (the docs suggest `mcp-remote`). Docs: `readme/apps/ai_mcp.md`, `readme/dev/spec/ai_mcp.md`. The spec says read tools default to on, but the code defaults them all to off.

## 5. Test patterns
- **User's plugin repo** (thescriptingguy/joplin-repeating-todos-plugin):
  - `scripts/setup-e2e.sh` downloads an x64 AppImage and extracts it. `e2e/launch.ts` spawns the binary with `--profile <tmp> --remote-debugging-port`, then Playwright calls `connectOverCDP`; `xvfb-run`.
  - The profile is seeded with `settings.json` (`plugins.devPluginPaths`).
  - Good: negative-control spec, "type like a user" helper, unit tests mocking the `api` module with `moduleNameMapper` plus `jest.fn` defaults and `resetJoplinMock()`, fake timers with a pinned clock.
  - Weak: UI-only assertions, fixed sleeps, per-file isolation, logs never attached, x64 only.
- **Upstream desktop Playwright** (`packages/app-desktop/integration-tests/`):
  - Fixtures in `util/test.ts` (`profileDirectory`, `electronApp`, `startAppWithPlugins`, `mainWindow`): a fresh profile per test, `log.txt` attached.
  - Page objects in `models/MainScreen.ts`, `NoteList.ts`, `Sidebar.ts` (`getByRole`).
  - Also `util/ignoreFlakyReporter.ts` and an axe-core `wcag.spec.ts`.
- **Upstream lib tests:** `packages/lib/testing/test-utils.ts` (`setupDatabaseAndSynchronizer`, `switchClient`, `synchronizerStart`; memory sync target), `Api.test.ts` (`api.route(...)` in-process), `McpServer.test.ts`. They are coupled to the monorepo (hard-coded `app-cli/tests` path).
- **Upstream CLI process tests:** `packages/app-cli/app/cli-integration-tests.test.ts` (execa with `--profile`, then inspect `database.sqlite`).
- **Upstream CI:**
  - `.github/workflows/github-actions-main.yml` runs a matrix that includes `ubuntu-22.04-arm`, but exits early on ARM64.
  - The `ServerDockerImage` job builds amd64 and arm64 and smoke-tests with `/api/ping` and `syncFuzzer`.
