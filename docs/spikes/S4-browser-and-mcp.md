# Spike S4: browser (Playwright Chromium on the Pi, OPFS, COEP) and upstream `/mcp` in the headless CLI

## Question
- **A.** Does the upstream web bundle run in Playwright's Chromium on the Pi with cross-origin isolation and OPFS, under both COEP `credentialless` and `require-corp`?
- **B.** Does the web app sync with an unmodified Joplin Server through our same-origin proxy (S2) and complete an E2EE round trip with another device? Is the sync-target version unchanged afterwards?
- **C.** Can upstream's built-in `/mcp` be turned on in the headless CLI (`mcp.enabled`, `ai.tool.*`), and do `initialize`, `tools/list` and `tools/call` work? What happens on the `file:` path?

## Timebox
3 h. Used: ~1 h 45 min.

## Setup
- **Bundle:** the S1 native build of `v3.7.21` (`packages/app-mobile/web/dist`), **unmodified, local use only, never distributed**. It is served by the S2 Caddy (`docs/spikes/S2/Caddyfile`) at `http://127.0.0.1:8080/` (a secure context; "127.0.0.1" doesn't contain "localhost", so `__DEV__` is false). `COEP` is set by env.
- **Browser:**
  - `playwright-core@1.59.1`, installed in `~/joplin-web-app-work/spikes/S4` (not in the repo).
  - Chromium `~/.cache/ms-playwright/chromium-1223/chrome-linux/chrome`, passed as `executablePath`. That build is newer than the 1217 that 1.59.1 expects, and it works.
  - Headless, `--no-sandbox`, one fresh context per run.
- **Server and "other device":** the S2 `joplin/server:3.7.2` (`user1@example.com`) and the S3 `device` CLI profile, which created the E2EE account with master password `s3-master-password-Δ`.
- **Scripts:**
  - `docs/spikes/S4/lib.mjs`
  - `probe.mjs` (A)
  - `explore.mjs` / `step.mjs` (UI discovery)
  - `sync-e2ee.mjs` (B)
  - `mcp-probe.sh` (C)
  - Logs in `~/joplin-web-app-work/spikes/S4/`.

## Evidence

### A. Cross-origin isolation, OPFS and service worker on the Pi
```
COEP=credentialless   loadMs=12886 (cold, includes the coi service worker's one-time self-reload)
  crossOriginIsolated=true secureContext=true sw=true opfs=true dev=false
  [console.log] COOP/COEP Service Worker registered http://127.0.0.1:8080/
  [console.log] Reloading page to make use of updated COOP/COEP Service Worker.
COEP=require-corp     loadMs=7108
  crossOriginIsolated=true secureContext=true sw=true opfs=true dev=false
time to interactive UI (sync wizard shown): 18.6 s cold on the Pi
OPFS after first run: ["log.sqlite.sqlite3","joplin.sqlite.sqlite3","joplin-web", …-journal]
storage: quota ≈ 2.17 GB, usage ≈ 30 MB (19 MB service-worker cache = the bundle)
```
- **Both COEP modes work in Chromium.**
- **Once installed, the upstream service worker rewrites COEP on every response it controls** to `credentialless`. It falls back to `require-corp` only if isolation fails (`upstream:packages/app-mobile/web/serviceWorker.ts:120-140, 198-235`). Our server header therefore mainly governs the first, uncontrolled load and browsers without a service worker. M2-AC17 must test the *effective* behaviour, not just the header.
- **External request:** the app sends `HEAD https://joplinapp.org/connection_check/` repeatedly. These fail (`net::ERR_ABORTED`) under cross-origin isolation, and the app keeps working. This is a privacy note (the request reveals to joplinapp.org that the app is in use) and a limitation to document. It is listed as upstream-first item U7 (configurable connectivity check).

### B. Sync through the proxy and an E2EE round trip
Flow in `sync-e2ee.mjs`:
1. The sync wizard appears.
2. "Other".
3. The target dropdown is set to "Joplin Server".
4. The fields are filled: URL `http://127.0.0.1:8080/joplin-server`, email, password.
5. "Check synchronisation configuration".
6. Wait for sync.
7. The "Press to set the decryption password." banner.
8. Password typed.
9. Wait for the decrypted title.

```
[18.5s] app loaded
[21.3s] check config: Success! Synchronisation configuration appears to be correct.
[21.3s] Save changes disabled after check (settings already saved by the check)
[33.3s] decryption-password banner shown
[35.7s] password typed
[53.9s] decrypted note title "Seed note alpha" visible
Synchronizer: Sync target remote info: {version: 3, e2ee: Object, activeMasterKeyId: Object, masterKeys: Array(1)}
Encryption is: Enabled  Decrypted items: 10 / 10  Master password: Loaded
```
Every sync request the browser made was same-origin and went through the proxy (counts from one run):
```
3x POST /joplin-server/api/sessions     9x GET /joplin-server/api/items/root:/…:/content   1x GET …/delta
2x GET /joplin-server/api/shares        2x GET /joplin-server/api/share_users              1x GET /joplin-server/api/users/:id
2x PUT /joplin-server/api/batch_items   4x PUT /joplin-server/api/items/root:/…:/content   3x PUT …/.resource/:id:/content
2x HEAD https://joplinapp.org/connection_check/        (the only non-same-origin request; see A)
```
Before the password was entered, the app **refused to upload its own new items unencrypted**:
```
Synchronizer: Error: Could not encrypt item 3518c1…: Master key is not loaded: 4f55c571…
```
After unlocking it uploaded them encrypted.

**Reverse direction (web → headless)** and the sync-target version, checked through the server API and the S3 headless profile:
```
server items: 21 ; md items encrypted=15 plaintext=0
info.json version= 3 e2ee= True masterKeys= 1          <- unchanged after the browser's syncs
headless cycle: OUTAGE=18555ms ; GET /search?query=Welcome -> "1. Welcome to Joplin!" (encryption_applied 0)
```

**Finding: welcome notes.** On first start the web app creates upstream's welcome notebook ("0. About the web app", "1. Welcome to Joplin!" … "5. Joplin Privacy Policy") and uploads it, encrypted, into the account. Against the user's real account this adds six notes on the first web login. This is upstream behaviour, not something we can configure. It is documented (limitation L14). M2 must decide whether the deploy guide tells users to delete them.

### C. Upstream `/mcp` in the headless CLI 3.7.1
Enabling went through `config --import` on stdin with `{"mcp.enabled":true,"ai.tool.<id>.enabled":true …}` for the 10 allow-listed tools, followed by one cycle (restart):
```
M0 before enabling:  403 {"error":"MCP server is disabled …"}
mcp.enabled = true
M1 initialize: 200 {"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"joplin-mcp","version":"1.0.0"}}
M2 notifications/initialized: 200 (empty body)  <- 3.7.1 predates upstream #16473 (202); irrelevant for us (we don't forward notifications)
M3 tools/list:
  enabled  search_notes [limit, query]            DISABLED semantic_search_notes (still listed, "(Disabled tool)")
  enabled  read_note [id, max_chars, offset]       enabled  list_notebooks []          enabled  list_tags []
  enabled  create_note [body, is_todo, notebook_id, title]
  enabled  update_note [append, body, id, notebook_id, prepend, replace_text, title, todo_completed]
  enabled  delete_note [id]   enabled manage_tags [add, note_id, remove]   enabled create_notebook [parent_id, title]
  enabled  read_image [id, resolution]
  snapshot saved: ~/joplin-web-app-work/spikes/S4/tools-list.cli-3.7.1.json (7653 bytes)
M4 list_notebooks → {"notebooks":[{"title":"S3 Notebook","note_count":4,…}]}
M5 create_note with body "![x](file:///data/headless/settings.json)" → created; resources before=0 after=0
M6 search_notes "zebracorn" → "Seed note alpha"
M7 update_note {id, append} → updated; body now "…seedword1appended-by-mcp"  (append adds no separator)
M8 semantic_search_notes → tool error "# Tool `semantic_search_notes` is disabled in Joplin's settings …"
M9 /mcp without token → 403
M10 REST POST /notes {"body":"![x](file:///tmp/fixture.txt)"} → body rewritten to "![x](:/35a64cf4…)";
    resources before=0 after=1 ; GET /resources/:id/file → "harmless-fixture-secret"   <- the exfiltration path, reproduced
```

## Result
- **A: GO.** Chromium on the Pi runs the bundle with full cross-origin isolation and OPFS in both COEP modes. A cold load to an interactive UI takes ~18 s on the Pi.
- **B: GO-WITH-CONDITIONS.**
  - Sync through the same-origin proxy works with an unmodified server 3.7.2.
  - The E2EE round trip works both ways (CLI device → browser → headless).
  - The sync-target `info.json` stays at version 3.
  - Conditions:
    1. The S2 proxy rules.
    2. Users are told about the first-run welcome notes (L14) and the `joplinapp.org` connectivity check.
    3. E2E tests treat the effective service-worker COEP behaviour as the thing under test.
- **C: GO-WITH-CONDITIONS** for the upstream `/mcp` passthrough (ADR-0004).
  - It works headless once the settings are enabled through `config`. Disabled tools stay listed and fail with an actionable error. `create_note` doesn't download `file:` URLs.
  - Conditions:
    1. Snapshot `tools/list` (the argument names are inconsistent: `id` vs `note_id`).
    2. Our layer adds the missing tools, auth and the sanitizer.
    3. Never forward notifications.
    4. Note that `update_note.append` concatenates without a separator. Our tool descriptions mention it.

  M10 proves that **`POST /notes` with untrusted bodies is a real exfiltration path**: a local file became a synced resource. ADR-0008's guard is mandatory.

## Follow-ups
- **The M2 E2E suite** turns `sync-e2ee.mjs` into fixtures and page objects. The UI selectors used here (`getByRole('button', {name: 'Other Select…'})`, the textboxes "Joplin Server URL/email/password", "Check synchronisation configuration", "Press to set the decryption password.") are a starting point. QA owns them.
- **CI** uses the official Playwright container at the version matching the pinned `@playwright/test`. Locally, `executablePath` pointing to the installed Chromium is proven to work.
- **Upstream-first:** a configurable or disable-able `connection_check` URL (U7), and an option to skip welcome notes when the sync target already has data.
- Firefox and Safari were not tested in this spike (M2-AC18).
