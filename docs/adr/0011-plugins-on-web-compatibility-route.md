# ADR-0011: Desktop-only plugins on web: an opt-in plugin compatibility repackager, no patches, upstream contributions deferred

## Status
**Accepted** (user decisions D1 to D6, 2026-11-20). Proposed by the architect on 2026-11-19 with the study [`docs/spikes/PLUGINS-WEB.md`](../spikes/PLUGINS-WEB.md). ADR-0001 is unchanged: zero source patches.

The user decided the six points of PLUGINS-WEB §6:

| # | Question | The user's decision (2026-11-20) | Where it lands |
|---|---|---|---|
| D1 | Build Phase 1 (route D, the repackager)? | **Yes.** Phase 1a, the manifest change, first, so that desktop-only plugins can run on web where that is technically possible. Then phase 1b, the menu script (rendering `views.menus`/`views.menuItems`). **Opt-in per plugin, off by default.** | Decision 1; story M2-S12 |
| D2 | Grant a `patches/` exception (route B)? | **Not now.** No `patches/` exception. | Decision 2 |
| D3 | File upstream PRs/issues (route A) from the user's account? | **Not now.** | Decision 3 |
| D4 | Where does the repackager run? | **A page in the `web` container.** | Decision 1 |
| D5 | Ask plugin authors to declare `mobile` (route E)? | **Not now.** | Decision 3 |
| D6 | Accept the risk wording? | **Accepted** as written in the study, with the feature off by default. | Decision 1 ("Risk statement") |

## Context
- **The ask.** The user wants limitation L2 fixed: desktop-only plugins and the missing plugin APIs working in the web app, "even with a big refactor" (STATUS, 2026-11-19).
- **What the study found** (PLUGINS-WEB, E1 to E6):
  - **Three causes.** Desktop-only plugins fail on web for three different reasons:
    - the **platform gate** (`upstream:packages/lib/services/plugins/PluginService.ts:626-631`, no override);
    - **menus that web never renders** (nothing in app-mobile reads `menu`/`menuItem` views);
    - **Node built-ins** (desktop runs plugins with `nodeIntegration: true`, `upstream:packages/app-desktop/services/plugins/PluginRunner.ts:119-124`; web allows `path` only, `upstream:packages/app-mobile/components/plugins/backgroundPage/pluginRunnerBackgroundPage.ts:13-44`).
  - **The share.** 287 of 411 repository plugins are desktop-only on web. 39 of the 40 most-downloaded of them have no `platforms` field at all.
  - **CodeMirror 5 content scripts** already run through upstream's CM5 emulation once the gate is lifted (`upstream:packages/editor/CodeMirror/CodeMirrorControl.ts:36`).
  - **The payoff.** In a static scan of the top 40, 20 need no upstream change (the gate, plus menus), 11 need new upstream APIs (scoped async fs, imaging, open dialog), and 9 can never work in a browser.
- **The gate, precisely.** `isCompatible` passes when the manifest's `platforms` (or, when it is empty, upstream's default for the id) includes `mobile` and the app version is at least `app_min_version` (`upstream:packages/lib/services/plugins/utils/isCompatible/index.ts:10-13`, `…/minVersionForPlatform.ts:6-22`). The manifest parser ignores fields it doesn't know (`upstream:packages/lib/services/plugins/utils/manifestFromObject.ts:55-79`). "Install from file" copies the `.jpl` to `<pluginDir>/<id>.jpl`, so a file with the same id replaces the installed one (`upstream:packages/lib/services/plugins/PluginService.ts:678-705`).
- **The upstream service worker serves its cache for non-OK same-origin responses** (`upstream:packages/app-mobile/web/serviceWorker.ts:180-187`), and its scope is the whole origin. Any page we add under the app origin is cached by it, and a later 404 for that page is answered with the cached copy.
- **The constraint.** The golden rule "Reuse, never fork" allows `patches/` only when a change is unavoidable. ADR-0001 says zero source patches, and `packages/web-build/src/build.ts:126-129` refuses a modified upstream tree.
- **The current L2** (ARCHITECTURE §9, as corrected in `045c351`): desktop-only plugins install from file but show **Incompatible** and never run; the repository's Install button is disabled for them; `views.menus`/`views.menuItems` are never rendered; the Plugins screen fetches GitHub and up to four third-party mirrors straight from the browser; plugins are per browser profile and not synced.

## Decision
1. **Route D: a plugin compatibility repackager of our own** (D1, D4, D6). Story [M2-S12](../backlog/M2.md).
   - **What it is.** A static page at `/tools/plugin-repack/`, served by the `web` container. Its code lives in `packages/plugin-repack`: a library, the page (built into the `web` image next to the overlay) and a CLI over the same library, which the tests and the `@network` nightly use. All processing happens **in the user's browser**: the page takes a `.jpl` the user picks from disk and offers a new `.jpl` as a download, which the user installs with upstream's "Install from file". It does not fetch plugins from the repository, and it never sends a plugin anywhere.
   - **Off by default.** The `web` container serves the tool only with `PLUGIN_REPACKAGER=on` (default `off`; any other value refuses to start). When it is off, every path under `/tools/plugin-repack/` answers **200** with a fixed "turned off" page that contains no tool code. It is 200 and not 404 because the upstream service worker would answer a 404 with a previously cached copy of the tool (Context). The tool never sends `Clear-Site-Data`, because that header would also delete the web app's local profile.
   - **Opt-in per plugin.** For each chosen file, the page shows the plugin's id, name and version, the scan verdict, the exact list of changes it will make, and the risk statement. The download stays disabled until the user ticks an acknowledgment that names that plugin id. There is no batch mode, and one acknowledgment never covers another file.
   - **Phase 1a, the manifest change.** The output's `manifest.json`:
     - `platforms` becomes the original list plus `desktop` and `mobile` (an absent or empty field counts as `["desktop"]`, upstream's default);
     - `name` gains the suffix " (web repack)", so the user can tell it apart in the plugin list;
     - a `notestead_repack` object records the tool version, the input's sha256 and the list of changes;
     - `id`, `version`, `app_min_version` and every other field stay as they are. Keeping the id keeps the plugin's settings and `user_data` namespaces compatible with the desktop install.

     Every other entry of the archive is byte-identical, including the plugin's licence and notice files.
   - **Phase 1b, the menu script.** Optional per plugin; offered (pre-selected) when the scan finds `views.menus` or `views.menuItems`. A prelude is prepended to `index.js`, and the original bytes follow unchanged. The prelude:
     - wraps the `window.joplin` global, so that every command registered through `views.menus.create` (nested submenus flattened) or `views.menuItems.create` is **also** registered once as a `noteToolbar` button, which upstream shows in the note's action menu (`upstream:packages/app-mobile/components/screens/Note/Note.tsx:1327`, `:1462-1468`). A command that already has a `noteToolbar` button is not added twice;
     - wraps `window.require` to add a harmless `os` stub (`tmpdir`, `homedir`, `platform`, `EOL`). Every other module keeps upstream's behaviour, including the error for `child_process`;
     - checks its two assumptions first (the plugin script runs after `window.joplin` is set, and the global is replaceable; `upstream:packages/app-mobile/components/plugins/backgroundPage/startStopPlugin.ts:57-66`, `…/initializePluginBackgroundIframe.ts:12`). If either fails, it does nothing except log one line, and the plugin runs as in phase 1a.
   - **What it refuses**, with a reason and no output:
     - a static scan hit for `child_process`, `electron`, `sqlite3` or a native addon (`*.node`); such plugins can never work in a browser;
     - input that is not a well-formed `.jpl`: not a tar, no `manifest.json`, entries with absolute paths, `..`, links or device files, or more than the size cap;
     - a plugin that already lists `mobile` ("already compatible"), a plugin whose `app_min_version` is above the pinned Joplin version (we never lower it), and a file that is already a repack.

     Hits for `fs`, `fs-extra`, `joplin.fs`, `joplin.imaging`, `showOpenDialog` or `views.noteList` give a named warning ("these features will fail on web"), not a refusal.
   - **Plugin code is data.** The library reads the archive and the bundle as bytes and text. It never evaluates, imports or renders plugin content as HTML. Manifest strings are shown as text only.
   - **The page's own security.** The page shares the app's origin, so a script injection into it could read the decrypted notes in the app's local storage. It is served with `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`. `connect-src 'none'` also makes "never uploads the plugin" enforceable by the browser. The page doesn't open OPFS, IndexedDB or the app's storage.
   - **Risk statement (D6, accepted wording).** Shown on the page next to the acknowledgment, and in the deploy guide: "A repacked plugin was never tested by its author on this platform. It has the same access to your decrypted notes as any plugin. Bug reports about repacked plugins go to Notestead, not to the plugin author or to Joplin."
   - **No redistribution.** We never host, ship or upload third-party plugins or repacked files: not in the repository, the images, release assets or CI artifacts. The page says that the repacked file is for the user's own use, stays under the plugin's own licence, and should not be shared. Test plugins in the repository are written by us (AGPL). The `@network` nightly downloads its real plugins at run time, pinned by sha256, and never keeps them as artifacts.
   - **Trademark.** The page uses Notestead's branding and the "unofficial, not affiliated with JOPLIN SAS" notice (ADR-0010). It ships no upstream logo, and it doesn't change upstream's `index.html` (ADR-0010's "upstream script tags byte-identical" holds). Users reach it by its URL, documented in the deploy guide.
2. **No `patches/`** (D2). ADR-0001's "zero source patches" stands. Route B, and the narrow exception sketched in PLUGINS-WEB §2 B, are not adopted. Only a new user decision can reopen them.
3. **Upstream and plugin-author contributions are deferred** (D3, D5). U15 to U19 (ARCHITECTURE §10) stay **candidates, not filed**, and no plugin author is contacted. We don't write upstream PRs, forum threads or author requests until the user asks. The prelude parts are still built so that each can be switched off by feature detection, should upstream ever add the matching feature.
4. **Not pursued:** `noteList` renderers on web, `joplin.ai` in the browser (AI clients use MCP, ADR-0004), `sqlite3` emulation, a scoped `fs` shim from the plugin side (the sandboxed iframe can't reach OPFS; PLUGINS-WEB §1 #5), and desktop theme and layout plugins.

## Alternatives considered
- **Reuse upstream as-is** (the state before this ADR): desktop-only plugins install but never run, and menus are invisible. It costs nothing, but it doesn't meet the user's ask. It stays the default behaviour: the tool is off by default, and nothing changes for a plugin the user hasn't repacked.
- **Route A: upstream PRs** (a "run anyway" option, menus on mobile, imaging, a scoped fs API). The only path that removes the gaps for every Joplin user and survives bumps for free, but it takes about 4 to 9 months per feature after acceptance, and it uses the user's GitHub account. **Deferred by the user (D3), not rejected.**
- **Route B: carry a patch series** to lift the gate and render menus inside the bundle.
  - It gives the most native result: menus in their proper places, and updates from the repository.
  - It is a feature wish rather than an unavoidable fix, so it breaks the golden rule without a user exception. ADR-0001 would have to be amended.
  - `Note.tsx`-level patches will conflict on some 3.7.x bumps (0.5 to 2 h each, plus a cache-miss rebuild), and every minor means a re-port.
  - **Declined by the user (D2).**
- **Runtime monkey-patching from our overlay** (inject a script into `index.html` to reach `PluginService` inside the webpack bundle). It is a patch in disguise, against bundle internals with no stable names, and it breaks ADR-0010's "upstream script tags byte-identical". Rejected.
- **A big refactor in our own copy of app-mobile** (fs, `noteList`, AI). That is a fork. Rejected by the golden rules, and unaffordable to rebase.
- **Route E: ask plugin authors to declare `mobile`.** The best permanent fix for a plugin that works. **Deferred by the user (D5).**
- **Where the tool runs** (D4): a CLI only (needs Node on the user's machine; no help on a phone or tablet); a server-side endpoint in `web` (the plugin would leave the browser, and Caddy would need code); **a client-side page in `web`** (chosen: no install, nothing uploaded, same code as the test CLI).
- **A 404 when the tool is off.** Simpler, but the upstream service worker answers it from the cache (Context), so a browser that had loaded the tool would keep it. Rejected for the 200 "turned off" page.

## Consequences
- About half of the popular desktop-only plugins can be made to run on web without touching upstream (PLUGINS-WEB §3, phases 1a and 1b; static finding, confirmed per plugin only at run time). Their menu commands appear in the note action menu rather than in their desktop locations, and they don't receive `noteIds`/`folderId` context arguments.
- **No in-app updates for a repacked plugin:** the repository manifest still says desktop-only, so upstream offers no update (`upstream:packages/lib/services/plugins/RepositoryApi.ts:286`). The user repacks the new version. Installing the original `.jpl` again (same id) undoes a repack.
- **L2 stays a limitation** (ARCHITECTURE §9): the tool is opt-in, the plugins still lack `fs`, imaging, the open dialog, `noteList` and the rest, and nothing changes for users who leave it off.
- **New dependencies on upstream internals,** each with a test that catches drift (Verification):
  - the gate's inputs (`platforms`, `app_min_version`) and the parser's tolerance of an extra manifest field;
  - for phase 1b only, the script order and the replaceable `window.joplin` global. If they drift, the prelude switches itself off and the phase 1a change alone keeps working.
- **Security.** A repacked plugin has the same access to the decrypted notes as any plugin, inside the same sandboxed iframe, with no new privilege. It was never tested by its author on this platform. The tool adds one page to the app origin; its CSP, its text-only rendering and its refusal to evaluate plugin code are acceptance criteria (M2-S12). ARCHITECTURE §5 records it.
- **Support.** Our docs and the page send bug reports about repacked plugins to us, not to plugin authors or upstream.
- **Licensing.** The user changes their own copy of a plugin for their own use. We don't distribute the result, so no licence obligation of a third-party plugin attaches to our artifacts. Our package is AGPL-3.0-or-later, and its dependencies follow the licence allow-list (M1-S9).

## Upgrade impact
- **Every bump** runs the repackager's contract tests with the pinned `@joplin/lib` (a repacked canary manifest passes `manifestFromObject` and `isCompatible` for the mobile app type at the pinned version; the original doesn't), the canary prelude contract, and the M2-S12 E2E specs.
- **A failure** is triaged like any other upstream drift (ADR-0005). The feature is opt-in and off by default, so the user may ship a security bump with the repackager marked unsupported in the release notes rather than hold the bump.
- **If upstream ever adds a matching feature** (for example menus on mobile), the bump that brings it runs the same E2E with the matching prelude part switched off by feature detection, and the part is then removed.

## Verification
- PLUGINS-WEB evidence E1 to E6 (code reading and a static scan; not run).
- **Story M2-S12** in [`docs/backlog/M2.md`](../backlog/M2.md):
  - phase 1a: M2-AC22 to M2-AC28 (off-by-default and the service-worker cache, the manifest change, the scan and input refusals, the per-plugin opt-in, local-only processing under CSP, the end-to-end run of a repacked canary against an unrepacked one, and no redistribution);
  - phase 1b: M2-AC29 to M2-AC32 (the prelude insertion, menu commands in the note action menu, the canary contract with the prelude's fail-safe, and the `@network` nightly on two pinned real plugins plus one that must be refused).
