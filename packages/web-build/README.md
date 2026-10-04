# web-build

Build tooling for the Notestead web UI: the pinned upstream Joplin web bundle (`packages/app-mobile`, `yarn web`),
plus the upstream pin checks. ADR-0001 (build) and ADR-0010 (branding overlay and source offer).

All commands run as `corepack yarn workspace web-build <command> …`. Use absolute paths: yarn runs workspace
scripts from `packages/web-build`. `--pin <file>` defaults to `upstream/joplin-version.json`. Exit codes: 0 OK,
1 failure (every message names the offending path), 2 usage error.

| Command | What it does |
|---|---|
| `build --out <dir> [--work <dir>]` | Fetches `web.repo` at exactly `web.commit` into `--work` (default `~/.cache/notestead/web-build/<commit>`), runs the official recipe with `SKIP_ONENOTE_CONVERTER_BUILD=1` (`corepack yarn install`, then `corepack yarn web` in `packages/app-mobile`), then `overlay`, `verify` and `package` on its `web/dist`. `--work` must be new, empty, or a directory an earlier `build` created (it holds a `.notestead-web-build-work` marker); anything else is refused untouched, because `build` resets and cleans its work directory on every run. Meant for x64 CI (~13 GB of disk). On arm64 it needs `NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1` and adds the spike S1 conditions (`BUILD_SEQUENCIAL=1`, a 3 GiB V8 heap): ~43 min, ~7 GiB peak. |
| `overlay <dist>` | Applies `overlay.json` in place: our `environment.js` (`__DEV__` always false), placeholder icons, no screenshots, our name in `manifest.json` and the page titles, a "Source" link, and a generated `source.html` (AGPL-3.0 §13 offer). Fails, changing nothing, if any file it expects is missing. |
| `verify [--upstream <git-dir>] <dist>` | Fails if any file has the sha256 of an upstream icon at `web.commit`, if `environment.js` is not ours, or if the CSP `<meta>` differs from upstream's. Without `--upstream` it uses the cached blobless fetch of `check:no-upstream-copy`. |
| `package <dist> --out <dir>` | Writes `web-bundle-<web.tag>.tar.zst`, `bundle-manifest.json` (upstream repo/tag/commit, our commit, every file with sha256 and size) and `SHA256SUMS`. Needs GNU tar; zstd comes from Node's zlib. |

The overlay's own assets and their provenance are described in `overlay/README.md`.
`source.html` takes our repository URL from the `origin` remote, or from `NOTESTEAD_SOURCE_REPO` when set.
