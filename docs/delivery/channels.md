# Delivery channels: investigation and plan

Status: **Proposed** (Mode 1 investigation, 2026-10-04, ci-cd-specialist). The user approves it at the Phase A gate, together with the architecture. ADR-0006 defers the choice of channels to this document.

Scope: research only. Nothing has been registered, reserved, pushed or published. The availability checks (§5) used public, unauthenticated read APIs on 2026-10-04, and their results can change at any time.

---

## 0. Summary

- **Phase 1 (first public release):**
  - GitHub Releases (bundle tarball, checksums, SBOMs, source offer)
  - GHCR (`web`, `headless`)
  - npm (the MCP stdio package)
  - the official MCP Registry

  These four need **no long-lived secret**. The only exception is a one-time, short-lived npm bootstrap token (F4).
- **Phase 2:**
  - a Docker Hub mirror
  - MCP directories (Glama, awesome-mcp-servers)
  - an MCPB bundle for Claude Desktop
- **Phase 3 (on demand):** Umbrel (community store first), Helm chart, Unraid CA, TrueNAS, Docker MCP Catalog.
- **Skip:** CasaOS (for now), YunoHost, the Home Assistant add-on, and an npm package for the web UI.
- **Recommended public name:** **Notestead**, shown as "Notestead for Joplin (unofficial)". It is free on every registry checked (§5). The user decides.
- **Release gate:** a single `release.yml`. Builds run unprivileged, then **one** `publish` job runs in the `release` environment and needs the user's approval in GitHub (§8).

## 1. Findings that change the plan

| # | Finding | Consequence |
|---|---|---|
| F1 | **The GitHub repo already exists and is public.** `TheScriptingGuy/Joplin-Web-App` has one commit ("Initial commit") on `main`. Q5's recommendation ("keep the repo private until Q1") therefore doesn't describe today's state. The repo name also starts with "Joplin". | Decide the name, **rename the repo before the first push** (GitHub keeps redirects), then push. |
| F2 | **GitHub Free plus a private repo breaks the release design:** <ul><li>environments, and with them our `release` approval gate, can't be created in private repos on Free</li><li>artifact attestations in private repos need GitHub Enterprise Cloud</li><li>npm provenance "is not supported for private repositories"</li><li>arm64 runners in private repos have 2 vCPU and are billed against the 2,000 free minutes (public: 4 vCPU, free)</li></ul> | The repo must be **public** when we release. Developing in public from the first push is the simplest path and costs nothing (decision D3). |
| F3 | **Docker Hub OIDC exists** (announced 2026-07-31), but only for **organizations** on Team, Business or DHI, or enrolled in DSOS. A free personal namespace needs a long-lived PAT. | Docker Hub moves to Phase 2: either a PAT in the `release` environment, or an org via DSOS, which brings OIDC and removes rate limits. |
| F4 | **npm trusted publishing** (OIDC; npm ≥ 11.5.1, Node ≥ 22.14; GitHub-hosted runners only; automatic provenance) **can't make the first publish** of a new package name. | Do one bootstrap publish *through the workflow* with a 7-day granular token. Then add the trusted publisher, set "Require 2FA and disallow tokens", and revoke the token. |
| F5 | **Most self-hosting catalogs open apps at `http://<host>:<port>`.** That isn't a secure context, so OPFS, WebCrypto and service workers fail (ADR-0006). Several catalogs also can't express our `internal: true` backend network, which is the egress confinement of ADR-0006/0008. Only umbrelOS ≥ 2.0 (`requiresHttps: true`) addresses the first problem. | Catalogs move to Phase 3. Before any catalog work, the architect must decide whether a catalog may ship without the internal network. |
| F6 | **The official MCP Registry is in preview** ("breaking changes or data resets may occur"). Two Joplin MCP servers are already listed: `io.github.alondmnt/joplin-mcp` (PyPI) and `io.github.jordanburke/joplin-mcp-server` (npm). | List it anyway; it costs little. The listing should name what sets us apart: alarms (`todo_due`), sync, headless E2EE, and the file:// and permanent-delete guards. |

## 2. Artifacts and where they go

| Artifact (ADR-0006) | Built by | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|---|
| `web` image (Caddy, overlaid bundle) | `images.yml`, native amd64 and arm64 | GHCR | Docker Hub | Umbrel, Unraid, TrueNAS, Helm |
| `headless` image (supervisor, CLI, MCP over HTTP) | `images.yml`, native amd64 and arm64 | GHCR | Docker Hub | same as `web` |
| MCP stdio package (`packages/mcp`) | `release.yml` (`yarn pack` → `npm publish`) | npm, MCP Registry | MCPB on GitHub Releases, Glama | Docker MCP Catalog (needs a stdio image) |
| Web bundle tarball | `web-bundle.yml`, built once on x64 | GitHub Releases | | YunoHost or bare-metal users, if the community packages it |
| Checksums, SBOMs, source offer, signatures | `release.yml` | GitHub Releases, plus attached to the images | | |

---

## 3. Channel evaluations

### 3.1 GHCR (`ghcr.io`): Phase 1, primary image registry

| Aspect | Assessment |
|---|---|
| Audience and value | Anyone with docker or podman, including the user's Pi. Images are linked to the repo (README, releases). No pull rate limit is documented for public images. |
| Artifact | `web` and `headless` multi-arch indexes, plus BuildKit SBOM/provenance attestations, cosign signatures and GitHub attestations |
| Namespace | `ghcr.io/thescriptingguy/<name>-web` and `…/<name>-headless`. The namespace is the GitHub user, in lowercase, so there's nothing to register. |
| Auth | `GITHUB_TOKEN` with `packages: write`, in the `publish` job only. **No stored secret.** |
| Provenance, SBOM, signing | <ul><li>BuildKit `sbom` and `provenance` attestations in the index</li><li>`cosign sign` (keyless), with the certificate bound to `…/.github/workflows/release.yml@refs/heads/main`</li><li>`actions/attest` with `push-to-registry`: SLSA v1.0 Build L2, a Sigstore bundle, verifiable with `gh attestation verify oci://…`</li></ul> |
| Multi-arch | Yes. Each arch is built natively and then merged into an OCI index. |
| Limits and costs | Free for public packages. **A new package under a user account starts private.** Making it public is a one-time setting and **irreversible**; it's an action that needs approval (§10). |
| Trademark and licence | Our name in the image and package names. The `org.opencontainers.image.source` label links the package to the repo. `LICENSE` and third-party notices sit inside the image. |
| Maintenance | Low. Only release tags are pushed, never PR or edge builds. |

### 3.2 Docker Hub: Phase 2 mirror

| Aspect | Assessment |
|---|---|
| Audience and value | Docker Hub is the default registry for `docker pull` and for Unraid, CasaOS and TrueNAS templates, and it's searchable. |
| Artifact | The same images as GHCR, copied by digest, so both registries serve identical digests. |
| Namespace | The personal namespace `thescriptingguy` **exists** (joined 2021-12-08, no public repos); the user should confirm it's theirs. Org namespaces for all the name candidates are free (§5). Creating a new org needs a paid Team subscription unless DSOS grants one. |
| Auth | <ul><li>**OIDC** (`docker/login-action` ≥ v4.5.0 with `DOCKERHUB_OIDC_CONNECTIONID`, no secret) is only available for orgs on Team, Business or DHI, or in DSOS.</li><li>**Free personal account:** a PAT with Read & Write, stored as a `release` environment secret, with an expiry date. Personal PATs can't be scoped to a single repo; repo-scoped tokens (OATs) are org-only.</li><li>Repo descriptions are set by hand in the web UI (Mode 2), because API updates would need a broader token.</li></ul> |
| Provenance, SBOM, signing | Same as GHCR. Docker Hub stores OCI indexes with attestation manifests and cosign signatures. |
| Multi-arch | Yes. |
| Limits and costs | <ul><li>A free personal account can have unlimited public repos.</li><li>Consumer pulls: **unauthenticated 100 per 6 h per IPv4 address or IPv6 /64**, authenticated free accounts 200 per 6 h.</li><li>DSOS removes the limits for us and for everyone who pulls our images. DSOS requires a public, OSI-licensed, actively developed, non-commercial project; membership lasts one year and is renewable.</li></ul> |
| Trademark and licence | Repo names `<name>-web`/`<name>-headless`. The overview must carry the "unofficial, not affiliated" notice. Never use the upstream logo as the avatar. |
| Maintenance | Low to medium: PAT rotation, a description edited by hand, one extra copy step. |
| Verdict | **Phase 2.** It moves into Phase 1 only if the user accepts a PAT. In the long term, apply to DSOS with an org namespace: that brings OIDC, removes the stored secret and lifts the rate limits. |

### 3.3 npm: Phase 1, the MCP stdio package

| Aspect | Assessment |
|---|---|
| Audience and value | **The largest audience.** Desktop Joplin users with AI clients (Claude Desktop or Code, VS Code, Cursor, …) can run `npx -y <name>-mcp` against the desktop Data API (the Web Clipper service) or against our headless gateway (ADR-0004). No containers needed. |
| Artifact | <ul><li>`packages/mcp`, packed with `corepack yarn pack`, which rewrites `workspace:` dependencies</li><li>published as that tarball with npm ≥ 11.5.1</li><li>the tarball must contain `LICENSE`, `bin`, `mcpName`, and a `repository.url` that **exactly** matches the GitHub repo (provenance checks it)</li></ul> |
| Name | <ul><li>`<name>` and `<name>-mcp` are unpublished for all five candidates.</li><li>The scopes `@<candidate>` are unclaimed.</li><li>An npm user or scope `thescriptingguy` exists; the user should confirm it's theirs.</li></ul> |
| Auth | **Trusted publishing (OIDC):** `id-token: write` on a GitHub-hosted runner, with the publisher bound to `release.yml` and the `release` environment. The **first publish needs a bootstrap token** (F4). Afterwards, set "Require 2FA and disallow tokens". Keep `npm publish` in `release.yml` itself, not in a reusable workflow, so the workflow claim npm checks is unambiguous. |
| Provenance, SBOM, signing | Provenance is automatic with trusted publishing (public repo only). Consumers check it with `npm audit signatures`. The SBOM (`npm sbom` or syft, SPDX) is a release asset. |
| Multi-arch | Architecture-neutral: plain JS with no native dependencies. The release smoke test runs `npx` on both arches (M5-AC10). |
| Limits and costs | Free for public packages. |
| Trademark and licence | The name may not start with "joplin" (M5-AC1 d). The keywords `joplin` and `mcp` are fine (nominative use). The description carries the notice. The tarball contains `LICENSE`; the source is the repo at the tag. |
| Maintenance | Low after the bootstrap. |

**A web-UI package on npm makes no sense:**
- The bundle needs a server: same-origin proxy, COOP/COEP headers and the internal sync path. That server *is* the `web` image.
- Republishing upstream's compiled app under our npm name adds trademark exposure and AGPL §6 surface, and it reaches no audience that the tarball or the image doesn't serve better.

**A headless package on npm:** no. It would lose the `internal` network egress confinement (ADR-0006).

**A small `npx <name> init` CLI** that writes `compose.yaml` plus secret files is a possible Phase 3 idea. It isn't planned.

### 3.4 GitHub Releases: Phase 1

| Aspect | Assessment |
|---|---|
| Audience and value | Users who run their own web server and want the static bundle; auditors; everyone who wants the changelog, the source offer or the verification material. Also a feed for future catalogs and the Helm chart. |
| Artifacts | <ul><li>`<name>-web-bundle-X.Y.Z-joplin<webtag>.tar.gz`: the overlaid `dist/`, `source.html`, third-party notices, `LICENSE`</li><li>`SHA256SUMS` plus its Sigstore bundle</li><li>SPDX SBOMs for the bundle, both images and the npm package</li><li>`SOURCE.md`, the AGPL §13/§6 offer: our commit, the upstream commit and tag, `patches/`, the build recipe</li><li>`joplin-version.json`</li><li>later: `<name>-mcp.mcpb`</li></ul> |
| Auth | `GITHUB_TOKEN` with `contents: write`. No stored secret. |
| Provenance and signing | <ul><li>`actions/attest` on the tarball; verify with `gh attestation verify <file> -R TheScriptingGuy/<name>`</li><li>`cosign sign-blob` on `SHA256SUMS`</li><li>**Immutable releases** (GA 2025-10-28): assets and tags are locked once published, and GitHub signs a release attestation</li></ul> |
| Multi-arch | Architecture-neutral (S1). |
| Limits and costs | Free. Each asset must be under 2 GiB; the bundle is about 29 MB. |
| Trademark and licence | The release title and notes use our name and the notice. The tarball redistributes upstream's compiled code, so the §6 source must come with it: the exact upstream commit, our tag, and the build recipe. Whether a link to upstream's GitHub is enough under §6(d) is a judgement call for the user; the conservative add-on is a written offer to provide the source on request. |
| Maintenance | Low; release-please automates it. With immutable releases the order must be **draft → upload assets → publish**. |

### 3.5 Official MCP Registry: Phase 1, published in the same job as npm

| Aspect | Assessment |
|---|---|
| Audience and value | MCP clients, and directories that ingest the registry. It also makes us discoverable next to the two existing Joplin entries. |
| Artifact | `packaging/mcp/server.json` (schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`). It holds metadata only and points to the npm package (`registryType: npm`, `transport: stdio`); MCPB comes later. **The headless image is not listed:** its MCP is streamable HTTP at a URL that differs per user. `remotes` are for fixed hosted endpoints, and OCI packages are for stdio containers. |
| Name | `io.github.thescriptingguy/<name>`. No entries exist for any candidate. All the `io.github.*` names observed are lowercase; we confirm this at the first publish. |
| Auth | `mcp-publisher login github-oidc` with `id-token: write`. GitHub OIDC grants the namespace of the repo owner. **No secret.** Pin the `mcp-publisher` release and its sha256; never download `latest`. |
| Verification | `package.json` `mcpName` must equal the server name, and the npm version must already exist, so **npm is published first.** |
| Provenance | The registry doesn't sign entries; trust comes from the npm provenance. |
| Limits | It's in preview, so data resets are possible. Versions are immutable; never reuse one. |
| Trademark | `title` "<Name> for Joplin (unofficial)", with the notice in the description. The name must not be `…/joplin…`. |
| Maintenance | Low: one step after npm. release-please keeps `version` in sync (an `extra-files` entry). |

### 3.6 Other MCP directories

| Directory | How a server gets listed | Value | Verdict |
|---|---|---|---|
| Glama (glama.ai/mcp/servers) | Indexes public GitHub MCP repos automatically. A `glama.json` (maintainers) at the repo root claims the listing. | Medium: a large catalogue with quality scores | **Phase 2** (one file) |
| awesome-mcp-servers (punkpeye) | A one-line PR from the user's fork | Medium: widely read | **Phase 2** |
| MCPB bundle (Claude Desktop one-click) | A `.mcpb` release asset plus a second package in `server.json` (`registryType: mcpb`, URL containing "mcp", `fileSha256`) | Medium: desktop users without Node tooling | **Phase 2** (optional) |
| Docker MCP Catalog (`docker/mcp-registry`) | A PR with the server definition. Docker builds and signs the image for MCP Toolkit. | Medium | **Phase 3**: needs a separate stdio container image, a third image |
| Aggregators that follow the official registry or GitHub | Pick us up automatically | Low effort | No action |
| Smithery | Centred on hosted or remote servers | Low: our data is local or self-hosted | **Skip** |

### 3.7 Self-hosting catalogs

The common issues are F5: the secure context and the internal network. A further problem: catalog users need an existing self-hosted Joplin Server (L10). TrueNAS already lists a `joplin` app in its community train, so its audience overlaps with ours; Umbrel and CasaOS have no Joplin app.

| Catalog | Packaging | Secure context (HTTPS) | `internal` backend network | Arch | Submission and review | Burden | Verdict |
|---|---|---|---|---|---|---|---|
| **Umbrel** (umbrelOS) | `umbrel-app.yml` + compose + `app_proxy` | Yes: `requiresHttps: true` (umbrelOS ≥ 2.0). Certificate trust on phones needs a spike. | **No.** "Do not add a top-level `networks:` block for ordinary packages"; the shared network is treated as untrusted. | amd64 + arm64 **required** | A PR to `getumbrel/umbrel-apps`, reviewed by the Umbrel team, who host the icon and gallery. Community app stores are a self-hosted alternative. | Medium | **Phase 3**: community store first, after the architect's network decision |
| **Unraid** Community Apps | XML template per container, in a templates repo, with a forum support thread | No: HTTP unless the user runs a reverse proxy (SWAG/NPM are common) | Manual: the user creates the network | amd64 (Unraid is x86) | CA moderators | Medium (two templates, user setup) | **Phase 3**, on demand |
| **TrueNAS** (CE ≥ 24.10) | A compose-based catalog `truenas/apps`, community train, their templating library | No by default (HTTP app port) | Possible in compose; the template library decides | amd64 only | A PR to `truenas/apps` | Medium to high (their library, their CI) | **Phase 3**, on demand |
| **CasaOS** | compose with `x-casaos` metadata | No: `http://casaos.local:<port>` | Possible in compose | amd64 + arm64 | A PR to `IceWhaleTech/CasaOS-AppStore` | Medium | **Skip for now**: no HTTPS, so the UI is broken by default |
| **YunoHost** | Native packaging (bash scripts, no Docker) in the `YunoHost-Apps` org | Yes (Let's Encrypt, SSO) | Not applicable: no containers, so the egress confinement is lost | any | Catalogue PR plus a package repo | **High**: re-implements the deployment | **Skip**. A community packager could use the release tarball. |
| **Home Assistant add-on** | One container per add-on (Supervisor), served through ingress | Through HA, but **ingress loads the UI in an iframe** inside HA's frontend. Cross-origin isolation (COOP/COEP) and the service worker scope there are a probable blocker (needs a spike). | Two containers don't map onto one add-on | aarch64 + amd64 | Our own add-on repository | High | **Skip** (an MCP-only add-on could be revisited later) |

### 3.8 Helm chart: Phase 3, on demand

| Aspect | Assessment |
|---|---|
| Audience and value | Kubernetes homelabs (k3s on Pi clusters, for example). |
| Artifact | `packaging/helm/<name>`: two Deployments, Services, Secrets, a PVC, and a **NetworkPolicy** that recreates the `internal` network (egress from headless only to `web:8089`). That policy only works on a CNI that enforces NetworkPolicy; k3s's embedded controller does. |
| Distribution | An OCI chart on GHCR (`helm push oci://ghcr.io/thescriptingguy/charts`), signed with cosign, optionally listed on Artifact Hub (which needs an account). |
| Auth | `GITHUB_TOKEN` (`packages: write`). No secret. |
| Multi-arch | The chart is architecture-neutral; the images are multi-arch. |
| Maintenance | Medium: chart tests in CI (kind plus chart-testing), and a stable values API. |
| Verdict | **Phase 3**, only if users ask for it. |

## 4. Channel matrix

| Channel | Artifact | Auth | Stored secret | Phase |
|---|---|---|---|---|
| GitHub Releases | bundle tarball, `SHA256SUMS`, SBOMs, source offer, signatures | `GITHUB_TOKEN` | none | **1** |
| GHCR | `web`, `headless` | `GITHUB_TOKEN` + OIDC (cosign, attest) | none | **1** |
| npm | `<name>-mcp` | trusted publishing (OIDC) | a 7-day bootstrap token, deleted after first use | **1** |
| MCP Registry | `server.json` → npm | GitHub OIDC | none | **1** |
| Docker Hub | `web`, `headless` | PAT, or OIDC with a DSOS org | PAT (personal route) or none | 2 |
| Glama, awesome list, MCPB | listings, `.mcpb` | repo files, PRs | none | 2 |
| Umbrel, Unraid, TrueNAS, Helm, Docker MCP Catalog | templates, chart | PRs, `GITHUB_TOKEN` | none | 3 |
| CasaOS, YunoHost, HA add-on, web-UI npm package | n/a | n/a | n/a | skip |

---

## 5. Public name (Q1): candidates and availability

The name may not start with "Joplin" (ADR-0010, M5-AC1 d). Listings show it as "**<Name> for Joplin (unofficial)**".

Availability was checked read-only on 2026-10-04. "free" means 404 / not found; "–" means not checked.
- **npm:** `registry.npmjs.org/<n>` and `/<n>-mcp`; the scope through `-/org/<n>/package`.
- **Docker Hub:** `hub.docker.com/v2/users|orgs/<n>`.
- **GitHub:** `api.github.com/users/<n>` (a user or org of that name) and `/repos/TheScriptingGuy/<n>`.
- **MCP Registry:** `/v0/servers?search=<n>`.
- **Web:** a general web search for apps or software with that name.

| Candidate | npm `<n>` / `<n>-mcp` / `@<n>` | Docker Hub `<n>` | GitHub user/org `<n>` | Repo `TheScriptingGuy/<n>` | MCP Registry | Web search | Notes |
|---|---|---|---|---|---|---|---|
| **Notestead** (recommended) | free / free / free | free | free | free | none | no software found | "homestead for your notes": says self-hosted, short, easy to spell |
| Jotstead | free / free / free | free | free | free | none | – | a variant of the above |
| Notewharf | free / free / free | free | free | free | none | – | "where notes dock": the sync and bridge idea |
| Paperstead | free / free / free | free | free | free | none | no exact match | near "PaperPort" (Tungsten); low risk |
| Leafdesk | free / free / free | free | free | free | none | no exact match | near "PaperDesk" (iPad app); low risk |

**Dropped:**
- Notefold: the iOS notes app "Note Fold" is in the same class of product.
- Noteport: too close to PaperPort.
- Cahier, Carnet, Syncopa and Inkstead: taken on npm, Docker Hub or GitHub.
- Notehaven and Notecove: the GitHub handle is taken.

**This is not a trademark clearance.** Before deciding, the user should search EUIPO TMview or the WIPO Global Brand Database (classes 9 and 42). Q1 also recommends a courtesy email to JOPLIN SAS.

How the recommended name maps onto each channel (it works the same for any candidate):

| Where | Value |
|---|---|
| GitHub repo | `TheScriptingGuy/notestead` (renamed from `Joplin-Web-App`) |
| Images | `ghcr.io/thescriptingguy/notestead-web`, `…/notestead-headless`. Docker Hub (Phase 2): `thescriptingguy/notestead-web`, or `notestead/web` with a DSOS org. |
| npm | `notestead-mcp` (unscoped, the shortest `npx`). Option: reserve the free npm org `@notestead` for later packages. |
| MCP Registry | `io.github.thescriptingguy/notestead`, title "Notestead for Joplin (unofficial)" |
| Release assets | `notestead-web-bundle-0.1.0-joplin3.7.21.tar.gz` |
| OCI label prefix | `io.github.thescriptingguy.notestead.` |

## 6. Versioning and tagging (aligned with ADR-0005 and ADR-0006)

**One lockstep semver for the whole repo.** Every artifact of a release shares `X.Y.Z`, and the git tag is `vX.Y.Z`. Upstream versions never enter our version number; they go into labels and suffixes.

| Change | Bump (0.x / ≥ 1.0) |
|---|---|
| Upstream **patch** bump within the pinned minor (M6 bump PR), or our own fixes | PATCH / PATCH |
| A compatible feature (a new MCP tool, a new option) | MINOR / MINOR |
| A **Joplin minor upgrade** (3.7 → 3.8; the user must move their server and clients too, per ADR-0005), or a breaking change to compose, env or config | MINOR / **MAJOR** |

*Proposed amendment to ADR-0006 (architect):* with this rule, a user who floats on `X` never silently changes Joplin minor.

**Image tags** (GHCR, and Docker Hub in Phase 2). Stable releases only; release candidates get just the exact tag.

| Tag | Moves | Example | Purpose |
|---|---|---|---|
| `X.Y.Z` | never | `0.3.1` | exact version (pin a digest for full immutability) |
| `X.Y.Z-joplin<minor>` | never | `0.3.1-joplin3.7` | exact version, plus the Joplin minor visible (ADR-0006). Renovate treats the suffix as a compatibility marker and only proposes updates with the same suffix. |
| `X.Y` | yes | `0.3` | receive patches |
| `X` | yes (≥ 1.0 only) | `1` | receive minors |
| `joplin<minor>` | yes | `joplin3.7` | "the newest release for my Joplin minor": for users whose server and clients must stay on that minor |
| `latest` | yes | | newest stable |
| `X.Y.Z-rc.N` | never | `0.1.0-rc.1` | pre-release; GHCR only, never floating |

**OCI labels** (built from `upstream/joplin-version.json` and git):
- `org.opencontainers.image.{version, revision, source, licenses=AGPL-3.0-or-later, title, description, url, created}`
- `<prefix>joplin.web-ref` (commit), `<prefix>joplin.web-tag` (`v3.7.21`), `<prefix>joplin.cli-version` (`3.7.1`), `<prefix>joplin.minor` (`3.7`), `<prefix>joplin.server-tested` (`3.7.2`), `<prefix>joplin.sync-version` (`3`)

**npm and the registry:**
- npm dist-tag `latest` for stable releases, `next` for `-rc.N`.
- `server.json` `version` = `X.Y.Z`.
- The README states the Joplin versions it was tested with.

**Release notes** always carry one line naming the upstream versions, for example: "Upstream: web `v3.7.21` (`e41516e66`), CLI `3.7.1`, tested with `joplin/server:3.7.2`, syncVersion 3".

**Rules:**
- Never re-tag or re-publish an exact version.
- A fix is a new PATCH.
- Rollbacks use digests (ADR-0005).

## 7. Phased rollout

| Phase | Contents | Entry criteria | Exit criteria |
|---|---|---|---|
| **0: Private-to-public groundwork** | The name is decided, the repo is renamed, the first push (D3), repo settings (§10, steps 4–9). `ci.yml`, `web-bundle.yml` and `e2e.yml` run on PRs; **nothing is published.** Local dry runs: `actionlint`, `npm pack`, `podman build` for arm64. | Plan approved (`plan-approved-v1`); Q1 and Q5 answered | M1-AC8, M1-AC9 and M1-AC22 green on x64 and arm64 |
| **1a: Release candidate** | `v0.1.0-rc.1` → GHCR (exact tag only) plus a GitHub **pre-release** | M5-S1 gate green (§9); `release` environment configured | M5-AC10 smoke green on both arches; the user's real-server smoke test M5-S6 passes **with these exact digests** |
| **1b: First stable release** | `v0.1.0` → GitHub Release, GHCR (all tags), npm (bootstrap, then trusted publishing), MCP Registry | 1a done; the user approves the `release` run | Smoke green; the trusted publisher is set and tokens are disallowed; the bootstrap token is revoked and its secret deleted |
| **2: Reach** | Docker Hub mirror (PAT route, or apply to DSOS), Glama, an awesome-mcp-servers PR, optionally MCPB | About two weeks of stable 1b without critical issues | Docker Hub digests equal GHCR's; listings carry the notice |
| **3: Ecosystems, on demand** | Umbrel (community store), Helm, Unraid, TrueNAS, Docker MCP Catalog | A user request, plus the architect's decision on the network model (F5) | Per-catalog smoke test |

## 8. Release workflow outline (story IDs from the backlog)

| Workflow | Story / AC | Triggers | Runners | Permissions (job level) | Secrets / environment |
|---|---|---|---|---|---|
| `ci.yml` | M1-S3 (AC8, AC9); contract suites from M1–M4 | `pull_request`, `push: main`, `workflow_dispatch` | `ubuntu-24.04`, `ubuntu-24.04-arm` | `contents: read` | none. Fork PRs never get secrets; there is no `pull_request_target`. |
| `web-bundle.yml` | M1-S3; reused by e2e and release | `workflow_call`, plus `pull_request` on changes to the pin or `packages/web-build/**` | x64 only | `contents: read` | none. The cache key is the hash of the pin plus `web-build`; **release builds don't restore the cache**. |
| `e2e.yml` | M1-S8 (AC22), M2/M4 E2E | `pull_request`, `workflow_call` | both arches | `contents: read` | none; traces and logs are uploaded on failure |
| `images.yml` | M5-S2 (AC4, AC5) | `workflow_call` (release), plus `pull_request` on `deploy/**` / Containerfiles (build only, never push) | native amd64 and arm64 | `contents: read` | none. Outputs per-arch **OCI archives** as artifacts and runs the inspect gate (non-root, read-only rootfs, secret scan, upstream-icon scan). |
| `release.yml` | M5-S3 (AC6, AC7), M5-S1 gate, M5-S5 smoke | `push: main` (release-please), `workflow_dispatch` (re-run publish) | as below | per job, below | the `release` environment |
| `upstream-bump.yml` | M6-S1, M6-S2 (AC1–AC5) | `schedule` (daily), `workflow_dispatch` | x64, then both arches via the reusable suites | `contents: write`, `pull-requests: write`, `issues: write` | none |

**`release.yml` job graph:**
```
release-please        contents: write, pull-requests: write   → opens or updates the release PR; on merge:
                                                                 creates a DRAFT release and the tag vX.Y.Z (force-tag-creation)
  └─ if release_created:
     build-bundle      contents: read   (uses web-bundle.yml, fresh build, no cache restore)
     build-images[amd64|arm64]  contents: read   (uses images.yml → OCI archives + BuildKit SBOM/provenance)
     pack-mcp          contents: read   (corepack yarn pack → tgz, npm pack --dry-run listing)
     prepublish-gate   contents: read   (check:prepublish on all 4 artifacts, M5-AC1/AC2; SBOMs via syft)
       └─ publish      environment: release (USER APPROVAL)
                       contents: write, packages: write, id-token: write, attestations: write
                       1. push per-arch images by digest → GHCR, create the index, apply the tags (§6)
                       2. cosign sign (keyless) + actions/attest (push-to-registry) for each index
                       3. upload bundle, SHA256SUMS (+ sigstore bundle), SBOMs, SOURCE.md → draft release; attest the tarball
                       4. npm publish <tgz> --access public   (trusted publishing → automatic provenance)
                       5. mcp-publisher login github-oidc && mcp-publisher publish packaging/mcp/server.json
                       6. publish the draft release (immutable from here on)
         └─ smoke[amd64|arm64]  contents: read, packages: read   (QA: tests/release/**, M5-AC10)
```

**Why this shape:**
- Untrusted dependency code (`yarn install` of the upstream monorepo, our own build) never runs with write tokens.
- The privileged job only pushes bytes that were already built and gated.
- The user approves **once**, after seeing the build and the gate go green.
- Phase 2 adds a Docker Hub copy step to `publish`: `docker/login-action`, then copy by digest.

**Controls in every workflow:**
- Third-party actions are pinned by commit SHA with a version comment. `check:workflows` runs actionlint plus a SHA-pin check (M1-AC8).
- The top level sets `permissions: {}`; each job grants the least it needs.
- No `pull_request_target`. No secrets in `pull_request` jobs. `concurrency: release`, with no cancel.
- Masking: never `echo` an env value; `set +x` around authentication steps; `add-mask` for derived values.
- Pinned tool binaries (`mcp-publisher`, `actionlint`, `cosign`, `syft`) are verified by sha256.
- Dependabot updates `github-actions` (SHA pins) and npm, but **ignores `joplin` and `@joplin/*`**; M6 owns those.
- No self-hosted runner. If one is ever added, fork PRs never run on it.

**Pull requests created by `GITHUB_TOKEN`** (the release-please PR, M6 bump PRs) **don't trigger workflows.** Resolution without a stored credential:
- The release PR only changes versions and the changelog, and `release.yml` rebuilds and re-tests everything before `publish`.
- `upstream-bump.yml` runs the reusable suites on the bump branch itself and writes the results and the snapshot diffs into the PR body (M6-AC3).
- If that proves awkward, a GitHub App installed on this repo only (decision D6) makes PR checks run normally.

**Repo settings the workflows rely on** (applied in Mode 2):
- default `GITHUB_TOKEN` read-only
- "Allow GitHub Actions to create and approve pull requests" **on** (release-please and the bump PRs)
- fork-PR runs need approval for all external contributors
- the `release` environment: required reviewer TheScriptingGuy, deployment branch `main`, "Prevent self-review" **off** (the user is the sole maintainer and triggers the run by merging)
- immutable releases on
- `main` ruleset: no force push, no deletion
- secret-scanning push protection on

## 9. Pre-publish checklist (must pass before the first public release on any channel)

| Item | Evidence or test |
|---|---|
| The public name is decided, isn't a bare "Joplin…", and is recorded in the ARCHITECTURE decision log | M5-AC3, M5-AC1 (d) |
| Repo renamed; README title changed (it currently reads "Joplin Web App (unofficial)") | review |
| No upstream icon hash in the `web` image, `headless` image, npm tarball or bundle tarball | M5-AC1 (a), M2-AC11 |
| `LICENSE` (AGPL-3.0-or-later) and third-party notices in both images and in the npm tarball | M5-AC1 (b) |
| `source.html` / `/source`, `SOURCE.md` and the OCI `source`/`revision` labels name the exact commits, the upstream ref and `patches/` | M5-AC2, M2-AC12 |
| The "unofficial, not affiliated with Joplin / JOPLIN SAS" notice in the README, npm description and README, `server.json`, release notes, and (Phase 2) the Docker Hub overview | M5-AC1 (c), plus a manual listing review |
| Images run as non-root with a read-only rootfs and contain no secrets (secret scan of the image filesystem) | M5-AC4 |
| MCP is off or secured by default: not published through `web` unless `MCP_PUBLIC=true`; bearer token required; Origin checks | ADR-0008, M4-AC2 |
| Signatures and attestations verify; the `SHA256SUMS` signature verifies | M5-AC5 |
| QA's release smoke tests are green on amd64 and arm64 | M5-AC10 |
| The repo is public; the `release` environment and immutable releases are on | §10 |

## 10. Account actions for the user

"Mode 2" means I drive the user's visible Chromium with Playwright. Each outward-facing step needs approval and ends in a `## HANDOFF` whenever a login, 2FA or a secret is involved. **Secrets are only ever typed by the user, directly into the provider's form or GitHub's.** I verify that a secret exists by its name only.

| # | When | Action | Where | Who | Credential handling | Mode 2? |
|---|---|---|---|---|---|---|
| 1 | Gate | Decide: the name (§5), the channel plan (§7), public repo (D3), the versioning rule (§6), release-please (D5) | chat | user | none | no |
| 2 | Gate (Q1 recommends it) | Courtesy email to JOPLIN SAS | email | user | none | no |
| 3 | Phase 0 | Confirm that Docker Hub `thescriptingguy` and npm `thescriptingguy` are the user's. Make sure 2FA (security key or TOTP) is on for GitHub, npm and Docker Hub. | provider sites | user | 2FA codes never go into the chat | no |
| 4 | Phase 0 | Rename the repo `Joplin-Web-App` → `<name>`; set the description and topics with the unofficial notice | github.com/TheScriptingGuy/Joplin-Web-App/settings | me, after approval | the user logs in if prompted | **yes** |
| 5 | Phase 0 | Push credentials on the Pi (there's no `gh`): an SSH ed25519 key whose *public* key goes into GitHub → SSH keys (recommended), or a fine-grained PAT entered by the user into a git credential helper | Pi terminal, github.com/settings/keys | user (I can open the page) | the private key or PAT never leaves the user's hands | partly |
| 6 | Phase 0 | Approve the first push (the orchestrator pushes) | chat | user | none | no |
| 7 | Phase 0 | Actions settings (§8): allowed actions, read-only token, PR creation on, fork approval | repo → Settings → Actions | me, after approval | none | **yes** |
| 8 | Phase 0 | Rulesets: on `main`, no force push and no deletion; on `v*` tags, no update or deletion | repo → Settings → Rules | me, after approval | none | **yes** |
| 9 | Phase 0 | Security: secret-scanning push protection, Dependabot alerts, private vulnerability reporting | repo → Settings → Security | me, after approval | none | **yes** |
| 10 | Before 1a | Create the `release` environment (reviewer TheScriptingGuy, branch `main`, self-review allowed); turn on immutable releases | repo → Settings → Environments / General | me, after approval | none | **yes** |
| 11 | Before 1b | **npm bootstrap token:** a granular token with packages read and write, a 7-day expiry, and 2FA bypass for CI if npm requires it. The user pastes it into the `release` environment secret `NPM_BOOTSTRAP_TOKEN`. | npmjs.com → Access Tokens; repo → Environments → release | **user** (I open both pages and hand off *before* the token is shown) | the value goes only from npm into GitHub | navigation only |
| 12 | 1a / 1b | Approve each `release` run in GitHub (the "Review deployments" button) | Actions run page | **user** | none | no |
| 13 | After the first GHCR push | Set both container packages to **public** (irreversible) and link them to the repo | github.com/users/TheScriptingGuy/packages | me, after approval | none | **yes** |
| 14 | After 1b | npm package settings: add a trusted publisher (GitHub Actions, `TheScriptingGuy/<name>`, `release.yml`, environment `release`); then publishing access → "Require 2FA and disallow tokens" | npmjs.com/package/<name>-mcp/access | me, after approval; the user completes 2FA | 2FA by the user | **yes** |
| 15 | After 1b | Revoke the bootstrap token (user); delete the secret `NPM_BOOTSTRAP_TOKEN` (me, by name) | npm tokens page; repo → Environments | user + me | none shown | **yes** (the delete) |
| 16 | 1b | MCP Registry: nothing to create (GitHub OIDC); check the listing after publishing | registry.modelcontextprotocol.io | me (read-only) | none | no |
| 17 | Phase 2 | Docker Hub, **personal route:** create the public repos `<name>-web` and `<name>-headless` with the overview text. The user creates a PAT (Read & Write, with an expiry) and pastes it into the `release` secret `DOCKERHUB_TOKEN`; I add the *variable* `DOCKERHUB_USERNAME`. | hub.docker.com; repo → Environments | me (repos) + user (PAT) | the PAT value only from Docker into GitHub | **yes** (repos) |
| 17' | Phase 2 | Docker Hub, **DSOS route** (alternative): the user applies for DSOS with an org `<name>`. Once approved: an OIDC connection with a ruleset bound to `repo:TheScriptingGuy/<name>`, and the connection ID stored as a variable (not a secret). | docker.com DSOS form; Docker Admin Console | user (application) + me (connection setup) | none stored | **yes** (setup) |
| 18 | Phase 2 | Glama claim (`glama.json` in the repo; the user signs in to Glama with GitHub); an awesome-mcp-servers PR from the user's fork | glama.ai; github.com/punkpeye/awesome-mcp-servers | me, after approval | the user's GitHub login | **yes** |
| 19 | Phase 3 | Per catalog: a fork and PR, an Unraid forum account, an Artifact Hub account (Helm) | per catalog | user + me | per catalog | **yes** |
| 20 | After every Mode 2 session | Offer to log out of the providers in the Playwright browser profile (logins otherwise persist) | browser | user decides | none | yes |

## 11. Dependencies on other owners (to be routed by the orchestrator)

- **Senior engineer** (`deploy/**`, `packages/**`):
  - Containerfiles accept the `ARG`s for the §6 labels.
  - Images run a non-root `USER`, have a `HEALTHCHECK` and an init process (ADR-0006).
  - `/licenses/LICENSE` and third-party notices are inside both images.
  - The build is compatible with `docker buildx` in CI and `podman build` locally.
  - `packages/mcp/package.json` gets: `name` = `<name>-mcp`, `mcpName`, `bin`, `files` (including `LICENSE`), `license: AGPL-3.0-or-later`, an exact `repository.url`, `engines.node >= 22`, and a description with the notice.
  - Change the README title once the name is chosen.
- **Location of `check:prepublish` (M5-S1, owned by CI):** I propose `packaging/checks/`, wired in as a root script. The root `package.json` belongs to the SE.
- **Architect:**
  - an amendment to ADR-0006/0005 for the bump rule "Joplin minor = our MAJOR (MINOR while 0.x)"
  - the catalog network-model decision (F5) before any Phase 3 catalog
- **QA:** `tests/release/**` must use the verification commands: `cosign verify --certificate-identity-regexp '^https://github.com/TheScriptingGuy/<name>/\.github/workflows/release\.yml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com`, `gh attestation verify`, `npm audit signatures`, `sha256sum -c`.
- **Orchestrator (D5):** release-please derives versions from Conventional Commit subjects (`feat:`, `fix:`, `feat!:`). The CLAUDE.md commit rule would change from "imperative subject" to "Conventional Commit prefix plus an imperative subject". Commits without a prefix are simply ignored.

## 12. Decisions needed from the user

| # | Decision | Recommendation |
|---|---|---|
| D1 | The public name (Q1) | **Notestead** (§5), after the user's own trademark search |
| D2 | The channel plan | Phase 1 = GitHub Releases + GHCR + npm + MCP Registry; Docker Hub in Phase 2 (§7) |
| D3 | Repo visibility (Q5) | Keep the repo **public** (it already is) and rename it before the first push. A private repo on GitHub Free can't host the release gate, attestations or npm provenance (F2). |
| D4 | Docker Hub route (Phase 2) | Start on the personal namespace with an expiring PAT in `release`; apply for DSOS later to get OIDC and drop the rate limits |
| D5 | Release tooling | **release-please** (manifest config, one lockstep version, draft releases, `extra-files` for `server.json`), with Conventional Commit prefixes. changesets would instead require a changeset file per story. |
| D6 | GitHub App for workflow-created PRs | Not now (§8); revisit if the bump or release PRs cause friction |
| D7 | Versioning rule for Joplin minor upgrades | Our MAJOR (MINOR while 0.x), plus the floating `joplin<minor>` tag (§6) |

## 13. Sources (checked 2026-10-04)

- npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- npm access tokens: https://docs.npmjs.com/creating-and-viewing-access-tokens
- npm first-publish limitation (community guidance): https://github.com/azu/setup-npm-trusted-publish
- Docker OIDC for GitHub Actions: https://www.docker.com/blog/docker-oidc-connections-for-github-actions-available-for-docker-orgs/ ; https://docs.docker.com/security/authentication/oidc-connections/create-manage.md
- Docker Hub usage and pull limits: https://docs.docker.com/docker-hub/usage/
- DSOS programme: https://www.docker.com/community/open-source/application/
- MCP Registry with GitHub Actions: https://modelcontextprotocol.io/registry/github-actions
- MCP Registry package types: https://modelcontextprotocol.io/registry/package-types
- MCP Registry API (existing Joplin entries): https://registry.modelcontextprotocol.io/v0/servers?search=joplin
- GitHub environments: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Artifact attestations: https://docs.github.com/en/actions/concepts/security/artifact-attestations ; https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- arm64 runners in private repos: https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories
- Immutable releases: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/
- Umbrel packaging rules: https://github.com/getumbrel/umbrel-apps/blob/master/.agents/skills/umbrel-package-app/SKILL.md
- TrueNAS apps catalog: https://github.com/truenas/apps
- CasaOS App Store: https://github.com/IceWhaleTech/CasaOS-AppStore
