# ADR-0009: Repository layout and tooling

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`). Proposed in Phase A (2026-10-03).

## Context
- `CLAUDE.md` requires the same language and tooling as upstream: TypeScript, yarn 4 via corepack, Jest, Playwright, and eslint modelled on Joplin's.
- On `release-3.7` upstream declares `"packageManager": "yarn@4.16.0"` and `engines.node >= 22.12`, uses `nodeLinker: node-modules` and `npmMinimalAgeGate: 1w` (`upstream:.yarnrc.yml`), Jest 29 and Playwright 1.59.1 (`upstream:packages/app-desktop`).
- **Golden rule:** never copy upstream source into this repo.

## Decision
- **Yarn 4 workspaces through corepack** (`"packageManager": "yarn@4.16.0"`), `nodeLinker: node-modules` and `npmMinimalAgeGate: 1w`, as upstream does.
  - Node **22 LTS** in containers (upstream's `engines`).
  - The dev box's Node 24 is fine for tooling.
- **Layout and owners:**
  - The senior engineer owns `packages/**`, `deploy/**`, `upstream/**` and `patches/**`.
  - The ci-cd-specialist owns `.github/**`, `packaging/**`, the release tooling config and `docs/delivery/**`.
  - QA owns `tests/**`.
  ```
  upstream/joplin-version.json   single version pin (ADR-0005)
  patches/                       empty; README with the patch policy (justification + upstream PR link)
  packages/
    web-build/      scripts: build the pinned upstream bundle (CI), apply the overlay, verify, package the artifact
    web/            Containerfile + Caddyfile template for the `web` image (consumes the web-build artifact)
    data-api-client/ typed REST Data API client (fetch), with guards (no body on POST /notes); used by mcp, headless, tests
    mcp/            MCP server library (tools, sanitizer, auth) + stdio bin (works against a desktop Joplin too);
                    publishable on its own (npm/MCP Registry candidate, see docs/delivery/channels.md)
    headless/       supervisor: CLI child-process manager, SyncStrategy, /healthz, /status, hosts mcp over HTTP, opt-in Data API gateway; Containerfile
  deploy/           compose.yaml (podman + docker), .env.example, secrets examples, TLS examples
  .github/          CI, web-bundle, images, e2e, release, upstream-bump workflows (ci-cd-specialist)
  packaging/        channel manifests, e.g. MCP Registry server.json (ci-cd-specialist)
  tests/            QA-owned: unit mocks, integration, contract, e2e, fixtures, stack helpers
  docs/
  ```
- **Root scripts:**
  - `corepack yarn lint` (eslint + `tsc --noEmit`)
  - `test` (unit + integration)
  - `test:contract`
  - `test:e2e`
  - `build`
  - `check:pin` (pin schema, lockfile minor, `syncVersion`)
  - `check:no-upstream-copy`
- **Split between script and workflow.** The scripts above live in `packages/**` and run identically on the Pi and in CI. The workflows in `.github/**` only orchestrate them, so a pipeline never contains build logic that can't be run locally.
- **`check:no-upstream-copy`:** a CI script that hashes every tracked text file with a size of at least 1 KiB. It fails if any matches a file in the pinned upstream tree (computed in CI from a sparse clone at the pinned commit), or if a file carries upstream's license header with upstream's copyright line.
- **ESLint:** a flat config modelled on upstream's `eslint.config.js`, using the same plugins (`@typescript-eslint`, `@stylistic`, react-hooks where relevant). It adds `jest/no-focused-tests`, `jest/no-disabled-tests` and `playwright/no-skipped-test`, plus a `no-restricted-syntax` rule against `waitForTimeout`.
- **Dependencies:** licences must be AGPL-compatible. `check:licenses` runs `yarn licenses list` against an allow-list (MIT, ISC, BSD-2/3, Apache-2.0, MPL-2.0, AGPL/GPL/LGPL-3.0 family, CC0, 0BSD, BlueOak; Python-2.0, Unlicense, Zlib and CC-BY-4.0 added by A8). Known needs:
  - `@modelcontextprotocol/sdk` (MIT)
  - `execa` (MIT)
  - `zod` (MIT)
  - Caddy (Apache-2.0, in the image only)
  - `joplin` CLI (AGPL-3.0-or-later)

## Alternatives considered
- **Reuse upstream as-is (add our packages inside a laurent22/joplin checkout).** That's a fork in all but name, and every bump becomes a merge. Rejected by the golden rule.
- **npm workspaces / pnpm.** Both are fine tools, but they differ from upstream's tooling, and contributors who move between the repos would pay the switching cost. Rejected.
- **Separate repos per component.** That means more version coordination and duplicated CI for a three-component stack. Rejected.

## Consequences
- One lockfile pins the CLI and its transitive `@joplin/*` packages (ADR-0005).
- The heavy upstream monorepo never enters this repo. `packages/web-build` clones it into a CI workspace (or `~/joplin-web-app-work` locally) at build time.

## Upgrade impact
- A yarn version bump follows upstream's `packageManager` field in the same bump PR, but only when a newer yarn is needed.

## Verification
- M1-AC1 to M1-AC4 (scaffold, lint/test green on the Pi, pin checks, no-upstream-copy check with a negative control: a copied upstream file must fail the check).
- M1-AC23 (headless image build-script allow-list), M1-AC24 to M1-AC26 (licences, licence header, `headless` manifest pin).

## Amendments (2026-10-04, M1-S1 review)
These amendments record the architect's verdicts on the deviations in `docs/worklog/M1-S1.md`. The layout, owners and golden rules above are unchanged.
- **A1. Packages are created lazily: accepted.** A package is created by the first story that puts real code in it: `web` in M1-S4, `data-api-client` in M1-S5 (the internal REST client) or else M3, and `mcp` in M4-S1. An empty package would need placeholder tests, which M1-AC1 rules out. The layout tree above is the target, not a day-one requirement. M1-AC1 ("every package has at least one real unit test") applies to each package from the story that creates it.
- **A2. The repo-wide check scripts live in `packages/web-build`: accepted.** Pipeline-only tooling is the exception; see A7. `check:pin` and `check:no-upstream-copy` share the pin reader and the cached upstream fetch with the bundle build. M1-S9's checks go there too. If a later check needs dependencies the build scripts shouldn't carry (for example image inspection for `check:prepublish`), it may move to a private `tooling` workspace. That move needs no ADR change, because the scripts stay in `packages/**` and run identically on the Pi and in CI.
- **A3. A smaller ESLint plugin set than upstream: accepted, with these rules.**
  - Kept: upstream's parser, `@typescript-eslint`, `@stylistic` and `jest` rule choices, plus our test-hygiene rules.
  - `react-hooks` (upstream uses `@seiyab/eslint-plugin-react-hooks`) is added by the first story that adds React/TSX code. None is planned, since the web UI is upstream's bundle.
  - `import/prefer-default-export` is **rejected** for this repo: we use named exports.
  - `eslint-plugin-promise` and `eslint-plugin-github` are optional. Add them when they catch something real.
  - Upstream's own `joplin/*` rules are internal to upstream. Re-implementing them is out of scope, and copying them is forbidden.
  - The `() => void` type-arrow spacing (worklog item 4) is accepted, because it matches the committed acceptance suite.
- **A4. Install scripts stay off by default; `sqlite3` is allow-listed.** Yarn 4.16 doesn't run third-party build scripts unless told to. Upstream sets `enableScripts: true` (`upstream:.yarnrc.yml`, v3.7.21); we don't, for supply-chain safety. As a result `sqlite3@5.1.6` (needed by the CLI), `sharp` and `keytar` were not built.
  - The headless image installs from **this repo's `yarn.lock`** (a focused, immutable, production install of `packages/headless`). It runs install scripts for an explicit allow-list only, which today is `sqlite3`. The senior engineer picks the mechanism in M1-S5: a per-package yarn setting if yarn 4.16 honours one while `enableScripts` is off, otherwise one explicit Containerfile step that runs `sqlite3`'s own install for that package only. Either way it is recorded in the worklog.
  - **Rejected:** `npm install joplin@<version>` in the Containerfile (the spike S3 shortcut). npm would resolve its own transitive tree, so the image could run `@joplin/*` versions that `yarn.lock` and `check:pin` never saw (ADR-0005). Also rejected: turning on `enableScripts: true` globally, which would run every dependency's lifecycle scripts.
  - `sharp` and `keytar` stay unbuilt. If the CLI ever needs either at runtime, the M1-AC16 contract test will fail, and the package then joins the allow-list through an ADR amendment.
  - Verification: M1-AC23 (binding loads on arm64 and amd64; the installed versions equal the lockfile; NEG: a non-allow-listed `postinstall` doesn't run).
- **A5. `check:no-upstream-copy` hashes all tracked files of at least 1 KiB, binaries included:** accepted. This is stricter than "text file" and also catches copied upstream icons. The licence-header half of the check runs on files of any size and is scheduled as M1-AC25 (M1-S9).
- **A6. `check:licenses`.** Yarn 4 has no `yarn licenses` command (checked with yarn 4.16.0: `Couldn't find a script named "licenses"`). The check reads the `license` field of every installed manifest instead and compares it with the allow-list above, plus a reviewed exception list that carries reasons. Scheduled as M1-AC24 (M1-S9). The optional `check:pin` cross-check of the `headless` manifest's `joplin` dependency against `cli.version` is M1-AC26.
- **Root configuration files** (`jest.config.js`, `playwright.config.ts`, `eslint.config.js`, the tsconfigs) written by the senior engineer in M1-S1: accepted. QA may take over the Jest/Playwright harness config in M1-S6. The ownership table in `CLAUDE.md` is unchanged.

## Amendments (2026-10-04, M1-S3 review)
- **A7. Pipeline-only tooling may live in `.github/scripts/` (review M1-S3-r1, P1): accepted.** This narrows A2 and the "split between script and workflow" rule above; it doesn't replace them.
  - **Allowed in `.github/scripts/`:** tooling that only checks or reports on the pipeline itself. Today that is `check:workflows` (`workflowRules.ts`, `check-workflows.ts`, `pinnedTools.ts` with `pinned-tools.json`) and the CI report helpers (`junit-summary.ts`). The ci-cd specialist owns it, as it owns the `.github/**` files it checks, which avoids a cross-owner edit loop.
  - **Conditions (all binding):**
    - It runs through a root `corepack yarn` script, identically on the Pi and in CI. Workflows call that script and contain no logic of their own.
    - It is TypeScript under the same eslint config and type-checked by the root `lint` (today `tsc -p .github/scripts/tsconfig.json`).
    - It is covered by QA tests under `tests/**`, like any other check.
    - It imports nothing from `packages/**` and nothing in `packages/**` imports it.
  - **Stays in `packages/**`:** anything the build, the images, the product or the other repo checks use or share code with (`check:pin`, `check:no-upstream-copy`, `check:licenses`, `check:prepublish`, the bundle build, the overlay). If a pipeline script grows a second consumer outside the pipeline, it moves to `packages/**` (the private `tooling` workspace of A2) in that story.
  - **Forbidden triggers.** `check:workflows` bans `pull_request_target` and `workflow_run` outright (M1-AC31). Allowing one for a specific, reviewed workflow needs an amendment here that names the file and the reason.
  - Verification: M1-AC8 (QA's `check:workflows` suite), M1-AC30 to M1-AC33 (review M1-S3-r1 C1–C5), and `corepack yarn lint` covering `.github/scripts/*.ts`.

## Amendments (2026-10-04, M1-S9 test plan, findings F1 and Interpretations 4–5)
- **A8. Allow-list additions (F1): Python-2.0, Unlicense, Zlib, CC-BY-4.0.** The real tree has `argparse@2.0.1` (Python-2.0), `markdown-it-anchor@5.3.0` and `tweetnacl@0.14.5` (Unlicense), `pako@1.0.11` (`MIT AND Zlib`) and `caniuse-lite` (CC-BY-4.0).
  - **Rule for the allow-list (binding from now on).** An SPDX ID is allow-listed only through an amendment here, and only if the FSF licence list marks it compatible with GPLv3 **and** it is either permissive or GPL-family. Anything else (unusual IDs, `-exception` variants, unknown or missing licences) stays a per-package, exact-version exception with a reason.
  - All four meet the rule (FSF licence list, fetched 2026-10-04): Python "2.0.1, 2.1.1, and newer versions … is compatible with the GNU GPL" (the SPDX `Python-2.0` text is that licence stack); the Unlicense is a GPL-compatible public-domain dedication with a lax fallback licence; zlib "is a free software license, and compatible with the GPL"; CC BY 4.0 "is compatible with all versions of the GNU GPL".
  - **CC-BY-4.0 is allow-listed without a "data-only" restriction.** The FSF's advice that CC licences shouldn't be used for software is about style, not compatibility. A name-scoped restriction would be a third mechanism next to the allow-list and the exception list, and `caniuse-lite`'s weekly version churn makes an exact-version exception unworkable. Its attribution duty is met the same way as MIT's: by shipping the licence text and notice (M1-AC29 for the bundle, the M5 gate for images).
  - Not added: the older Python licences (1.6b1 to 2.1, GPL-incompatible per the FSF), `PSF-2.0`, `CC-BY-3.0` and other CC versions. None is in the tree today; if one appears, it is an exception first and an amendment only if it meets the rule.
- **A9. Legacy licence forms (Interpretation 5) are evaluated, not treated as missing.**
  - A legacy `licenses` array is read as the **OR** of its entries' `type` values. That is npm's documented meaning: the package.json docs replace the legacy array `[{"type":"MIT"},{"type":"Apache-2.0"}]` with `(MIT OR Apache-2.0)`. An entry may be an object with `type` or a plain string.
  - A legacy `license` object (`{"type": "MIT", "url": …}`) is read as its `type`.
  - The derived expression is then evaluated like a `license` field. If any entry has no usable `type`, the whole form counts as missing.
  - "Never silently passed" means **visible, not refused**: the listing line shows the derived expression with a `legacy` marker, and the `--report` `license` holds the derived expression.
  - Consequences: the four real cases (`exit@0.1.2`, `@joplin/fork-uslug@2.0.7`, `format@0.2.2`, `querystring@0.2.0`, all MIT) are `allowed`. A legacy form whose entries are all SSPL-1.0 is `denied`. A legacy `[MIT, SSPL-1.0]` is `allowed` through the OR, exactly as `(MIT OR SSPL-1.0)` would be.
- **A10. "Upstream's licence header" (check:no-upstream-copy, Interpretation 4): QA's definition is confirmed.**
  - The header is line 1 of `upstream:LICENSE` at `web.commit` ("All code in this repository is licensed under the AGPL-3.0-or-later License", upstream:LICENSE:1 at v3.7.21).
  - The copyright line is `Copyright (c) <years> <holder>`, with the holder taken from that file's `Copyright (c) …` line (upstream:LICENSE:29, Laurent Cozic) and **any** single year or range.
  - Upstream source files have no per-file header, so nothing narrower exists. Our own files must not reuse upstream's line-1 sentence; our AGPL header names this project and its own copyright holder.
- Verification: M1-AC24 and M1-AC25 as amended in `docs/backlog/M1.md` (M1-S9, amendments of 2026-10-04).
