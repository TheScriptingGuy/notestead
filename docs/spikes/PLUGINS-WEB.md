# PLUGINS-WEB: desktop-only plugins and the missing plugin APIs in the web app (feasibility study)

Requested by the user on 2026-11-19: fix limitation L2 and make desktop-only plugins and the missing plugin APIs work in the web app, "even with a big refactor". This is a **study only**: no code was written. The user decided on 2026-11-20 (§6, "The user's answers"), and [ADR-0011](../adr/0011-plugins-on-web-compatibility-route.md) is **Accepted**; the work is story M2-S12 in [`docs/backlog/M2.md`](../backlog/M2.md).

Upstream citations are `upstream:<path>:<line>` at `v3.7.21` (`e41516e66`, the pin in `upstream/joplin-version.json`), read in `~/joplin-web-app-work/upstream-joplin`. QA's M2-S4 findings (P1 to P8) are in [`docs/test-plans/M2-S4.md`](../test-plans/M2-S4.md).

## Question
1. For each missing piece, what does upstream do on mobile/web today, is it possible in a browser at all, how would we do it, how big is it, and would it also help Joplin Mobile (which matters for upstream acceptance)?
2. Which delivery route: (A) upstream PRs, (B) carrying `patches/`, (C) a hybrid? How does (B) collide with "Reuse, never fork"?
3. Which popular desktop-only plugins would start working in each phase, and which never can?
4. A phased recommendation, the user's decisions, and how each phase is tested.
5. The correction of L2.

## Timebox
3 hours, light job: code reading, read-only GETs from the official plugin repository, and a text-only scan of 40 plugin packages. No build, no container, no browser run. About 2.5 hours used. **Nothing in this study was measured at runtime.** Every "would work" below is a static finding and needs the runtime test that §7 names.

## Setup
```bash
# 1. Repository statistics and the top-40 desktop-only plugins (GET manifests.json, stats.json, 40 x plugin.jpl;
#    about 100 MB into ~/joplin-web-app-work/spikes/PLUGINS-WEB, never into the repo).
bash docs/spikes/PLUGINS-WEB/run.sh
# It runs analyse-manifests.cjs (platform split, using upstream's own allow-list from getDefaultPlatforms.ts)
# and scan-jpl.cjs (pattern scan of the extracted bundles; plugin code is read as text, never loaded or run).
```
- The scripts are in [`docs/spikes/PLUGINS-WEB/`](PLUGINS-WEB/).
- **Download counts** come from the repository's `stats.json`, which sums GitHub release downloads. They are a rough popularity proxy only (old plugins accumulate counts; the in-app repository install from `plugin.jpl` is not counted).
- **Upstream's stance** was checked on GitHub (issue and PR pages, the search API) and the Joplin forum on 2026-11-19. Sources are listed at the end.

## Evidence

### E1. How a plugin runs on desktop versus web
- **Desktop** runs each plugin in a hidden Electron `BrowserWindow` with `nodeIntegration: true, contextIsolation: false` (`upstream:packages/app-desktop/services/plugins/PluginRunner.ts:119-124`). A plugin bundle can therefore `require('fs')`, `require('os')` or `require('child_process')` directly. `joplin.require` adds only `sqlite3`, `fs-extra` and `7zip-bin` (`upstream:packages/app-desktop/services/plugins/plugin_index.js:50-67`).
- **Web (and mobile)** runs each plugin in a sandboxed `srcdoc` iframe (`sandbox="allow-scripts allow-modals"`), nested in the plugin runner (M2-S4 P3; `upstream:packages/app-mobile/components/plugins/backgroundPage/startStopPlugin.ts:29-79`).
  - `window.require` allows `path` only. Three legacy plugin ids also get non-functional `fs`/`process`/`url` mocks, and everything else throws `Unable to require module X on mobile.` (`upstream:packages/app-mobile/components/plugins/backgroundPage/pluginRunnerBackgroundPage.ts:13-44`).
  - The main-side `joplin.require` is an empty stub, so `joplin.require('fs-extra')` resolves to `undefined` (`upstream:packages/lib/services/plugins/api/Joplin.ts:156-158`).
  - `window.joplin` is a plain global holding the API proxy, assigned before the plugin's script runs. The plugin script is inserted after `await initializePluginBackgroundIframe(…)` (`startStopPlugin.ts:57-66`; `upstream:packages/app-mobile/components/plugins/backgroundPage/initializePluginBackgroundIframe.ts:12`). Route D (§3) relies on this order.

**Consequence.** Most "desktop-only" plugins are not blocked by a missing Joplin API. They are blocked by the **platform gate** (E2), by **menus** that web never renders (E3), or by **Node built-ins** that no browser has (E4). Only the first two are cheap to fix.

### E2. The platform gate
- `PluginService.runPlugin` throws `Plugin "<id>" was disabled: This plugin doesn't support Joplin Mobile.` when `isCompatible` fails (`upstream:packages/lib/services/plugins/PluginService.ts:626-631`, message from `:594-617`). The web build counts as `AppType.Mobile` (`:582-588`).
- A manifest without `platforms` defaults to `['desktop']`, unless its id is on upstream's hard-coded allow-list of 24 ids (`upstream:packages/lib/services/plugins/utils/isCompatible/getDefaultPlatforms.ts`).
- **There is no override.** No setting, safe-mode switch or dev-mode flag bypasses the check: dev plugins go through the same `runPlugin`.
- **Install paths** (see also M2-S4 P4):
  - **Install from file:** works for any plugin. `installPlugin` performs no compatibility or signature check, and the manifest is read from the `.jpl` itself (`PluginService.ts:321-375`, `:678-713`). The plugin is listed with an **Incompatible** chip and never runs.
  - **Repository search:** desktop-only plugins are listed (sorted last; `upstream:packages/lib/services/plugins/RepositoryApi.ts:228-236`), but their **Install button is disabled** (`upstream:packages/app-mobile/components/screens/ConfigScreen/plugins/buttons/InstallButton.tsx:27`). Updates are also offered only for compatible plugins (`RepositoryApi.ts:286`).
  - **iOS** is restricted further (recommended plugins only, no install from file; `…/ConfigScreen/plugins/utils/useRepoApi.ts:25`, `…/plugins/PluginUploadButton.tsx:27-29`). This matters for upstream acceptance of any "run anyway" option.

### E3. How plugin views are rendered on web
- **`views.menus` and `views.menuItems`.** They register without error and their state is in Redux (`upstream:packages/lib/services/plugins/api/JoplinViewsMenus.ts`; `upstream:packages/lib/services/plugins/reducer.ts:110-125`, `viewsByType`), but **nothing in app-mobile reads them** (M2-S4 P5). Nothing renders any `MenuItemLocation` at all: not `Tools`, not `Note`, not `NoteListContextMenu`, `FolderContextMenu`, `TagContextMenu` or `EditorContextMenu`.
- **`views.toolbarButtons`:**
  - `noteToolbar` buttons become entries in the note's **action menu**, not a toolbar (`upstream:packages/app-mobile/components/screens/Note/Note.tsx:1327`, `:1462-1468`).
  - `editorToolbar` buttons are appended to the editor toolbar's list (`upstream:packages/app-mobile/components/EditorToolbar/utils/allToolbarCommandNamesFromState.ts:47-52`). The user's toolbar selection then decides which are shown (`…/EditorToolbar/utils/selectedCommandNamesFromState.ts`).
  - The API docs mark `noteToolbar` "desktop" (`upstream:packages/lib/services/plugins/api/types.ts:347-359`), but app-mobile does render it.
- **`views.panels` and `views.dialogs`:** supported. Dialogs and panels are webviews in `PluginDialogManager`, and panels open in a viewer (`upstream:packages/app-mobile/components/plugins/dialogs/PluginDialogManager.tsx:61`, `…/PluginPanelViewer.tsx`), not docked beside the editor. Upstream calls the entry point "not ideal" (forum, 2024).
- **`views.editors`** (editor plugins): supported on mobile since #11831 (`Note.tsx:64-73`, `:194`).
- **Upstream precedent.** Upstream PR #14456 (Feb 2026) let plugins add `menuItems` to the mobile "new note" menu. It was closed unmerged: the maintainer liked the technical side, but wanted the UI/UX (menu clutter) discussed first. PR #16027 (notebook long-press menu redesigned as a drawer) is in 3.7 (`1d7c5c0a4`). That drawer is a natural home for `FolderContextMenu` items.

### E4. The other APIs (what upstream does today on mobile/web)
- **`joplin.fs`** at 3.7 has a single method, `archiveExtract` (zip), through `fsDriver().zipExtract` (`upstream:packages/lib/services/plugins/api/JoplinFs.ts:29-40`). The base driver throws `Not implemented: zipExtract` (`upstream:packages/lib/fs-driver-base.ts:277-278`), and the web driver implements `tarExtract` but not `zipExtract` (`upstream:packages/app-mobile/utils/fs-driver/fs-driver-rn.web.ts:199`).
  - Upstream's own issue **#10291** "Mobile plugins: Add APIs to allow file system access" (opened 2024-04-09 by a core mobile contributor) has been open since then: medium priority, no assignee. It states that mocking `fs` "doesn't seem feasible, particularly with synchronous methods (all plugin IPC is `async`)".
- **File System Access API on web:** the web driver can already mount a directory picked with `showDirectoryPicker` (Chromium only; `fs-driver-rn.web.ts:225`, used by `…/ConfigScreen/FileSystemPathSelector.tsx:38-72`). It can also register a picked `File` as a read-only virtual file (`fs-driver-rn.web.ts:221`; `upstream:packages/app-mobile/utils/pickDocument.ts:25-67`).
- **`joplin.imaging`:** the mobile `PlatformImplementation` throws `Not implemented` for `createFromPath`, `createFromPdf` and `getPdfInfo`, and `nativeImage` is `null` (`upstream:packages/app-mobile/services/plugins/PlatformImplementation.ts:73-90`). `pdfjs-dist` is already a lib dependency (`upstream:packages/lib/package.json:40`).
- **`dialogs.showOpenDialog`:** throws `Not implemented: showOpenDialog` (`PlatformImplementation.ts:53-55`).
- **`joplin.ai`:** the API calls `AiService` in lib (`upstream:packages/lib/services/plugins/api/JoplinAi.ts`, marked desktop at `:21`). The AI settings are `appTypes: [AppType.Desktop]` (`upstream:packages/lib/models/settings/builtInMetadata.ts:650`, `:672`), so the web app has no UI to enable them, and every call fails with "AI features are disabled".
- **CodeMirror 5 content scripts.** The web/mobile editor loads `codeMirrorPlugin` content scripts into CodeMirror 6 through upstream's **CodeMirror 5 emulation**:
  - `CodeMirrorControl extends CodeMirror5Emulation` (`upstream:packages/editor/CodeMirror/CodeMirrorControl.ts:36`), and `PluginLoader` hands that object to the content script (`upstream:packages/editor/CodeMirror/pluginApi/PluginLoader.ts:147-149`). The emulation provides `defineExtension`, `defineOption`, `addOverlay`, `markText`, `getDoc` and more (`upstream:packages/editor/CodeMirror/CodeMirror5Emulation/CodeMirror5Emulation.ts:356-465`).
  - `codeMirrorRequire` offers only CodeMirror 6 and Lezer packages, then falls back to `window.require` (`upstream:packages/editor/CodeMirror/pluginApi/codeMirrorRequire.ts`). So `require('codemirror/addon/…')` fails.
  - Desktop 3.7 still ships the real CodeMirror 5 editor behind `editor.legacyMarkdown` (`upstream:packages/app-desktop/gui/NoteEditor/NoteEditor.tsx:49`, `:592`; `builtInMetadata.ts:2017`).
  - **So CM5 content scripts are mostly a gate problem, not a missing feature.**
- **Other desktop-only surfaces:**
  - `window.loadChromeCssFile` and `loadNoteCssFile` (`upstream:packages/lib/services/plugins/api/JoplinWindow.ts:17-37`).
  - `clipboard.readHtml`, `writeHtml`, `readImage`, `writeImage` and `write` (`upstream:packages/lib/services/plugins/api/JoplinClipboard.ts:38-80`).
  - `interop` import/export modules: they register on mobile, but "there is no GUI to activate them" (`upstream:packages/lib/services/plugins/api/JoplinInterop.ts:22-23`).
  - `workspace.filterEditorContextMenu` (`upstream:packages/lib/services/plugins/api/JoplinWorkspace.ts:157-166`).
  - `views.noteList.registerRenderer` (`upstream:packages/lib/services/plugins/api/JoplinViewsNoteList.ts:39-52`; no consumer in app-mobile).
  - `onNoteAlarmTrigger` never fires on web (L1).

### E5. The official plugin repository (2026-11-19)
`node analyse-manifests.cjs …`:
```
{"plugins":411,"mobileCompatible":124,"desktopOnly":287,"explicitPlatforms":146,"allowList":24,"downloadShareMobile":0.544}
```
- **287 of 411 plugins (70 %) are desktop-only on web.** By GitHub release downloads, the mobile-compatible ones account for 54 %.
- **39 of the 40 most-downloaded desktop-only plugins have no `platforms` field at all.** They are desktop-only by default, because they predate the field. Only Hotfolder declares `["desktop"]` explicitly.

### E6. Static scan of the 40 most-downloaded desktop-only plugins
`node scan-jpl.cjs …` (pattern hits in the bundles; trimmed):
```
net.rmusin.joplin-table-formatter       | menuItems cmContentScript cm5
io.github.jackgruber.copytags           | menuItems dialogs
joplin-plugin-search-and-replace        | menuItems panels dialogs cmContentScript cm5
joplin.plugin.MultiMarkdownTableTools   | menus dialogs cmContentScript cm5 cm6 editorContextMenu toolbarButtons
joplin.plugin.benji.favorites           | menus menuItems panels dialogs
com.ckant.joplin-plugin-better-code-blocks | cmContentScript cm5 cm6
com.joplin.JSheets                      | panels
joplin-plugin-knowledge-graph           | panels toolbarButtons
com.github.marc0l92.joplin-plugin-drawio | nodeFs os joplinRequire menus dialogs mdContentScript
joplin-plugin-conflict-resolution       | nodeFs joplinRequire menuItems cm5
io.github.jackgruber.combine-notes      | nodeFs os menuItems
io.github.personalizedrefrigerator.js-draw | nodeFs os joplinRequire menuItems dialogs showOpenDialog imaging chromeCss toolbarButtons
io.github.jackgruber.backup             | nodeFs childProcess os nodeNet menuItems dialogs
io.github.jackgruber.notelistpreview    | nodeFs electron os nodeNet menuItems dialogs noteList imaging
com.andrejilderda.macOSTheme            | nodeFs joplinRequire chromeCss noteCss
… (40 rows; full output reproducible with run.sh)
```
**Spot checks of how `fs` is used:**
- Draw.io writes a temp file under `os.tmpdir()` and attaches it as a resource.
- Conflict Resolution reads HTML from `joplin.plugins.installationDir()` through `joplin.require('fs-extra')`.
- Markmap writes a file.
- Combine notes calls `existsSync`, which is synchronous.

The first three patterns are reachable with an **asynchronous, scoped** file API on web, because the extracted plugin and any temp file live in OPFS and `data.post(['resources'], …, [{ path }])` reads through the same driver. Synchronous calls are not reachable.

## 1. Each missing piece

Sizes: **S** ≤ 3 days, **M** ≤ 2 weeks, **L** ≤ 6 weeks, **XL** more, or open-ended research. "Mobile" means "would also benefit Joplin Mobile (Android/iOS)", which is what upstream acceptance hinges on.

| # | Piece | Upstream on web/mobile today (v3.7.21) | Possible in a browser? | Approach | Size | Mobile? |
|---|---|---|---|---|---|---|
| 1 | **Platform gate** | Hard block at `runPlugin` (E2). No override. Installs from file but shows Incompatible; repository Install disabled. | **Yes**, trivially. | (a) **No upstream change:** re-tag the `.jpl` manifest (`platforms` += `mobile`) with our own tool and install from file (route D). (b) **Upstream:** an opt-in, per-plugin "Run anyway (unsupported)" in lib + app-mobile, off by default, Android/web only. | S | Yes (Android; iOS excluded by App Store rules) |
| 2 | **`views.menus` / `views.menuItems`** | Registered, never rendered (E3). | **Yes.** UI only; the data is already in Redux. | (a) **No upstream change:** a prelude in the repackaged plugin turns each menu item into a `noteToolbar` button, so it shows in the note's action menu. Commands then get no `noteIds`/`folderId` arguments; most plugins fall back to the selected note. (b) **Upstream:** render menus per location: `Tools`/`Note`/`Edit`/`View` in a "Plugins" group of the note action menu (or a plugin-commands sheet); `NoteListContextMenu` in the note long-press/multi-select menu; `FolderContextMenu` in the notebook drawer (#16027); `TagContextMenu` in the tag menu. Needs a forum UX discussion first (#14456 precedent). | (a) S, (b) M | Yes |
| 3 | **`views.toolbarButtons`** (where they differ) | `noteToolbar` → note action menu entries; `editorToolbar` → editor toolbar, subject to the user's toolbar selection (E3). | Already works. | Nothing to build. Document the differences. A web-only docked note toolbar is possible but not worth a patch. | — | — |
| 4 | **`views.noteList`** (custom note-list renderers) | Desktop only; app-mobile never reads the registered renderer. The mobile list is a native React Native list. | **Yes** in a browser (desktop renders HTML templates), but only through a web-specific note list. | Upstream: a renderer path in app-mobile that renders plugin HTML items (an iframe or sanitized HTML per row, plus virtualization and input events). Low acceptance on native mobile (performance). | L (web) / XL (mobile) | Weak |
| 5 | **`joplin.fs`** and **Node `fs`/`fs-extra`/`os`** | `joplin.fs.archiveExtract` throws on web (no `zipExtract`). Node built-ins: `path` only; `joplin.require` returns `undefined` (E1, E4). | **Partly.** An **async**, scoped API (the plugin's `installationDir`/`dataDir`, a temp dir, mounted directories) can sit on the existing OPFS driver. **Synchronous** calls (`existsSync`, `readFileSync`) can't cross the async IPC. The user's real disk is reachable only through picked directories (Chromium). | Upstream #10291: a permission-scoped async `fs` (an `fs-extra` subset) for plugins on mobile and web, plus `os.tmpdir()`/`homedir()` mapped to the scoped dirs, plus `zipExtract` on web (an MIT-licensed JS zip library). A no-upstream variant (prelude shim) can't reach OPFS from the sandboxed iframe (opaque origin), so it is not worth building. | `archiveExtract` S; scoped fs M–L | **Yes** (#10291 is upstream's own issue) |
| 6 | **`joplin.require`** and other Node/native modules | Desktop: `sqlite3`, `fs-extra`, `7zip-bin` and anything Node offers. Web: `path` only. | `fs-extra`: see #5. `sqlite3`: emulable over sqlite-wasm (node-sqlite3's API is callback-async), but niche. **`child_process`, `electron`, `7zip-bin`, `net`/`http` servers, native addons: never.** | Only `fs-extra` through #5. Nothing else. | sqlite3 L (not recommended) | — |
| 7 | **`joplin.imaging`** | All three platform hooks throw `Not implemented` (E4). | **Yes**: `createImageBitmap`/`OffscreenCanvas` for resize, crop, PNG and JPEG; `pdfjs-dist` (already in lib) for PDF pages. | Upstream: implement the mobile `PlatformImplementation.imaging` inside the plugin-runner webview, which is a browser on all mobile platforms too. | M | **Yes** |
| 8 | **`dialogs.showOpenDialog`** | Throws `Not implemented` (E4). | **Yes**, with limits: files through `<input type=file>` registered as read-only virtual files (as `pickDocument.ts` does), and directories through `showDirectoryPicker` + `mountExternalDirectory` (Chromium only). The call needs a user gesture, which is lost across the plugin IPC, so the app must show its own confirm-and-pick prompt. The returned paths are useful only with #5 or `data.post` resources. | Upstream, together with #5. | M | Yes (document picker) |
| 9 | **`joplin.ai`** | API present; settings hidden on web (desktop `appTypes`), so every call fails (E4). | Chat: **yes**, but provider CORS varies (Anthropic needs a browser-access header; local OpenAI-compatible servers need CORS), and the API key would sit in browser storage (L4). Semantic search: onnxruntime-web + sqlite-vec WASM: research-grade. | **Not recommended.** Our stack already gives AI clients access to the notes through MCP (ADR-0004). If upstream brings AI to mobile, the web app gets it for free. | Chat L; search XL | Upstream's call |
| 10 | **CodeMirror 5 ("legacy") content scripts** | Loaded into CodeMirror 6 through upstream's CM5 emulation (E4). Blocked today only by the gate. | **Mostly already.** Gaps: `require('codemirror/addon/…')` and CM5 internals the emulation lacks. | Nothing new: lift the gate (#1) and verify per plugin. Missing emulation methods are small upstream PRs (shared with desktop's CodeMirror 6 editor). | S per fix | Yes |
| 11 | **`views.panels` and dialogs on web** | Supported: panels in a viewer opened from the note action menu, not docked (E3). Open upstream issue #13119 (`panels.isActive`). | Yes. | Optional upstream improvement: docked panels on wide screens (web, tablets). | M | Tablets |
| 12 | **Others** | `loadChromeCssFile` (desktop DOM); `loadNoteCssFile`; HTML/image clipboard; `interop` (no GUI); `filterEditorContextMenu`/`EditorContextMenu`; menu accelerators; `onNoteAlarmTrigger` (L1). | Chrome CSS: **never meaningful** (it styles desktop DOM classes that the React Native Web UI doesn't have). Note CSS: yes. Clipboard HTML/images: yes (async Clipboard API, needs focus and permission). Interop: yes (a web import/export screen). Editor context menu: yes on web (right-click). Accelerators: yes on web. | Each one is a separate upstream PR. None is worth a patch. | S–M each | Mixed |

## 2. Delivery routes

### (A) Upstream-first: PRs to laurent22/joplin
- **How upstream works:**
  - Features are discussed on the forum (or in an issue) before a PR, especially UI changes: see #14456's closing comment.
  - PRs merge into `dev`. Release branches such as `release-3.7` take fixes only.
  - Minors arrive about every four months: 3.3.1 on 2025-02-16, 3.4.1 on 2025-05-20, 3.5.1 on 2025-10-02, 3.6.1 on 2026-01-17 and 3.7.1 on 2026-05-11 (release commits in the clone).
- **Timeline for us:** a PR merged today ships in the next minor (3.8, or 3.9 if 3.8 has already branched). We consume it only when the user's server and clients move to that minor (ADR-0005's same-minor rule), so expect **about 4 to 9 months per feature**, after acceptance.
- **Likelihood, per piece (our estimate):**

  | Piece | Likelihood | Why |
  |---|---|---|
  | Imaging (#7) | Medium-high | Clear mobile benefit, no UX debate. |
  | Scoped fs (#5, #8) | Medium | Upstream's own #10291, but it needs a permission design. |
  | "Run anyway" (#1b) | Medium | The 24-id allow-list shows that upstream prefers curation. Support load and iOS rules are the objections to expect. |
  | Menus (#2b) | Medium-low | The UX debate came first last time (#14456). |
  | `noteList` (#4) | Low | Performance on native mobile. |
- **How we consume it:**
  - Through the normal bump. M6's bump PR moves `web.commit` to the new minor once the user's devices are on it.
  - The full E2E suite runs, including the plugin specs from §7.
  - The parts of our route D tool (below) that upstream now covers are switched off by feature detection, and then deleted.
- **Cost:** our time to write the PRs, plus the user's GitHub account to file them (as with Q11/U-items). There is no recurring cost.

### (B) Carrying `patches/`
- **The mechanism:**
  - Today `build.ts` refuses a modified upstream tree on purpose (`packages/web-build/src/build.ts:126-129`, "refusing to build a modified upstream tree"). ADR-0001 decision 1 says "zero source patches".
  - Route B would add a step after `checkoutPinned`. It applies an ordered series `patches/web/NNNN-<slug>.patch` with `git apply --3way --index`, fails the build if any hunk doesn't apply, and then runs the official recipe unchanged.
  - The pristine-tree check becomes "pin + series".
  - `bundle-manifest.json` and `source.html` list each patch (sha256, upstream PR link).
  - The web-bundle cache key gains `hashFiles('patches/**')` (`.github/workflows/web-bundle.yml:122`).
  - `check:no-upstream-copy` compares whole-file blob IDs only (`packages/web-build/src/upstreamCopy.ts:1-4`), so patch files don't trip it.
  - The arm64 fallback build (S1) applies the same series.
- **Cost and risk per 3.7.x bump:**
  - Every bump re-applies the series.
  - A lib-side gate patch (#1b, about 30 lines in `PluginService.ts` + settings metadata) will rarely conflict.
  - A menu-rendering patch (#2b) touches `Note.tsx` (2 000+ lines, changed in most releases) and the menu components, so it **will** conflict on some bumps. Expect 0.5 to 2 hours of senior-engineer rebasing per conflicting patch, plus a cache-miss x64 rebuild (about 40 min of CI) and the full E2E suite.
  - Each Joplin minor bump means re-porting the series.
- **Hidden risks:**
  - Upstream tests an unpatched app, so our patched code paths have no upstream test signal.
  - Bug reports to upstream must first be reproduced on an unpatched build.
  - A patch that silently changes meaning across a bump (it applies, but the surrounding code changed) is only caught by our E2E.
- **CI impact:** one extra step with an exact failure message, and one cache-key input. The bump-PR workflow (M6) gains a "series applies" gate that fails before the 40-minute build.
- **AGPL:**
  - No new obligation in kind. We are AGPL-3.0-or-later and already make the §13 offer for a modified build (ADR-0010).
  - `source.html` must say plainly that the bundle is upstream **plus the listed patches**, and the patches must be in our repo at the exact commit. They would be.
- **Trademark:**
  - A patched build is more clearly "not Joplin". Our "Notestead for Joplin (unofficial)" naming and the branding overlay already cover the name.
  - **New:** plugin authors could receive bug reports from Notestead users about a platform they never supported. Our UI and docs must route such reports to us, not to the plugin author or to upstream.
- **The collision with the golden rule, stated plainly:**
  - CLAUDE.md allows `patches/` only "if a change to upstream is unavoidable". Running desktop-only plugins is a **feature wish, not an unavoidable fix**, so route B is a fork in all but name unless the user grants an explicit exception.
  - ADR-0001's "zero source patches" decision would also have to be amended.
  - A patch series that grows with each wished-for feature is exactly how forks start, and we would carry its rebase cost forever.
- **What a narrowly scoped exception would look like** (if the user wants one):
  1. **Paths.** Only plugin-subsystem and plugin-menu UI files: `packages/lib/services/plugins/**`, `packages/app-mobile/{components,services}/plugins/**`, and the named menu components. Never sync, E2EE, database, settings migration or the service worker.
  2. **An upstream PR for every patch.** Each patch has an **open upstream PR** (not just an issue) with the same diff, and is dropped at the first bump that contains it.
  3. **A flag for every patch.** Each patch sits behind its own setting that defaults to upstream behaviour.
  4. **A size cap.** At most about 400 changed lines across the series.
  5. **Fail-safe at bumps.** If a patch doesn't apply, the bump ships **without** it (the feature falls back to upstream behaviour, documented in the release notes) rather than blocking a security bump.
  6. **A sunset.** The series is re-approved by the user at every Joplin minor bump.
  7. **Tests on both builds.** The E2E suite runs on the patched build. A smoke run on the unpatched build proves that the flags really are a kill switch.

### (C) A hybrid
Our own code at the edges (route D below), upstream PRs for everything inside the app, and, only with the user's exception, short-lived patches for the window between "upstream PR open" and "minor bump that contains it".

### (D) A fourth route found in this study: plugin-side compatibility, with no upstream change
- **What it is.** A small tool of ours (an in-browser page served by our `web` container, and the same code as a CLI) takes a plugin `.jpl` and produces a new `.jpl` that the user installs with upstream's "Install from file". It:
  1. **re-tags** the manifest: `platforms` gains `mobile`; the plugin **id stays the same**, so plugin settings and `user_data` namespaces stay compatible with the user's desktop install (M2-S4 P6);
  2. **can prepend a compatibility prelude** to `index.js`:
     - it wraps the `window.joplin` global so that `views.menus.create` and `views.menuItems.create` **also** register `noteToolbar` buttons, which show in the note action menu;
     - it wraps `window.require` to add a harmless `os` stub;
  3. **refuses**, with a reason, plugins whose static scan shows `child_process`, `electron` or native modules.
- **Why it fits the golden rules:**
  - It doesn't change, patch or copy upstream.
  - It consumes the `.jpl` format (published), install-from-file (published UI) and toolbar buttons (a documented API).
- **The internals it relies on, and how drift is caught.** It relies on two upstream internals: the plugin script runs after `window.joplin` is assigned, and `window.joplin` is a writable global (E1). A canary test plugin that we author catches drift at every bump (§7).
- **Its limits:**
  - It can't reach OPFS from the sandboxed iframe, so it can't provide `fs`.
  - Repacked plugins get no in-app updates, because the repository manifest stays incompatible (`RepositoryApi.ts:286`). The user re-repacks after an update.
  - The repacked plugin was never tested by its author on this platform, and it runs with the same access to decrypted notes as any plugin.
  - We never redistribute repacked plugins. The tool runs on the user's side, on the user's copy.

### (E) The ecosystem route
39 of the top 40 desktop-only plugins have **no** `platforms` field (E5). After route D has shown that a plugin works, a one-line issue or PR to its author ("add `"platforms": ["desktop", "mobile"]`") fixes it for every Joplin Mobile and web user, permanently and at no cost to us. Adding verified ids to upstream's allow-list (`getDefaultPlatforms.ts`) is a second option, but upstream treats that list as a stopgap.

## 3. Payoff (top-40 desktop-only plugins; static scan, not yet run)

| Phase | What it adds | Plugins that would start working (needs runtime confirmation) |
|---|---|---|
| **1a. Gate lifted** (route D re-tag, or upstream #1b) | Existing web features: toolbar buttons, panels, dialogs, markdown-it and CodeMirror content scripts (CM5 through emulation) | Better Code Blocks, Markdown Table: Sortable, Enhancement, JSheets, Graph (knowledge-graph), Insert Date, Autolinker, Markdown table calculations, Event Calendar, Note Link System |
| **1b. + menus** (route D prelude; later upstream #2b) | Menu commands in the note action menu | Table Formatter, Tagging (copytags), Search & Replace, MultiMarkdown Table Tools (not its editor context menu), Folding in CodeMirror (depends on the CM5 emulation), Favorites, Ez Table, Markdown Prettier, Joplin DDDot, Text Colorize |
| **2. Upstream APIs** (#5 scoped async fs + `os.tmpdir`, #7 imaging, #8 open dialog; upstream minor ≥ 3.8) | Temp files, reading the plugin's own files, image processing | Draw.io, PlantUML2, joplin-excalidraw, Kity Minder, Kminder Mindmap, Markmap, Conflict Resolution, Freehand Drawing (js-draw), Note overview, Combine notes (only once its `existsSync` is async), Csv Import (also needs an interop GUI) |
| **Never** | — | Backup (spawns the 7-Zip binary), Hotfolder (watches real folders), Note list (Preview) (note-list renderer **and** Electron), macOS theme and GitHub Theme (desktop chrome CSS), Note list and sidebar toggle buttons and Persistent Editor Layout (desktop layout), Cursor Sync (desktop split view), Email Plugin (Node SMTP) |

**Roughly:**
- Half of the top 40 (20) need **no upstream change at all** (phases 1a and 1b).
- A quarter (11) need upstream APIs that are a year away at best.
- About a fifth (9) can **never** work in a browser.

The rest of the 287 desktop-only plugins were not scanned. Expect the same shape.

## 4. Phased recommendation

| Phase | What | Route | Size | Golden rules |
|---|---|---|---|---|
| **0 (done here)** | Correct L2 (§5). | — | — | — |
| **1 (cheapest, high value)** | **Plugin compatibility repackager:** (1a) re-tag, then (1b) the menus-to-note-action-menu prelude and the `os` stub, plus the static-scan verdict ("will not work: uses `child_process`"). Opt-in, per plugin, with a plain warning. | D | 1a S, 1b S–M | Kept |
| **2 (in parallel, long-running)** | Upstream: a forum spec and PRs, in this order: imaging (#7); `zipExtract` on web (#5 small part); scoped async fs + `showOpenDialog` (#5, #8; #10291); menus on mobile (#2b, after a UX thread); an opt-in "run anyway" for Android/web (#1b). Report verified plugins to their authors (route E). | A, E | each S–M; fs L | Kept |
| **3 (only with the user's exception)** | Carry a patch for an upstream PR that is open and agreed in principle, until the minor that contains it. Candidates: #2b menus and #1b "run anyway", never fs. | B (narrow) | per patch S + per-bump upkeep | Exception |
| **Not recommended** | `noteList` on web, `joplin.ai` in the browser (use MCP), `sqlite3` emulation, theme plugins. | — | L–XL | — |

**Why not "a big refactor" now:** every big piece (fs, `noteList`, AI) sits inside upstream's app code. Doing it ourselves would mean exactly the fork the project rules out, and it would be rebased by hand on every bump forever. The same work, done as upstream PRs, benefits Joplin Mobile, survives bumps for free, and is the only way it stays maintained.

## 5. L2 corrected
Applied to ARCHITECTURE §9 L2 (QA's M2-S4 P2, P4 and P7):
- Desktop-only plugins **do** install from file. They show **Incompatible** and **never run**. In the repository search they are listed, but their Install button is disabled.
- Opening the **Plugins** screen fetches the repository straight from the browser: GitHub, plus up to four third-party mirrors if GitHub doesn't answer.
- Plugins and their settings are **per browser profile**. They are not synced, and "clear site data" removes them.

## 6. Decisions the user must make
Recommendations are in bold.
1. **D1: build Phase 1 (route D, the repackager)?** **Yes:** 1a first (S), then 1b, as a new M2 story.
2. **D2: grant a `patches/` exception (route B, narrow scope §2)?** **Not now.** Revisit per feature once an upstream PR is open and the maintainers agree in principle. Until then, zero patches (ADR-0001 unchanged).
3. **D3: file upstream (route A) from your GitHub account,** starting with imaging and the #10291 design, then the menus UX thread? **Yes**, as with the earlier U-items. Each filing is one approval.
4. **D4: where the repackager runs.** **A page in the `web` container** (no install, same origin, never uploads the plugin anywhere), with the same code as a CLI for tests.
5. **D5: report verified plugins to their authors (route E)?** **Yes**, a one-line request each, once Phase 1 shows that a plugin works.
6. **D6: accept the risk wording.** A force-run plugin was never tested by its author on this platform. It has the same access to your decrypted notes as any plugin. Our UI and docs send bug reports to us, not to the plugin author. **Accept, with the feature off by default.**

**The user's answers (2026-11-20),** recorded in ADR-0011:
- **D1: yes.** Phase 1a (the manifest change) first, so that desktop-only plugins can run on web where that is technically possible; then phase 1b (the menu script). Opt-in per plugin, off by default.
- **D2: not now.** No `patches/` exception.
- **D3 and D5: not now.** No upstream PRs or issues, and no requests to plugin authors.
- **D4:** a page in the `web` container.
- **D6:** the risk wording is accepted.

## 7. How each phase would be tested
- **Phase 1 (route D):**
  - **Unit (Jest):** the `.jpl` rewrite (tar in and out, manifest edit, prelude prepended once, id unchanged, original untouched, output sha256 recorded); the static-scan verdict. Negative controls: a fixture that uses `child_process` is refused; a second repack doesn't double the prelude.
  - **Contract (canary):** a tiny test plugin that **we author** (AGPL, in `tests/fixtures/plugins/`), desktop-only, with one `menuItems` command, one CM5-style content script and a `require('os')`. At every bump it proves the prelude's two assumptions (script order, a writable `window.joplin`). Negative control: the same canary, not repacked, is Incompatible and never runs (it extends M2-S4's NEG 2).
  - **E2E (Playwright):**
    - Repack the canary in the page, install from file, and assert that the menu command appears in the note action menu and runs. Assert the effect through REST (for example, a note body changed by the command).
    - The CM5 content script decorates the editor.
    - NEG: no plugin label from `menus.create` appears anywhere else (rendered text only, as in the H5 ruling).
  - **@network nightly:** two real plugins pinned by sha256 (Table Formatter, Tagging) are repacked and exercised once, so drift in real plugins becomes visible without blocking per-commit CI.
- **Phase 2 (upstream):** each PR carries upstream-style Jest tests. On our side, the bump that brings the feature runs the same E2E with the prelude's matching part switched off by feature detection, then deleted.
- **Phase 3 (patches, if ever):** a build-time "series applies" gate; the E2E suite on the patched build; a smoke run on the unpatched build with the flag off (the kill-switch proof). A negative control: a deliberately stale patch fails the gate with the exact file and hunk.

## Result
- **GO-WITH-CONDITIONS** for Phase 1 (route D), with conditions:
  - opt-in per plugin, with the risk wording (D6);
  - the canary contract test;
  - no redistribution of repacked plugins.
- **GO** for route A (upstream-first) as the long-term path for fs, imaging, open dialog and menus.
- **NO-GO** for "all desktop-only plugins": native modules, `child_process`, Electron and desktop-layout plugins can never work in a browser (§3, "Never").
- **NO-GO** for route B as a default. It needs an explicit, narrow user exception (D2).

## Follow-ups
- D1 approved: story **M2-S12** in `docs/backlog/M2.md` (architect, done), then the test plan (QA) and the canary fixture.
- Candidate upstream items U15 to U19 are in ARCHITECTURE §10 as **not filed**. The user deferred filing (D3, D5).
- `docs/delivery` and the deploy guide: the privacy note on the Plugins screen's direct GitHub/mirror requests (L2), for the ci-cd-specialist and senior engineer when the guide is written.

## Sources
- [laurent22/joplin#10291: Mobile plugins: Add APIs to allow file system access](https://github.com/laurent22/joplin/issues/10291)
- [laurent22/joplin#14456: Mobile: Plugins: Allow adding new actions to the "new note" menu (closed unmerged)](https://github.com/laurent22/joplin/pull/14456)
- [laurent22/joplin#16027: Mobile: Implement redesigned notebook long-press menu (merged 2026-07-31)](https://github.com/laurent22/joplin/pull/16027)
- [laurent22/joplin#13119: `joplin.views.panels.isActive` regression](https://github.com/laurent22/joplin/issues/13119)
- [Forum: Mobile plugins: Best way to support opening plugin panels?](https://discourse.joplinapp.org/t/mobile-plugins-best-way-to-support-opening-plugin-panels/36892)
- [Forum: Mobile: Plugin support](https://discourse.joplinapp.org/t/mobile-plugin-support/35262)
- [Official plugin repository data: manifests.json, stats.json](https://github.com/joplin/plugins)
