# DNS-1: the web proxy intermittently fails to resolve `server` (502). Test plan and work orders

- **Origin:** CI-M2-S2 finding I (`docs/test-plans/CI-M2-S2-x64-arm64.md` on `test/M2-S2-ci-x64-arm64`, proof run 3, e2e 40020973008). The user split it out of M2-S2 on 2026-10-24, and decided the same day to fix DNS-1 before the CI fix branch merges.
- **Branch:** `feat/DNS-1-proxy-dns`, cut from `main`.
- **Inputs:** the investigation in `docs/worklog/DNS-1.md` (SE `8513a0d`, ci-cd runner side `0753528`); the CI evidence in `~/joplin-web-app-work/ci-evidence/<run>/` (runs 39663284028, 39768694985, 39957733152, 40020973008, 40075823250).
- **Planner:** qa-specialist (Opus), 2026-10-24. **Executor:** the Sonnet QA executor, through the work orders below.

## What is known (from the worklog)

- The CI error `dial tcp: lookup server: i/o timeout` with `"duration":3.00…` is Caddy's default 3 s `dial_timeout` expiring while Go's resolver (static Caddy, pure Go) still waits on the first `resolv.conf` nameserver. Go waits 5 s per nameserver (no `options` line: timeout 5, attempts 2) before it asks the next one.
- `web` sits on `front` and `back`, so its `resolv.conf` lists two aardvark gateways. One silent first gateway is enough for a 502, even when the second answers in microseconds.
- The SE reproduced the CI signature exactly with a UDP sink as the first nameserver: 502 at 3.002 s, 5 of 5. With `transport http { dial_timeout 10s }`: 200 at 5.006 s, 5 of 5.
- Why the first gateway goes silent in CI (podman 4.9.3) is **not proven**; the Pi (podman 5.4.2, aardvark-dns 1.14.0) never showed it in about 16 200 lookups. The runner's netavark and aardvark-dns versions are still unknown (ci-cd proposal P1).
- **Indirect effect** (ci-cd §4): the same episodes broke the E2EE device's seed sync. The device got 502s for 39 s, printed `Completed: … (39s) Last error: Error: Error 502 Bad Gateway`, still **exited 0** and printed `RESULT`, but never uploaded the master key. The headless service then looped on "no master key is currently loaded" until a 420 s or 600 s fixture timeout. Three cases in five runs.

**The fix the orchestrator dispatches (proposed by the SE):** `transport http { dial_timeout 10s }` in the `joplin_server_proxy` snippet of `deploy/web/Caddyfile`. This plan tests the behaviour, not the mechanism, except for one cheap static guard (DNS1-S1).

## Acceptance criteria (proposed; the architect may move them into the backlog)

| ID | Criterion |
|---|---|
| **DNS1-AC1** | A proxied request survives a first nameserver that never answers. Through `web`'s public listener (`:8080`) **and** its internal listener (`:8089`, the headless sync path), with a `resolv.conf` whose first nameserver is silent and whose next one is the network's real DNS, `GET /joplin-server/api/ping` returns 200 `{"status":"ok"}` from the server within **9 s**, and `web` logs no proxy error for it. |
| **DNS1-AC2** | No regression for POST and PUT under the same fault. A login (`POST /joplin-server/api/sessions`) that is the first upstream request of a fresh `web` returns the server's 200 and a session. A sync upload (`PUT /joplin-server/api/items/root:/<name>:/content`) made with that session lands on the server **exactly once** with the exact bytes (checked on the server directly, not through the proxy). |
| **DNS1-AC3** | A genuinely unreachable server still fails, boundedly and clearly. For each of "name does not exist", "connection refused", "address with no host" and "every nameserver silent", the proxied request ends with **502 or 504 within 15 s** (no hang, no 200), and `web` logs an error line for it. |
| **DNS1-AC4** | The E2EE test device fails fast and loudly when its seed sync fails (harness hardening, QA-owned). A seed sync that reports `Last error` makes the device exit non-zero within 150 s, without a `RESULT` line, naming the error. The stack harness also checks on the server that the seed uploaded a master key before it hands the account to a test. |
| **DNS1-AC5** | CI proof. In an e2e run that contains the fix, on both `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64): **zero** `web` lines with the old signature (`lookup server … i/o timeout` with a duration from 2.5 to 4.5 s), and **zero** device logs with `Last error`. Every other `lookup server` line is listed with its duration (see the decision rule under DNS1-C5). |

**Retiring the tie rule.** CI-M2-S2 lets `test/M2-S2-ci-x64-arm64` merge with arm64 failures that a `web.log` line ties to finding I. Once DNS1-AC5 passes, that exception is **retired**: a `lookup server` failure is then a regression again, with no tie-rule allowance.

## Acceptance → tests

All contract tests are in `tests/contract/dns-1/proxy-dns.test.ts` (one file, one joplin/server, one worker), results in `test-results/contract/dns-1/proxy-dns/`. Each case starts a **fresh `web` container**: Caddy keeps upstream connections alive, so only the first proxied request of a fresh `web` reliably dials and looks up. The web image is the one under test (the contract `globalSetup` build). The server runs on the suite network with `--network-alias server`, and every case's `JOPLIN_SERVER_URL` is `http://server:22300`, as in compose, unless stated otherwise.

**Fault injection (fixture F-SINK).**
- `tests/fixtures/dns-1/udp-sink.mjs` runs on the official Node image at a fixed address `<prefix>.53`. It binds UDP `0.0.0.0:53`, logs `ready` once it is listening, logs `query <n> <bytes> from <addr>` for each datagram, and **never answers**.
- `resolv.base` is podman's own `resolv.conf` for a container on the suite network, read from a labelled throwaway probe container (`podman run --rm --network <net> <nodeImage> cat /etc/resolv.conf`). It is never hand-written, so the test follows whatever podman 4.9.3 (CI) or 5.4.2 (Pi) generates. It is saved under the results dir, which also answers ci-cd question 3 (does the host resolver leak in?) for every runner.
- Variants: `resolv.sink-first` (the line `nameserver <prefix>.53` before the first `nameserver` line of the base), `resolv.sink-only` (the sink as the only nameserver, every other line kept).
- `web` gets the variant bind-mounted read-only at `/etc/resolv.conf`. Podman leaves a user-mounted `resolv.conf` alone on both 4.9 and 5.4; the image's own `--read-only` hardening stays on.
- **Self-checks in every fault case**, so a test cannot pass because the fault was not on the path:
  - `podman exec <web> cat /etc/resolv.conf` equals the mounted variant;
  - the sink's query count rises during the request.

**Timing.** Every request is timed with `performance.now()` around the HTTP call. Each case appends `{case, status, elapsedMs, sinkQueriesDelta}` to `test-results/contract/dns-1/proxy-dns/timings.json` as evidence.

| AC | Test ID | Layer | Fixture(s) | What it checks | Negative control | Data-level assertion | RED expectation |
|---|---|---|---|---|---|---|---|
| AC1 | `dns1-c0` | contract | server, F-SINK running, `web` with `resolv.base` mounted (no sink line) | baseline: `GET :8080/joplin-server/api/ping` → 200 in under 2.5 s; sink count unchanged | (is the control for c1: the mount itself is harmless) | body `{"status":"ok"}` comes from the server | **green** |
| AC1 | `dns1-c1` | contract | F-SINK, `web` with `resolv.sink-first` | `GET :8080/joplin-server/api/ping` → 200 within 9 s; sink got the lookup; no `lookup server` error line in `web` | `dns1-c1-neg` | body `{"status":"ok"}` | **red** (502 at about 3 s) |
| AC1 | `dns1-c1b` | contract | same, request on `:8089` | as c1, on the internal listener the headless uses | `dns1-c1-neg` | as c1 | **red** |
| AC1 NEG | `dns1-c1-neg` | contract | F-SINK, `web` with `resolv.sink-first` **and** a variant Caddyfile: the image's own `/etc/caddy/Caddyfile` (copied out with `podman create` + `podman cp`, as `ac11-r3-neg` does) with every `transport http { … }` block that sets `dial_timeout` removed, nothing else changed | the fault detects the defect: 502 with elapsed from 2.5 to 4.5 s; the `web` log has a line matching `/lookup server\b[^"]*i\/o timeout/`; the sink got the lookup | (is the negative control) | the server is never reached; nothing to read back | **green** (the shipped Caddyfile has no transport block yet, so the variant equals it); the test records whether a block was removed |
| AC2 | `dns1-c2` | contract | F-SINK, fresh `web` with `resolv.sink-first`, `:8080` | the first request is `POST /joplin-server/api/sessions` (user1) → 200 with a session id, within 9 s; then `PUT /joplin-server/api/items/root:/dns1-<rand>.md:/content` (a sync-format note, as in `tests/contract/m1-s4/proxy.test.ts` `noteItem`) → 200 | `dns1-c2-neg`: the same first POST through the `c1-neg` variant gets 502 at about 3 s, and the server shows no new session for the variant attempt (shown through `GET /api/items` being unchanged; see note 1) | **direct to the server** (published port), amended by decision D1 below: the note `<id>.md` matches field by field, and a 256 KiB blob `.resource/<id2>` matches byte for byte (sha256 and length); each name is listed exactly once | **red** |
| AC2 | `dns1-c2b` | contract | as c2, on `:8089` | the first request is the login POST → 200 with a session | (c2-neg) | the session works: `GET /api/items/root:/:/children` with it, **direct to the server**, returns 200 | **red** |
| AC3 | `dns1-c3a` | contract | `web` with `JOPLIN_SERVER_URL=http://nst-dns1-missing-<run>:22300` (a name that does not exist) | 502 or 504 within 15 s; an error line in `web` | (bounded-failure guard; see note 2) | none (nothing reaches a server) | **green** |
| AC3 | `dns1-c3b` | contract | `web` with `JOPLIN_SERVER_URL=http://<prefix>.53:22300` (the sink container: up, TCP 22300 closed) | 502 or 504 within 15 s; error line | (note 2) | none | **green** |
| AC3 | `dns1-c3c` | contract | `web` with `JOPLIN_SERVER_URL=http://<prefix>.250:22300` (an address with no container) | 502 or 504 within 15 s; error line | (note 2) | none | **green** |
| AC3 | `dns1-c3d` | contract | F-SINK, `web` with `resolv.sink-only`, `JOPLIN_SERVER_URL=http://server:22300` | 502 or 504 within 15 s; error line; the sink got the lookup | (note 2) | the server's item list for user1 is unchanged (direct) | **green** |
| AC1-3 | `dns1-s1` | unit | `deploy/web/Caddyfile` (read as text) | the `(joplin_server_proxy)` snippet's `reverse_proxy` block contains a `transport http` block with `dial_timeout` from 6 s to 15 s (Go's 5 s per nameserver plus at least 1 s; at most AC3's bound); `import joplin_server_proxy` appears exactly twice (`:8080` and `:8089`); amended by decision D2: the `reverse_proxy` block is located by its line, and must contain `header_up Host` | the RED state itself (no transport block) | none (static) | **red** |
| AC4 | `dev1-c1` | contract | the device fixture image (`deviceImage()`), a fresh account (`createUser`), a normal `web` (no sink) | the device exits 0 with a `RESULT` line | `dev1-neg` | **direct to the server**: `info.json` has at least one master key and `e2ee.value` true (through `checkSeededInfo`) | **green** |
| AC4 NEG | `dev1-neg` | contract | the device image; a `web` whose `JOPLIN_SERVER_URL` is `http://<prefix>.53:22300` (refused, so every sync request gets a 502) | the device exits **non-zero** within 150 s, prints no `RESULT` line, and its stderr has `SEED SYNC FAILED` and `Last error` | (is the negative control) | none (nothing can reach a server) | **red** (exits 0 with `RESULT` today) |
| AC4 | `dev1-u1` | unit | `tests/stack/seedCheck.ts` `checkSeededInfo(status, text)` | returns `undefined` for a real-shaped `info.json` with master keys and E2EE on; returns a reason for a 404, invalid JSON, `masterKeys: []`, a missing `masterKeys` and `e2ee.value: false` | (each rejected case is a negative) | n/a | **red** (module missing) |
| AC5 | `dns1-c5` | CI evidence | `tests/harness/tools/scan-proxy-dns.ts` over the run's downloaded artifacts | the AC5 counts per runner, from every `*_web_1.log`, every `web*.log` and every `device-*.log` | the tool, run on the 5 old runs, reproduces the evidence, amended by decision D3: 225 old-signature lines (x64 79, arm64 146), 8 NXDOMAIN lines reported but not counted, and 3 device logs with `Last error` | n/a | n/a (runs after the fix) |
| AC5 | `dns1-u5` | unit | `tests/support/proxyDnsScan.ts` | parses Caddy JSON lines: counts `lookup <name> … i/o timeout` errors, buckets them by `duration` (old signature 2.5 to 4.5 s, other), ignores the `no such host` NXDOMAIN lines of AC20-style tests, finds `Last error` in device logs | the NXDOMAIN and clean-device samples must count 0 | n/a | **red** (module missing) |

**Notes.**
1. `dns1-c2-neg`'s server-side check reads user1's item list before and after the attempt, directly on the server. A 502 at the lookup means nothing was sent, so the list must be unchanged.
2. The AC3 cases are **guards** and pass before and after the fix. Their job is to stop a later change that hangs or turns a dead upstream into a long wait (a `dial_timeout` above 15 s, or a large `lb_try_duration`). Their negative is the bound itself. They have no fix-dependent NEG.
3. Bounds, and the margin each gives:

   | Case | Expected (SE's measurements) | Bound |
   |---|---|---|
   | c0 | 4 ms | under 2.5 s |
   | c1 | 5.006 s | 9 s, below the 10 s dial timeout |
   | NEG | 3.002 s | 2.5 to 4.5 s |
   | c3d | about 10 s | 15 s |

   **Bounds are planner-owned.** If a measured value falls outside one, the executor stops and reports it. It never widens the bound itself.

**Decision rule for DNS1-C5:**
- Old-signature lines = 0 on both runners, and device `Last error` = 0: **PASS**.
- Any old-signature line: **FAIL**. The fix is not in the image that ran.
- Lines with a duration of about 10 s (both nameservers silent for more than 10 s) mean the hypothesis is wrong. That is **FAIL**, with a new finding for the planner, not a bound change.
- `no such host` lines from the tests that stop `server` on purpose are expected and not counted.

## Device seed sync: folded into this story (decision)

**Decision: fold it in as harness hardening (DNS1-AC4), and do not route it.** Why:
- It is QA-owned code only: `tests/fixtures/m1-s5/device/device.mjs`, `tests/stack/stack.ts`, a new `tests/stack/seedCheck.ts`. No product code is involved, and no other agent needs dispatching.
- It is the same incident. A 3 s DNS blip became a 420 s or 600 s fixture timeout, with a misleading symptom ("no master key") in a different container. Without the hardening, DNS1-AC5's evidence can't be attributed cleanly.
- It is small and has a clean negative control (`dev1-neg`).

**The rule:** fail fast and loudly, **never retry**. A retry would hide exactly the class of fault this story is about. If a seed sync fails, that test fails at once with the device log path, and CI's own retry policy (strategy §6) applies as for any failure.
- **In the device:** after the batch, the output must contain at least one `Completed:` line and **no** line containing `Last error:`. Otherwise the device writes `SEED SYNC FAILED: <that line>` to stderr and exits 3, before `RESULT`. The CLI's own output keeps streaming as now, so the log keeps the cause.
- **In the stack harness:** `enableE2ee` reads `info.json` from the server directly (`serverItemContent`) after a successful device run, and throws if `checkSeededInfo` returns a reason. This is a data-level post-condition, in line with CLAUDE.md "assert on data". The device-level check is the primary one; this catches any silent upload failure the CLI does not report.
- **Out of scope:** the contract helper `seedDevice` in `tests/contract/support/headless.ts` gets the device-level check for free. It does not get the `info.json` post-condition: those suites assert on decrypted data themselves.

## SQLITE_IOERR on arm64: a watch item, routed (no link to DNS-1)

- **Where:** run 40075823250 arm64, `tests/e2e/m2-s1/e2ee-unlock.spec.ts:181`, "M2-AC2 NEG a wrong master password …", attempt 1. The evidence is in `~/joplin-web-app-work/ci-evidence/40075823250/extracted/test-results-e2e-ubuntu-24.04-arm/test-results/e2e/output/m2-s1-e2ee-unlock-M2-S1-E2-8f8b5--error-nothing-is-decrypted-chromium/browser-console.log` lines 30-34. The browser logged `sqlite3_step() rc= 10 SQLITE_IOERR` on `CREATE TABLE migrations`, then `Startup failure during task: buildStartupTasks/openDatabase`, 1 s after start. The test then timed out waiting for the Synchronisation dialog. The retry passed.
- **No link to DNS:** it happens in the browser's OPFS during the first database open, before any network request. There are 0 `502` lines in that console log.
- **Routing:** watch item **W-DNS1-1**, to M2-S3's QA (the web E2E owner), under the strategy §6 flake policy. If it recurs within a week, it becomes a bug with a root cause. Candidates are OPFS on the arm64 runner's disk under parallel contexts, or an upstream wa-sqlite/OPFS startup race. The first step then is to attach the context's storage state and the runner's free disk. **No work order in this story.**

## Out of scope

- The root cause on the runner (aardvark-dns version, reload behaviour). The **ci-cd P1** read-only log step (`podman info` network backend, `dpkg-query`, one container's `resolv.conf`) is recommended to the orchestrator as a separate ci-cd dispatch. The `resolv.base` copies this suite saves in CI give part of that answer for free.
- `dns_opt: ["timeout:1", "attempts:2"]` in compose (SE option D). The user compose is M5 (follow-up b in the worklog). The test stack (`tests/stack/compose.yaml`) deliberately does **not** get it now: CI must keep showing the user-facing behaviour of the shipped image (ci-cd's P2 caveat). If M5 adopts it, M5's plan adds an "about 1 s" case.
- The headless 30 s readiness retry (worklog follow-up d): a headless story.
- `lb_try_duration` (option B): not adopted. If it is ever added, `dns1-c3*`'s 15 s bound guards it.

## Work orders (QA executor)

General rules for every WO:
- Write only under `tests/**`, `docs/test-plans/DNS-1.md` (the RED and validation sections only) and `docs/testing/strategy.md` (WO-8).
- Never touch `deploy/**`, `packages/**` or `.github/**`.
- One heavy job at a time on the Pi; long runs in the background with a timeout.
- No `.only`, no skips, no fixed sleeps (`waitFor` / `expect.poll` only).
- Never change a bound or an expectation in this plan.
- Every commit ends with:
  ```
  Agent: qa-specialist
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HDZtZf644tRb9aJyBFPmyj
  ```
- **At a HARD STOP you may only:** read logs, copy evidence into `test-results/` or the session scratchpad, record what you saw in your report, and report. No further code edits, commits or test runs.

### WO-0: Pre-flight (no commit)
1. `git status` is clean, and the branch is `feat/DNS-1-proxy-dns`.
2. Record `podman version`, plus `podman info --format '{{json .Host.NetworkBackendInfo}}'`.
3. `podman ps -a`, `podman network ls`: record. Only the user's own `byparr` items may exist. Any `nst-*` leftover goes to `node tests/stack/cli.ts down` **only if** its descriptor is yours. Otherwise **HARD STOP**.
4. Set `NOTESTEAD_KEEP_IMAGE=1` for every run in this story (worklog §7: `down` otherwise removes the shared images).

### WO-1: Fixtures and helpers (part of the RED commit of WO-2)
1. `tests/fixtures/dns-1/udp-sink.mjs`, as specified under F-SINK. It is about 15 lines and uses `node:dgram`; it logs to stdout; it never calls `send`.
2. `tests/contract/support/services.ts`:
   - `startJoplinServer` gets an optional `aliases?: string[]`, passed as `--network-alias <a>`;
   - `startWeb` gets an optional `resolvConf?: string`, mounted `<file>:/etc/resolv.conf:ro,Z`.

   Existing callers stay unchanged.
3. `tests/contract/support/dns.ts`:
   - `startSink(stack)`: host 53, waits for `ready` in its log;
   - `sinkQueries(name)`: the count of `query` lines;
   - `baseResolvConf(stack)`: the probe container, labelled with the test and run labels and `--rm`;
   - `writeResolvVariants(stack, base, sinkIp)`: `sink-first` and `sink-only`. It throws if the base has no `nameserver` line;
   - `timedRequest(...)`: wraps `request` with `performance.now()`;
   - `noDialTimeoutCaddyfile(stack)`: the image's Caddyfile minus any `transport http { … }` block that contains `dial_timeout`. It returns `{ file, removedBlocks }`;
   - `recordTiming(...)`: appends to `timings.json`.

### WO-2: The DNS contract tests and the static guard (RED commit)
1. `tests/contract/dns-1/proxy-dns.test.ts`: `dns1-c0`, `c1`, `c1b`, `c1-neg`, `c2`, `c2-neg`, `c2b`, `c3a` to `c3d`, exactly as in the table.
   - `createStack('proxy-dns', 'dns-1')`; the server at host 30 with alias `server`; the sink at 53; each case's `web` at its own host number (20 to 29, then 40 to 49).
   - Every `web` the file starts is removed in `afterAll` through `teardownStack` (logs written, redacted).
   - The `c1-neg` and `c2-neg` assertions also record `removedBlocks` in `timings.json`, so the VERIFY run can show 1 removed block (after the fix) where RED showed 0.
2. `tests/unit/deploy/caddyfile-dial-timeout.test.ts`: `dns1-s1`. Use plain text parsing with brace matching over the snippet; accept the `s` and `ms` units.
3. `corepack yarn lint`: clean.
4. Commit: `test(contract): DNS-1 proxy survives a silent first nameserver (RED)`.

### WO-3: The device hardening tests (RED commit)
1. In the same contract file, a second `describe`: `dev1-c1` and `dev1-neg`.
   - Use `deviceImage()` and `createUser` from `tests/contract/support/headless.ts`.
   - Write a local `runDevice(stack, web, user, master, label)` that mirrors `seedDevice`'s `podman run --rm -i` (secrets on stdin only, `runLogged` with the secrets, so the log is scrubbed). It measures the elapsed time.
2. `tests/unit/harness/seedCheck.test.ts`: `dev1-u1`. Use real-shaped `info.json` samples: take one from a passing stack (`serverItemContent(state, account, 'info.json')` during WO-6's run, or from a run's results) and **strip the key material**. Keep only the structure: `version`, `e2ee`, an id-only `masterKeys` entry.
   - The test imports `checkSeededInfo` from `tests/stack/seedCheck.ts`, which does not exist yet, so it is red.
3. Lint clean. Commit: `test(harness): DNS-1 the E2EE device must fail on a seed sync error (RED)`.

### WO-4: The device hardening (QA-owned harness code; green commit)
1. `tests/fixtures/m1-s5/device/device.mjs`: the rule under "Device seed sync" (no `Completed:` line, or any `Last error:` line → stderr `SEED SYNC FAILED: …`, exit 3, no `RESULT`). Update the header comment.
2. `tests/stack/seedCheck.ts`: `checkSeededInfo(status, text): string | undefined`.
3. `tests/stack/stack.ts` `enableE2ee`: the post-condition, with its error naming the device log path. It needs `async`. Check every caller with `grep -rn "enableE2ee(" tests/`, and await them. If a caller cannot become async without a fixture redesign, **HARD STOP** and report the call site.
4. Lint clean. Commit: `test(harness): the E2EE device fails fast on a seed sync error (DNS1-AC4)`.

### WO-5: The CI scan tool (commit)
1. `tests/support/proxyDnsScan.ts` (pure functions) and `tests/unit/harness/proxyDnsScan.test.ts`: `dns1-u5`, with synthetic lines modelled on real ones (no tokens; the logs are redacted already).
2. `tests/harness/tools/scan-proxy-dns.ts`: `node tests/harness/tools/scan-proxy-dns.ts <dir>…` walks the directories and prints a JSON summary per runner directory. The runner is taken from the `test-results-e2e-<runner>` folder name. The summary has: old-signature lines, other-duration lines, NXDOMAIN lines (reported, not counted), and device logs with `Last error`. Duplicated attachment copies must be counted once: dedupe by file content hash.
3. **Validation (`dns1-c5` NEG):** run the tool over the five runs in `~/joplin-web-app-work/ci-evidence/*/extracted/`. It must reproduce the ci-cd totals (x64 82, arm64 151; 225 at 3.00x s; 3 device logs).
   - If it differs, find out why (dedupe rule, file set) and report the difference.
   - **Do not tune the tool to the number.** If the cause is not clear after reading the files, **HARD STOP**.
4. Commit: `test(harness): DNS-1 CI scan for proxy lookup timeouts and failed seed syncs`.

### WO-6: The RED run on the Pi (no commit)
1. `corepack yarn jest tests/unit/deploy tests/unit/harness/seedCheck.test.ts tests/unit/harness/proxyDnsScan.test.ts`. Expect `dns1-s1` red (no transport block). `dev1-u1` and `dns1-u5` are green after WO-4 and WO-5.
2. In the background, with a 40 min timeout: `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract tests/contract/dns-1 --verbose`.
3. **Expected:**
   - **red:** `dns1-c1`, `c1b`, `c2`, `c2b` (each 502 at about 3 s with the sink's query count rising);
   - **green:** `dns1-c0`, `c1-neg` (with `removedBlocks` 0), `c2-neg`, `c3a` to `c3d`, `dev1-c1`, `dev1-neg` (after WO-4).
4. Prove that `dev1-neg` was red before WO-4, without touching the working tree: `git worktree add ~/joplin-web-app-work/spikes/DNS-1/qa-red <WO-3 sha>`. From there, run only `-t dev1-neg` and record the output (expected: the device exits 0 with `RESULT`, so the test fails). Then `git worktree remove --force` it.
5. **HARD STOP** if any outcome differs from the list above. Examples:
   - c0 not under 2.5 s;
   - NEG elapsed outside 2.5 to 4.5 s;
   - a fault case with no sink query;
   - the mounted `resolv.conf` differs inside `web`;
   - a red test failing for any reason other than the 502 at about 3 s.

   Copy the timings, the `web` logs and the `resolv.base` into the report.

### WO-7: Fix simulation, to prove the tests can go green (no commit, scratch only)
1. Make a `git worktree add ~/joplin-web-app-work/spikes/DNS-1/qa-fixsim HEAD`. In **that worktree only**, add `transport http { dial_timeout 10s }` inside `reverse_proxy` in the `joplin_server_proxy` snippet of `deploy/web/Caddyfile`. This is the SE's change, simulated outside the repo's branch.
2. From the worktree, run `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract tests/contract/dns-1 --verbose` (globalSetup builds its own web image from the worktree), and `corepack yarn jest tests/unit/deploy`.
3. **Expected:** every test green; `c1-neg` reports `removedBlocks` 1 and still gets a 502 at about 3 s; `c1` and `c2` about 5 s; `c3d` about 10 s.
4. Then `git worktree remove --force` it, and confirm `git worktree list` shows only the repo.
5. **HARD STOP** if anything is not green: report the timings and logs. Never "fix" the test to pass in the worktree.

### WO-8: Strategy (`docs(testing)` commit)
In `docs/testing/strategy.md`:
- **fixtures:** F-SINK (the silent-nameserver fault injection, the derived `resolv.conf`, and the self-checks);
- **harness rules:** a seed sync's `Last error` fails the device; `enableE2ee`'s `info.json` post-condition; the scan tool as the CI evidence for proxy DNS;
- **watch list:** W-DNS1-1;
- **flake policy:** a `lookup server … i/o timeout` in CI after DNS-1 is a regression, and the tie rule is retired.

Commit: `docs(testing): DNS-1 fault-injection fixture, seed sync rule, CI scan`.

### WO-9: Record and report (`docs(test-plans)` commit), then HARD STOP
1. Append to this file:
   - `## RED (DNS-1, <date>, Pi arm64)`: the commands, the per-test outcomes, the durations, the `timings.json` content and the log paths;
   - `## Harness validation`: WO-5's numbers and WO-7's result.
2. Commit: `docs(test-plans): DNS-1 RED and harness validation`.
3. **HARD STOP.** Report to the orchestrator: the commits, the outcomes and any deviation. The SE dispatch follows.

### Later, the VERIFY dispatch (planned now, ordered after the SE reports done)
- **V1:** the unit tests; `tests/contract/dns-1`; then `tests/contract/m1-s4` (proxy, headers, rate-limit, static: proxy regressions, including POST bodies and large uploads); then the full contract layer; then the full E2E suite (1 worker). One at a time, on the Pi.
- **V2:** `git log --format='%h %s%n%b' main..HEAD -- tests/` shows only QA commits.
- **V3:** the CI proof run, which the orchestrator arranges (a branch that has both this fix and the CI-M2-S2 branch). Then `scan-proxy-dns.ts` over its artifacts per runner, and the DNS1-C5 decision rule.
- **V4:** append `## Results`, and resolve the Disputes.

## What the senior engineer implements (after WO-9; `deploy/web/**` only)

1. **`deploy/web/Caddyfile`**, in the `(joplin_server_proxy)` snippet, inside `reverse_proxy {$JOPLIN_SERVER_URL} { … }`:
   ```
   transport http {
       dial_timeout 10s
   }
   ```
   It needs a comment that says why: Go's resolver waits 5 s per `resolv.conf` nameserver, and Caddy's default 3 s dial timeout turned one silent first nameserver into a 502 (DNS-1). It must stay at most 15 s, so a dead server still fails fast (DNS1-AC3). Nothing else in the file changes. Both listeners already import the snippet.
2. **`deploy/web/README.md`:** a short note on the user-facing behaviour. A slow first nameserver costs up to about 5 s instead of a 502, and an unreachable server is reported as a 502 within about 10 s, where it was 3 s.
3. **`docs/worklog/DNS-1.md`:** the implementation section (the commands, and the test evidence from `tests/contract/dns-1`, `tests/unit/deploy` and `tests/contract/m1-s4`). It must state that no ADR deviates. ADR-0006's name-based topology is kept.
4. **Not in scope for the SE:** `tests/**` (disputes go below), compose `dns_opt` (M5), `lb_try_*`, and any change to `packages/**`.
5. **Done when:** `dns1-s1`, `dns1-c1`, `c1b`, `c2` and `c2b` are green; the rest of `tests/contract/dns-1` stays green; and `corepack yarn lint` is clean.

## Planner decisions after the WO-7 HARD STOP (2026-10-24)

Executor commits so far: `0be311d` (WO-1/2 RED), `8e00acb` (WO-3 RED), `630507f` (WO-4), `a334db3` (WO-5). The WO-6 outcomes match the plan. The WO-7 fix simulation timings are c1 5014 ms, c1b 5011, c2 5252, c2b 5250 and c3d 10013, and the negatives still got 502 at about 3 s with `removedBlocks` 1. All of these are inside every bound. Two test bugs stopped it.

### D1: `dns1-c2`'s "exactly once, intact" check (test bug 1)
**Decision: both, a field-level note check and a byte-exact blob.** The note keeps the realistic sync payload. The blob gives the byte-for-byte strength, which a note cannot have, because Joplin Server re-serializes notes: it appends `is_locked:` and `extracted_resource_ids:`. This is the same split as M1-S4 `ac10-c3`, which checks a marker for notes and exact bytes only for blobs.
- **Order on the fresh `web`:**
  1. the login POST, the first upstream request (unchanged, with all its current assertions);
  2. `PUT /joplin-server/api/items/root:/<id>.md:/content` with the `noteItem` text;
  3. `PUT /joplin-server/api/items/root:/.resource/<id2>:/content` with 256 KiB of `randomBytes`, `Content-Type: application/octet-stream`.

  Both PUTs must return 200.
- **Note, read directly on the server:** a parser `parseJoplinItem(text)` returns `{ title, body, props: Map }`. The props come from the trailing `key: value` block, and the title and body from the lines before it, in Joplin's serialization. Then:
  - `compareUploadedItem(uploaded, stored)` returns the list of differences. It must be empty;
  - title and body are exactly equal;
  - **every** uploaded property is present with an identical value, `id` included;
  - extra stored keys are allowed and are recorded in `timings.json` as `extraKeys`, not asserted (they are the server's, at the pinned tag).
- **Blob, read directly on the server:** the sha256 and the length are equal.
- **Exactly once:** `root:/:/children`, read directly, lists `<id>.md` exactly once and `.resource/<id2>` exactly once. If the listing does not show `.resource/` names at the pinned tag, read `GET /api/items/root:/.resource/<id2>:` (the metadata) and assert 200 instead. Record which path was used.
- **The parser's own negative:** `tests/unit/harness/joplinItem.test.ts`. It must show that:
  - the same text gives no differences;
  - the server-appended keys give no differences;
  - a changed body, a changed title, a changed property value and a missing property each give exactly one named difference.

  The parser and the comparison live in `tests/contract/support/joplinItem.ts`.
- **The RED state is unchanged:** c2 still fails at the login with a 502 at about 3 s.

### D2: `dns1-s1` (test bug 2)
**Decision:** find the block by its line, not by the variable name.
- The opener is the `reverse_proxy` line inside the snippet, `/^[ \t]*reverse_proxy\b[^\n]*\{[ \t]*$/m`. The block opens at that line's **last** `{`.
- The proposed `reverse_proxy\s+\{\$JOPLIN_SERVER_URL\}\s*\{` is rejected: it would break if the upstream placeholder were renamed, and it hides the same class of bug.
- **A sanity assertion inside s1:** the extracted block contains `header_up Host`. So a wrong block fails loudly instead of failing on `transport`.
- **Proof matrix (WO-7b), mandatory:**

  | Caddyfile state | Expected result |
  |---|---|
  | branch HEAD (no fix) | **red**, and only at the `transport` assertion |
  | the fix with `10s` | green |
  | `3s` | red at the lower bound |
  | `20s` | red at the upper bound |
  | `transport http { dial_timeout 10s }` placed in a second, unrelated `reverse_proxy` outside the snippet | red at the `transport` assertion |

  WO-6's red for s1 is **void**. The matrix replaces it.

### D3: the deviations
- **The scan counts: accepted, and the plan's expectation was wrong.** The ci-cd total of 233 counted every `lookup server` line. The plan said "233 lines … 225 with a 3.00x s duration", and those 8 others are the NXDOMAIN `no such host` lines at 0.0 s, which the plan itself says not to count. I checked independently: unique `lookup server: i/o timeout` lines per run in the stack `*_web_1.log` files are 4, 23, 47, 60 and 91, which is 225. Corrected expectation: 225 (x64 79, arm64 146), plus 8 NXDOMAIN reported separately, plus 3 device logs.
- **The line-level dedupe: accepted, on two conditions:**
  - the dedupe key is the **whole raw line**: Caddy's `ts` has sub-millisecond precision, so two genuine events never share a line;
  - the tool reports how many lines each file contributed after the dedupe.

  The `web*.log` attachments are slices of the stack logs, so counting them twice would be wrong. WO-7c adds a unit case for it.
- **`seedCheck.ts` as a throwing stub in the RED commit: accepted.** It was red for the right reason (not implemented), and it is green after `630507f`.
- **`dns1-u5` written together with its module (no red-before-green): accepted only with a mutation proof** (WO-7c). Its integration proof is the 225/8/3 reproduction.
- **`dns1-c2`'s name `<id>.md` instead of `dns1-<rand>.md`: accepted.** The server requires id-based item names; my plan text was wrong.
- **Device containers without a fixed IP: accepted.** Nothing addresses the device.
- **The nested `describe` for dev1: accepted.** It shares the file's server and the `afterAll` teardown.

### Follow-up work orders (executor). The rules of "Work orders" apply, including the HARD STOP rule

#### WO-7a: D1, the c2 rewrite (commit)
1. Write `tests/contract/support/joplinItem.ts` and `tests/unit/harness/joplinItem.test.ts` as in D1. Run the unit test first and record it red: the module does not exist yet. Then write the module, and record the unit test green.
2. Rewrite `dns1-c2` in `tests/contract/dns-1/proxy-dns.test.ts` as in D1. Don't change any other case.
3. `corepack yarn lint`: clean.
4. Commit: `test(contract): DNS-1 c2 checks the note field by field and a blob byte for byte`.
5. **HARD STOP** if the server answers the blob PUT or the listing differently from D1 in a way that D1's fallback does not cover. Report the status and the body, and nothing else.

#### WO-7b: D2, s1 (commit after the matrix)
1. Change the opener in `tests/unit/deploy/caddyfile-dial-timeout.test.ts` and add the `header_up Host` sanity assertion, as in D2.
2. **On branch HEAD:** run `corepack yarn jest tests/unit/deploy`. It must be red **only** at the `transport` assertion. Record the failure message.
3. **The matrix in a scratch worktree:** `git worktree add ~/joplin-web-app-work/spikes/DNS-1/qa-s1 HEAD`. Edit `deploy/web/Caddyfile` **there only**, once per row of D2's matrix, and run the same command from the worktree for each row. Record each row's result and failure message. Then `git worktree remove --force`, and check `git worktree list`.
4. Commit (the branch only, test file only): `test(unit): DNS-1 s1 finds the reverse_proxy block past the upstream placeholder`.
5. **HARD STOP** if any row differs from the matrix.

#### WO-7c: dns1-u5's sensitivity and the dedupe (commit only if a test is added)
1. If `tests/unit/harness/proxyDnsScan.test.ts` has no case where the same raw line appears in two files and is counted once, plus a case where two lines differ only in `ts` and are counted twice, add both. Then commit: `test(harness): DNS-1 scan dedupe cases`.
2. **Mutations in a scratch worktree** (`~/joplin-web-app-work/spikes/DNS-1/qa-u5`, removed afterwards). Apply each one alone to `tests/support/proxyDnsScan.ts` and run `corepack yarn jest tests/unit/harness/proxyDnsScan.test.ts`:
   - (i) the old-signature lower bound 2.5 s set to 0;
   - (ii) NXDOMAIN lines counted as timeouts;
   - (iii) the dedupe disabled;
   - (iv) the device `Last error` match removed.

   Each mutation must make at least one test red. Record which test went red for each.
3. Re-run the scan over the five runs on HEAD and record: 225 (x64 79, arm64 146), 8 NXDOMAIN with their file paths, and 3 device logs with their paths.
4. **HARD STOP** if a mutation survives (no test goes red), or if the numbers change.

#### WO-7d: the RED re-run on HEAD (no commit)
1. In the background, with a 40 min timeout: `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract tests/contract/dns-1 --verbose`.
2. Then `corepack yarn jest tests/unit`.
3. **Expected:**
   - **red:** `dns1-c1`, `c1b`, `c2`, `c2b` (each a 502 at about 3 s, with the sink's count rising; c2 at the login), and `dns1-s1` (at `transport` only);
   - **green:** everything else, including `joplinItem`, `seedCheck` and `proxyDnsScan`.
4. **HARD STOP** if anything differs.

#### WO-7e: the fix simulation re-run (no commit)
1. Run WO-7 again, in a fresh worktree at the new HEAD, with the 10 s fix applied in the worktree only.
2. **Expected:** every test green, `dns1-s1` included. c2 records `extraKeys`. The negatives still get a 502 at about 3 s with `removedBlocks` 1. The timings are inside every bound.
3. Remove the worktree.
4. **HARD STOP** on any red. Report the timings and the logs; never adjust a test in the worktree.

#### Then WO-8 and WO-9 as written
WO-9's RED section also records:
- the void WO-6 s1 red, and D2's matrix in its place;
- the WO-7c mutation table;
- the corrected counts;
- every deviation, with D3's verdict on it.

## QA review of the implementation and the VERIFY plan (planner, 2026-10-24)

**The executor's WO-7a to WO-9:** `625b1d2`, `266c0ed`, `39385b8`, `db41d01` and `b7e5521`, with no HARD STOP. The s1 matrix, the u5 mutations, the WO-7d RED and the WO-7e fix simulation (13/13) all match D1 to D3. **Accepted.**

### The SE diff (`385718b`, `5d59f5c`) against "What the senior engineer implements"
- **`deploy/web/Caddyfile`:** exactly the planned block, `transport http { dial_timeout 10s }`, inside `reverse_proxy` of `(joplin_server_proxy)`, with the required comment (Go's 5 s per nameserver, Caddy's 3 s default, stay at most 15 s). Nothing else changed. **OK.**
- **`deploy/web/README.md`:** the behaviour note as asked. **OK.**
- **`docs/worklog/DNS-1.md`:** the implementation section, the commands, "no ADR deviates", and the follow-ups. **OK.**
- **V2, test integrity (done by reading):** `git log --format='%h %an %s | %(trailers:key=Agent,valueonly)' main..HEAD -- tests/` lists 7 commits, all `Agent: qa-specialist`: `0be311d`, `8e00acb`, `630507f`, `a334db3`, `625b1d2`, `266c0ed`, `39385b8`. **The SE did not touch `tests/**`.**
- **The "c1 6.6 s" question:** **within tolerance, and not a regression.**
  - The SE quoted Jest's **test durations**: 6599, 6530, 6938, 7094 and 11552 ms. Those include starting the fresh `web` container.
  - The request times the bounds apply to are in `test-results/contract/dns-1/proxy-dns/timings.json`, written 13:18:22 by the run whose `Caddyfile.image:73` carries `dial_timeout 10s`:

    | Case | Status | Elapsed |
    |---|---|---|
    | c0 | 200 | 12 ms |
    | c1 | 200 | 5011 ms (Caddy's own log: `"duration":5.0067`) |
    | c1b | 200 | 5015 ms |
    | c2 | 200 | 5252 ms (extra keys `is_locked`, `extracted_resource_ids`; listing `children`) |
    | c2b | 200 | 5239 ms |
    | c1-neg | 502 | 3006 ms (`removedBlocks` 1) |
    | c2-neg | 502 | 3009 ms |
    | c3a | 502 | 14 ms |
    | c3b | 502 | 6 ms |
    | c3c | 502 | 3080 ms |
    | c3d | 502 | 10007 ms |
    | dev1-neg | exit 3, no `RESULT` | 32.9 s |

    These equal the WO-7e simulation to within 15 ms, and every bound has a margin of 4 s or more.
  - The mounted `resolv.base` is `search dns.podman` / `nameserver 10.89.200.1` (podman 5.4.2: aardvark only, no host resolver).
  - **Process note for the lead (non-blocking):** worklog evidence should quote `timings.json`, not Jest durations. `test-results/` is not committed, so V4 copies these figures into `## Results`.

### Which VERIFY steps need a heavy run
- **V1: two heavy runs are needed. Reading is not enough here.**
  - WO-4 changed the E2EE device (`tests/fixtures/m1-s5/device/device.mjs`), and made `enableE2ee` async with a server-side `info.json` post-condition. Every E2E test (`tests/e2e/support/fixtures.ts:176`, `upDefault`) and the m1-s5, m1-s6, m1-s6a and m1-s7 contract suites run through these.
  - The SE's change sits on the `:8089` path the headless syncs through.
  - Neither the full contract layer nor the full E2E suite has run since. Unit, `tests/contract/dns-1` and `tests/contract/m1-s4` have run (SE), and I read their evidence; they are not repeated except as part of the full contract run.
- **V2:** done above, by reading.
- **V3 (DNS1-AC5):** CI only. Decided below.
- **V4:** after V1 (Pi) and again after V3.

### DNS1-AC5: recommendation
**Merge DNS-1 to `main` after the lead's APPROVE and a green V1, with DNS1-AC5 as an explicit post-merge gate. Don't ask for a branch push.** Why:
- A `main` push is covered by the user's standing approval. A branch push would need a new approval and a round trip, for the same evidence.
- The fix can only remove the old signature. With a 10 s dial timeout, a 502 at 3 s from a lookup cannot happen. The AC3 guards (`c3a` to `c3d`, 15 s) bound the downside, and the fix simulation, the SE run and the negatives all agree.
- If AC5 fails, the cause is that the hypothesis is wrong (both nameservers silent for more than 10 s), not that the fix is harmful. That means a new investigation story, fix-forward, **not a revert**.

**Conditions:**
- `STATUS.md` shows DNS-1 as "merged, DNS1-AC5 pending", not done, until V3 passes. QA's final sign-off is given only then.
- **The tie rule is retired only after V3 passes,** and only then does proof run 5 of `test/M2-S2-ci-x64-arm64` lose its finding-I allowance.
- **Which run decides:** the first CI e2e run that contains `385718b` and has **complete artifacts on both runners**. On each runner, "complete" means:
  - (a) the contract `jest-results.json` shows `tests/contract/dns-1` 13 of 13 passed. This is also the DoD's x64 run of the AC1 to AC4 tests;
  - (b) `test-results/contract/dns-1/proxy-dns/Caddyfile.image` contains `dial_timeout 10s`, so the image that ran has the fix;
  - (c) the stack `*_web_1.log` files are present.

  `main` does not yet have CI-M2-S2's artifact and timeout fixes (`globalTimeout`, the immediate failure line), so its run can be red on arm64 for known M2-S2 reasons, or lose artifacts. If (a) to (c) don't hold on both runners there, **proof run 5 decides instead.** A red `main` run for reasons other than DNS does not fail DNS1-AC5.
- **An informational figure, not a pass criterion:** proxied requests in the stack access logs with status 200 and `duration` of 4.5 s or more. These are episodes the fix absorbed. They show whether the CI fault still happens.

### VERIFY work orders (executor). The rules of "Work orders" apply, including HARD STOP

#### V1a: Pre-flight (no commit)
1. The branch is `feat/DNS-1-proxy-dns`, the HEAD is the planner's sign-off commit or later, and `git status` is clean.
2. As WO-0: `podman ps -a` / `network ls` hold no `nst-*` leftovers. `NOTESTEAD_KEEP_IMAGE=1` is set for every run.
3. Move the existing `test-results/` aside to `~/joplin-web-app-work/spikes/DNS-1/test-results-pre-verify/`, so V1's scans see only V1's output.

#### V1b: The full contract layer on the Pi (no commit)
1. In the background, with a 120 min timeout:

   `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract --verbose --json --outputFile=test-results/contract/jest-results.json > test-results/contract/verify-full.log 2>&1`
2. **Expected:** every suite passes, including `tests/contract/dns-1` (13 of 13) and m1-s5, m1-s6, m1-s6a and m1-s7, which seed through the hardened device.
3. Then run `node tests/harness/tools/scan-proxy-dns.ts test-results/contract`. **Expected:**
   - 0 old-signature lines;
   - 0 device logs with `Last error`;
   - 0 `SEED SYNC FAILED`;
   - NXDOMAIN lines only from the suites that stop `server` on purpose (list them).
4. **HARD STOP** on any failed test or any unexpected scan count. Record:
   - the failing test, and the first error;
   - any `lookup` line in that stack's web log within ±5 s;
   - any `SEED SYNC FAILED` or `info.json` post-condition message.

   Copy the logs. Don't re-run.

#### V1c: The full E2E suite on the Pi (no commit; only after V1b is green)
1. In the background, with a 120 min timeout:

   `NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test > test-results/e2e-verify-full.log 2>&1`

   Use the repository's config as is: 1 worker, its own retries.
2. **Expected:** every test passes. A retry-pass is reported as a flake with its first-attempt error; it is not hidden.
3. Then run `node tests/harness/tools/scan-proxy-dns.ts test-results`. The expectations are as in V1b.
4. **HARD STOP** as in V1b.

#### V1d: Quick checks (no commit)
Run `corepack yarn jest tests/unit` and `corepack yarn lint` at HEAD. Both must be green.

#### V4a: Results (Pi) (`docs(test-plans)` commit), then HARD STOP
1. Append `## Results (VERIFY, Pi arm64, <date>)` to this file.
2. For each of DNS1-AC1 to AC4, give PASS or FAIL with the command, the duration, the `timings.json` figures and the log paths under `test-results/`.
3. List DNS1-AC5 as **PENDING (V3)**.
4. Add the full-contract and E2E totals, each with its scan summary.
5. Commit: `docs(test-plans): DNS-1 VERIFY results (Pi arm64)`.
6. **HARD STOP** and report.

#### V3: CI evidence (after the merge to `main` and its CI run; dispatched separately)
1. The ci-cd-specialist downloads the run's artifacts to `~/joplin-web-app-work/ci-evidence/<run>/extracted/`, as before. It also confirms conditions (a) to (c) per runner.
2. The QA executor runs `node tests/harness/tools/scan-proxy-dns.ts ~/joplin-web-app-work/ci-evidence/<run>/extracted`. It applies the DNS1-C5 decision rule per runner, adds the informational figure (absorbed episodes), and records each runner's `resolv.base` from the dns-1 results. That answers ci-cd question 3.
3. It appends `## Results (CI, run <id>)` and commits.
4. **HARD STOP**, and the planner gives the final sign-off or opens a new finding.

### QA status
**Pending.** No sign-off yet.
- **AC1 to AC4:** the evidence on the Pi is green for the units, `dns-1` and `m1-s4`; V1b to V1d are still to run.
- **AC5:** pending V3.
- **Disputes:** none were raised.

## Planner ruling on the V1c HARD STOP (2026-10-24)

**V1b:** green. 15 of 16 suites passed in the full run. m1-s7 failed only because the V1b command I wrote lacked `NOTESTEAD_WEB_ARTIFACT`. **That is my order's omission, not a test or product defect.** The orchestrator's ruling (re-run m1-s7 alone with the variable: 11 of 11) stands, and V4a records it as a deviation. Scan: 0 old-signature lines; 1 NXDOMAIN (ac20, which stops `server` on purpose); 1 `Last error` device log, which is the `dev1-neg` control, as expected.

**V1c:** 13 of 14 passed in 35.1 min. The one failure is M2-AC3, `tests/e2e/m2-s2/notes.spec.ts:102`, step 6. The headless REST note `95f1a980…` has body B2 but title T1 after the edit cycle. There are 14 tests and not 16 because `main` does not have the CI-M2-S2 LOC-01/02 specs; that is expected.

### (a) Is it F-R2? **No.** Is it caused by DNS-1? **No.**
The evidence is in `test-results/e2e/output/m2-s2-notes-M2-S2-notes-in-ebbdc--and-one-headless-sync-each-chromium/` (the trace, `network.log`, `browser-console.log`, `web.log`, `supervisor.log`). All times are UTC.

**F-R2's signature is absent.** F-R2 is a press that cancels the app's own sync, so no delta follows, and `syncWebOnce` times out with "no delta request since the press". Here:
- the press is at 12:30:21.194 (trace);
- a sync starts at 21.413, uploads the note (`PUT …95f1a980….md:/content` 200 at 22.296, `web.log`), and makes its delta request after the press (22.957);
- the side menu then reports `Completed:` (innerText at 24.825);
- the console has **no** "cancelling" line in the edit cycle.

`syncWebOnce` succeeded. The re-press fix (`78d3c4d`) would not have pressed again.

**The headless is not at fault either.** Its restart sync (12:30:39 to 41) requests the delta from the web's last cursor (`C4s8…`) and downloads the note's content at 12:30:40.294, after the web's last upload. "Updated local items: 1" means the note itself. "Created: 1" is a revision.

**What failed is the web app's own copy of the title.**
- **What the server has:** the server's latest copy, decrypted by the headless, has the **edited body and the old title**. The diff shows only `title`.
- **What the web shows:** at the failure, the web UI lists "Notestead edited note 9dcb6937 Δ" (the `error-context.md` page snapshot). So the screen shows T2, but the row the app synced had T1.
- **The only browser-side error in the window**, 1.4 s after the title was typed (11.924 to 12.5):

  ```
  12:30:13.922 [warning] sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN (…)
  12:30:14.637 [error]   models/Setting: Could not save settings {type: error, dbId: db#1@…, messageId: exec#2297, …}
  ```

  The body was typed after it (15.3 to 18.5).
- **Best-supported hypothesis (not proven):** the failed settings transaction rolled back the note-title UPDATE that ran on the same connection between its BEGIN and its ROLLBACK. The UI state kept T2; the database kept T1. The body save that followed wrote only `body`, so the synced row is T1 plus B2.

**Not DNS-1:**
- 0 `lookup` lines and 0 5xx in every `web.log` of the run;
- every proxied request of this test returned 200;
- the 10 s dial timeout never fired;
- the seed was not involved: the device succeeded, and the `info.json` post-condition passed.

**F-R2 is not the right attribution, and the CI-M2-S2 branch does not fix this.** None of its 45 commits touches browser SQLite or the note save path: `78d3c4d` is the re-press, `e393033` the trash exit, and the rest are the locale, readiness and the CI budget.

### The finding: W-DNS1-1 becomes a bug, WEB-SQLITE-1 (routed to M2-S3: QA, then the SE)
- **Two occurrences within a week (strategy §6 flake policy):**
  - run 40075823250 arm64 (CI): `SQLITE_IOERR` on `CREATE TABLE migrations` at `openDatabase`;
  - this Pi run: `rc= -1` on a settings write, with a lost note-title edit.

  So it is not arm64-CI-only, and it can **silently lose a user's edit**: the UI shows the new title, but the synced copy has the old one. **It is user-facing, and it outranks a flake.**
- **For M2-S3's QA plan:**
  - (1) a harness rule: every E2E test fails on any browser console `sqlite3_step() rc=` warning or `Could not save` error, naming it. Today the test failed only 60 s later, on data;
  - (2) a data-level check after every UI edit: the web app's **own** stored row (its database, read in the page) equals the UI before any sync. That separates "the save was lost" from "the sync was lost";
  - (3) evidence capture: the worker's error object, and the storage estimate of the OPFS origin;
  - (4) the SE investigates whether upstream's web database layer (`@joplin/lib` with the web SQLite worker) runs unrelated statements inside an open transaction, so that a rollback can undo them. If it does, that is an upstream issue (CLAUDE.md: propose upstream, no fork).
- **It does not block DNS-1:** different component, different cause, no shared code path.

### (b) How V1c counts
- **Not** "accepted as F-R2". That attribution is wrong.
- **No scratch merge with `test/M2-S2-ci-x64-arm64`.** It cannot address WEB-SQLITE-1 (nothing there touches it), costs another 35 min of the Pi, and proof run 5 runs exactly that merged state on both runners anyway.
- **Ruling:** V1c counts as **13 of 14, with M2-AC3 failed for a cause not attributable to DNS-1** (WEB-SQLITE-1, evidence above). It is **conditional on V1c'**: one targeted re-run of `notes.spec.ts` on the DNS-1 HEAD. That shows M2-AC3's flow passes with DNS-1 in place, so the attribution does not rest on log reading alone.
- The failure stays visible in the Results as a FAIL with its finding. It is not counted as a pass.

### Orders (executor). The rules of "Work orders" apply, including HARD STOP

#### V1c': Evidence first, then one targeted re-run (no commit)
1. **Before anything else:** Playwright clears `test-results/e2e/output` on every run. So copy:
   - the failing test's directory `test-results/e2e/output/m2-s2-notes-M2-S2-notes-in-ebbdc--and-one-headless-sync-each-chromium/`, the full-run log `test-results/e2e-verify-full.log` and the Playwright report, **to** `~/joplin-web-app-work/spikes/DNS-1/evidence-v1c/`;
   - also the V1b contract output (`test-results/contract/`), if V4a still needs it and it is not copied yet.

   `sha256sum` the copied files into `MANIFEST.sha256` there.
2. In the background, with a 30 min timeout:

   `NOTESTEAD_KEEP_IMAGE=1 corepack yarn playwright test tests/e2e/m2-s2/notes.spec.ts > test-results/e2e-verify-v1c-prime.log 2>&1`

   Use the same environment as V1c: if V1c set `NOTESTEAD_WEB_ARTIFACT` or other `NOTESTEAD_*` variables, set the same ones, and record them.
3. **Expected:** M2-AC3 passes. Then:
   - `grep -c "sqlite3_step() rc=\|Could not save" <the test's browser-console.log>`: record the count, which should be 0;
   - `node tests/harness/tools/scan-proxy-dns.ts test-results`: 0 old-signature lines, 0 `Last error`.
4. **HARD STOP if M2-AC3 fails again.**
   - Copy its output as in step 1, to `evidence-v1c-prime/`.
   - Record the failing step and its diff.
   - Say whether the console has a `sqlite3_step() rc=` or `Could not save` line. Say whether a `cancelling` line or a "no delta request since the press" error appears (the F-R2 signature). Count the `lookup` lines and the 5xx in `web.log`.
   - Don't run anything else.

#### V1d: Quick checks (no commit)
`corepack yarn jest tests/unit` and `corepack yarn lint` at HEAD. Both must be green.

#### V4a: Results (Pi), as ordered above, with these additions (`docs(test-plans)` commit), then HARD STOP
1. Append `## Results (VERIFY, Pi arm64, 2026-10-24)` with one row per AC:

   | AC | Status | Evidence |
   |---|---|---|
   | DNS1-AC1 | PASS | `tests/contract/dns-1`: c0, c1, c1b, c1-neg; V1b timings |
   | DNS1-AC2 | PASS | c2, c2-neg, c2b, with `extraKeys` and the listing path |
   | DNS1-AC3 | PASS | c3a to c3d |
   | DNS1-AC4 | PASS | dev1-c1, dev1-neg, dev1-u1; the full contract and E2E runs seeded through the hardened device with 0 `SEED SYNC FAILED` |
   | DNS1-AC5 | PENDING (V3) | |

   Give each row its command, duration and log paths (under `test-results/`, or the `evidence-v1c/` copies).
2. **The regression runs:**
   - **V1b:** 15 of 16 suites passed, plus m1-s7 re-run alone with `NOTESTEAD_WEB_ARTIFACT` (11 of 11). This is a **deviation: the planner's V1b command omitted the variable**. Add the scan summary.
   - **V1c:** 13 of 14, M2-AC3 **FAIL, attributed to WEB-SQLITE-1, not DNS-1**, with the evidence paths and the console lines quoted above.
   - **V1c':** its result.
   - **V1d:** its result.
3. Commit: `docs(test-plans): DNS-1 VERIFY results (Pi arm64)`.
4. **HARD STOP** and report.

### QA status after this ruling
- **Still pending.**
- **DNS1-AC1 to AC4:** sign-off follows V1c' green, V1d and V4a.
- **DNS1-AC5:** V3, as decided above.
- **The merge recommendation is unchanged:** merge after the lead's APPROVE and the V4a record; AC5 is a post-merge gate.
- **WEB-SQLITE-1 is an open finding for M2-S3.** It does not block DNS-1, and the orchestrator puts it in `STATUS.md`.

## Planner ruling on the V1c' HARD STOP, and the combined-branch plan (2026-10-24)

### (a) V1c' is F-R2. V1c and V1c' both count as "blocked by known non-DNS causes", not as a pass
- **V1c' evidence:** `~/joplin-web-app-work/spikes/DNS-1/evidence-v1c-prime/`.
  - `syncWebOnce` (`tests/e2e/support/flows.ts:79`, from `notes.spec.ts:134`) failed after 180 s with "no delta request since the press".
  - Console: `Starting scheduled sync` at 12:51:15.835, then `Sync: cancelling` at 15.966 (131 ms later), then "Synchronisation was cancelled".
  - This is F-R2 exactly (CI-M2-S2: "starting" then "cancelling" 190 ms later). It was fixed by the re-press, `78d3c4d`, on `test/M2-S2-ci-x64-arm64`. `main`, and so this branch, does not have it.
  - Clean otherwise: no `rc= -1`, no `Could not save` (the one `sqlite3_step()` line is the known startup `spellfix1` warning, rc 1), 0 `lookup` lines, 0 5xx, the scan clean.
- **Two runs, two causes, neither DNS-1:**
  - V1c: **WEB-SQLITE-1** (a lost title save, with the browser SQLite write failure);
  - V1c': **F-R2** (a known harness gap, fixed elsewhere).

  Both stay recorded as **FAIL with their attribution.** DNS-1's E2E regression check is **not done on this branch**; it moves to the combined branch (V5 below). Nothing here is counted as a pass. The F-R2 failure is no evidence against DNS-1 either: the proxy answered every request with 200.
- **Why not try again here:** a third run on this branch would only roll the same two dice. The harness that removes F-R2 already exists; it is on the other branch.

### (b) The orchestrator's combined-branch plan: **accepted, with amendments**
It supersedes my earlier "merge DNS-1 to `main` first, AC5 as a post-merge gate". `main` then gets only proven changes.

1. **The lead reviews DNS-1 now.** The scope is the diff and the contract, unit and Pi evidence for DNS1-AC1 to AC4. The review states that DNS-1's E2E regression evidence and DNS1-AC5 come from the combined branch (V5, V3). APPROVE then means "approved to combine", not "done".
2. **Merge `feat/DNS-1-proxy-dns` into `test/M2-S2-ci-x64-arm64`, `--no-ff`.**
   - **The one conflict** (checked with `git merge-tree`; it is the only one): `docs/test-plans/DNS-1.md`, add/add. **Resolve it by taking `feat/DNS-1-proxy-dns`'s file whole** (`git checkout --theirs docs/test-plans/DNS-1.md`, seen from the CI branch). Its `## History` section already holds the CI branch's briefs verbatim.
   - **Auto-merged, and checked by me in the merge tree:**
     - `tests/stack/stack.ts`: `upDefault` still has `await enableE2ee` (line 489 of the merged file);
     - `tests/e2e/support/fixtures.ts`: `await enableE2ee` (line 197);
     - `docs/testing/strategy.md`.

     No caller of `enableE2ee` lacks an `await`. V5 step 2 (lint and tsc) is the gate for the rest.
3. **V5 (below):** the combined branch on the Pi. The full contract layer, then the full E2E suite, with the CI branch's harness.
4. **Push the combined branch for proof run 5,** under the user's existing approval for that branch. That one run is both the CI-M2-S2 proof and the DNS1-AC5 evidence (V3), and also the DoD's x64 run of DNS-1's contract tests.
5. **If the run meets the criterion below,** both merge to `main` together. `--no-ff` keeps both histories.

**The merge criterion for proof run 5** replaces the CI-M2-S2 tie rule for finding I:
- **x64:** every test passes.
- **arm64:** every test passes, except failures tied to WEB-SQLITE-1 under the narrow tie below, if the user grants it.
- **Both runners:** DNS1-AC5 passes (the scan's decision rule DNS1-C5), and the evidence is complete as defined in "Which run decides" (a) to (c).
- **The finding-I tie rule is retired:** a `lookup server` failure is a regression, with no allowance.
- **No F-R2 allowance either:** on this branch F-R2 is fixed, so a "no delta request since the press" failure is a regression of `78d3c4d`.

### WEB-SQLITE-1: a narrow tie or block? **Recommendation: a narrow tie, time-boxed. The user decides.**

> **Superseded in part:** the tie as granted is defined by "T: the WEB-SQLITE-1 tie" in the amendment after DNS-1-r1, below. Conditions 1 to 5 here are history.
Accepting a known red departs from the Definition of Done. So, as with finding I, **this is the user's decision.**

**Why a tie:**
- The defect sits in the browser database layer of the upstream web build, and is probably an upstream issue. It has nothing to do with either change being proven.
- It has its own owner (M2-S3). Blocking would hold two finished, proven fixes (the proxy DNS fix and the CI harness) back for an investigation of unknown length.

**Why narrow and time-boxed:** it can lose a user's edit silently. A loose allowance would hide exactly that.

**The tie applies to a failed test only if all of these hold:**
1. **Every** failed attempt of the test (the first run and the CI retry) has, in its own `browser-console.log`, at least one SQLite failure line before the failing assertion. A failure line is either `sqlite3_step() rc=` **other than** the startup `CREATE VIRTUAL TABLE notes_spellfix USING spellfix1` warning, or `Could not save`. A retry-pass is reported as a flake, as now.
2. Neither attempt shows another cause: 0 `lookup` lines and 0 5xx in its `web.log` in the attempt's window; no F-R2 signature (`Sync: cancelling` within 1 s of a press, or "no delta request since the press"); no `SEED SYNC FAILED`.
3. At most **one** tied test per runner. More than one means WEB-SQLITE-1 is frequent enough to block.
4. The failure is **visible**: it is red or flaky in the report, never skipped, never retried beyond the configured retries.
5. **The tie expires** when M2-S3 merges, or after the next 3 proof runs, whichever comes first.

**If the user declines:** a WEB-SQLITE-1 failure blocks the combined merge, and M2-S3's WEB-SQLITE-1 work becomes a prerequisite. In either case, the orchestrator puts WEB-SQLITE-1 first in M2-S3's queue: it can lose data.

### (c) Orders (executor). The rules of "Work orders" apply, including HARD STOP

#### V1d: Quick checks on `feat/DNS-1-proxy-dns` (no commit), now
`corepack yarn jest tests/unit` and `corepack yarn lint` at HEAD. Both must be green; record the counts. **HARD STOP** on any red.

#### V4a': Results on this branch (`docs(test-plans)` commit), now, then HARD STOP
1. Append `## Results (VERIFY, Pi arm64, 2026-10-24, feat/DNS-1-proxy-dns)`.
2. **Per AC**, each with its command, duration and log paths. Use the copies in `~/joplin-web-app-work/spikes/DNS-1/evidence-*` where `test-results/` has been overwritten.

   | AC | Status | Evidence |
   |---|---|---|
   | DNS1-AC1 | PASS | c0, c1, c1b, c1-neg; the timings in "QA review of the implementation" and from V1b |
   | DNS1-AC2 | PASS | c2, c2-neg, c2b; `extraKeys` and the listing path |
   | DNS1-AC3 | PASS | c3a to c3d |
   | DNS1-AC4 | PASS (contract and unit) | dev1-c1, dev1-neg, dev1-u1; V1b seeded every contract suite through the hardened device with 0 `SEED SYNC FAILED`; the E2E part is PENDING (V5) |
   | DNS1-AC5 | PENDING (V3, proof run 5) | |
3. **Regression runs:**
   - **V1b:** 15 of 16, plus m1-s7 alone with `NOTESTEAD_WEB_ARTIFACT` (11 of 11). Deviation: the planner's command omitted the variable. Add the scan summary.
   - **V1c:** 13 of 14, M2-AC3 FAIL, WEB-SQLITE-1. Quote the two console lines and give the path.
   - **V1c':** M2-AC3 FAIL, F-R2. Quote the starting and cancelling lines and give the path.
   - **Verdict line:** "E2E regression evidence for DNS-1: blocked by known non-DNS causes on this branch; moved to V5 on the combined branch."
   - **V1d:** its counts.
4. Commit: `docs(test-plans): DNS-1 VERIFY results on the story branch (Pi arm64)`.
5. **HARD STOP** and report. The lead review follows.

#### V5: The combined branch on the Pi (after the lead's APPROVE and the orchestrator's merge; no commit until step 6)
1. **Pre-flight:**
   - check out the combined `test/M2-S2-ci-x64-arm64`, with a clean status;
   - `git log --oneline -1` shows the merge commit, and `git show --stat HEAD` shows the DNS-1 files;
   - no `nst-*` leftovers in podman;
   - move `test-results/` aside to `~/joplin-web-app-work/spikes/DNS-1/test-results-pre-v5/`.
2. Run `corepack yarn lint` and `corepack yarn jest tests/unit`. Both must be green, or **HARD STOP**: a merge that type-checks wrongly is reported, not fixed.
3. **The full contract layer.** In the background, with a 120 min timeout:

   `NOTESTEAD_KEEP_IMAGE=1 NOTESTEAD_WEB_ARTIFACT=<the same value V1b's m1-s7 re-run used> corepack yarn test:contract --verbose --json --outputFile=test-results/contract/jest-results.json > test-results/contract/v5-full.log 2>&1`

   Expected: every suite green, including `tests/contract/dns-1` 13 of 13. Then run `node tests/harness/tools/scan-proxy-dns.ts test-results/contract`. Expected: 0 old-signature lines; the `Last error` count is only `dev1-neg`'s; NXDOMAIN only from ac20.
4. **The full E2E suite**, only after step 3 is green. In the background, with a 120 min timeout. Use **the exact command and environment of the CI-M2-S2 plan's last accepted full local run** (its WO-11 / round-3 results: under the CI locale, with its `NOTESTEAD_*` variables). Read them from `docs/test-plans/CI-M2-S2-x64-arm64.md` and record them; redirect the output to `test-results/e2e-v5-full.log`.

   Expected: every test passes, the LOC specs included (16 tests, not 14). Then run `node tests/harness/tools/scan-proxy-dns.ts test-results`. Also run `grep -l "sqlite3_step() rc=\|Could not save"` over every `browser-console.log`, and list each hit, leaving out the startup `spellfix1` line.
5. **HARD STOP:**
   - **on any failure in step 3;**
   - **on any failure in step 4.** Classify it first, record it, then stop:
     - WEB-SQLITE-1: the tie conditions 1 and 2 above;
     - F-R2: now a regression;
     - DNS: any `lookup` line or 5xx;
     - other.

     Copy its output to `~/joplin-web-app-work/spikes/DNS-1/evidence-v5/`, with `MANIFEST.sha256`. A WEB-SQLITE-1-classified failure is still a stop: the planner and the user's tie decision rule on it.
6. **If everything is green:** append `## Results (V5, combined branch, Pi arm64, <date>)` to `docs/test-plans/DNS-1.md` on the combined branch, with the per-AC update: AC4's E2E part, and DNS-1's E2E regression check. Commit: `docs(test-plans): DNS-1 V5 on the combined branch (Pi arm64)`. Then **HARD STOP** and report. The orchestrator pushes for proof run 5.

#### V3: Proof run 5 (after the push; dispatched separately)
As written in "V3: CI evidence", on proof run 5's artifacts, plus:
1. Apply the merge criterion above per runner, including the WEB-SQLITE-1 tie if the user granted it.
2. Append `## Results (CI, proof run 5, run <id>)` to `docs/test-plans/DNS-1.md` **and** a short cross-reference in `docs/test-plans/CI-M2-S2-x64-arm64.md` on the combined branch. Commit.
3. **HARD STOP.** The planner gives the final sign-off for DNS-1 and CI-M2-S2, or opens a finding.

### QA status after this ruling
**Pending.**
- **AC1 to AC3:** PASS on the Pi (the contract layer).
- **AC4:** PASS at the contract and unit level; E2E pending V5.
- **AC5:** pending proof run 5.
- **The DNS-1 E2E regression check:** blocked on this branch by known non-DNS causes (WEB-SQLITE-1, F-R2); moved to V5.
- **For the user, through the orchestrator:** the WEB-SQLITE-1 tie, recommended narrow and time-boxed.

## Amendment after DNS-1-r1 (planner, 2026-10-24): the WEB-SQLITE-1 tie as granted, and DNS1-AC5 kept decisive

The lead's DNS-1 r1 (`f3261ec`) is APPROVE to combine. The user granted the narrow WEB-SQLITE-1 tie on 2026-10-24. This section **narrows** that tie (r1 C3, gaps 1 to 5) and **tightens** DNS1-AC5 (r1 C1). It never widens either. It **supersedes** conditions 1 to 5 of "WEB-SQLITE-1: a narrow tie or block?" above; where the two differ, this section applies.

### T: the WEB-SQLITE-1 tie (proof runs of the combined branch only)
**T1, where it applies:**
- **arm64 only** (`ubuntu-24.04-arm`), in e2e workflow runs of the combined `test/M2-S2-ci-x64-arm64` branch.
- **x64 gets no allowance, deliberately** (r1 gap 4). Both known occurrences were on arm64 (the CI runner and the Pi). An x64 occurrence would be new information: the defect spreading. It **blocks** the merge, and goes to the planner as a new finding.
- Stricter than the evidence requires is safe; looser is not.

**T2, the failure must have one of two known shapes** (r1 gap 1). Any other failure does not qualify, **whatever the console holds**: a timeout elsewhere, a different UI regression, an assertion on something the test did not edit.

- **Shape A, a lost write.** The occurrence it is modelled on is V1c: `tests/e2e/m2-s2/notes.spec.ts:102`, step 6.
  - (i) The failing assertion is a **data-level** read: the headless Data API, MCP or the server's own API.
  - (ii) For at least one field the test edited **in the UI**, it received exactly that field's **pre-edit value**.
  - (iii) The web UI shows the **post-edit value** for the same item, in the attempt's `error-context.md` page snapshot or in its trace after the edit step.
  - (iv) Every other field compared in that assertion has its expected value.
- **Shape B, a startup failure.** The occurrence it is modelled on is run 40075823250 arm64: `tests/e2e/m2-s1/e2ee-unlock.spec.ts:181`, attempt 1.
  - (i) The console has `root: Startup failure during task: buildStartupTasks/openDatabase`.
  - (ii) The test fails in the app's first wait for its UI, before any action on notes, notebooks, tags or to-dos. That wait is a locator timeout on the first dialog or screen the app shows after loading.

**T3, the qualifying console lines** (r1 gap 2). These come from the failed attempt's own `browser-console.log`, the file the harness attaches for that attempt; never from another test's or another attempt's log. Lines are matched as text, format `<ISO time> [<level>] <message>`.
- **Line S (both shapes):** a `[warning]` line matching

  `/^\S+ \[warning\] sqlite3_step\(\) rc= (-?\d+) /`

  It qualifies when **both**:
  - the captured rc is neither `0` nor `1`;
  - and the line does **not** contain `CREATE VIRTUAL TABLE notes_spellfix USING spellfix1`. That line is the known, harmless startup warning: rc 1, `SQLITE_ERROR`, in every run.

  Note the space after `rc=`: the worker prints `rc= <n>`.
- **Line E, which must follow line S within 2 s:**
  - **Shape A:** an `[error]` line containing `Could not save`.
  - **Shape B:** the `[error]` line `root: Startup failure during task: buildStartupTasks/openDatabase`.
- **The two known occurrences, verbatim** (the SQL is cut where the log cuts it):
  - **Shape A, Pi, V1c**, copy in `~/joplin-web-app-work/spikes/DNS-1/evidence-v1c/…/browser-console.log` lines 581-582:
    ```
    2026-10-24T12:30:13.922Z [warning] sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN (…)
    2026-10-24T12:30:14.637Z [error] 14:30:14: models/Setting: Could not save settings {type: error, dbId: db#1@…, messageId: exec#2297, …}
    ```
  - **Shape B, CI arm64, run 40075823250**, file `~/joplin-web-app-work/ci-evidence/40075823250/extracted/test-results-e2e-ubuntu-24.04-arm/test-results/e2e/output/m2-s1-e2ee-unlock-M2-S1-E2-8f8b5--error-nothing-is-decrypted-chromium/browser-console.log` lines 31 and 33:
    ```
    2026-10-24T08:12:53.157Z [warning] sqlite3_step() rc= 10 SQLITE_IOERR SQL = CREATE TABLE migrations (id INTEGER PRIMARY KEY, number INTEGER NOT NULL, updated_time INT NOT NULL, created_time INT NOT NULL);
    2026-10-24T08:12:53.159Z [error] 10:12:53: root: Startup failure during task: buildStartupTasks/openDatabase
    ```

    So the CI `SQLITE_IOERR` **does** print as `sqlite3_step() rc= 10 SQLITE_IOERR …`. It is matched by line S and is not a different shape. The `rc= 1 SQLITE_ERROR SQL = ROLLBACK` line that follows it (line 32) is a consequence, not a qualifying line: rc 1.
- **The time window:**
  - **Shape A:** line S falls inside the failing step, or in the **60 s before that step starts** (V1c: 12:30:13.922, 5.9 s before step 6 began at 12:30:19.8). It must also fall **after** the start of the UI edit step whose value was lost (V1c: step 5, at 12:30:10.7).
  - **Shape B:** line S falls within **60 s of the page's first navigation** in that attempt (CI: about 10 s after `goto`).

**T4, every failed attempt qualifies on its own:**
- Every failed attempt of the test (the first run and each CI retry) must meet T2 and T3 by itself, with its own lines. The two attempts may have different shapes.
- A retry that passes makes the test **flaky**, which the report shows. A flaky test needs no tie.

**T5, nothing else explains it.** In the attempt's window (from its first navigation to its failure), all of these must hold:
- 0 `lookup` lines in the stack's `*_web_1.log`;
- 0 Caddy `dial tcp` errors (502/504) in that log;
- no F-R2 signature: a `Sync: cancelling` within 1 s of a Synchronise press, or "no delta request since the press";
- no `SEED SYNC FAILED`;
- no `info.json` post-condition error.

**T6, the cap:** at most **one** tied test per arm64 runner per proof run. A second qualifying failure in the same run **blocks**: WEB-SQLITE-1 is then frequent enough to need its fix first.

**T7, visibility:** a tied failure stays red or flaky in the report and in the job summary. It is never skipped, quarantined, or retried beyond the configured retries.

**T8, expiry** (r1 gap 3):
- The tie covers at most **three** e2e workflow runs of the combined branch, **counting proof run 5 as the first** (run 5, run 6, run 7). It ends at the end of proof run 7, or when M2-S3 merges to `main`, whichever comes first.
- Every completed run counts, **re-runs of failed jobs included**. Re-running in search of a green result uses up the budget.
- After expiry, WEB-SQLITE-1 failures block like any other.

**T9, evidence, which the lead verifies** (r1 gap 5):
- For each tied failure, V3's results quote, per failed attempt:
  - the test title and the attempt number;
  - the shape (A or B), and the T2 facts: for A, the field, the received pre-edit value, the expected value and the UI evidence location; for B, the failing wait;
  - the qualifying lines S and E **verbatim**, with the artifact file path, the line numbers and the `sha256sum` of that `browser-console.log`;
  - the T5 checks with their counts.
- The status is **"tie claimed"** until the lead, in the next review round, has checked the quoted lines and the sha256 against the downloaded artifact (`~/joplin-web-app-work/ci-evidence/<run>/extracted/`), and confirmed T2 to T6. Only then is it "tie applied". Until then, the combined branch does not merge.

### DNS1-AC5 stays decisive (r1 C1); its decision rule, tightened
- **DNS-1 is not closed on the contract tests.** The fix covers one silent nameserver (about 5 s). It does not cover a first nameserver silent for longer than about 10 s, or both silent; r1 C1 is right that this is unproven. **Proof run 5 is what decides it.**
- **The file set (made explicit):**
  - every stack `web` log, meaning every `*_web_1.log` and every per-test `web*.log` attachment, after the scan's dedupe;
  - plus the headless and device logs.
  - **Excluded:** `test-results/contract/dns-1/**`, whose `web` containers produce deliberate fault-injection lines (c1-neg, c2-neg, c3a to c3d, dev1-neg). The scan already leaves them out, because their names (`nst-proxy-dns-web-*`) match neither pattern. V3 must **list** the files counted per runner, and state that no `contract/dns-1/` file is among them.
- **The rule, per runner, replacing DNS1-C5's:**
  - **PASS** needs all of these:
    - 0 `lookup server … i/o timeout` lines **of any duration** (the old 3 s signature, about 5 s, about 10 s, or anything else);
    - 0 Caddy `dial tcp` 502/504 error lines outside the tests that stop `server` on purpose (M1-AC20 and the like, each named in V3; their `no such host` NXDOMAIN lines are expected);
    - 0 device logs with `Last error`, except `dev1-neg`'s own (deliberate, in `contract/dns-1/`, so outside the file set anyway);
    - the evidence complete as in "Which run decides" (a) to (c).
  - **FAIL:** anything else. A line at about 10 s means the hypothesis is wrong, which is a new finding, as r1 C1's scenario. A line at about 3 s means the image that ran lacks the fix. **Never a bound change.**
  - **Informational, not a criterion:** proxied 200s with a `duration` of 4.5 s or more (episodes the fix absorbed). Server-originated 5xx (the upstream server's own errors, not Caddy `dial` errors) are listed with their URIs.
- **x64 and arm64 are judged the same way.** No DNS tie exists on either runner.

### Other r1 items for QA
- **C2 (the timing windows):** the bounds stay as they are and remain planner-owned. If `c1`, `c1-neg` or `c2-neg` falls outside its window on a loaded runner in proof run 5, that is a FAIL that comes to the planner with its `timings.json`, not a widened bound. The executor never edits them.
- **P1 to P4:** no QA action.

### Merge resolution for the orchestrator (unchanged)
When merging `feat/DNS-1-proxy-dns` into `test/M2-S2-ci-x64-arm64` (`--no-ff`), resolve the only conflict, `docs/test-plans/DNS-1.md` (add/add), by taking this branch's file **whole**. The merged file must contain this amendment section. V5 pre-flight checks that.

## History: the investigation briefs (CI-M2-S2 round 4, commit 7752875 on test/M2-S2-ci-x64-arm64)

Kept as written; both were delivered in `docs/worklog/DNS-1.md` (8513a0d, 0753528).

- **Symptom:** `web` (Caddy, `reverse_proxy {$JOPLIN_SERVER_URL}` = `http://server:22300`, `deploy/web/Caddyfile:58`) logs `dial tcp: lookup server: i/o timeout`, and the client gets a 502.
  - **How often:** arm64 runner 46 `web` lines plus 12 in headless (the 502s it received through `web`); x64 14 plus 7; the Pi 6.
  - **Not arm64-only:** it also occurs in passing runs and on every platform.
  - **One known hard failure:** M1-AC21 NEG's positive-control ping in run 40020973008, at 21:03:41 and 21:04:08 (both attempts).
- **User-facing:** a self-hosted user's `web` resolves `server` through the same container-network DNS. **The tests are not changed to wait or retry around it.**
- **Status:** investigation only. A fix needs the orchestrator's decision. QA writes the regression test once a fix is chosen.

### Brief for the senior engineer (investigation first, no fix without a decision)
Goal: find why `web` intermittently cannot resolve `server`, and propose the smallest deploy-level fix.
1. **Reproduce:**
   - On the Pi, start a stack with `node tests/stack/cli.ts up` and report its project name. Remove it afterwards with `cli.ts down` (the P1 leftover-stack rule).
   - From inside `web`, resolve `server` in a loop for 10 minutes, for example `getent hosts server` or whatever probe the image has. Record failures and latencies.
   - In the same window, send steady `GET /joplin-server/api/ping` requests through the proxy, and count the `lookup server` lines in `web`'s log.
2. **Inspect:**
   - `web`'s `/etc/resolv.conf`: its nameservers, and `options timeout`/`attempts`;
   - the network's DNS backend (`podman network inspect`, the aardvark-dns version);
   - whether the failures cluster at stack start or are spread out.
3. **Options to evaluate, without implementing any yet:**
   - Caddy `reverse_proxy` `lb_try_duration` / `lb_try_interval`. It retries dials only, and a failed lookup means nothing was sent, so it is safe for POST.
   - A resolver setting in the image (`resolv.conf` options, `GODEBUG=netdns=go`).
   - An upstream by address. This is rejected unless nothing else works: the topology stays name-based (ADR-0006).
4. **Deliver** `docs/worklog/DNS-1.md` with:
   - the measurements;
   - the cause, or the best-supported hypothesis;
   - the proposed change and its user-facing effect;
   - a contract-test idea for QA: a fault-injected DNS delay must not give a 502.

### Brief for the ci-cd-specialist (runner side; read-only, no workflow change)
1. From e2e runs 39663284028, 39768694985, 39957733152 and 40020973008, tabulate the `lookup server: i/o timeout` lines per runner and container, with timestamps relative to stack start.
2. From the runner images, report:
   - the podman, netavark and aardvark-dns versions;
   - whether the host's `resolv.conf` (systemd-resolved, `127.0.0.53`) leaks into the containers' DNS chain.
3. Propose, and do not apply, any runner-side setting that removes a DNS hop.

Deliver this as a section of `docs/worklog/DNS-1.md`, or in `docs/delivery/`, as the orchestrator assigns.

## Disputes

## RED (DNS-1, 2026-10-24, Pi arm64)

Executor: qa-specialist (Sonnet). Branch HEAD for the final RED run: `39385b8` (tests) with the strategy commit on top. Evidence is under `test-results/contract/dns-1/` (not committed): `red-run2/` (log and `proxy-dns/` with `timings.json`, `resolv.base`, `resolv.sink-*`, every container log), `red-run/` and `red-dev1-neg-wo3/` (earlier runs), `fixsim-run/` and `fixsim-run2/`, `scan-old-runs.json`.

Commits: `0be311d` (WO-1/2), `8e00acb` (WO-3), `630507f` (WO-4), `a334db3` (WO-5), `625b1d2` (WO-7a), `266c0ed` (WO-7b), `39385b8` (WO-7c), `db41d01` (WO-8).

**Commands.**
- `NOTESTEAD_KEEP_IMAGE=1 timeout 2400 corepack yarn test:contract tests/contract/dns-1 --verbose` (127 s)
- `corepack yarn jest tests/unit` (111 tests)

**Outcomes on `39385b8` (contract, ms for the request).**

| Test | Outcome | Request |
|---|---|---|
| dns1-c0 | green | 200 in 14 ms, sink delta 0 |
| dns1-c1 | red | 502 at 3011, sink delta 2 |
| dns1-c1b | red | 502 at 3011, sink delta 2 |
| dns1-c1-neg | green | 502 at 3008, delta 2, `removedBlocks` 0 |
| dns1-c2 | red at the login | 502 at 3008, delta 2 |
| dns1-c2-neg | green | 502 at 3006, delta 2, `removedBlocks` 0 |
| dns1-c2b | red | 502 at 3009, delta 2 |
| dns1-c3a / c3b / c3c / c3d | green | 502 at 17 / 6 / 3009 / 3005 |
| dev1-c1 | green | exit 0, RESULT, `info.json` accepted by `checkSeededInfo` |
| dev1-neg | green | exit 3 after 32.8 s, `SEED SYNC FAILED`, `Last error` |
| dns1-s1 (unit) | red, at `transport` only | `expect(transport).not.toBeNull()` |
| other unit tests (joplinItem, seedCheck, proxyDnsScan, all existing) | green | 110 of 111 |

`dev1-neg` was red at `8e00acb` (WO-3, before the device hardening): the device exited 0 with `RESULT` after a `Last error: Error 502` sync (`test-results/contract/dns-1/red-dev1-neg-wo3/`).

**The WO-6 red for `dns1-s1` is void.** The first opener regex stopped at the `{` of `{$JOPLIN_SERVER_URL}`, so the test was red for the wrong reason and stayed red with the fix. D2's matrix replaces it (WO-7b, in the scratch worktree `qa-s1`, removed afterwards):

| Caddyfile state | Result | Failure line |
|---|---|---|
| branch HEAD (no fix) | red | `expect(transport).not.toBeNull()`, after the `header_up Host` sanity passed |
| fix, `dial_timeout 10s` | green | |
| `3s` | red | `expect(value).toBeGreaterThanOrEqual(6)`, received 3 |
| `20s` | red | `expect(value).toBeLessThanOrEqual(15)`, received 20 |
| `transport http { dial_timeout 10s }` in a second `reverse_proxy` outside the snippet | red | `expect(transport).not.toBeNull()` |

## Harness validation

**Scan over the five old runs** (`tests/harness/tools/scan-proxy-dns.ts`, WO-7c; D3 corrected expectation):
- 225 old-signature lines: x64 79, arm64 146. Other durations: 0.
- 8 NXDOMAIN lines, reported not counted: x64 3, arm64 5. They are in the `m1-s6/ac20/stack/nst-e2e-*_web_1.log` files of runs 39663284028 (arm64), 39768694985 (both), 39957733152 (both), 40020973008 (both), 40075823250 (arm64).
- 3 device logs with `Last error`: x64 `contract/m1-s6/ac20/stack/device-0bca5973.log`; arm64 `contract/m1-s6a/c1/stack/device-7825a393.log` and `e2e/stack/device-803d774f.log`.
- ci-cd's 233 (x64 82, arm64 151) is these 225 plus the 8 NXDOMAIN lines. The tool also reports lines contributed per web log after the dedupe (sums 82 and 151, NXDOMAIN included).

**`dns1-u5` mutation proof** (WO-7c, scratch worktree `qa-u5`, removed afterwards; each mutation applied alone to `tests/support/proxyDnsScan.ts`):

| Mutation | Tests that went red |
|---|---|
| (i) old-signature lower bound 2.5 set to 0 | "the old signature window is 2.5 s to 4.5 s, edges included" |
| (ii) NXDOMAIN counted as timeouts | "nxdomain lines are reported in their own count…", "lines already counted…" |
| (iii) dedupe disabled | "lines already counted…", "two lines that differ only in ts are two events…" |
| (iv) device `Last error` match removed | "finds Last error in a failed seed sync" |

No mutation survived.

**Fix simulation** (WO-7e, scratch worktree `qa-fixsim` at `39385b8` with `transport http { dial_timeout 10s }` added in the worktree only; removed afterwards). 13 of 13 contract tests and 2 of 2 `tests/unit/deploy` green:
- c0 13 ms; c1 5013; c1b 5012; c2 5245; c2b 5238; c3a 14; c3b 9; c3c 3072; c3d 10007 (all ms).
- c1-neg and c2-neg: 502 at 3009 with `removedBlocks` 1.
- c2 data check: the note matched field by field; the server's extra keys were `is_locked` and `extracted_resource_ids`; the blob matched by sha256 and length (256 KiB); the listing path was `children`.
- dev1-neg exit 3 after 32.9 s.

**Deviations and D3's verdict.**
- Scan counts differ from the plan's 82/151/233: accepted (the plan counted NXDOMAIN lines).
- Line-level dedupe added to the scan: accepted, key is the whole raw line, per-file contribution reported.
- `seedCheck.ts` a throwing stub in `8e00acb`: accepted.
- `dns1-u5` written with its module: accepted with the mutation proof above.
- Note name `<id>.md`: accepted. Device without a fixed IP: accepted. Nested `describe` for dev1: accepted.
- Images: `localhost/notestead-web:m1-s4-test` now holds the WO-7e fixsim build (it includes `dial_timeout`; the next run rebuilds it). Kept for sign-off.

## Results (VERIFY, Pi arm64, 2026-10-24, feat/DNS-1-proxy-dns)

HEAD at the runs: `7b9d7d0`/`03d03f1` on top of the fix `385718b` (`dial_timeout 10s`). Evidence lives under `test-results/` (not committed) and, where Playwright overwrote it, in `~/joplin-web-app-work/spikes/DNS-1/evidence-v1c/` and `evidence-v1c-prime/` (each with `MANIFEST.sha256`; the V1b contract output is in `evidence-v1c/contract/`).

| AC | Status | Evidence |
|---|---|---|
| DNS1-AC1 | PASS | `NOTESTEAD_KEEP_IMAGE=1 corepack yarn test:contract` (V1b), `dns-1/proxy-dns.test.ts` 138 s. c0 200 in 11 ms; c1 200 in 5011 ms; c1b 200 in 5013 ms; c1-neg 502 in 3008 ms with `removedBlocks` 1. `evidence-v1c/contract/dns-1/proxy-dns/timings.json` and the `nst-proxy-dns-web-*.log` files beside it |
| DNS1-AC2 | PASS | c2 200 in 5275 ms (note matched field by field, `extraKeys` `is_locked`, `extracted_resource_ids`; 256 KiB blob equal by sha256 and length; listing path `children`); c2-neg 502 in 3007 ms, server unchanged; c2b 200 in 5235 ms. Same `timings.json` |
| DNS1-AC3 | PASS | c3a 502 in 15 ms; c3b 502 in 5 ms; c3c 502 in 3074 ms; c3d 502 in 10006 ms (bound 15 s). Same `timings.json` |
| DNS1-AC4 | PASS (contract and unit); E2E part PENDING (V5) | dev1-c1 green, dev1-neg exit 3 after 32.8 s with `SEED SYNC FAILED` and `Last error`, dev1-u1 6 of 6 (unit run V1d). V1b seeded every contract suite through the hardened device with 0 `SEED SYNC FAILED` outside `dev1-neg` |
| DNS1-AC5 | PENDING (V3, proof run 5) | CI only |

**V1b, the full contract layer** (`test-results/contract/verify-full.log`, `jest-results.json`): 15 of 16 suites, 89 of 100 tests. The one failing suite was m1-s7 (11 tests), with the message "Run it with NOTESTEAD_WEB_ARTIFACT=…". **Deviation: the planner's V1b command omitted `NOTESTEAD_WEB_ARTIFACT`; m1-s7 re-run alone with it: 11 of 11 passed in 462 s** (`test-results/contract/m1-s7-rerun/verify-m1s7.log`; `evidence-v1c/contract/m1-s7-rerun/`). Scan over the contract output: 0 old-signature lines, 0 other durations, 1 NXDOMAIN (m1-s6 ac20, which stops `server` on purpose), 1 device log with `Last error` (`m1-s5/device-dev1-neg.log`, the deliberate control).

**V1c, the full E2E suite** (`NOTESTEAD_KEEP_IMAGE=1 NOTESTEAD_WEB_ARTIFACT=~/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21 corepack yarn playwright test`, 35.1 min, log `evidence-v1c/e2e-verify-full.log`): **13 of 14. M2-AC3 (`tests/e2e/m2-s2/notes.spec.ts:102`) FAIL, attributed to WEB-SQLITE-1, not DNS-1.** The headless REST note had the edited body and the old title. Console lines (`evidence-v1c/m2-s2-notes-M2-S2-notes-in-ebbdc--and-one-headless-sync-each-chromium/attachments/browser-console-log-*.log`):
- `2026-10-24T12:30:13.922Z [warning] sqlite3_step() rc= -1 undefined SQL = DELETE FROM settings WHERE key IN (…`
- `2026-10-24T12:30:14.637Z [error] 14:30:14: models/Setting: Could not save settings {type: error, dbId: db#1@661096, …`

0 `lookup` lines and 0 5xx in the stack web logs. 14 tests, not 16: `main` has no LOC-01/02 specs.

**V1c', `notes.spec.ts` alone** (same environment, 7.9 min, log `evidence-v1c-prime/e2e-verify-v1c-prime.log`): **M2-AC3 FAIL, attributed to F-R2.** `syncWebOnce` (`support/flows.ts:79`, from `notes.spec.ts:134`): expected `completed`, received `no delta request since the press`. Console (`evidence-v1c-prime/m2-s2-notes-*/attachments/browser-console-log-*.log`):
- `2026-10-24T12:51:15.829Z [info] 14:51:15: Starting scheduled sync`
- `2026-10-24T12:51:15.966Z [info] 14:51:15: Synchronizer: Sync: cancelling`

No `rc= -1`, no `Could not save` (the one `sqlite3_step()` line is the startup `spellfix1` warning, rc 1), 0 `lookup` lines, 0 5xx, scan clean. The fix for F-R2 (`78d3c4d`) is on `test/M2-S2-ci-x64-arm64`, not on this branch.

**Verdict: E2E regression evidence for DNS-1: blocked by known non-DNS causes on this branch; moved to V5 on the combined branch.**

**V1d** (HEAD): `corepack yarn jest tests/unit` 15 suites passed, 111 of 111 tests; `corepack yarn lint` clean (exit 0).

## Results (V5, combined branch, Pi arm64, 2026-10-24)

Branch `test/M2-S2-ci-x64-arm64` at merge commit `cbcf075` (DNS-1 fix `385718b` and the CI-M2-S2 harness `78d3c4d` together); status clean; the "Amendment after DNS-1-r1" section is present; no `nst-*` leftovers; the previous `test-results/` is in `~/joplin-web-app-work/spikes/DNS-1/test-results-pre-v5/`. Logs under `test-results/` (gitignored).

| Step | Command | Result | Duration | Log |
|---|---|---|---|---|
| lint | `corepack yarn lint` | clean | | `test-results/lint.log` |
| unit | `corepack yarn jest tests/unit` | 20 suites, 139 of 139 | | |
| contract | `NOTESTEAD_KEEP_IMAGE=1 NOTESTEAD_WEB_ARTIFACT=~/joplin-web-app-work/ci-evidence/37285783648/extracted/web-bundle-v3.7.21 corepack yarn test:contract --verbose --json --outputFile=test-results/contract/jest-results.json` | **16 of 16 suites, 100 of 100 tests**, including `dns-1` (13 of 13, 142 s) and m1-s7 (11 of 11, 400 s) | about 46 min | `test-results/contract/v5-full.log`, `jest-results.json` |
| E2E | `env LANG=C.UTF-8 LC_ALL=C.UTF-8 NOTESTEAD_KEEP_IMAGE=1 NOTESTEAD_WEB_ARTIFACT=<same> corepack yarn playwright test` (the command of CI-M2-S2's WO-11, without the `$IMG` variables, so the device image is built by `globalSetup`, F-H1) | **16 of 16 passed**, no retry, LOC-01 and LOC-02 included | 34.7 min | `test-results/e2e-v5-full.log` |

**Scans** (`node tests/harness/tools/scan-proxy-dns.ts test-results`): 0 old-signature lookup lines, 0 other durations; 1 NXDOMAIN line (m1-s6 `ac20`, which stops `server` on purpose); 1 device log with `Last error`, `contract/m1-s5/device-dev1-neg.log`, the deliberate control, which is also the only file with `SEED SYNC FAILED`. The E2E stack `*_web_1.log` has 0 `lookup` lines. No `Sync: cancelling` line in the E2E run log. No hit for `sqlite3_step() rc=` or `Could not save` in any `browser-console.log` other than the known startup `notes_spellfix USING spellfix1` warning (rc 1) in the m1-s7 contract output. Browser consoles are attached only for failed tests, and the E2E run had none.

**Per-AC update.**
- DNS1-AC4: the E2E part now PASS. All 16 E2E tests, whose `e2eeAccount` and `upDefault` seed through the hardened device and the `info.json` post-condition, passed with 0 `SEED SYNC FAILED`.
- DNS-1's E2E regression check: PASS on the combined branch (16 of 16). The failures of V1c (WEB-SQLITE-1) and V1c' (F-R2) did not recur; F-R2 is fixed here by `78d3c4d`.
- DNS1-AC1 to AC3: PASS (contract layer, 13 of 13 in this run). DNS1-AC5: PENDING (V3, proof run 5).
- Classification of failures: none.
- Images kept: `notestead-test-device:3.7.1` (still tagged after this contract run), `notestead-web:m1-s4-test`, `notestead-web:stack-test`, `notestead-headless:stack-test`, `:m1-s5-test`, `:m1-s5-neg`.
