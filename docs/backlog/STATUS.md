# Project status

The orchestrator (main Claude session) maintains this file.

| Phase / milestone | State | Notes |
|---|---|---|
| Bootstrap: agent team, CLAUDE.md, AGPL relicense | done | branch `chore/agent-team` |
| **Phase A / M0:** architecture, ADRs, spikes S1–S5, backlog | done | `5a383c4`: S1–S5 all GO or GO-WITH-CONDITIONS; 10 ADRs; 93 acceptance criteria in M1–M6 |
| **Phase A:** delivery channel investigation (`docs/delivery/channels.md`) | done | `2aeb101` |
| **User gate:** approve architecture, delivery channel plan and public name | **approved 2026-10-04** | tag `plan-approved-v1` |
| M1 Walking skeleton + test harness | in progress | **M1-S1 merged** (APPROVE r1); **M1-S2 merged** (APPROVE r3; M1-AC5 PENDING-CI until M1-AC27) |
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

## Follow-ups from reviews (route into the named story when it starts)
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
