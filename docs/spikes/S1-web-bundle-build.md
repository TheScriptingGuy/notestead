# Spike S1: building the upstream web bundle (app-mobile `yarn web`) on arm64, and the x64 CI path

## Question
- Can upstream `packages/app-mobile` `yarn web` be built **natively on the Raspberry Pi 4** (arm64, 8 GB RAM + 2 GB swap) with upstream's own recipe?
- How long does it take and how much memory does it need?
- What is the architecture-neutral artifact path for releases?

## Timebox
3 h (hard `timeout 11000`). Used: 43 min of build time, plus analysis.

## Setup
- **Source:** laurent22/joplin tag `v3.7.21` = `release-3.7` head = `e41516e669efb693b009bedb21f3eb1fcbea4fc9`, a shallow clone in `~/joplin-web-app-work/spikes/S1/joplin`.
- **Host:** Node v24.17.0 (nvm), yarn 4.16.0 via corepack (`packageManager` in upstream `package.json`), Debian (Raspberry Pi OS), aarch64.
- **At start:** 2.7 GB of RAM already in use by the desktop session (Chromium, Claude Code), swap empty.
- **Recipe:** the same as the official deploy (github.com/joplin/web-app `.github/workflows/deploy-github-pages.yml`: checkout `release-X.Y` → `corepack enable` → `yarn install` → `cd packages/app-mobile && yarn web`). Three environment additions:
  - `SKIP_ONENOTE_CONVERTER_BUILD=1`: no Rust on the Pi. The converter only builds when `IS_CONTINUOUS_INTEGRATION` is set (`upstream:packages/onenote-converter/tools/build.js:10-27`), so the official deploy doesn't build it either.
  - `BUILD_SEQUENCIAL=1`: upstream's own switch in `gulpfile.js` (`buildSequential` instead of `buildParallel`), to lower peak memory.
  - `NODE_OPTIONS=--max-old-space-size=3072`.
- **Measurement:** `/usr/bin/time` isn't installed, and installing it would be an apt change. `docs/spikes/S1/measure.py` reports wall/CPU time and `ru_maxrss` of the largest child (RUSAGE_CHILDREN), and samples `/proc/meminfo` every 2 s for peak system memory and swap use.
- **Commands:**
  ```bash
  nohup timeout 11000 docs/spikes/S1/build-web-arm64.sh v3.7.21 > ~/joplin-web-app-work/spikes/S1/build.log 2>&1 &
  # build-web-arm64.sh = git clone --depth 1 --branch v3.7.21 … ; measure.py install 7200 -- corepack yarn install ;
  #                      cd packages/app-mobile ; measure.py web 3600 -- corepack yarn web
  ```

## Evidence
```
ref=v3.7.21 commit=e41516e669efb693b009bedb21f3eb1fcbea4fc9 node=v24.17.0 arch=aarch64
➤ YN0000: ┌ Resolution step   └ Completed in 4s 131ms
➤ YN0000: ┌ Fetch step        └ Completed in 4m 33s
➤ YN0000: ┌ Link step         └ Completed in 28m 51s     (includes root postinstall: husky && gulp build → buildSequential → yarn tsc)
➤ YN0000: · Done in 33m 31s
[measure:install] exit=0 wall=33.6 min user=38.2 min sys=8.0 min max_child_rss=3459 MiB
                  peak_sys_used=7027 MiB (baseline 2700 MiB) peak_swap_used=2048 MiB (baseline 0 MiB)
[measure:web] start 2026-10-03T21:27:57 cmd=corepack yarn web
webpack 5.97.1 compiled successfully in 31881 ms                      (service-worker config)
webpack 5.97.1 compiled with 2 warnings in 497716 ms                  (app config; warnings = asset size limits)
[measure:web] exit=0 wall=8.6 min user=11.3 min sys=0.4 min max_child_rss=3917 MiB
              peak_sys_used=5750 MiB (baseline 1753 MiB) peak_swap_used=507 MiB
29M	web/dist
```

**Observations during the install phase:**
- Swap filled completely (2.0/2.0 GiB), and `MemAvailable` dropped to **870 MB** (21:22:37). The peak came when upstream's `yarn tsc` ran `tsc` for `app-desktop` and `app-mobile` in parallel (~0.8–1.1 GB each), on top of the yarn process (1.2 GB).
- The build had the highest `oom_score` (802), so an OOM kill would have hit the build before the user's processes. There was no OOM kill.
- **Disk:** the root filesystem went from 36 GB to 49 GB used. That is **~12–13 GB for the clone and its `node_modules`**: `nmHoistingLimits: workspaces` creates a `node_modules` per workspace, e.g. app-mobile 1.3 GB, app-desktop 870 MB, lib 719 MB.
- The root `postinstall` builds **every** workspace (desktop, server, CLI, clipper with a nested `npm install`, …), even though only app-mobile is needed.

**Output** (`packages/app-mobile/web/dist`, 29 MB):
```
index.html environment.js manifest.json index.css info-page.css just-one-client.html closed.html
app.bundle.js (18,877,358 B)  serviceWorker.bundle.js (5,204 B)  528/665/794/804.bundle.js
4df5e7af1d8a6b183755.wasm (938,882 B, sqlite-wasm)  *.ttf (icon fonts)  *.png (6 UI icons, 36–63 px)
icons/ (6 files)  screenshots/ (2 files)  *.LICENSE.txt
```

**Parity with the official deployment** (app.joplincloud.com, `last-modified: Mon, 07 Sep 2026`, built from the `release-3.7` head of that day):

| file | official (bytes) | ours (bytes) |
|---|---|---|
| index.html | 1670 | 1670 |
| environment.js | 352 | 352 |
| manifest.json | 1324 | 1324 |
| serviceWorker.bundle.js | 5204 | 5204 |
| 4df5e7af1d8a6b183755.wasm | 938882 | 938882 (same content-hash name) |
| app.bundle.js | 18869899 | 18877358 (+7.5 KB: 18 days of release-branch fixes) |

**Branding inventory** (input to ADR-0010):
- Every file under `dist/icons/` is byte-identical to `packages/app-mobile/web/public/icons/*`. The overlay can detect and replace them by hash.
- The 6 PNGs that webpack emits are UI glyphs: for example `77417465…png` is a back chevron (viewed). The only inline images in `app.bundle.js` are a checkbox-tick SVG (decoded) and one PNG data URI. There are no Joplin logos in the JavaScript bundles.
- The word "Joplin" appears in `index.html` (3×), `manifest.json` (4×), `just-one-client.html` (6×) and `closed.html` (2×). All of these are overlay targets.
- `environment.js` contains `window.__DEV__ = window.location.origin.includes('localhost')` (overlay target).

## Result
**GO-WITH-CONDITIONS** for a native arm64 build, as a *local fallback*. **GO** for the x64 CI artifact path as the *release path*.

**Native build on the Pi works** with upstream's unmodified recipe. It is not a good release path:
- **Time:** ~43 min (33.6 install + 8.6 webpack) on a warm network.
- **Memory:** 7.0 GiB system peak with swap full; webpack alone reached a 3.9 GiB RSS. It only fits when nothing else heavy runs and ≥ 5 GB is free at the start.
- **Disk:** ~13 GB.
- **No upstream CI coverage on ARM64** (`upstream:.github/scripts/run_ci.sh:56-77`), so a future bump may break here first.

**Conditions for using the native build:**
1. Run it alone, under `timeout`, with `BUILD_SEQUENCIAL=1`, `SKIP_ONENOTE_CONVERTER_BUILD=1` and `--max-old-space-size=3072`.
2. Have ≥ 5 GB RAM free and ≥ 15 GB disk.
3. Accept that it may break on ARM64 before x64.

**Release path (decided in ADR-0001):**
- `web-bundle.yml` (ci-cd-specialist) runs the same `build-web-arm64.sh`-equivalent script (`packages/web-build`) once on `ubuntu-24.04` x64. GitHub's standard runner is 4 vCPU/16 GB for public repos and 2 vCPU/8 GB for private repos. The official joplin/web-app workflow runs the same recipe on `ubuntu-latest`. The ci-cd-specialist measures the actual time and memory in M1-S3; the 8 GB private runner may need `BUILD_SEQUENCIAL=1` like the Pi.
- It applies the overlay and verification, and uploads `web-bundle-<tag>.tar.zst` plus `SHA256SUMS` plus `bundle-manifest.json`, cached by the pin hash.
- The `images.yml` jobs on **both** architectures copy the artifact into the Caddy-based `web` image. No arm64 webpack, no QEMU.
- The Pi consumes the image or the tarball.

## Follow-ups
- The native-build script stays in `docs/spikes/S1/` as a documented fallback. `packages/web-build` will wrap the same steps (M1-S2).
- **Optional system tuning is the user's decision** (open question): a larger swap (e.g. 4 GB), or zram, would give the Pi headroom for occasional native builds. Not required for the chosen path.
- **Upstream-first U9:** a supported standalone web build, or the web bundle published as a release asset, would remove our build step. It would also make the 13 GB / 43 min cost disappear for everyone self-hosting the web app.
- The built `dist/` in `~/joplin-web-app-work/spikes/S1/` is reused (unmodified, local only) by S2/S4. It isn't distributed.
