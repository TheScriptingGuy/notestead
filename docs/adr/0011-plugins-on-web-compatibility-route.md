# ADR-0011: Desktop-only plugins on web: a plugin-side compatibility repackager first, upstream PRs for app changes, no patches by default

## Status
**Proposed** (architect, 2026-11-19). It is not accepted until the user decides D1 to D6 in [`docs/spikes/PLUGINS-WEB.md`](../spikes/PLUGINS-WEB.md) §6. If it is accepted as written, ADR-0001 is unchanged (zero source patches). If the user grants the `patches/` exception (D2), ADR-0001 decision 1 must be amended in the same change.

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
- **The constraint.** The golden rule "Reuse, never fork" allows `patches/` only when a change is unavoidable. ADR-0001 says zero source patches, and `packages/web-build/src/build.ts:126-129` refuses a modified upstream tree.

## Decision (proposed)
1. **Phase 1, route D: a plugin compatibility repackager of our own.** It runs as a page in the `web` container, with the same code as a CLI. It takes a `.jpl` and outputs a new `.jpl` for upstream's "Install from file":
   - it adds `mobile` to the manifest's `platforms` and keeps the plugin id;
   - optionally, it prepends a prelude that mirrors `views.menus`/`views.menuItems` items as `noteToolbar` buttons (shown in the note action menu) and stubs `require('os')`;
   - it refuses plugins whose static scan shows `child_process`, `electron` or native modules.

   It is opt-in per plugin, carries a plain risk statement, never redistributes repacked plugins and never uploads them.
2. **Upstream-first for everything inside the app.** In this order:
   - `joplin.imaging` on mobile/web;
   - `zipExtract` on web;
   - a permission-scoped async plugin file API plus `showOpenDialog` (upstream #10291);
   - plugin menus on mobile, after a forum UX thread (#14456 precedent);
   - an opt-in "run anyway" on Android/web.

   We consume each at the Joplin minor the user moves to (ADR-0005). The matching part of the prelude is then switched off by feature detection and deleted.
3. **No `patches/` by default.** A narrowly scoped exception (PLUGINS-WEB §2 B, rules 1 to 7) exists only if the user grants it, per patch, and only for an upstream PR that is open and agreed in principle.
4. **Not pursued:** `noteList` renderers on web, `joplin.ai` in the browser (AI clients use MCP, ADR-0004), `sqlite3` emulation, desktop theme and layout plugins.

## Alternatives considered
- **Reuse upstream as-is** (today's state): desktop-only plugins install but never run, and menus are invisible. It costs nothing, but it doesn't meet the user's ask. It stays the default behaviour while every plugin is opt-in.
- **Route B: carry a patch series** to lift the gate and render menus inside the bundle.
  - It gives the most native result: menus in their proper places, and updates from the repository.
  - It is a feature wish rather than an unavoidable fix, so it breaks the golden rule without a user exception. ADR-0001 would have to be amended.
  - `Note.tsx`-level patches will conflict on some 3.7.x bumps (0.5 to 2 h each, plus a cache-miss rebuild), and every minor means a re-port.
  - Rejected as the default; kept as an exception route (D2).
- **Runtime monkey-patching from our overlay** (inject a script into `index.html` to reach `PluginService` inside the webpack bundle). It is a patch in disguise, against bundle internals with no stable names, and it breaks ADR-0010's "upstream script tags byte-identical". Rejected.
- **A big refactor in our own copy of app-mobile** (fs, `noteList`, AI). That is a fork. Rejected by the golden rules, and unaffordable to rebase.
- **Ask plugin authors to declare `mobile`** (route E). The best permanent fix for a plugin that works. It needs evidence first, which Phase 1 provides. Adopted as a follow-up, not as the mechanism.

## Consequences
- About half of the popular desktop-only plugins can be made to run on web without touching upstream. Their menu commands appear in the note action menu rather than in their desktop locations, and they don't receive `noteIds`/`folderId` context arguments.
- Repacked plugins get no in-app updates: the user re-repacks after an update.
- **New dependencies on two upstream internals:**
  - the plugin script runs after `window.joplin` is set (`upstream:packages/app-mobile/components/plugins/backgroundPage/startStopPlugin.ts:57-66`);
  - `window.joplin` is a writable global (`…/backgroundPage/initializePluginBackgroundIframe.ts:12`).

  Both are guarded by a canary contract test. If they drift, the prelude is disabled, and the re-tag alone keeps working.
- **Security.** A force-run plugin has the same access to the decrypted notes as any plugin, inside the same sandboxed iframe, with no new privilege. It was never tested by its author on this platform. Off by default; the user opts in per plugin.
- **Support.** Our docs and UI send bug reports about repacked plugins to us, not to plugin authors or upstream.

## Upgrade impact
- **Every bump:** the canary contract test and the plugin E2E run. A failure disables the prelude, not the bump.
- **When an upstream feature lands in the minor we move to:** the matching prelude part is switched off by feature detection, then removed in a follow-up.
- **Route B (only if granted):** a "series applies" gate before the build; the fail-safe ships the bump without a non-applying patch.

## Verification
- PLUGINS-WEB evidence E1 to E6 (code reading and a static scan; not run).
- **If accepted:** unit tests (the `.jpl` rewrite, the scan verdict, negative controls), a canary contract test, E2E (a repacked canary shows its menu command in the note action menu and its effect is asserted through REST; the unrepacked canary stays Incompatible), and an @network nightly on two pinned real plugins (PLUGINS-WEB §7).
