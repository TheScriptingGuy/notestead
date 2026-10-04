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
- **`environment.js` turns on React Native dev mode** for any origin containing "localhost" (`upstream:packages/app-mobile/web/public/environment.js:2`). Dev mode changes the database name, runs self-tests and points Joplin Cloud URLs at `joplincloud.local`.

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

## Upgrade impact
- An upstream change to the `public/` file names breaks the overlay loudly (build failure), not silently.

## Verification
- M2-AC11 (overlay applied: unit test of overlay rules, plus E2E checks of the manifest name and icons)
- M2-AC12 (`source.html` links the exact commits; E2E)
- M2-AC13 (`__DEV__` false on a `localhost` origin; E2E negative control: the unmodified bundle on `localhost` shows dev mode)
- M5-AC1 to M5-AC3 (pre-publish gate: artifact scan for upstream icon hashes, licence and source-offer presence, name check)

## Amendments (2026-10-04, gate 1)
- **Public name decided: Notestead** ("Notestead for Joplin (unofficial)"; artifact names in ADR-0006 and channels.md §5). The overlay's `manifest.json` name and short name are now concrete. The first public release still waits for the user's EUIPO TMview check.
