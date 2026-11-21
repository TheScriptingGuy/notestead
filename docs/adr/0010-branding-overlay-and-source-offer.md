# ADR-0010: Branding overlay (trademark) and AGPL source offer

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`), amended the same day (see Amendments). Proposed in Phase A (2026-10-03). The public name is **Notestead**, shown as "Notestead for Joplin (unofficial)". The user still runs an EUIPO TMview check before the first public release.

**Public distribution is a project goal** (Docker Hub, GHCR, npm, GitHub Releases, MCP Registry; channel plan in `docs/delivery/channels.md`, approved at gate 1). The trademark and logo question is therefore **not optional**: it is a precondition of the first public release on any channel.

## Context
- **"Joplin" is a registered trademark of JOPLIN SAS, and the upstream logos and icons are all rights reserved** (`CLAUDE.md`). The upstream web bundle carries them only in static files copied from `packages/app-mobile/web/public/` after webpack (`"web": "webpack … && cp -r ./web/public/* ./web/dist/"`):
  - `icons/*`
  - `manifest.json` (`name: "Joplin Web"`)
  - `index.html` (`<title>Joplin</title>`, `og:*`, description)
  - `screenshots/*`
  - `just-one-client.html`, `closed.html`

  `grep` over `packages/app-mobile/components` finds no logo images imported into the React UI. The built `dist/` was checked in S1/S4 (see S1 evidence for the asset list).
- **The UI text says "Joplin"** in places (About, settings). Changing it would need source patches.
- **The upstream app is AGPL-3.0-or-later.** Serving a modified build over a network triggers §13: we must prominently offer users the Corresponding Source of our version.
- **`environment.js` turns on React Native dev mode** for any origin containing "localhost" (`upstream:packages/app-mobile/web/public/environment.js:2`). In source, dev mode changes the database name, runs self-tests and points Joplin Cloud URLs at `joplincloud.local`.
  - **At the pin, the published production bundle crashes at start in dev mode** *(amended 2026-11-21, M2-S6 ruling RU-1)*. On any `localhost` origin, upstream's `environment.js` sets `__DEV__ = true` and the title `Joplin DEV`. Upstream's code then reaches the React Refresh runtime, which webpack includes only for hot reload (`upstream:packages/app-mobile/web/webpack.config.ts:8,36,63`), so a production build carries the package's stub instead: `throw Error("React Refresh runtime should not be included in the production bundle.")`. The page dies before it opens a database or shows the sync wizard. Observed on the Pi in M2-S6 (`docs/test-plans/M2-S6.md`, "HARD STOP at WO-4" and RU-1).
  - So the overlay's `environment.js` is **what makes the bundle usable on `localhost`** (for example `http://localhost:8080` on the host that runs the stack), not only a cosmetic flag. Anyone serving the raw upstream bundle on `localhost` gets a blank page. Candidate upstream issue: ARCHITECTURE §10, **U20** (draft there, unfiled).

## Decision
`packages/web-build` applies an **overlay to the built `dist/`**. It edits static files only and never touches upstream source or the webpack bundles:

| File | Overlay |
|---|---|
| `environment.js` | Replaced by ours. `window.__DEV__ = false` unconditionally, the same `exports`/`process.env.EXPO_OS` shims, and nothing else. |
| `manifest.json` | Our `name` ("Notestead for Joplin (unofficial)") and `short_name` ("Notestead"), our icons, no upstream screenshots. Keeps `start_url: "./"` and `display: standalone`. |
| `icons/*` | Our own icon set (SVG + PNG 64/192/256/512), under a licence we own. |
| `screenshots/*` | Removed. |
| `index.html`, `just-one-client.html`, `closed.html` | `<title>`/description/`og:*` replaced with our name plus a "not affiliated with JOPLIN SAS" notice in meta. The upstream CSP and script tags stay byte-identical. One added `<link rel="license" href="./source.html">` and a small fixed-position "Source" link (overlay CSS, `aria-label`, keyboard reachable) that opens `source.html`. |
| `source.html` (new) | The §13 offer: the upstream repo and **exact commit**, our repo and **exact commit**, the build recipe (`packages/web-build`), and links to both licences. Generated at build time from `upstream/joplin-version.json` and `git rev-parse HEAD`. |
| `third-party-notices.txt` (new) | Licence texts collected from the bundle's dependencies (webpack's license output, if upstream emits it, else generated from the upstream lockfile at build time). |

- **The overlay is declarative** (`overlay.json`: file → action). It **fails the build** if any file it expects to replace is missing or has moved, so an upstream rename can't silently ship upstream branding.
- **The verify step checks the result:**
  - no upstream icon hashes remain in `dist/`
  - `__DEV__` is false on any origin
  - the CSP `<meta>` is unchanged from upstream
- **Every published artifact** (images, the npm MCP package, the release tarball, registry listings) uses our name (Notestead), never a bare "Joplin …" name. Nothing is published until the user has completed the trademark check (ARCHITECTURE §14, open item O1).
- **Pre-publish gate.** These preconditions are acceptance criteria of M5 and are checked by the ci-cd-specialist's pre-publish checklist:
  - the user has decided the public name and it isn't a bare "Joplin …" (decided: Notestead; the user's EUIPO TMview check is still open)
  - no upstream icon hash in any artifact
  - `LICENSE` inside the images and the npm tarball
  - `source.html`/`/source` and the OCI `org.opencontainers.image.source` label point to the exact commits
  - an "unofficial, not affiliated with Joplin / JOPLIN SAS" notice in the README and in every listing

## Alternatives considered
- **Reuse upstream as-is (serve the bundle unmodified).** It ships the all-rights-reserved logos under the Joplin name, `__DEV__` flips on for `localhost` origins, and there is no §13 offer for our build. Not acceptable for a published image, though acceptable for local spikes (S2/S4 did this, and say so in the evidence).
- **Patch the upstream source to rebrand the UI text.** That is a large, conflict-prone patch, against the reuse-first rule. UI text naming "Joplin" describes what the app is (nominative use). The user may still ask JOPLIN SAS (open question).
- **Inject a runtime script that rewrites UI text.** Fragile and hacky. Rejected.

## Consequences
- In-app strings still say "Joplin". Our distribution, icons, page title and PWA name don't.
- A visible but small "Source" link sits on top of the upstream UI. Its position is chosen so it never covers upstream controls (verified by E2E screenshots on narrow and wide viewports, M2).
- **Known limitation: upstream's Joplin Cloud logo is shown in the sync wizard** *(added 2026-11-21; the user's decision Q1 = (a) of 2026-11-20, M2-S6 RU-4)*. The wizard's "Joplin Cloud" option renders an inline SVG logo from `upstream:packages/app-mobile/components/SyncWizard/JoplinCloudIcon.tsx` (used by `SyncWizard.tsx`). It is compiled into `app.bundle.js`, not a static file, so the overlay can't replace it without a source patch.
  - **Accepted as nominative use:** it labels the third-party Joplin Cloud sync option in a list of sync targets and is never our branding. (Joplin Cloud itself is not a supported target of this deployment, ARCHITECTURE L10.)
  - **The trademark review before the first public release must include it**, alongside the user's EUIPO TMview check (ARCHITECTURE §14, O1).
  - **Documented by** `M2-S6-LOGO-01` (`tests/e2e/m2-s6/limitations.spec.ts`): the option holds an `svg` with upstream's gradient stops. If it fails, upstream changed the logo: update this limitation, never just the test's colours.
  - Stated to users as ARCHITECTURE **L21**. A build option to hide cloud branding would be the upstream remedy (part of U7).

## Upgrade impact
- An upstream change to the `public/` file names breaks the overlay loudly (build failure), not silently.

## Verification
- M2-AC11 (overlay applied: unit test of overlay rules, plus E2E checks of the manifest name and icons)
- M2-AC12 (`source.html` links the exact commits; E2E)
- M2-AC13 (`__DEV__` false on a `localhost` origin; E2E negative control: the unmodified bundle on `localhost` shows dev mode)
- M5-AC1 to M5-AC3 (pre-publish gate: artifact scan for upstream icon hashes, licence and source-offer presence, name check)
- `M2-S6-LOGO-01` (documents the Joplin Cloud logo limitation, Consequences)
- M2-AC33 (`import` refuses a `source.html` whose commit isn't the manifest's) and M2-AC34 (the dev-only re-overlay never produces a release artifact), M2-S13
- M5-AC2 as amended 2026-11-21 (the image's revision label, `source.html` and the bundle manifest name one commit)

## Amendments (2026-10-04, gate 1)
- **Public name decided: Notestead** ("Notestead for Joplin (unofficial)"; artifact names in ADR-0006 and channels.md §5). The overlay's `manifest.json` name and short name are now concrete. The first public release still waits for the user's EUIPO TMview check.

## Amendments (2026-10-04, M1-S2)
- **`third-party-notices.txt`: deferral accepted.** M1-S2 did not generate it (worklog deviation 1). Webpack emits only `*.LICENSE.txt` banner extracts, not full licence texts, so the table's "webpack's license output" source is not sufficient: the file is generated from upstream's `yarn.lock` and installed tree at `web.commit` (M1-AC29, in M1-S9). Until then `source.html` links the `*.LICENSE.txt` extracts, and they stay linked afterwards. No artifact is published without the file: M5-AC1 (e) adds it to the pre-publish gate, and `verify` checks it once M1-AC29 lands.
- **Verification** gains M1-AC29 (generation and `verify` check) and M5-AC1 (e) (pre-publish).

## Amendments (2026-10-04, M1-S9 test plan, finding F2 and Interpretation 3)
- **Entry precedence in `third-party-notices.txt`.** The first matching rule applies:
  1. **Upstream workspace without its own licence file** (for example `@joplin/lib`, `@joplin/htmlpack`): listed once as `AGPL-3.0-or-later` with the `source.html` pointer. Upstream's root licence (upstream:LICENSE:1-3 at v3.7.21) makes AGPL the default "unless a directory contains a LICENSE or LICENSE.md file". The entry may mention a differing `package.json` field (htmlpack declares MIT), but `License:` says AGPL-3.0-or-later.
  2. **Any package with licence files**, including upstream workspaces that carry their own (`fork-*`, `turndown*`, `onenote-converter`, `react-native-alarm-notification`, `react-native-saf-x`): its declared licence and the full text of each file. Listing those workspaces as AGPL would misstate their licence. QA's Interpretation 3 is confirmed.
  3. **No licence file, but a usable declared licence** (F2: 120 packages at the pin, mostly MIT `expo-*`, `metro-*`, `@react-native/*`): the **standard SPDX text** of every licence ID in the declared expression. The `license` field counts, or the legacy form derived as in ADR-0009 A9. The entry carries:
     - one marker line: `Licence text: standard SPDX text for <expression>; no licence file in the package`
     - the package's `author`, `contributors` and `repository` as declared, or "not declared"
     - the text(s)

     Placeholders such as `<year> <copyright holders>` are left as they are and never invented. "Usable" means a valid SPDX expression whose every ID has a standard text available to the generator.
  4. **Otherwise** (no field, `UNLICENSED`, `SEE LICENSE IN …`, a non-SPDX string, or an ID without a standard text): an exact-version exception with `noticeText` is required; without one the step fails.
- **Why rule 3 is acceptable.** These packages declare their licence but ship no text to copy, so the standard text plus the declared author is the most complete notice that exists. Requiring 120 hand-written exceptions, re-reviewed on every bump, would add churn and no information. Exceptions stay for the cases where we would otherwise have to guess.
- **Where the standard texts come from.** The source must be offline at build time, pinned and reviewed: a subset of SPDX `license-list-data` at a named tag committed under `packages/web-build/`, or an npm data package that passes `check:licenses`. The build never fetches a text from the network. The engineer records the choice in the worklog. If a committed text of 1 KiB or more matches a file in the upstream tree, `check:no-upstream-copy` flags it; in that case use the npm route.
- Verification: M1-AC29 as amended in `docs/backlog/M1.md` (M1-S9, amendments of 2026-10-04).


## Amendments (2026-11-21, M2-S6: rulings RU-1 and RU-4, finding F4)
- **RU-1 (Context).** The raw upstream production bundle crashes at start on any `localhost` origin (Context, the `environment.js` bullet). Nothing changes in the Decision: the overlay already sets `__DEV__ = false` unconditionally, and M2-AC13 proves it (its NEG, as ruled in RU-1, asserts `__DEV__ === true`, the `Joplin DEV` title and upstream's crash line on the un-overlaid bundle).
- **RU-4 (Consequences).** The Joplin Cloud logo in the sync wizard is a known limitation, accepted by the user as nominative use (Q1 = (a), 2026-11-20), part of the pre-release trademark review, documented by `M2-S6-LOGO-01`.
- **F4: which commit the source offer names for the `web` image's own files.**
  - **The problem.** `source.html` is generated when the *bundle* is built, and names that build's commit (`bundle-manifest.json` `notestead.commit`). The `web` image adds our own AGPL files from `deploy/web/` (Caddyfile, entrypoint, Containerfile), built from whatever commit builds the image. Locally (and in CI's e2e job, which imports a kept bundle artifact) the two commits can differ, and then `source.html` doesn't point at the source of the image's own files.
  - **Decision: one commit per published artifact set.** `source.html` names exactly one commit of our repo, **C**, and that commit is the Corresponding Source of everything in the `web` image: `/tree/<C>` contains `packages/web-build` (overlay, generator) and `deploy/web/` alike. So a published `web` image must be built from C too:
    1. M5's release workflow builds the bundle and the `web` image **from the same commit** in one run, never from a kept or imported bundle of another commit.
    2. The image carries `org.opencontainers.image.revision` = C (M5-AC2).
    3. **The pre-publish gate fails** unless the image's `revision` label, the commit in the served `/source.html` (`/tree/<C>` and `/blob/<C>/LICENSE` links) and `bundle-manifest.json` `notestead.commit` are the same full 40-character SHA, and `notestead.dirty` is `false`. This is added to **M5-AC2** with a NEG.
  - **Not chosen:** a second, image-time source offer (for example `/source.html` regenerated in the Containerfile, or an extra "image source" line). It needs `git` metadata inside the image build, adds a second generator for one page, and still leaves two commits to explain to users. Rejected for published artifacts.
  - **Development and test images** (local `import` of an older bundle, CI's e2e jobs) may name an older commit in `source.html`. They are never published, and the operator is the developer, who has the repo. That is acceptable. `notestead.dirty` already marks bundles built from an uncommitted tree, and the dev-only re-overlay (M2-AC34) keeps that marking.
  - **Consistency inside the artifact.** Nothing ties `source.html`'s commit to `bundle-manifest.json`'s today, so a hand-edited `source.html` would import and serve (M2-S6 QA proposal). `import` now refuses that (**M2-AC33**, M2-S13), so the gate's equality check also holds for every imported bundle.
- **Upgrade impact:** none. These are our own build and release rules; no new upstream interface is consumed.
