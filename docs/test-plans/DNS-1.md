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
