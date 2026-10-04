# web-build

Build tooling for the Notestead web UI: the pinned upstream Joplin web bundle (`packages/app-mobile`, `yarn web`),
plus the repository checks (`check:pin`, `check:no-upstream-copy`, `check:licenses`). ADR-0001 (build), ADR-0009
(checks) and ADR-0010 (branding overlay, source offer and third-party notices).

All commands run as `corepack yarn workspace web-build <command> …`. Use absolute paths: yarn runs workspace
scripts from `packages/web-build`. `--pin <file>` defaults to `upstream/joplin-version.json`. Exit codes: 0 OK,
1 failure (every message names the offending path), 2 usage error.

| Command | What it does |
|---|---|
| `build --out <dir> [--work <dir>]` | Fetches `web.repo` at exactly `web.commit` into `--work` (default `~/.cache/notestead/web-build/<commit>`), runs the official recipe with `SKIP_ONENOTE_CONVERTER_BUILD=1` (`corepack yarn install`, then `corepack yarn web` in `packages/app-mobile`), then `notices`, `overlay`, `verify` and `package` on its `web/dist`. `--work` must be new, empty, or a directory an earlier `build` created (it holds a `.notestead-web-build-work` marker); anything else is refused untouched, because `build` resets and cleans its work directory on every run. Meant for x64 CI (~13 GB of disk). On arm64 it needs `NOTESTEAD_ALLOW_ARM64_WEB_BUILD=1` and adds the spike S1 conditions (`BUILD_SEQUENCIAL=1`, a 3 GiB V8 heap): ~43 min, ~7 GiB peak. |
| `notices <upstream-tree> --bundle <dist> --out <file> [--exceptions <file>]` | Writes `third-party-notices.txt` for an upstream checkout after `yarn install` and its built dist: every package of the `packages/app-mobile` `dependencies` closure (from the tree's `yarn.lock` and root `resolutions`) plus every installed package a `*.LICENSE.txt` banner names, each with its declared licence and the full text of its licence files. Upstream workspaces without their own licence file are listed as AGPL-3.0-or-later with a pointer to `source.html`; a package without a licence file gets its exception's `noticeText`, else the standard SPDX text of its declared licence (from the pinned `spdx-license-list` package, offline), else the step fails naming it and writes nothing. |
| `overlay <dist>` | Applies `overlay.json` in place: our `environment.js` (`__DEV__` always false), placeholder icons, no screenshots, our name in `manifest.json` and the page titles, a "Source" link, and a generated `source.html` (AGPL-3.0 §13 offer, linking `third-party-notices.txt` when present). Fails, changing nothing, if any file it expects is missing. |
| `verify [--upstream <git-dir>] <dist>` | Fails if any file has the sha256 of an upstream icon at `web.commit`, if `environment.js` is not ours, if the CSP `<meta>` differs from upstream's, or if `third-party-notices.txt` is missing or not linked from `source.html`. Without `--upstream` it uses the cached blobless fetch of `check:no-upstream-copy`. |
| `package <dist> --out <dir>` | Writes `web-bundle-<web.tag>.tar.zst`, `bundle-manifest.json` (upstream repo/tag/commit, our commit, every file with sha256 and size) and `SHA256SUMS`. Needs GNU tar; zstd comes from Node's zlib. |

The overlay's own assets and their provenance are described in `overlay/README.md`.
`source.html` takes our repository URL from the `origin` remote, or from `NOTESTEAD_SOURCE_REPO` when set.

## Repository checks (root scripts)
- `corepack yarn check:pin [--pin <file>] [--lockfile <file>] [--headless-manifest <file>]`: the pin schema, `yarn.lock` against the pin (CLI version, lockstep minor, every `joplin`/`@joplin/*` entry resolved from the npm registry as `<name>@npm:<version>`), and `packages/headless/package.json` depending on `joplin` at exactly `cli.version`.
- `corepack yarn check:no-upstream-copy [--root <dir>] [--upstream <git-dir>] [--pin <file>]`: tracked files of at least 1 KiB byte-identical to an upstream file at `web.commit`, and tracked files of any size carrying upstream's licence header (line 1 of `upstream:LICENSE`) with its copyright line.
- `corepack yarn check:licenses [--root <dir>] [--exceptions <file>] [--report <file>]`: lists every installed package (root and workspace `node_modules`, nested included) with its declared licence and fails unless the SPDX expression is on ADR-0009's allow-list or the exact `name@version` is in `license-exceptions.json` (exact version, licence, evidence, reason; `prepublishBlocker: true` when the licence is UNKNOWN).
