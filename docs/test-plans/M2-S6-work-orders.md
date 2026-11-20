# M2-S6 work orders (QA executor)

These orders implement `docs/test-plans/M2-S6.md`. Read that plan first. Its Findings F1 to F5, Interpretations I1 to I5, Planner decisions D1 to D10, the AC table, the harness table and the sensitivity table are the design. Each order gives the files, signatures, assertions, the commit split and subjects, the commands, the expected outcome and the stop points. Upstream paths are `upstream:packages/…` under `~/joplin-web-app-work/upstream-joplin/` at `v3.7.21` (read-only).

**The story's shape is unusual.** Most of the feature landed in M1-S2. The planner expects most E2E tests to **pass on arrival**; RED for the right reason cannot be manufactured for a feature that exists. Their power to fail is proven instead by the un-overlaid NEGs and the sensitivity runs (WO-5). Product failures found in WO-4 are **the SE's work list**, recorded, not stop points. Harness failures are stop points.

## Rules for every order
- **Branch:** `feat/M2-S6-branding-source`. WO-0 checks it.
- **Commit trailer**, at the end of every message:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
  If the orchestrator's dispatch names your model, use it in `Co-Authored-By`.
- **Commit subjects:** `test(...)`, `chore(...)`, `docs(testing)` or `docs(test-plans)` only. Never `feat` or `fix`, and never push. Stage by path (`git add <path>`), never `git add -A`.
- **Paths:** write only `tests/**`, `playwright.config.ts`, `docs/testing/**` and `docs/test-plans/M2-S6*.md`. Never write `packages/**`, `deploy/**`, `.github/**`, `eslint.config.js`, `upstream/**`, ADRs, the architecture or STATUS.
- **Upstream bytes (plan D1):** read through git at test time only. Never write an upstream file, or a list of upstream hashes, anywhere under the repository except `test-results/` (gitignored). A test output dir under `test-results/` is fine; delete reconstructed dists at teardown.
- **Test-first history:** an order marked **RED → GREEN** is two commits.
  1. **The failing test.** Before committing: `corepack yarn eslint --max-warnings 0 <its files>` clean; `corepack yarn tsc -p tsconfig.json` (and `-p tests/acceptance/tsconfig.json` for `.mts`) with **only** the missing modules or exports the RED is about; the RED run logged under `red/`.
  2. **The support code,** the test passing, logged under `green/`. If the GREEN touches a shared harness module (`fixtures.ts`, `stack.ts`, `localProfile.ts`, `network.ts`, `pages/joplinWebApp.ts`, `tests/acceptance/support/upstream.mts`), also run `corepack yarn jest tests/unit/harness tests/integration/harness` and `node --test --test-concurrency=1 --test-reporter=spec 'tests/acceptance/m1-s2/*.test.mts' 'tests/acceptance/m1-s9/*.test.mts'`. All must pass.
- **Tests:**
  - No `.only`, `.skip`, `fixme`, `waitForTimeout`, `test.slow()` or sleeps. Wait only with `expect.poll`, `waitFor` or `holdsFor` (`tests/support/poll.ts`).
  - Type into the app only with `typeLikeUser`/`clearLikeUser`. Never `fill()` or `dispatchEvent`.
  - Never weaken an assertion; never change an asserted string; never read an expectation from `overlay.json` (D5).
  - Every spec uses `test.describe.configure({ timeout: longSpecTimeoutMs })` and `requireUpstreamBundle(stack, 'M2-S6')`. No spec writes its own timeout number.
  - Locators are role- or label-based. Never CSS classes (the Source link is `getByRole('link', { name: /^Source\b/ })`).
  - No screenshots, no `--trace on`, no `use.trace`.
- **Working tree during a run:** never keep another order's uncommitted files in the tree while running a command. A sensitivity edit starts only after its order is committed and is reverted with `git checkout -- <file>`.
- **Run environment (every heavy command):**
  ```sh
  cd ~/Joplin-Web-App
  export NOTESTEAD_WEB_ARTIFACT=$HOME/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21
  export NOTESTEAD_KEEP_IMAGE=1
  run() { log=$1; shift; mkdir -p "$(dirname "$log")"; s=$(date +%s); LANG=C.UTF-8 timeout "${T:-100m}" "$@" > "$log" 2>&1; c=$?; echo "# duration $(( $(date +%s) - s )) s; exit $c" >> "$log"; return $c; }
  e2e_pre() { [ -d test-results/e2e/stack ] && mkdir -p test-results/verify/m2-s6/stale-stack && mv test-results/e2e/stack "test-results/verify/m2-s6/stale-stack/$(date +%s)"; true; }
  IMG="NOTESTEAD_WEB_IMAGE=localhost/notestead-web:stack-test NOTESTEAD_HEADLESS_IMAGE=localhost/notestead-headless:stack-test NOTESTEAD_DEVICE_IMAGE=localhost/notestead-test-device:3.7.1"
  ```
  - **One heavy job at a time** (E2E, full `yarn lint`, image builds, `check:no-upstream-copy`), in the background with `timeout`. **One Playwright worker** (never pass `--workers`).
  - After every E2E run: copy `test-results/e2e/junit.xml` next to its log as `<name>-junit.xml`, and run `node tests/harness/tools/scan-l20.ts test-results/e2e > <log dir>/<name>-l20.txt`. Run `e2e_pre` before every E2E run.
  - Logs: `test-results/verify/m2-s6/<phase>/<name>.log`, `<phase>` = `red`, `green`, `run`, `sens` or `verify`.
- **Images:** never `podman rmi`, `image prune`, `tag` or `untag`. An unexpected image state is a **RECORD**. A test-labelled container or stack you did not start is a **HARD STOP**; don't remove it. Never touch `byparr` or any unlabelled podman resource.
- **Network:** nothing in this story needs the internet beyond the blobless upstream fetch, if the local clone lacks the pin (it has it). Never fetch `source.html`'s external links. Never point anything at a real Joplin Server.
- **L20 (plan D9):** record qualifying failures; never re-run to get green; the third in one Playwright invocation is a **HARD STOP**.

### Stop points
- **HARD STOP.** Allowed: collect the evidence the order names (logs, `error-context.md`, the trace path, an `ariaSnapshot()`, the browser console, `podman ps -a`/`podman images`); re-run the **same** command once only if the order says so; read upstream source; revert temporary edits; write the finding under `## Findings (executor)` in `docs/test-plans/M2-S6.md`, uncommitted; end your turn with a report (order and step, what happened, evidence paths, your view of the cause, `git status --short`). **Not allowed:** changing code, tests, locators, timeouts or config; adding a retry, a wait or a workaround; committing; continuing with other orders; removing containers or images.
- **RECORD.** Write the observation under `## Findings (executor)` with its evidence, and continue. Change nothing because of it.
- **PRODUCT FAILURE.** A test fails, the harness is shown sound (its NEG or positive control behaves, the failure message names a product fact such as a covered control or an unreachable link), and the cause is in the served bundle. Write it under `## Findings (executor)` → `### Product failures (for the SE)` with the test, the failing assertion text, the evidence path and the product file you believe is at fault (`packages/web-build/overlay/…`). Continue. Never change the test to make it pass.

---

## WO-0: Pre-flight (no commit)
1. `git branch --show-current` is `feat/M2-S6-branding-source`; `git status --short` is empty; `git log --oneline -2` shows the planner's plan commit on top of `88fbffe`.
2. `(cd $NOTESTEAD_WEB_ARTIFACT && sha256sum -c SHA256SUMS)` all `OK`; `bundle-manifest.json` has `notestead.commit` `dc515fa0ce398f6933121fde4d2de3e5fb9b7e6d` and `git merge-base --is-ancestor dc515fa HEAD` exits 0. Otherwise **HARD STOP**.
3. `git -C ~/joplin-web-app-work/upstream-joplin cat-file -e e41516e669efb693b009bedb21f3eb1fcbea4fc9^{tree}` exits 0, and `git -C … ls-tree --name-only e41516e -- packages/app-mobile/web/public/icons/ packages/app-mobile/web/public/screenshots/` lists 6 icons and 2 screenshots. Otherwise **RECORD** (the blobless fetch will be used).
4. Podman state into `test-results/verify/m2-s6/podman-before.txt` (as M2-S4 WO-0 step 3). A test-labelled container you did not start: **HARD STOP**. **RECORD** whether the three kept image tags exist (then use `$IMG`).
5. **The upstream lookup loads under Node:** `node -e "import('./tests/acceptance/support/upstream.mts').then(m=>console.log(typeof m.upstreamFilesUnder))"` prints `function`. **RECORD** the result. Whether Playwright can import it is tried in WO-2, which says what to do either way.

## WO-1: Pure checkers and the placement criterion (RED → GREEN)
**Files:**
- `tests/support/branding.ts` (erasable TS; used by Jest, Playwright and node:test):
  - constants (plan D5): `productName`, `productShortName`, `notAffiliated` (`/not affiliated/i` and `/JOPLIN SAS/`), `ourRepoUrl(env = process.env)` (`NOTESTEAD_SOURCE_REPO` or `https://github.com/TheScriptingGuy/notestead`, trailing `/` and `.git` removed);
  - `titleOf(html): string[]` (all `<title>` texts, entity-decoded);
  - `metaContents(html, key): string[]` (`name=` or `property=`, any attribute order, multi-line tags);
  - `iconRefs(html): { rel: string; href: string }[]` (`<link>` whose `rel` token list has `icon` or `apple-touch-icon`, plus `<meta property="og:image">`);
  - `manifestIconRefs(manifest): { src, type, sizes }[]`;
  - `htmlBrandingProblems(page: 'index' | 'closed' | 'just-one-client', html): string[]`: exactly one title; it contains `productName`; no `Joplin` outside the product name or `JOPLIN SAS`; each description (and `og:description` on index) contains `productName` and the notice;
  - `manifestBrandingProblems(json): string[]`: `name === productName`, `short_name === productShortName`, no `screenshots`, PNG `192x192` and `512x512` among `icons`;
  - `upstreamHashHits(entries: { path; sha256 }[], hashes: Map<sha256, upstreamPath>): { path; upstreamPath }[]`.
- `tests/e2e/support/placement.ts`: `interface Box { x; y; width; height }`; `interface Control { role; name; box: Box; centreHitsLink: boolean }`; `coveredControls(controls, link: Box, minShare = 0.25): { control; share }[]` (plan D8).
- Tests: `tests/unit/harness/branding.test.ts` (`br-01…08`, plan table) and `tests/unit/harness/placement.test.ts` (`cov-01…05`).

**Commit 1 (RED):** `test(harness): branding checkers and the Source-link placement criterion (M2-S6, RED)`. RED = the two modules missing.
**Commit 2 (GREEN):** `test(harness): implement the branding checkers and the placement criterion (M2-S6)`.

## WO-2: Upstream tree, un-overlaid bundle, extra containers, app contexts, OPFS paths (RED → GREEN)
**Files and design (plan D1 to D4):**
- **Upstream lookup:** if WO-0 step 5 and a trial import from `tests/e2e/support/upstreamBranding.ts` show Playwright loads `tests/acceptance/support/upstream.mts`, import it. Otherwise move `upstreamGitDir`/`upstreamFilesUnder` into `tests/support/upstreamTree.ts` and make `upstream.mts` re-export them (one implementation; the M1-S2/M1-S9 acceptance suites must still pass). `tests/e2e/support/upstreamBranding.ts` exports `upstreamPublic(): Map<relPath, Buffer>`, `upstreamIconHashes(): Map<sha256, path>` (must be 6 distinct) and `upstreamScreenshotHashes()` (must be 2); a wrong count throws, naming the pin.
- **`tests/stack/stack.ts`:** `upExtraWeb(state, { label, role, port?, mountDist? })` (plan D3) and `upWebWithoutHostRewrite` rewritten as a wrapper around it with byte-identical behaviour (same name pattern, labels, env, hardening). Mount: `-v <dir>:/srv/www:ro`. If the bind mount is unreadable to the container's user 65532 (403/500 from Caddy): **HARD STOP** (do not chmod around it without a ruling beyond 0644/0755).
- **`tests/e2e/support/unoverlaid.ts`:** `reconstructUnoverlaid(stack, dir): { served: string; unoverlaid: string }` (plan D2 steps 1 to 3) and `checkUnoverlaid(...)` (step 4, returns problems).
- **`tests/e2e/support/fixtures.ts`:** worker fixture `unoverlaidDist` (built once per worker under `test-results/e2e/m2-s6-dists/<worker>`; removed at worker teardown); test fixtures `extraWebs` (D3) and `appContexts` (D4). Factor `webApp`'s console, trace and WEB-SQLITE-1 teardown into one function both use. `webApp`'s observable behaviour must not change.
- **`tests/e2e/support/localProfile.ts`:** `opfsPaths(app: WebApp): Promise<string[]>` (closes the app page like `localFilesNamed`; paths only; `waitFor` 30 s on read errors).
- **Self-checks:** `tests/e2e/harness/unoverlaid-dist.spec.ts` (`H-UO-01`, `H-LH-01`) and `M2-S6-OPFS-03` added to `tests/e2e/harness/opfs-files.spec.ts` (plan harness table). `H-UO-01` runs `corepack yarn workspace web-build verify --pin <abs pin> <abs dir>` with a 120 s bound and asserts a non-zero exit naming all six `icons/*` paths and `environment.js`.

**Commit 1 (RED):** `test(harness): un-overlaid bundle, extra web containers, app contexts and OPFS paths self-checks (M2-S6, RED)`. RED = the missing fixtures/exports.
**Commit 2 (GREEN):** `test(harness): reconstruct the un-overlaid bundle and serve it from the image under test (M2-S6 D2-D4)`. Run: `T=60m run test-results/verify/m2-s6/green/harness-e2e.log [env $IMG] corepack yarn playwright test tests/e2e/harness/unoverlaid-dist.spec.ts tests/e2e/harness/opfs-files.spec.ts`, then the shared-module regressions of the rules, plus `tests/e2e/m1-s7` (it uses `upWebWithoutHostRewrite`): `T=60m run …/green/m1-s7.log env $IMG corepack yarn playwright test tests/e2e/m1-s7`.

**HARD STOPs in WO-2:** `H-LH-01` cannot load `http://localhost:<P>` (Chromium resolving `localhost`); `H-UO-01` finds a non-`public/` file that differs from the served one, or `verify` passes on the reconstruction; `crossOriginIsolated` false on the localhost origin; M1-S7 fails after the `upWebWithoutHostRewrite` change.

## WO-3: File-level acceptance for M2-AC11 (one commit, expected GREEN on arrival)
- `tests/acceptance/m2-s6/ac11-branding.test.mts`: `U-AC11-01…04` (plan table). F2 via the existing `tests/acceptance/support/webBundle.mts` helpers, overlaid once in `before` with the real `corepack yarn workspace web-build overlay <abs dir>`; the checkers from `tests/support/branding.ts`; the overlay icons oracle is `packages/web-build/overlay/icons/` at `HEAD` (file level: the overlay under test is the tree's).
- Run: `run test-results/verify/m2-s6/run/u-ac11.log node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m2-s6/ac11-branding.test.mts`.
- **Commit:** `test(acceptance): M2-AC11 overlay branding at file level (M2-S6)`. The message states the outcome (expected: 4/4 pass, the feature landed in M1-S2; `U-AC11-04` is the NEG proving the checkers fail on upstream's files). A failure of `-01…03` is a **PRODUCT FAILURE**; a failure of `-04` is a **HARD STOP** (the checkers are blind).

## WO-4: The M2-S6 E2E specs (one commit; run; record)
**Files** (plan AC table): `tests/e2e/m2-s6/branding.spec.ts` (`M2-AC11-01…03`), `source-offer.spec.ts` (`M2-AC12-01…03`), `dev-mode.spec.ts` (`M2-AC13-01`), `source-link-placement.spec.ts` (`M2-S6-ADR10-01`, `-02`). Details:
- **Oracle C (D6):** a helper `servedBundleCommit()` in `tests/e2e/support/branding.ts` reads `NOTESTEAD_WEB_ARTIFACT/bundle-manifest.json`; unset or unreadable → throw with "M2-S6 needs NOTESTEAD_WEB_ARTIFACT (the artifact the web image was built from)". Our overlay icon bytes: `git show <C>:packages/web-build/overlay/icons/<name>`; `git ls-tree` at C gives the expected icon set.
- **Manifest via CDP:** `const cdp = await webApp.context.newCDPSession(webApp.page); await cdp.send('Page.getAppManifest')`. Assert `url`, `errors` (empty) and parse `data`. If the response shape differs at the installed Chromium (no `data`), **RECORD** it and assert on the fetched `<link rel="manifest">` body instead, keeping `errors` empty if present.
- **Closing the sync wizard:** its `Close` button (`upstream:packages/app-mobile/components/DismissibleDialog.tsx:116`, `accessibilityLabel={_('Close')}`), found inside `app.syncWizard()`. Add `closeSyncWizard()` to `JoplinWebApp`.
- **The keyboard walk (`M2-AC12-01`):** after the page is ready, `page.keyboard.press('Tab')` then `await sourceLink.evaluate(el => el === document.activeElement)`, at most 200 times; annotation `tabs` with the count per page. Then `expect(sourceLink).toBeFocused()`, `Enter`, `page.waitForURL('**/source.html')`, heading `Source code of …` visible.
- **`M2-AC12-02` relative links:** every `a[href]` on the rendered page via `getByRole('link')`; resolve each `href`; for same-origin ones, a Node GET through the stack's web port (`webRequest`), status 200.
- **`M2-AC13-01`:** `const port = await freePort()`; POS: `extraWebs.start({ role: 'web-extra', port })`, `appContexts.open('http://localhost:' + port, 'pos')`, `JoplinWebApp.open` to the wizard, the `evaluate` probes, network policy (`endOfTestViolations` with the localhost origin), `opfsPaths` (closes the page), `appContexts.close`, `extraWebs.stop`. NEG: `extraWebs.start({ role: 'web-unoverlaid', port, mountDist: unoverlaidDist.unoverlaid })`, a new context, the same probes with the NEG expectations; the NEG records its network log but does not assert the policy. Assert `posOrigin === negOrigin`. If the port is taken when NEG starts (podman error "address already in use"): **HARD STOP** (do not pick another port: I2).
- **Placement (`M2-S6-ADR10-*`):** `webApp.page.setViewportSize` first; the D8 collection over `page.frames()`, each role in the D8 list, `locator.all()`, visible ones only, `boundingBox()`, and `centreHitsLink` from `page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el?.closest('a[href$="source.html"]'); }, [cx, cy])` for top-frame controls (for iframe controls, the iframe element's own hit test at the same page point). States (1) to (5) of the plan; scroll "to its end" with the mouse wheel over the list until `holdsFor` 2 s shows no change in the last row's box, bounded by 50 wheel steps. A note to open: upstream's first-start notes if the list has any, else create one with the UI (`typeLikeUser`). Annotation `textbox-overlap`.
- **Commit:** `test(e2e): M2-S6 branding, source offer, dev mode and Source-link placement (M2-AC11-13)`, after eslint/tsc are clean.
- **Run:** `e2e_pre; T=90m run test-results/verify/m2-s6/run/m2-s6.log env $IMG corepack yarn playwright test tests/e2e/m2-s6`.

**Outcomes (the planner's prediction, not a requirement):** `M2-AC11-01…03`, `M2-AC12-02`, `-03` and `M2-AC13-01` pass; `M2-AC12-01` probably passes; `M2-S6-ADR10-01`/`-02` may fail (plan R1).
- A NEG test (`M2-AC11-03`, `M2-AC12-03`, the NEG phase of `M2-AC13-01`) failing: **HARD STOP** (the test cannot see the difference).
- The dev-mode app in NEG never reaches the sync wizard: **HARD STOP** (attach the console; plan F2 assumed it starts).
- POS finds `'joplin' in window` true, or the OPFS database name differs from `/joplin.sqlite.sqlite3`: **HARD STOP** (plan F2 is wrong at the pin).
- Any other failure whose message names a product fact: **PRODUCT FAILURE**. A failure inside harness code (an exception in a helper, a locator that never matches an upstream control that the `ariaSnapshot` shows under another name): **HARD STOP**.
- A qualifying L20 failure: plan D9.

## WO-5: Sensitivity runs (no commits)
Each is a temporary edit, run alone (`-g <test id>`), with `e2e_pre` and `env $IMG`, logged under `sens/<id>.log`, junit copied, reverted with `git checkout -- <files>`, and `git status --short` clean before the next. The table is the plan's "Sensitivity runs". `S-OPFS3` runs `tests/e2e/harness/opfs-files.spec.ts -g M2-S6-OPFS-03`.
- **A sensitivity run that passes, or fails elsewhere:** **HARD STOP**.
- A sensitivity whose target test is a recorded PRODUCT FAILURE (for example `S-ADR10` while `ADR10-02` already fails) is run after the SE's fix, in WO-6, not now; **RECORD** it as deferred.
- A qualifying L20 failure during a sensitivity: an occurrence, re-run that sensitivity **once**; a second L20 hit: **HARD STOP**.

**End of the RED phase.** Report to the orchestrator: the commits, the per-test outcomes of WO-3 and WO-4, the PRODUCT FAILURE list (the SE's work), the sensitivities done and deferred, the L20 count, the RECORDs. Then stop; the SE works next.

---

## WO-6: Verify (after the SE reports done; no commits; logs under `verify/`)
1. Read the SE's worklog `docs/worklog/M2-S6.md`: the artifact to use (CI run id, `notestead.commit`). Set `NOTESTEAD_WEB_ARTIFACT` to it (download and extract under `~/joplin-web-app-work/ci-evidence/<run>/extracted/`, `sha256sum -c`). If the SE changed nothing under `packages/web-build/overlay*`, keep the current artifact. If the overlay changed and no artifact built from the new commit exists: **HARD STOP** (testing the old bundle proves nothing about the fix). With a new artifact, the kept web image must be rebuilt: run without `NOTESTEAD_WEB_IMAGE` once (the harness builds and keeps it); **RECORD** the image id.
2. Unit and acceptance: `corepack yarn jest tests/unit/harness tests/integration/harness` → `verify/harness.log`; `corepack yarn test:acceptance` → `verify/acceptance.log` (the whole default acceptance suite: the overlay may have changed).
3. M2-S6 E2E: `T=90m run verify/m2-s6.log env $IMG corepack yarn playwright test tests/e2e/m2-s6 tests/e2e/harness/unoverlaid-dist.spec.ts tests/e2e/harness/opfs-files.spec.ts`.
4. The deferred sensitivities of WO-5, then every sensitivity again if the overlay changed.
5. The full E2E regression (shared fixtures changed): `T=100m run verify/full.log env $IMG corepack yarn playwright test`.
6. `T=30m run verify/lint.log corepack yarn lint`; `T=60m run verify/no-upstream-copy.log corepack yarn check:no-upstream-copy` (a hit under `tests/**`: **HARD STOP**).
7. Tests untouched by others: `git log --format='%h %an %s%n%b' main..HEAD -- tests/ playwright.config.ts`; every commit must carry `Agent: qa-specialist`. **RECORD** any that does not.

A failure in steps 2 to 5: as in WO-4 (NEG failing or harness failing: **HARD STOP**; product: **PRODUCT FAILURE**, reported back for the SE's next round; L20: D9).

## WO-7: Results and the strategy (commit)
- Append `## Results (QA executor, Pi arm64, <date>)` to `docs/test-plans/M2-S6.md`: per row of the AC table and the harness table, PASS/FAIL, the command, the duration (the log's `# duration`), the log/junit/trace paths under `test-results/verify/m2-s6/`, and the annotations (`scan`, `tabs`, `origins`, `textbox-overlap`). Then the sensitivity table with each run's failure site, the L20 occurrences, the RECORDs, and x64 as **PENDING-CI**. Put a short "Results at a glance" under the plan's header.
- Update `docs/testing/strategy.md`:
  - **§4 Fixtures:** `unoverlaidDist` (the reconstructed upstream `yarn web` output: served tree plus upstream `public/` at the pin, never committed), `extraWebs`, `appContexts`, `opfsPaths`.
  - **§5 Rules:** upstream branding is compared by hashes computed at test time from git blobs at the pin; no upstream file or hash list is committed. Branding expectations are constants in `tests/support/branding.ts`, never read from `overlay.json`.
- **Commits:** `docs(test-plans): M2-S6 results on arm64` and `docs(testing): un-overlaid bundle fixture and branding rules (M2-S6)`, staged by path.

Then end your turn with the final report: the orders done, the commits, per-AC status, the L20 count, the RECORDs and any PRODUCT FAILURE still open.
