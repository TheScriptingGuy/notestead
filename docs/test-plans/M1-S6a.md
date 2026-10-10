# Test plan: M1-S6a Harness hardening ahead of M1-S7

- **Story:** the M1-S6 review follow-ups that must land before M1-S7 (`docs/reviews/M1-S6-r1.md`, `docs/backlog/STATUS.md` § "M1-S6 review follow-ups"):
  - **C1:** per-test secrets in the redacting reporter, plus redaction of error messages and stdout/stderr;
  - **C2:** the lint-ban gaps;
  - **C4:** the contract sweep that wipes a developer's stack.
  
  **ADRs:** 0007 (harness, no fixed sleeps), 0008 (redaction, secrets).
- **Branch:** `feat/M1-S6a-harness-hardening`, from `main` at `e127859`.
- **Owners:**
  - **qa-specialist:** this plan, everything under `tests/**`, and the whole of C1 and C4 (harness code).
  - **senior-engineer:** the C2 lint rule in `eslint.config.js` (§Requirements on the implementation).
- **Not in this story:**
  - C3 (ADR-0007 amendment, architect);
  - C5 (secrets at rest in `/tmp/notestead-stacks` and in M1-S6's `planted.json`, M1-S8);
  - P1 (lint logs carry the exit code: every log of this story ends with `exit <code>`).

## How to run
```sh
# C2: one lint run with the fixtures in place (~1 min)
node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s6a/c2-lint-sleep-values.test.mts

# C1 and C4: contract (C1 runs two inner Playwright runs, each with its own compose stack: ~10 min warm on the Pi,
# plus the image builds when cold)
corepack yarn test:contract --verbose tests/contract/m1-s6a
corepack yarn test:contract --verbose tests/contract/m1-s6a/c1-pertest-secrets.test.ts
corepack yarn test:contract --verbose tests/contract/m1-s6a/c4-sweep.test.ts

# C1 unit tests of the secret registry, stdio redaction and reporter (part of `corepack yarn test`)
corepack yarn jest tests/unit/harness

# regression: the M1-S6 harness self-tests and F1 lint tests
corepack yarn test:contract --verbose tests/contract/m1-s6
node --test --test-concurrency=1 --test-reporter=spec 'tests/acceptance/m1-s6/*.test.mts'
```

**Where the results go:**
- `test-results/contract/m1-s6a/c1/`: the C1 inner run (`playwright-console.log`, `report.json`, `output/`, `stack/`).
- `test-results/contract/m1-s6a/c1-neg-summary.json`: the C1 negative control. This is a value-free summary of the leaks found: where they were and their kind, never the values. The NEG run's own artifacts are deleted, because they leak on purpose.
- `test-results/acceptance/m1-s6a/C2-lint-sleep-values.log`: the C2 lint run.
- `test-results/verify/m1-s6a/`: QA's RED and VERIFY logs, each ending with `exit <code>`.

## Criteria → tests
| ID | Criterion | Test IDs (file) | Layer | Fixtures | Negative control | Data-level assertion |
|---|---|---|---|---|---|---|
| **C1** | The secrets a test's own fixtures create never reach an artifact or the console unredacted. These are the per-test account's password and E2EE master password (`e2eeAccount`) and the per-test headless service's Data API token (`headlessService`). The channels are the Playwright trace, stdout/stderr, error messages (test and step errors), step titles, attachments (body and file), the JSON, JUnit and HTML reports, and the run's console. | `c1-ran`, `c1-planted`, `c1-redacted-{trace,stdout,errors,steps,attachments,reports,console}`, `c1-redacted-all` (`tests/contract/m1-s6a/c1-pertest-secrets.test.ts`; inner `tests/harness/selftest/pertest-secrets.spec.ts`) | contract (harness self-test: a real compose stack, a real per-test E2EE account and headless service, real Chromium) | the inner spec plants the three real secrets: `fill` and `pressSequentially` into a login form (trace parameters, step titles, DOM snapshots), a `test.step` whose title carries the master password, a page `console.warn` (trace, browser console), `process.stdout`/`stderr` writes, an attachment with a body and one with a path, and a soft and a hard assertion failure. The self-test config now has the same HTML and JUnit reporters as `playwright.config.ts`. | `c1-neg`: the same inner run with `NST_SELFTEST_SECRET_FEED=off` (honoured only in self-test runs), so the harness knows only the default account, as before C1. The scan must find the planted secrets in **every** channel (trace, stdout, errors, steps, attachments, reports, console); otherwise the positive scan could be vacuous. `c1-planted` is a positive control in the main run: each channel carries the planting context (`"method":"fill"` on "Account password" and `"method":"type"` on "Master password" in `*.trace`, the `C1 planted …` lines in stdout, stderr, errors, the step title, `junit.xml`, the HTML report's data, attachments and the live console; `Fill "` step titles in the HTML report). | The scan uses `findLeaks` over the JSON report's `errors`, `stdout`/`stderr` (base64 buffers decoded), the step tree (titles and errors), every attachment (bodies decoded, the trace zip entry by entry), `junit.xml`, the HTML report's embedded data zip (decoded from `index.html`), `playwright-console.log`, and every file under the run's dir (`output/` with the originals of attached files, `report.json`, stack logs). Secrets are the three planted values. The catch-all also forbids the pattern `nst(pw\|mp)[0-9a-f]{24}`, which every harness-generated password of any account of the run matches. Podman resources are identical before and after each inner run. |
| **C2** | Lint rejects the sleep forms F1 missed, on the exact line, in test files. Allowed forms stay allowed. | `C2-T01`, `C2-T02-{promisify,alias,destructure,computed,interval,interval-promises}`, `C2-T03-{allowed,repo,only-ban}` (`tests/acceptance/m1-s6a/c2-lint-sleep-values.test.mts`) | acceptance (one `corepack yarn lint` with the fixtures placed, as F1) | NEG fixtures `tests/fixtures/m1-s6a/lint/sleep-*.fixture`, one form each, placed in `tests/unit`, `tests/contract`, `tests/e2e`, `tests/harness`, `packages/headless/src` (co-located test) and `tests/acceptance` (`.mts`). Positive fixtures: `allowed-values.test.ts`, `allowed-values.spec.ts`, and non-test source `timers-source.ts` in `packages/headless/src`. | The positive controls are below (§R1 "Allowed"), plus every existing repository file: the exempt `tests/support/poll.ts`, the in-container samplers `tests/fixtures/**/*.mjs`, and package code that uses timers. `C2-T03-only-ban`: the NEG fixtures have no other lint problem, so a report on them is the ban and nothing else. | ESLint's stylish output is parsed into (file, line, rule). Each NEG fixture's `// NEG` line must carry a report from a restriction rule (`no-restricted-syntax`, `-imports`, `-globals` or `-properties`). `C2-T01` also requires that eslint, not `tsc`, fails the run. |
| **C4** (nit) | The contract run's start-up sweep removes leftovers, but never a stack in use. That means a `node tests/stack/cli.ts up` stack (persistent) or a stack whose owning process is alive. | `c4-keep-dev`, `c4-keep-live`, `c4-sweep-dead`, `c4-sweep-orphan`, `c4-sweep-contract` (`tests/contract/m1-s6a/c4-sweep.test.ts`) | contract (real podman) | Five cases, each with a real network, volume and created container carrying the harness labels:<br>1. **dev:** a `stack` stack with a persistent descriptor.<br>2. **live:** a `stack` stack whose descriptor's `ownerPid` is the test process.<br>3. **dead:** a `stack` stack whose descriptor's `ownerPid` has exited.<br>4. **orphan:** a `stack` stack with no descriptor.<br>5. **contract:** a `contract`-labelled set.<br><br>Then `removeLabelled()`, which is exactly what `tests/contract/support/globalSetup.ts` calls. | `c4-sweep-*` are the controls: the sweep still removes what it must (dead, orphan, contract) | `podman container/network/volume exists` for each resource. The descriptor files: kept for dev and live, removed for dead. |

## C1 design (QA harness code, implemented in this story)
- **Secret registry, `tests/support/secrets.ts`:**
  - `registerSecrets()` keeps the secrets in process memory. When `NOTESTEAD_SECRETS_FILE` is set, it also appends them as JSON lines to that 0600 file.
  - The Playwright globalSetup creates the file in a fresh 0700 `mkdtemp` dir, and registers the default account's passwords and its Data API token.
  - The redacting reporter reads the file and deletes the dir in `onExit`. The file must outlive globalSetup's teardown, because Playwright runs the teardown *before* `reporter.onEnd`.
- **Who registers:**
  - `createAccount` registers the password and master password.
  - `upHeadless` registers the service's Data API token once it is healthy.
  - The `headlessService` fixture registers the token again at teardown, because the token rotates on every CLI start.
  - Any test may call `registerSecrets` for a secret it makes itself, for example M4's MCP bearer token.
- **Worker stdio (new auto worker fixture `redactStdio`):** wraps `process.stdout.write` and `process.stderr.write` in the worker. Playwright forwards those chunks to the runner, and the `list` reporter prints them live, which is the CI job log. Chunks are redacted at the source with every secret the worker knows. A reporter cannot do this, because it receives the chunk after `list` has printed it.
- **Reporter (first in the list):**
  - `onStepEnd`: redacts the step's title and error. Step titles carry `Fill "<value>"` and `Type "<text>"`.
  - `onTestEnd`: redacts every attachment, the errors (message, stack, value, snippet, cause), the stdout/stderr chunks and the step tree, all in place, before the `list`, HTML, JSON and JUnit reporters read them.
  - `onEnd`: redacts every file under each project's `outputDir`, before the HTML reporter copies anything. This covers the original of an attachment added by path, which Playwright copies into `attachments/` and leaves in place.
- **Residual risks (accepted, written down):**
  - A secret split across two `write` calls is not matched by the stdio wrapper. The reporter still redacts the stored chunks, but the live console would show both halves.
  - Pixels in screenshots, videos and screencast frames are not redacted. Password inputs are masked by the browser; nothing types a secret into a visible text field.

## C4 design (QA harness code, implemented in this story)
- Stack descriptors record `ownerPid` (the process that created the stack). `node tests/stack/cli.ts up` marks its stack `persistent: true`.
- `removeLabelled()` without a run id does this:
  1. It removes everything labelled `test=contract`.
  2. It removes `test=stack` resources whose run has no live descriptor. A descriptor is live when it is persistent, or when its `ownerPid` is alive.
  3. It deletes the descriptors of the dead stacks it swept.
- A descriptor without `ownerPid` was written before this change. It is treated as live, because it may be a developer's stack. `node tests/stack/cli.ts down <project>` removes it.

## Requirements on the implementation
- **R1 (C2, `eslint.config.js`, senior-engineer):** extend the "No fixed sleeps in tests (ADR-0007)" block.
  - **Files:** the same as today: `testFiles` minus `sleepExempt`.
  - **Banned in those files:**
    - **Value uses.** Every reference to the identifiers `setTimeout` and `setInterval` that is not one of the allowed positions below. This covers:
      - a call (the existing ban, now also for `setInterval`);
      - an argument, as in `promisify(setTimeout)` and `new Promise(r => setInterval(r, 10))`;
      - an alias, as in `const later = setTimeout`;
      - `setTimeout.bind(…)`.
    - **Destructuring** a property named `setTimeout` or `setInterval` from anything: `const { setTimeout: pause } = globalThis`, `… = require('node:timers')`.
    - **Member access on the globals** (`globalThis`, `global`, `window`, `self`):
      - dotted (`globalThis.setTimeout`, already banned; now also `.setInterval`);
      - computed with a string literal or a no-substitution template literal (`globalThis['setTimeout']`, `globalThis[`setInterval`]`).
    - **Imports** of `setInterval`, as well as `setTimeout`, under any alias, from `timers`, `node:timers`, `timers/promises` and `node:timers/promises`. Namespace imports are reported as today.
  - **Each report must sit on the line of the banned form.** This is the line marked `// NEG` in the fixture: for an alias or destructuring, the line where `setTimeout` is taken as a value, not the later call.
  - **Allowed (must not be reported):**
    - a non-computed member property on any other object: `req.setTimeout(…)`, `test.setTimeout(…)`, `page.setDefaultTimeout(…)`, `timeouts.setTimeout`;
    - object-literal keys: `{ setTimeout: 1_000, setInterval: 250 }`;
    - string arguments: `jest.spyOn(globalThis, 'setTimeout')`;
    - type positions: `ReturnType<typeof setTimeout>`;
    - `clearTimeout`/`clearInterval`;
    - `AbortSignal.timeout`;
    - Jest fake timers (`jest.useFakeTimers`, `jest.advanceTimersByTime`);
    - `expect.poll`.
  - **Exempt files, unchanged and exactly:** `tests/support/poll.ts` and `tests/fixtures/**/*.mjs`.
  - **Non-test source** (`packages/*/src/**/*.ts` that is not `*.test.ts`) is not covered and must stay unreported. The fixture `timers-source.ts` uses every banned form.
  - The message keeps pointing to `waitFor` (`tests/support/poll.ts`) and `expect.poll`. Any restriction rule is fine.
  - **Hint, not a requirement.** A temporary stand-in, never committed, turned all 10 C2 tests green (`test-results/verify/m1-s6a/qa-c2-standin.log`). It had two `no-restricted-syntax` selectors and `'setInterval'` added to the `importNames`:
    - `Identifier[name=/^set(Timeout|Interval)$/]:not(MemberExpression[computed=false] > Identifier.property):not(ObjectExpression > Property > Identifier.key):not(TSTypeQuery > Identifier):not(CallExpression[callee.name="setTimeout"] > Identifier.callee):not(ImportSpecifier > Identifier)`
    - `MemberExpression[computed=true][property.value=/^set(Timeout|Interval)$/]`
    
    The engineer may write it differently, for example covering class and interface keys, or the template-literal key.
  - **Must keep passing:** F1 (`tests/acceptance/m1-s6/f1-lint-sleeps.test.mts`), and `corepack yarn lint` on the repository.
- **No production seam is needed for C1 or C4.** Both are QA harness code under `tests/**`.

## Interpretations
1. **"Per-test secrets"** are the values a test's fixtures create in the worker: account passwords, master passwords and Data API tokens. They also include any secret a test registers itself. The default account's secrets were already known to the reporter (`NOTESTEAD_E2E_STACK`). Its Data API token was not; C1 registers it as well.
2. **"stdout/stderr attachments"** are the test's stdout/stderr. Playwright keeps these as result chunks, not as attachments: the JSON, JUnit (`system-out`) and HTML reports show them, and the `list` reporter prints them live. Both the stored and the live forms are covered.
3. **The C1 negative control is automated** (`c1-neg`), not a one-off sensitivity run as in M1-S6. Its artifacts leak on purpose, so they are deleted right after the scan, and only `c1-neg-summary.json` (where and what kind, no values) is kept. This means CI never uploads them.
4. **C1's planted values file** (`NST_SELFTEST_PLANTED`) lives in a 0600 file in a `mkdtemp` dir outside `test-results/`, and the outer test removes it. This is the C5 lesson applied to the new self-test. M1-S6's `planted.json` stays as it is until C5.
5. **Step titles.** Playwright's JSON reporter keeps only `test.step` steps. Action steps such as `Fill "<value>"` appear in the HTML report and the trace. So C1 plants a `test.step` title for the JSON channel, and scans the HTML report's data for the action steps. The first RED run found exactly this: the `steps` channel was empty, and `c1-neg` failed on it.
6. **The self-test config gains the HTML and JUnit reporters** that `playwright.config.ts` has, so those reports are scanned as well. This also applies to the M1-S6 self-tests, so the M1-S6 contract suite is part of this story's regression.
7. **C2 adds `setInterval` from `timers/promises`** (`interval-promises`), beside the review's `setInterval` form. The first tick of its async iterator is the same fixed delay.

## Out of scope
- C3, C5 and the `e2eeAccount` seeding gap: see the story line above and STATUS.md.
- Redacting pixels (screenshots, video, screencast frames): see the residual risks above.
- x64: PENDING-CI (M1-S8).

## Disputes
None yet.

## RED (2026-10-10, Pi arm64)
Branch `feat/M1-S6a-harness-hardening`, from `e127859`. Raspberry Pi 4, podman 5.4.2, podman-compose 1.3.0, Node 24.17.0, Playwright 1.59.1 with `chromium-1223`. Logs are under `test-results/verify/m1-s6a/` (gitignored), each ending with `exit <code>`.

**C2 (acceptance):** `node --test --test-concurrency=1 --test-reporter=spec tests/acceptance/m1-s6a/c2-lint-sleep-values.test.mts`: **3 passed, 7 failed**, 51 s (`red-c2.log`).
- With all six NEG fixtures and three positive fixtures in place, `corepack yarn lint` **exits 0**, including `tsc`, so the fixtures type-check.
- `C2-T01` and every `C2-T02-*` fail with `NEG line(s) <n> not reported … (reported lines: none)`.
- The three `C2-T03-*` positive controls pass.
- **Turns green with R1.** A temporary stand-in rule turned all 10 green (`qa-c2-standin.log`); `eslint.config.js` was restored right after and never committed.

**C1 and C4 (contract):**

**Run 1.** `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract --verbose tests/contract/m1-s6a` (cold: the web, headless and device images are built by the run). **5 passed, 10 failed**, 672 s (`red-contract.log`).
- C4 is final in this run.
- C1 exposed a harness gap. `c1-neg` failed on `steps: false`: the JSON reporter keeps only `test.step` steps, so the `steps` channel was empty.
- **Fix to the test before RED was taken** (Interpretations 5 and 6):
  - plant a `test.step` title;
  - add the HTML and JUnit reporters to the self-test config;
  - scan them as a new `reports` channel.
  
  A second run (`red-c1.log`) failed `c1-planted` on its `htmlFill` check. The HTML report's data JSON-escapes the quote (`"title":"Fill \"…`). I corrected the pattern and checked it against that run's report.

**Final C1 RED.** `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract --verbose tests/contract/m1-s6a/c1-pertest-secrets.test.ts`: **3 passed, 8 failed**, 350 s (`red-c1-final.log`).

| Test | Result | Why | Turns green with |
|---|---|---|---|
| `c1-ran` | PASS | The inner test failed on purpose with both deliberate errors and planted 3 secrets; podman showed no difference before and after. | n/a |
| `c1-planted` | PASS | Every channel carries the planting context (positive control). | n/a |
| `c1-neg` | PASS | With the feed off, the scan finds leaks in all 7 channels (`c1-neg-summary.json`: trace 12, stdout 3, errors 3, steps 1, attachments 6, reports 6, console 3). The switch does not exist yet, so this run behaves like any pre-C1 run. | n/a (it must keep passing) |
| `c1-redacted-trace` | **FAIL** | 12 leaks, 4 per secret. They sit in `test.trace` and `0-trace.trace` (`fill`/`type` params, the `Fill "…"`/`Type "…"` step titles, the console message) and in the DOM-snapshot resources. | C1 harness fix |
| `c1-redacted-stdout` | **FAIL** | 3 leaks: `stdout[0]`, `stdout[1]`, `stderr[0]`. | C1 harness fix |
| `c1-redacted-errors` | **FAIL** | 3 leaks: `errors[0]` and `error` (the token in the soft failure), `errors[1]` (the master password). | C1 harness fix |
| `c1-redacted-steps` | **FAIL** | 1 leak: the `test.step` title. | C1 harness fix |
| `c1-redacted-attachments` | **FAIL** | 6 leaks: `pertest-body.txt` and `pertest-file.txt`. The fixture-made attachments (`browser-console.log`, `server.log`, …) were already clean, because the fixtures redact with the worker's full list. | C1 harness fix |
| `c1-redacted-reports` | **FAIL** | 6 leaks in `junit.xml` (system-out, failure message). | C1 harness fix |
| `c1-redacted-console` | **FAIL** | 3 leaks in `playwright-console.log`: the live stdout chunks, plus the `list` epilogue (error message and the inline `pertest-body.txt`). | C1 harness fix |
| `c1-redacted-all` | **FAIL** | 189 leaks. 79 are per-test secrets and 109 are hits of the harness-password pattern, all at the planted places, including `error-context.md` (which now carries the errors), `output/…/pertest-file.txt` (the original of an attached file) and `html/data/*` (the HTML report's copies). **1 was a scanner false positive:** `cookie=x.value` in `html/trace/assets/*.js`, the trace viewer app that Playwright copies into every HTML report. After this run, both this scan and M1-S6's `ac20-redacted` scan exclude `html/trace/`; the report's data stays scanned (`html/data/`, and the zip inside `index.html`). | C1 harness fix |

**What RED shows.** The review's C1 failure scenario is real: the per-test master password typed into the page reaches `trace.zip`, the HTML report's copy of it, JUnit, the JSON report and the run's console. The same holds for the per-test account password and Data API token.

**C4, from run 1:** **2 passed, 3 failed**.

| Test | Result | Why |
|---|---|---|
| `c4-keep-dev` | **FAIL** | The persistent `cli.ts up` stack was removed (`{container: false, network: false, volume: false}`). |
| `c4-keep-live` | **FAIL** | The stack owned by a live process was removed. |
| `c4-sweep-dead` | **FAIL** | The resources are gone, which is right, but the dead stack's descriptor is left behind. |
| `c4-sweep-orphan`, `c4-sweep-contract` | PASS | The controls: the sweep still removes these. |

**Leftovers:** `podman ps -a`, `network ls` and `volume ls` are identical before and after every run (`podman-before.txt`, `podman-after-red1.txt`), and the descriptor dir is empty. The three images under test were kept on purpose (`NOTESTEAD_KEEP_IMAGE=1`) for the GREEN runs; they are removed at the end of the story.
