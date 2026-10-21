# Project status

The orchestrator (main Claude session) maintains this file.

| Phase / milestone | State | Notes |
|---|---|---|
| Bootstrap: agent team, CLAUDE.md, AGPL relicense | done | branch `chore/agent-team` |
| **Phase A / M0:** architecture, ADRs, spikes S1–S5, backlog | done | `5a383c4`: S1–S5 all GO or GO-WITH-CONDITIONS; 10 ADRs; 93 acceptance criteria in M1–M6 |
| **Phase A:** delivery channel investigation (`docs/delivery/channels.md`) | done | `2aeb101` |
| **User gate:** approve architecture, delivery channel plan and public name | **approved 2026-10-04** | tag `plan-approved-v1` |
| M1 Walking skeleton + test harness | **done 2026-10-16** | Stories S1–S9 and S6a merged, each approved in review (S2 in r3, the rest in r1). Every acceptance criterion passes on arm64 and x64 (`e2e.yml` 38881804121, `ci.yml` 38881804157). Close-out `docs/reviews/M1-closeout-r2.md` APPROVE r2; tag `m1-done` |
| M2 Web app | in progress | M2-S1 merged 2026-10-21 (`M2-S1-r1` APPROVE). M2-S2 merged 2026-10-21 (`M2-S2-r1` APPROVE; test-only, product unchanged; arm64 14/14 E2E). x64 PENDING-CI for both. New limitation L18. Next: M2-S3 (search, attachments, trash) |
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

## CI verification
- **Closed 2026-10-05:** QA verified the first CI run (head `dc515fa`; recorded in `d550c16`) against V1–V8.
- **Closed 2026-10-16:** QA verified `e2e.yml` run 38881804121 and `ci.yml` run 38881804157 (head `4dc0cf5`) against X1–X9. Every M1 acceptance criterion now passes on arm64 (Pi) and x64 (CI), recorded per story in `docs/test-plans/M1-S*.md`. The lead checked the evidence in `docs/reviews/M1-closeout-r1.md`. Evidence is in `~/joplin-web-app-work/ci-evidence/<run-id>/`.
- **Watch item W1:** the headless restart and sync are slow on x64 (the E2E step took 9.9 min against 6.6 min on arm64; the slowest test used 294 of its 600 s). If an x64 run gets within 20% of a timeout, profile the restart.

## Follow-ups from reviews (route into the named story when it starts)
Done in M1 (detail in the reviews and test plans):
- `check:workflows` hardening, now M1-AC30–33;
- `ci.yml` checks;
- the M1-S9 lockfile source and licence exceptions;
- M1-S6 C1, C2, C4, C5 and P1;
- M1-S6a C1-R1, C1-R2, C4-R3 and FU-S6a-1;
- M1-S7 hand-over, C1-R1a and C1-R1b;
- the M1-S8 first CI run and the `ac12-s7` podman 4.9 fix;
- every x64 evidence item;
- the ADR-0007 (C3 harness rules, Chromium in CI) and ADR-0003 (sync-success) amendments, and the M1-AC21 rewording (`55a4be9`, `21389c2`).

Open, grouped by when they are due, following the classification in `docs/reviews/M1-closeout-r1.md`:
- **M2-S1 QA:** ~~serial rule, M1-S8 C2, C-N1, C-N3, C1-R4, C2-R5~~ (done in M2-S1, 2026-10-21).
- **Pending CI:** the x64 `e2e.yml` run for the M2-S1 merge (39568721933) never reached E2E: the runner's `packages.microsoft.com` apt source returned 403 and the browser install failed. Fixed in CI-e2e-browser-gate (merged 2026-10-21, `docs/reviews/CI-e2e-browser-gate-r1.md` APPROVE r1). QA records CI-EBG-4 and the missing M2-S1 x64 rows from the first run after that merge.
- **CI-e2e-browser-gate r1 follow-ups:** C1 keep apt sources by content, not by file name (fix at once if the post-merge arm64 run shows the guard removing the archive); C2 QA tightens `browserGate.mts` so non-guarding scripts fail (next QA touch of CI tests); C3/C4 nits (directory in `sources.list.d`; skip unless `RUNNER_ENVIRONMENT=github-hosted`); P1 QA notes that VERIFY was recorded before `0aa81a9`.
- **M2-S2 (done 2026-10-21):** ~~M2-S1 r1 C1, C2, C5, P1, P2; `e2eeAccount` to-do/tag/attachment seeds (opt-in); C-N2 (covered by M2-AC2 step 6)~~.
- **Pending CI:** QA records the x64 rows for M2-S1, M2-S2 and CI-EBG-4 from the first `e2e.yml` run after the M2-S2 merge (run id, junit counts, `flaky: 0`, `retry: 0`, durations). M2-S2 adds ~18 min single-worker Pi time; watch the E2E step's 45 min timeout (W1). M2-S2 r1 P3: S3/S4 and the final full run predate WO-19.
- **M2-S3 QA (from `docs/reviews/M2-S2-r1.md`):**
  - C1: `NoteScreen.waitSettled` (F8) has no sensitivity run, measured lag or unit test; consider waiting for the focus to land in the editor iframe.
  - C2: a due time typed in the hour when summer time ends resolves to the first occurrence (1 h off); handle or document.
  - C3: the M2-AC5 NEG asserts the spy only in the main frame; check `framesWithSpy` in the real app.
  - C4: M2-AC2 steps 9 and 174 and the M2-S2 REST diffs print seeded or synthetic values on failure; add a strategy sentence and make them value-free.
  - C5 (nit): `webReport` returned by `syncWebThenHeadless` is never read.
  - P2 (nit): strategy §8 wording vs the `syncWebOnce` rule and `waitSettled`, which have no unit test.
  - Architect + QA: empty and huge note bodies are in no M2 AC; decide where they go.
- **M2-S2 architect (not blocking):** ADR-0007 A2 says `e2eeAccount` seeds a to-do, tag and attachment; M2-S2 makes them opt-in (`e2eeSeed.extras`). Amend A2.
- **M3-S1 (supervisor):** `packages/headless/src/supervisor.test.ts:70` and `:109` (M1-S1-T04) run a full supervisor cycle on Jest's default 5 s timeout and failed once under load (2026-10-21). Move them to the integration layer or give them a measured timeout (QA plan, SE change).
- **M2-S5 plan:** M2-S1 r1 C3: `chromium-serial` depends on `chromium`, so a red parallel run hides the first disruptive spec as "not run".
- **Before M3/M4 mix sync and MCP:**
  - The "one headless sync" helper (a restart, which rotates the token) moves to M3's manual sync trigger.
  - QA, M3-AC1: a contract test where `/api/ping` answers but sync fails, so the stack never reports ready. A wrong sync password is a hard failure.
  - Architect: decide the non-E2EE account case. `e2ee decrypt --force` exits 1, so the supervisor never reports ready.
  - Optional: "no init" in `/status`.
- **M4:** C1-R6, a Data API token that rotates mid-test is not registered until teardown.
- **Before M5-S4 (tunnel) / M5 pre-publish:**
  - `provenance.ts` turns the SSH alias remote into a fake host in `source.html`. Derive the URL from the canonical repo.
  - `Cache-Control` on static 404s.
  - Architect: rule on stripping `Cf-Access-Client-Id`/`-Secret` (ADR-0002 rule 3).
  - The OCI label set overrides Caddy's labels.
  - Architect: ADR-0009 A4, the sqlite3 prebuilt binary checksum gap, and its remedy.
  - `verify` hash-checks upstream screenshots and the other replaced binaries.
  - Web-bundle tarball reproducibility (tar metadata).
  - Release-please `bootstrap-sha`/`exclude-paths` for the `fix(...)` commits that changed no behaviour: P-R1's three and `79546b0` (M5-S3).
- **M6 or any pin-tooling story:**
  - M2-S2 r1 C6: a static check that the upstream UI strings the E2E relies on (side menu toggle, `▼` glyph, alarm and tags dialogs, L1 alert) still exist in the pinned bundle, as an early signal on a 3.7.x bump.
  - M1-S9 C1: the `check:pin` alias hole.
  - C2: ADR-0010 says an exception's text wins.
  - C3: missing packages and banners that name no package fail.
  - C4/P1: a legacy plain-string `licenses` counts as declared.
- **Anytime, low priority:**
  - the optional Jest JUnit reporter;
  - M1-S8 C1 (podman action: warn when lingering gives no user bus, record the network backend);
  - e2e timeout tuning (the slowest run used 18/75, 7/45 and 26/150 min);
  - a test for the harness-error path when `podman top` fails;
  - the M1-S2 cache cleanup (about 13 GB per commit) and the T90 note wording;
  - the M1-S4 nits;
  - M1-S8 nits C3–C5;
  - optional: list ADR-0003's three upstream interfaces in the ARCHITECTURE reuse map.
- **Standing:**
  - accepted risk A1, the lint-ban bypasses;
  - the Node 24 trace workaround stays everywhere.
- **Upstream proposals (the user may file them):**
  - U13/L18: on the first web login to an E2EE account the upload of the welcome notes fails ("Master key is not loaded") and aborts the whole sync, so nothing downloads before the master password;
  - `joplin sync` exits non-zero when it fails;
  - the web app's "Joplin Server URL" field loses focus;
  - the Playwright trace merge hangs on Node 24;
  - `tkwidgets` has no licence field.
- **Process:**
  - ~~M2-S1 r1 P1, P2~~ (strategy §8, M2-S2).
  - M2-S2 r1 P1: the executor removed test images before the planner's review twice (M2-S1, M2-S2 WO-17); orchestrator briefs now say to keep them and the orchestrator removes them after sign-off.
  - Team pattern since 2026-10-21: Opus QA planner and architect; Sonnet QA executor, senior engineer, ci-cd and lead.
  - P1: QA hands over runner configs before implementation.
  - P2: keep unrelated decisions out of story commits.
  - P-R1: test- or docs-only commits use `test`/`chore`/`docs(test-plans)`.

## Open items for the user
- EUIPO TMview check for "Notestead" before the first public release (user).
- ~~Approve the repo rename to `notestead` and the first push~~ (done 2026-10-05).
- Confirm the Docker Hub and npm accounts `thescriptingguy` are yours (before Phase 1 and 2 publishing).
