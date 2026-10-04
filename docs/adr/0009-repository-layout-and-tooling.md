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
- **Dependencies:** licences must be AGPL-compatible. `check:licenses` runs `yarn licenses list` against an allow-list (MIT, ISC, BSD-2/3, Apache-2.0, MPL-2.0, AGPL/GPL/LGPL-3.0 family, CC0, 0BSD, BlueOak). Known needs:
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
