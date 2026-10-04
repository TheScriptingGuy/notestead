# ADR-0001: The web UI is upstream's app-mobile web build, built from a pinned ref on x64 CI, consumed as an architecture-neutral artifact

## Status
Proposed (Phase A, 2026-10-03). Spike S1:
- Native arm64 build: **GO-WITH-CONDITIONS** as a local fallback (43 min, 7.0 GiB peak with swap full, ~13 GB of disk).
- x64 CI artifact path: **GO**.

The output is byte-size-identical to the official deployment for every static file except `app.bundle.js`, which has 18 more days of release-branch fixes.

## Context
- **`packages/app-mobile` has a react-native-web build.**
  - `"web": "webpack --mode production --config ./web/webpack.config.ts --progress && cp -r ./web/public/* ./web/dist/"` (`upstream:packages/app-mobile/package.json:12` at `v3.7.21`).
  - It is the code behind app.joplincloud.com. The official deploy (github.com/joplin/web-app `deploy-github-pages.yml`) checks out the newest `release-X.Y` branch, then runs `corepack enable`, `yarn install` and `cd packages/app-mobile && yarn web`, on `ubuntu-latest` (x64).
- **The output is static:** `index.html`, `app.bundle.js`, `serviceWorker.bundle.js`, wasm, fonts and assets. It contains no native code, so it is architecture-neutral.
- **The build needs the full monorepo install.**
  - The root `postinstall` runs `husky && gulp build`, which runs `buildParallel`/`buildSequential` across every workspace (desktop, server, CLI, clipper, …).
  - `nodeLinker: node-modules` with `nmHoistingLimits: workspaces` makes per-workspace `node_modules` trees. S1 measured more than 11 GB on disk during the link step.
  - The `onenote-converter` (Rust/wasm) only builds when `IS_CONTINUOUS_INTEGRATION` is set (`upstream:packages/onenote-converter/tools/build.js`). The official deploy doesn't set it, so the deployed web app doesn't have it either. We also set `SKIP_ONENOTE_CONVERTER_BUILD=1`.
- **Upstream CI doesn't build app-mobile on ARM64** and exits early ("nothing works properly with the ARM64 architecture"; `upstream:.github/scripts/run_ci.sh:56-77`).
- **There are no upstream tests for the web build** (findings §1).
- **No source patches are needed for our use.**
  - The app runs on any origin.
  - On origins other than `https://app.joplincloud.com` it offers the Joplin Server sync target (`isJoplinCloudWebApp`, `upstream:packages/app-mobile/utils/buildStartupTasks.ts:189`).
  - The service worker derives every path from its own location, so sub-path hosting works (`upstream:packages/app-mobile/web/serviceWorker.ts:48-52`).
  - Branding and `__DEV__` live in static files that we overlay after the build (ADR-0010).

## Decision
1. **Reuse the upstream web build unmodified.** It is built from `upstream/joplin-version.json` → `web.commit` on `web.branch` (today `release-3.7` @ `e41516e66` = `v3.7.21`), with the exact official recipe plus `SKIP_ONENOTE_CONVERTER_BUILD=1`. There are **zero source patches**. Our only changes are the post-build overlay of static files (ADR-0010).
2. **The primary build runs once on x64 CI** (`web-bundle.yml`, owned by the ci-cd-specialist; scripts in `packages/web-build`, owned by the senior engineer). It produces `web-bundle-<tag>.tar.zst` with `SHA256SUMS` and `bundle-manifest.json`, and is cached by pin hash. The `web` image for **both** architectures copies this artifact into a multi-arch Caddy base. No QEMU and no native arm64 webpack build are needed for releases.
3. **Locally on the Pi**, developers and tests:
   - (a) download the CI artifact, or
   - (b) build natively with `docs/spikes/S1/build-web-arm64.sh`, under the conditions recorded in S1. This is a fallback for when CI is unavailable, not the release path.
4. **Serving requirements** are implemented by the `web` container (ADR-0002/0006):
   - HTTPS, or `127.0.0.1` for local use
   - COOP `same-origin` + COEP (`credentialless` by default; `require-corp` selectable)
   - `application/wasm`
   - static file serving from any path prefix
5. **Spike exception.** Until M1-S2 exists, local spikes may serve a *static copy of the official deployment* (app.joplincloud.com) for testing only, never for distribution. Spike reports say so explicitly.

## Alternatives considered
- **Reuse upstream as-is: point users at app.joplincloud.com.**
  - On that origin `isJoplinCloudWebApp` is true, so the sync wizard only offers Joplin Cloud. A self-hosted server can't be used ("A self-hosted instance cannot sync with Joplin Cloud", `components/SyncWizard/SyncWizard.tsx`).
  - That origin also isn't in our control (no proxy, so no CORS path to the user's server).
  - Not viable.
- **Build natively on every arm64 machine (`yarn web` in the image build).** The image build would need the full monorepo install (>11 GB, an hour or more, several GB of RAM; S1) for a static output. Rejected as the release path; kept only as a local fallback.
- **Build the image's bundle under QEMU for arm64.** It produces byte-equivalent static output at many times the cost. Pointless.
- **A focused install** (`yarn workspaces focus @joplin/app-mobile`). It would skip the root `postinstall` `gulp build`, so we would have to re-implement upstream's build orchestration (`compilePackageInfo`, `buildInjectedJs`, `copyWebAssets`, renderer/editor assets). That is a private build contract that drifts with every bump. Rejected in favour of the official recipe. It could be reconsidered upstream as a supported `yarn web:standalone` script (upstream-first item).
- **Fork app-mobile, or patch it for a runtime config hook** (e.g. a prefilled server URL). Not needed. The user types the sync URL once. A runtime config hook is proposed upstream.
- **Use the desktop app instead (Electron) via a remote desktop.** That isn't a web app, and there's no Linux arm64 desktop build (findings). Rejected.

## Consequences
- The UI is exactly the upstream mobile/web app, with its known limitations (ARCHITECTURE.md §9):
  - no alarm notifications (`services/AlarmServiceDriver.web.ts` is a no-op)
  - only mobile-compatible plugins
  - single tab
  - sync only while the tab is open
- The release path depends on a GitHub-hosted x64 runner. The Pi can always rebuild locally (S1 conditions).
- Upstream gives no test signal for the web build, so our E2E suite (ADR-0007) is the gate.

## Upgrade impact
- **A bump changes `web.commit`.** CI rebuilds, the overlay's expected-file check (M1-AC6) runs, and the full E2E suite runs on both architectures (M6-AC3).
- **If upstream breaks the recipe** (new build steps, a new Node or yarn version), `web-bundle.yml` fails before anything ships.
- **If upstream ever publishes the web bundle as a release asset,** we switch to consuming it (verify the checksum) and drop our build step.

## Verification
- **S1:** native arm64 build measurements and the CI path design.
- **S4:** the bundle runs in Chromium on the Pi with OPFS and both COEP modes.
- **Backlog:**
  - M1-AC5–7 (build, overlay, verify)
  - M1-AC21 (walking skeleton)
  - M2 (full web E2E coverage)
