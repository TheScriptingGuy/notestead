# ADR-0005: One version pin, same-minor skew policy, upgrade and rollback rules

## Status
Proposed (Phase A, 2026-10-03). Becomes Accepted when the user approves the plan (`plan-approved-v1`).

## Context
We consume three upstream artifacts, each released on its own schedule:

| Artifact | Latest on 2026-10-03 | Where it comes from |
|---|---|---|
| Web bundle (`packages/app-mobile`, `yarn web`) | `release-3.7` head = tag `v3.7.21` = `e41516e669efb693b009bedb21f3eb1fcbea4fc9` (2026-09-25) | built from source; not published as a package |
| CLI | npm `joplin@3.7.1` (tag `cli-v3.7.1` = `425a05ac4`, 2026-09-07) | npm registry |
| Test server | `docker.io/joplin/server:3.7.2` (tag `server-v3.7.2`, amd64 + arm64) | Docker Hub |

Facts that constrain the policy (all verified in the reference clone):
- **Sync-target version is 3 in all three refs:** `upstream:packages/lib/models/Setting.ts:306` (`syncVersion: 3`) at `v3.7.21`, `cli-v3.7.1`, `server-v3.7.2` and `android-v3.7.11`. A client whose `syncVersion` is higher than the target's `info.json` version upgrades the target, and older clients then refuse to sync (`upstream:packages/lib/services/synchronizer/MigrationHandler.ts:72-90`). That is the one change that can lock the user's other devices out.
- **Local database versions differ but don't matter across devices.** `v3.7.21` has migrations up to 54 and `cli-v3.7.1` up to 53 (`upstream:packages/lib/services/database/migrations/index.ts`). Each client's database is local, and migrations are one-way. An older build refuses a newer profile.
- **`android-v3.7.11` and `v3.7.21` are the same app-mobile code.** Between `70eac1b2e` and `e41516e66`, `packages/app-mobile`, `lib`, `renderer` and `editor` changed only in release bookkeeping (lock files, "Releasing sub-packages", the iOS version). Pinning `v3.7.21` therefore means building what Android/iOS 3.7.11 shipped, and it matches what the official deploy builds (the `release-3.7` head).
- **The npm CLI declares floating ranges** (`"@joplin/lib": "~3.7"`, `@joplin/renderer`, `@joplin/utils`). Only 3.7.1 of each is published today, but a future `@joplin/lib@3.7.x` would be picked up silently without our own lockfile.
- **The CLI tag predates some lib fixes on `release-3.7`.** For example #16473 ("Return 202 for MCP notification requests") is not in `cli-v3.7.1`. Web and CLI can therefore differ in behaviour within a minor.

## Decision
1. **A single pin file, `upstream/joplin-version.json`** (owned by the engineer), is the only place upstream versions live:
   ```json
   {
     "minor": "3.7",
     "web":    { "repo": "https://github.com/laurent22/joplin.git", "branch": "release-3.7",
                 "tag": "v3.7.21", "commit": "e41516e669efb693b009bedb21f3eb1fcbea4fc9" },
     "cli":    { "npm": "joplin", "version": "3.7.1" },
     "server": { "image": "docker.io/joplin/server", "tag": "3.7.2" },
     "syncVersion": 3
   }
   ```
   - Build scripts, Containerfiles, CI and test fixtures read this file and hard-code nothing.
   - `packages/headless/package.json` depends on `"joplin": "3.7.1"` exactly. Our `yarn.lock` pins the transitive `@joplin/*` versions, and a CI check fails if the lockfile's `@joplin/lib` minor differs from `minor`.
2. **Skew policy.**
   - All three artifacts stay on the **same minor** as the user's Joplin Server and clients (3.7 today).
   - Within that minor, patches may differ (web 3.7.21 vs CLI 3.7.1 is allowed).
   - **Hard rule:** the `syncVersion` read from the pinned web ref and from the CLI's installed `@joplin/lib` must both equal `syncVersion` in the pin file and the version in the user's sync-target `info.json`.
3. **Upgrade policy.**
   - **Patch bumps** within the minor are proposed automatically by a scheduled workflow (M6). They merge only when the full suite is green on x64 and arm64.
   - **Minor bumps** (3.7 → 3.8) are proposed only after the user confirms that their server and their desktop/mobile clients are on the new minor. They need a written ADR amendment and the user's approval.
   - **Automation never runs `joplin sync --upgrade`**, and never points a newer-`syncVersion` client at the user's server. The supervisor refuses to start if the CLI's `syncVersion` differs from the pin (M3).
4. **Rollback policy.**
   - **Images:** every release is an immutable image digest, so rolling back means redeploying the previous digest.
   - **Headless profile:** before a container starts a CLI whose version differs from the one recorded in the profile, the supervisor makes a **pre-upgrade snapshot** of the profile directory (a tarball in the data volume, last 3 kept). Rollback restores the snapshot. Alternatively, delete the profile: it is a cache of server data plus env-provided settings, so a re-sync rebuilds it.
   - **Browser profile (OPFS):** migrations are one-way.
     - Rolling the bundle back across a migration makes the app refuse its own database.
     - The runbook says: sync first, roll back, then "clear site data" and re-sync. What is lost: unsynced local edits, the local E2EE password cache and installed plugins, which the user reinstalls.
     - The service worker fetches network-first, so a redeployed bundle is picked up on the next online load.
   - **The user's Joplin Server is never upgraded or rolled back by this project.**

## Alternatives considered
- **Reuse upstream as-is: always build the latest `release-X.Y` head, as github.com/joplin/web-app does.** It's simple and stays fresh, but builds aren't reproducible: the same image tag can contain different code, there is no test gate before the user gets it, and it can jump minors unannounced when upstream creates `release-3.8`. Rejected, though we keep the same *source* (the release branch) and only add a pinned commit.
- **Pin the web bundle to an `android-v*` tag.** It is equivalent today (same app-mobile code, see Context), but the tag is created after the release-branch commit and sometimes lags. We record the equivalent Android tag in the bump PR description instead.
- **Use the `latest`/floating npm range for the CLI.** It is not reproducible, so rejected.
- **Pin the web bundle and CLI to the same commit by building the CLI from source too.** That gives exact parity, but it means building `app-cli` from the monorepo (which needs the same heavy install as S1) instead of consuming the published npm package. It violates "published interfaces first", so rejected.

## Consequences
- Bumps are explicit, reviewable PRs, and the user always knows exactly which upstream code they run.
- Web and CLI may differ by a few patches. Behavioural differences inside a minor are caught by the contract and E2E suites, not prevented.
- One extra check (`syncVersion`) guards the only failure mode that affects the user's other devices.

## Upgrade impact
This ADR *is* the upgrade policy. Each bump PR updates `upstream/joplin-version.json`, `yarn.lock` and the compatibility matrix (`docs/spikes/S5-compatibility-matrix.md`, later `docs/architecture/compatibility.md`).

## Verification
- **S5** (compatibility matrix) produced the `syncVersion` and migration evidence above.
- **M1-AC2 / M1-AC3:** pin-file schema and lockfile checks (unit).
- **M3-AC9:** the supervisor refuses a CLI whose `syncVersion` ≠ pin (integration, with a negative control).
- **M6-AC2:** the bump PR fails when the `syncVersion` constant changes (contract test against a patched fixture).
- **M5-AC9:** the rollback runbook is exercised once on the Pi (manual, recorded).
