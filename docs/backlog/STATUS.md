# Project status

The orchestrator (main Claude session) maintains this file.

| Phase / milestone | State | Notes |
|---|---|---|
| Bootstrap: agent team, CLAUDE.md, AGPL relicense | done | branch `chore/agent-team` |
| **Phase A / M0:** architecture, ADRs, spikes S1–S5, backlog | done | `5a383c4`: S1–S5 all GO or GO-WITH-CONDITIONS; 10 ADRs; 93 acceptance criteria in M1–M6 |
| **Phase A:** delivery channel investigation (`docs/delivery/channels.md`) | done | `2aeb101` |
| **User gate:** approve architecture, delivery channel plan and public name | **approved 2026-10-04** | tag `plan-approved-v1` |
| M1 Walking skeleton + test harness | in progress | **M1-S1 merged** (APPROVE r1); **M1-S2 merged** (APPROVE r3); **M1-S3 merged** (APPROVE r1); **M1-S9 merged** (APPROVE r1); **first push done 2026-10-05** (`dc515fa`, ci + web-bundle green on x64 and arm64); **M1-S4 merged** (APPROVE r1); next: CI evidence → QA closes CI-pending ACs; then M1-S5 |
| M2 Web app | not started | |
| M3 Headless Data API | not started | |
| M4 MCP | not started | |
| M5 Release | not started | |
| M6 Upgrade automation | not started | |

## Decisions log
- 2026-10-03: License changed to AGPL-3.0-or-later. Sync target is the user's existing self-hosted Joplin Server (tests use a throwaway server). E2EE is enabled on the user's account. Gate: pause for user approval after Phase A.

- 2026-10-03: Added the `ci-cd-specialist` agent at the user's request. It owns public delivery (Docker Hub, GHCR, npm, GitHub Releases, MCP Registry, …) through GitHub Actions, and configures accounts through Playwright with the user entering credentials themselves.

- 2026-10-04 **Gate 1 approved with the recommended defaults.** The user's answers:
  - **Name: Notestead** ("Notestead for Joplin (unofficial)"). The user still runs an EUIPO TMview check before the first public release.
  - **HTTPS front: Cloudflare Tunnel.** The architect amends the design for Cloudflare's request-body limit and for `CF-Connecting-IP` as the client-IP source behind the `X-Real-IP` overwrite rule.
  - **Versions:** the server and all clients are on 3.7.x, and one master password unlocks all E2EE keys.
  - **Recommended defaults adopted:**
    - D2: phased channels (GitHub Releases, GHCR, npm, MCP Registry first; Docker Hub in Phase 2).
    - D3: keep the repo public and rename it before the first push.
    - D4: Docker Hub on the personal namespace with an expiring token; apply to DSOS later.
    - D5: release-please with Conventional Commits.
    - D6: no GitHub App for now.
    - D7: a Joplin minor upgrade is our major bump (minor while 0.x), plus a floating `joplin3.7` tag.
    - Q6: accept the ~16–19 s sync pause.
    - Q7: MCP on behind TLS with a bearer token; the REST gateway off.
    - Q8: use the full account.
    - Q9: permanent delete and remote links off; time zone Europe/Amsterdam.
    - Q10: accept the welcome notes once.
    - Q11: upstream security reports go privately.
    - Q12: no swap change.
  - **Still requires separate, one-at-a-time approval:** the repo rename (Playwright), the first push, and each first publish per channel.

- 2026-10-04 **MCP exposure (L17):** the user chose to **publish MCP through the Cloudflare Tunnel behind Cloudflare Access plus the bearer token**. They accept that Cloudflare can read the decrypted note content MCP returns, so cloud clients such as claude.ai connectors can reach it. This replaces the earlier default (Q7). The architect records it in ARCHITECTURE §14 and the M4/M5 acceptance criteria. The product default for other users stays opt-in.

## Pending CI verification (closes on the first green run after the user-approved push; QA's V1–V8 in docs/test-plans/M1-S3.md)
- M1-AC8 (x64), M1-AC9, M1-AC27, and through M1-AC27: **M1-AC5** (full web build on x64).
- M1-AC24/25/26/29 on x64, and M1-AC29's T90 notices assertions.
- **First CI run (2026-10-05):** `ci` run 37285783659 and `web-bundle` run 37285783648 both concluded `success` on `dc515fa`. QA still has to check them against V1–V8, using artifacts downloaded through the logged-in browser, before these ACs flip to PASS.
- M1-S4 x64 (contract suite): gated by M1-S8. An x64 failure reopens M1-S4.
- If the first run fails, fixes go on a `fix/M1-S3-*` branch, not the merged story branch.

## Follow-ups from reviews (route into the named story when it starts)
- **M1-S8 (or earlier):** `check:workflows` gaps from review M1-S3:
  - C1: YAML aliases bypass the pin and permission checks.
  - C2: ban `pull_request_target` outright.
  - C3: also check local actions outside `.github/actions/`.
  - C4/C5 (nits): verify the sha256 of a cached tool binary, and add a download timeout.
- **Before the first push (ci-cd-specialist):** `ci.yml` runs `check:licenses`, `check:pin` and `check:no-upstream-copy` on both architectures (M1-S9 goal).
- **M1-S4 review follow-ups:**
  - **Bug, fix before M5 pre-publish:** `packages/web-build/src/provenance.ts` turns the SSH alias remote `git@github-notestead:…` into a fake host `https://github-notestead/…` in `source.html`. Locally packaged bundles get a broken source link; CI builds are unaffected. Derive the URL from the canonical repo instead (e.g. `package.json` `repository`).
  - Add `Cache-Control` on static 404s (`handle_errors`), so Cloudflare doesn't briefly cache a 404 for a `.js` file.
  - Architect: should `Cf-Access-Client-Id`/`-Secret` be stripped before proxying to Joplin Server? ADR-0002 rule 3 doesn't cover them.
  - M5: the OCI label set must override Caddy's inherited labels (licence, title, source).
  - Nits: empty unlisted dirs survive `import`; the decompression limit comes from the manifest; a trailing-slash `JOPLIN_SERVER_URL` fails with Caddy's error rather than ours; the image `EXPOSE`s 8089, so `podman run -P` would publish the internal listener.
- **M1-S9 review follow-ups, for the architect to schedule:**
  - C1: `check:pin` alias hole — any `joplin`/`@joplin/*` lockfile entry must resolve to the same name. Needs a concrete story.
  - C2: ADR-0010 should say an exception's text wins over the standard SPDX text, which is what the code does.
  - C3: missing installed packages, and banners that name no package, should fail unless the package is platform-specific or on a reviewed list.
  - C4/P1: treat a plain-string legacy `"licenses": "MIT"` (e.g. `requireg@0.2.2`) as declared.
  - Optional upstream courtesy: `tkwidgets` lacks `"license": "MIT"` (the user can file it).
- **Architect (with M1-S9, done):** an ADR-0009 amendment allowing pipeline-only tooling in `.github/scripts/` (review M1-S3 P1), and an M1.md fix: post-merge CI fixes go on `fix/M1-S3-*`.
- **M1-S9 / M1-AC26:** `check:pin` must also check the *source* of `joplin`/`@joplin/*` in the lockfile: require `npm:` resolutions, reject git or local patches (review M1-S1 C1).
- **M1-S9 `check:licenses`:** exception list with reasons for 5 transitive packages of `joplin@3.7.1` (one LGPL-3.0, one MPL-2.0-no-copyleft-exception, one AFL/BSD, two with no licence field) (review M1-S1).
- **M1-S6:** the lint ban on fixed sleeps should also catch `setTimeout`-based sleeps in tests (C2). Playwright Chromium revision mismatch (expects r1217, the Pi has r1223): pin to the installed browser or ask the user before downloading. Fixture log attachments and the CI report format.
- **M1-S2 follow-ups:**
  - `verify` should also hash-check upstream screenshots and every other binary the overlay replaces (at M1-AC29 or the M5-AC1 scan) (r1-C2).
  - Cache cleanup policy for `~/.cache/notestead/web-build/<commit>` (~13 GB each) (r1-C4).
  - QA: the T90 note should say `NOTESTEAD_BUILD_WORK` must be new, empty, or created by an earlier `build`.
- **Process (P1):** QA writes or hands over test-runner configs (`jest.config.js`, `playwright.config.ts`) *before* implementation starts.
- **Process (P2):** the orchestrator keeps unrelated decisions out of story commits (`4277bff` mixed the MCP-exposure decision into M1-S1).

## Open items for the user
- EUIPO TMview check for "Notestead" before the first public release (user).
- Approve the repo rename to `notestead` and the first push when M1-S3/S8 need CI.
- Confirm the Docker Hub and npm accounts `thescriptingguy` are yours (before Phase 1 and 2 publishing).
