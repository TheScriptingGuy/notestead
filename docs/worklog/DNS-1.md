# DNS-1 worklog: `web` intermittently fails `lookup server: i/o timeout` (502)

Investigation only. No product change: nothing under `deploy/**`, `packages/**`, `tests/**` or `docs/adr/**` was touched. Branch `feat/DNS-1-proxy-dns`, senior-engineer, 2026-10-24. All experiments ran from scratch copies in `~/joplin-web-app-work/spikes/DNS-1/` (Caddyfiles, resolv.conf variants, probe scripts, raw logs). Tokens do not appear anywhere in this file.

## Summary

- **On the Pi (podman 5.4.2, netavark and aardvark-dns 1.14.0) the failure does not reproduce**, not at idle, under 8-way parallel dialing with container churn, nor under 4-core CPU saturation plus network create/remove churn. The `i/o timeout` form appears only in CI (podman 4.9.3), never in any local Pi log.
- **What the error is.** `lookup server: i/o timeout` with no `on <ip>:53` and a `"duration":3.00…` is not a DNS answer or a resolver timeout. It is Caddy's 3 s default `dial_timeout` expiring while Go's pure-Go resolver is still waiting on the first nameserver of `resolv.conf` (Go waits 5 s per server before trying the next). I reproduced it exactly with a fault-injected, silent first nameserver: 502 at 3.0022 s in 5/5 requests, same message, same duration as CI (3.0005 s).
- **Why the first nameserver is silent in CI is not proven.** The best-supported hypothesis is that aardvark-dns on the CI runner (Ubuntu 24.04: podman 4.9.3, so aardvark-dns about 1.4) stops answering for a while when the headless container joins `back`. The evidence is below. The ci-cd-specialist's section should confirm the version.
- **Proposed fix** (smallest, deploy-level, image-owned): `dial_timeout 10s` in the `reverse_proxy` transport of `deploy/web/Caddyfile`. Optional second layer: `dns_opt: ["timeout:1", "attempts:2"]` on `web` in the compose files. Neither is applied here.

## 1. Reproduction on the Pi

Commands (all outcomes as seen):

- `node tests/stack/cli.ts up` -> project `nst-dev-mvm3pvrs4047b1` (web `127.0.0.1:34711`). This builds the web, headless and device images itself, and `down` removes them again (see "Process note" below).
- Three probes ran in parallel for 600 s:
  1. `getent hosts server` every 0.5 s inside `web` (musl resolver, not Go). `/proc/uptime` timestamps (10 ms resolution).
  2. `GET /joplin-server/api/ping` on `127.0.0.1:34711` through the real `web`, every 0.2 s (keep-alive, so it rarely dials, which makes it a weak DNS probe by itself).
  3. A scratch Caddy (`dns1-probe`, same image, same two networks, `keepalive off`, `Host joplin.example.test`) with `curl` against it every 0.2 s: one fresh dial and therefore one Go-resolver lookup per request. This is the real DNS probe.

Results, phase 1 (idle, 600 s):

| Probe | n | failures | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `getent hosts server` in `web` | 1176 | 0 | 0 ms | 10 ms | 10 ms | 30 ms |
| scratch Caddy, one Go lookup + proxy per request | 2701 | 0 (all 200) | 4.2 ms | 11 ms | 16 ms | 54 ms |
| real `web` ping through :8080-published port | 2573 | 0 (all 200) | 4.2 ms | | 15.8 ms | 27 ms |

`lookup server` lines: 0 in `web`, 0 in `dns1-probe`, 0 in headless; 502 count 0.

Phase 2 (180 s): 8 parallel loops into the scratch Caddy (5886 fresh dials) while `podman run --rm` containers joined `front`+`back` and `back` alone, 300 starts and stops. 0 failures, p99 57 ms, max 123 ms. `getent` loop: 0 of 345.

Phase 3 (180 s): the same 8 loops while 4 cores were pinned with busy loops and a new network plus container was created and removed 70 times. 5758 dials, 0 failures, p99 73 ms, max 264 ms. `getent`: 0 of 342, p99 40 ms, max 190 ms.

Total on the Pi: about 16 200 name resolutions with no failure, max latency 264 ms.

The Pi's own test-results contain only `lookup server on 10.89.x.1:53: no such host` lines (50 counting duplicated attachments). These are the NXDOMAIN case of tests that stop the `server` container on purpose (AC20 and similar), a different message and a different mechanism.

## 2. Inspection

`web` (Pi): `/etc/resolv.conf`:

```
search dns.podman dns.podman
nameserver 10.89.1.1      (front gateway)
nameserver 10.89.2.1      (back gateway)
```

No `options` line, so the defaults apply: timeout 5 s, attempts 2, no rotate. The order follows the order in which the container's networks are listed; a container started with `--network back --network front` gets them reversed (observed in the scratch container). `server` is only on `front`, but the lookup succeeds against either gateway in all my runs, so aardvark answers for names on any network of the querying container.

Facts about the DNS stack on the Pi:

- netavark 1.14.0, aardvark-dns 1.14.0 (`podman info`), crun 1.21, podman 5.4.2. One `aardvark-dns` process per user serves all networks, binding `:53` on each network's gateway. Per-network records live in `/run/user/1000/containers/networks/aardvark-dns/<net>` (the internal `back` network is stored as `<net>%int`). Both networks have `dns_enabled: true`; `back` is `internal: true`.
- The `web` image is Alpine with static Caddy v2.11.6 (Go resolver, not libc; `nsswitch.conf` is irrelevant to it). The container has no `GODEBUG`.
- Host `resolv.conf` (NetworkManager, `192.168.2.254`) is not in the container's chain for `server`: aardvark answers its own container names and forwards only unknown names.
- CI: podman 4.9.3 on `ubuntu-24.04` and `ubuntu-24.04-arm` (job log). Versions of netavark and aardvark-dns on the runners are the ci-cd-specialist's part of this story.

Clustering in the CI evidence (run 40020973008):

- Not only at stack start. Arm64 E2E `web` log: 33 lines spread over 366 s, in bursts spaced about 3 s apart (+75..85 s, +106..118 s, +234..273 s), plus isolated ones.
- Simple stacks (`nst-guardpos-*`, only `server` + `web` + one headless) show the same signature: three consecutive failures of the headless readiness ping at +16 s, +49 s, +82 s after `web` start (each exactly 33 s apart: a 30 s retry plus the 3 s dial timeout), each `"duration":3.0005…`, then a success at +112 s. The same web served `/joplin-server/api/sessions` and `items` requests fine at +9 s, about 2 s before the headless container started (headless first log line 20:54:52.65, first failed ping 20:54:57.1). That is the best evidence for the window opening when the headless container joins `back`.
- Presence: `i/o timeout` shows in about 35 retained stack web logs, all CI (both arches, all runs back to 38874722165), none from the Pi.

## 3. Cause (best-supported hypothesis)

Proven:

1. The CI error is Caddy's 3 s dial deadline firing during a Go name lookup. Evidence: message without `on <ip>:53`, `"duration":3.0005`, and an exact local reproduction (section 4, variant A).
2. Go's resolver, with no `options` in `resolv.conf`, waits 5 s on a silent nameserver before asking the next one. Caddy gives up at 3 s. So any single dropped or delayed UDP reply from the first gateway turns into a 502, even though the second gateway answers in microseconds.

Hypothesis (not proven):

3. The first nameserver is silent in CI for tens of seconds after the headless container joins `back`: timing correlates (failures begin right after headless start, end after about 100 s), and CI has older aardvark-dns (about 1.4, Ubuntu 24.04) than the Pi (1.14.0), which never showed it. A network change makes podman signal aardvark-dns to reload its listeners; an old build can leave the gateway socket unresponsive for a while. I could not install aardvark 1.4 on the Pi (no system changes), so this link is unconfirmed. A related CI cause (runner CPU starvation delaying UDP replies) would have the same effect and the same fix.

Either way, the weakness in our deploy is the same: a 3 s dial deadline against a 5 s resolver timeout.

## 4. Options evaluated (scratch only, nothing implemented)

Fault injection: a UDP sink container on `front` that never answers (`node` `dgram` socket on :53), mounted resolv.conf with the sink as the first nameserver (then the two real gateways), scratch Caddy on both networks, `keepalive off`, 5 requests each (`curl` inside the scratch container). The sink stays silent for every packet, which is harsher than the CI transient.

| Variant | Config | Result (5 requests) |
|---|---|---|
| Control | no fault, current Caddyfile | 200 in 4 ms (section 1) |
| A | current Caddyfile (default `dial_timeout` 3 s) | 502 at 3.002 s each time; log `dial tcp: lookup server: i/o timeout` (identical to CI) |
| B | `lb_try_duration 10s`, `lb_try_interval 250ms` | 502 at 12.76 s each time (persistent fault: every try times out). With a transient fault (earlier run, a sink that goes quiet after the first peer) it recovered: 200 at 6.5 s. Retrying is safe for POST (nothing was sent, a lookup failed) but helps only transient faults and makes the failure slower |
| C | `transport http { dial_timeout 10s }` | 200 at 5.006 s each time: the second nameserver is asked after Go's 5 s |
| D | `resolv.conf` `options timeout:1 attempts:2` | 200 at 1.005 s each time |
| E | B plus D | 200 at 1.005 s |
| F | `GODEBUG=netdns=go` | Not needed: the static Caddy already uses the Go resolver (error format proves it). No effect expected |
| G | upstream by IP | Not tried; rejected by the brief (ADR-0006 keeps name-based topology) |

`podman run --dns-option timeout:1 --dns-option attempts:2` (compose `dns_opt`) puts exactly `options timeout:1 attempts:2` in the container's `resolv.conf`, keeping both aardvark gateways (checked on podman 5.4). The image cannot set it itself: the runtime writes `resolv.conf`, and the root filesystem is read-only.

## 5. Recommendation

1. **`deploy/web/Caddyfile`, in the `joplin_server_proxy` snippet:** add

   ```
   transport http {
       dial_timeout 10s
   }
   ```

   Smallest and image-owned, so every user gets it with no compose change and it works on docker too. User-facing effect: a lookup that hits a slow first nameserver shows as a request that takes about 5 s instead of a 502; sync clients (headless, mobile web) never see the transient error. Risk: when the server really is down, a request now fails after up to 10 s instead of 3 s (and the headless readiness ping, the web UI's sync-error banner and the MCP waits are slower to report it). I judge that acceptable; nothing in the web health check depends on it (it targets `127.0.0.1:8080/`, not the proxy).
2. **Optional hardening, in `tests/stack/compose.yaml` and the user compose in M5:** `dns_opt: ["timeout:1", "attempts:2"]` on `web`. Effect: a silent gateway costs 1 s, not 5 s. Risk: low; with a single embedded resolver (docker's 127.0.0.11) it is harmless. `tests/stack/**` belongs to QA, and `deploy/compose.yaml` does not exist yet (M5), so this is a follow-up for M5.
3. **Not recommended on its own:** `lb_try_duration/interval` (variant B). It is safe for POST but only masks transient faults and lengthens persistent ones. If the orchestrator wants belt and braces, add `lb_try_duration 15s` with `lb_try_interval 500ms` after `dial_timeout`.

Changing `dial_timeout` alters a Caddy default, not upstream Joplin: no patch and no upstream issue is involved (upstream-first note: nothing to propose upstream; this is Caddy configuration in our own image).

## 6. QA test idea (contract layer, new regression test once a fix is chosen)

"A delayed DNS answer from the first nameserver must not produce a 502 through `web`."

- Start the compose test stack. Add a throwaway UDP sink container on `front` that receives on :53 and never answers (the headless image has Node; `dgram` is 3 lines). Give `web` a bind-mounted `resolv.conf` whose first nameserver is the sink's IP, followed by the real gateways (override file; `web` is read-only but `/etc/resolv.conf` can be mounted).
- Positive: `GET /joplin-server/api/ping` through `web` returns 200, even a `POST` to an api route returns the server's answer, and the `web` log has no `lookup server` line. Time bound: under 12 s.
- Negative control: with the current Caddyfile, the same test fails with 502 at about 3.0 s and `lookup server: i/o timeout` in the `web` log. QA writes it first to prove the fault injection works (red before the fix, green after). Do it with `keepalive` irrelevant: use a fresh `GET` after an idle period longer than the upstream keep-alive, or `POST` to a path that forces a dial (Caddy's default transport keeps connections for 2 minutes, so the first request after stack start is the reliable one).
- If `dns_opt` is adopted, add a second case asserting the request takes about 1 s.

## 7. Process notes and follow-ups

- **Images.** `cli.ts up` always builds the test images and `down` removes them (`removeBuiltImages`, unless `NOTESTEAD_KEEP_IMAGE=1`). My first `up`/`down` therefore removed `localhost/notestead-test-device:3.7.1`, `notestead-headless:stack-test` and `notestead-web:stack-test`, which were present before. I noticed after the first `down`, rebuilt them with `NOTESTEAD_KEEP_IMAGE=1 node tests/stack/cli.ts up` followed by the same `down`, and confirmed all three tags exist again (rebuilt from this branch, same sources as main). Anyone using `cli.ts` for a probe should set `NOTESTEAD_KEEP_IMAGE=1` or pass the `NOTESTEAD_*_IMAGE` variables.
- **Cleanup.** Both stacks (`nst-dev-mvm3pvrs4047b1`, `nst-dev-mvm67sms04f264`) were removed with `cli.ts down`; scratch containers `dns1-probe`, `dns1-silent`, `dns1-vA..E` and temporary `dns1-tmp-*` networks removed. `podman ps -a` shows only the user's `byparr`, networks only `byparr_default` and `podman`. `git status` is clean apart from this file.
- **Follow-ups:** (a) orchestrator decision on the fix (section 5); (b) M5: put `dns_opt` in the user compose; (c) confirm the aardvark-dns version and the reload hypothesis on the runner (ci-cd-specialist part); (d) the headless readiness retry of 30 s makes every transient 502 cost 33 s; a shorter first retry would shrink the visible window (headless story, out of scope here).
- The brief's ci-cd-specialist section (per-runner tabulation, runner versions, host resolv.conf chain) is not part of this worklog; I only read the retained logs in `~/joplin-web-app-work/ci-evidence/` for the cross-checks above.

## Runner side (ci-cd-specialist)

Read-only. No workflow, setting or runner change was made or applied. Data: the retained artifacts and job logs of e2e runs 39663284028, 39768694985, 39957733152, 40020973008 and 40075823250 (head 24e6c99) in `~/joplin-web-app-work/ci-evidence/<run>/`. Timestamps are UTC. "Stack" means one compose project (a `web` container log). Reproducible with the scratch script described at the end.

### 1. Lookup-timeout lines per runner and container

Counted from the stack `*_web_1.log` files (the Caddy JSON lines with `"msg":"dial tcp: lookup server: i/o timeout"`). The NEG `web-nohost-*` containers (separate Host-rewrite-free web) logged 0 lines in every run. No other container logs the Caddy line; `headless` shows the effect as `initial cycle failed: the sync target did not answer /api/ping before the sync (HTTP 502)`.

| Run | Runner | Stacks (with lines / total) | `web` lines | After latest headless start: 0-60 s / 60-300 s / over 300 s | First line, s after `web` start (per stack) |
|---|---|---|---|---|---|
| 39663284028 | x64 | 1 / 7 | 1 | 1 / 0 / 0 | 44 |
| 39663284028 | arm64 | 1 / 7 | 4 | 3 / 1 / 0 | 16 |
| 39768694985 | x64 | 2 / 7 | 8 | 7 / 1 / 0 | 40, 135 |
| 39768694985 | arm64 | 3 / 7 | 17 | 7 / 10 / 0 | 16, 39, 123 |
| 39957733152 | x64 | 2 / 7 | 29 | 20 / 9 / 0 | 39, 70 |
| 39957733152 | arm64 | 3 / 7 | 20 | 11 / 9 / 0 | 17, 30, 35 |
| 40020973008 | x64 | 3 / 7 | 15 | 9 / 5 / 1 | 15, 16, 308 |
| 40020973008 | arm64 | 4 / 8 | 47 | 32 / 15 / 0 | 15, 16, 16, 32 |
| 40075823250 | x64 | 4 / 8 | 29 | 24 / 5 / 0 | 15, 16, 26, 107 |
| 40075823250 | arm64 | 2 / 8 | 63 | 20 / 43 / 0 | 32, 34 |
| **Total** | x64 | 12 / 36 | 82 | | |
| **Total** | arm64 | 13 / 37 | 151 | | |

Facts:
- 225 of the 233 lines carry `"duration"` 3.00x s (Caddy's `dial_timeout`); the other 8 carry 0.0 s.
- No line in any stack precedes the start of the first headless container of that stack ("before any headless joined": 0 of 233). In the simple stacks (guard-position, `ac18-up`; one `server`, one `web`, the default headless) the first line is at +15 to +17 s after `web` start, the default headless started at +11 to +12 s.
- Caveat on that fact: the headless supervisor's first `/api/ping` is the first request that needs a fresh dial, so "no failures before a headless joined" is partly because nothing else dials. It does not separate "headless joining `back` breaks aardvark" from "failure is random and first seen when there is traffic". In the long E2E stacks, 18 to 629 proxied requests with status 200 precede the first failure, and failures later come in bursts roughly 3 s apart (one 3 s dial each) that last 20 to 100 s.
- Failure windows are not tied to a headless start: in run 40075823250 arm64 the E2E stack had 62 lines, 43 of them 60 to 300 s after the latest headless start.

### 2. Versions on the runners

From the job logs (step "Podman and the pinned podman-compose", `.github/actions/podman`):
- `podman version 4.9.3`, Go 1.22.2, `podman-compose version 1.3.0`, `cgroupManager=systemd cgroupVersion=v2 eventLogger=journald rootless=true graphDriver=overlay runRoot=/run/user/1001/containers`, on both `ubuntu-24.04` (linux/amd64) and `ubuntu-24.04-arm`.
- **netavark and aardvark-dns versions are not in any retained log or artifact.** No step runs `podman info` with network fields, and `dpkg -l` is not run. A search of all five runs for `netavark` finds nothing; the only `aardvark` hit is `Terminate orphan process: pid (57927) (aardvark-dns)` in the cleanup of run 39663284028.
- Not confirmed. A web search of the Ubuntu noble archive was inconclusive (it lists 1.4.0-4 and 1.6.0-1ubuntu1 for both packages without saying which noble ships). Treat "aardvark-dns about 1.4" in section 3 above as unverified. One read-only log step would settle it (proposal P1 below).

### 3. Does the host `resolv.conf` (127.0.0.53) reach the containers?

- **Not answerable from the retained logs.** No log or artifact contains `127.0.0.53` or `nameserver` (all five runs searched). The Caddy error has no `on <ip>:53`, so it does not name the nameserver that was silent.
- Indirect, labelled as such: `server` is a container name on `front`, so aardvark answers it from its own records and only forwards unknown names to the host resolver. A host stub (127.0.0.53) would matter only for external names, and `web` resolves none. So a host-resolver leak is unlikely to explain `lookup server` failures. This is reasoning, not an observation.
- Mechanism seen on the Pi (section 2 above) is the better lead: two aardvark gateways in `resolv.conf` (front, then back), Go waits 5 s per server, Caddy gives up at 3 s.

### 4. New runner-side evidence from run 40075823250

The same DNS episodes also break the test seeding, not only the proxied requests. Across the five runs, 3 of 202 `device-*.log` files (some are copies inside report folders) (the throwaway CLI "device" that enables E2EE and uploads the seed) contain `Completed: ... (39s) Last error: Error: Error 502 Bad Gateway`:
- run 39957733152 arm64, `contract/m1-s6a/c1/stack/device-7825a393.log` (the 600 s `headlessService` wait);
- run 40075823250 x64, `contract/m1-s6/ac20/stack/device-0bca5973.log` (a 420 s fixture timeout);
- run 40075823250 arm64, `e2e/stack/device-803d774f.log` (M2-AC3 attempt 1, a 420 s fixture timeout; the retry passed).

In the x64 case the web log shows eight consecutive `POST /joplin-server/api/sessions` 502s, each `"duration":3.0`, from 08:09:21.357 to 08:10:03.518 (the device's login, retried by the CLI until it gave up after 39 s). The device still exits 0 and prints `RESULT`, but it never uploaded the master-key info. The headless container for that account then loops: `[joplin e2ee decrypt] DecryptionWorker: cannot start because no master key is currently loaded.` then `initial cycle failed: e2ee decrypt exited with code 1; retrying in 30 s` (13 times in 420 s), `/healthz` stays 503 `starting`, `lastSync none`. In all three cases this is the only cause I found for the headless readiness timeouts; in the other runs' passing per-test headless starts the device log has no `Last error`.

This is a harness finding as well as a DNS one (the device command should fail on `Last error`), which is outside this brief and goes to QA.

### 5. Proposals (not applied)

None needs a workflow change that I recommend before the orchestrator decides on the Caddy fix.

- **P1, evidence first (read-only, one extra log step in `e2e.yml`, ci-cd-owned):** in the podman action, print `podman info --format '{{json .Host.NetworkBackendInfo}}'` (netavark and aardvark-dns versions and paths), `dpkg-query -W podman netavark aardvark-dns` and, from one throwaway container, `cat /etc/resolv.conf`. It settles sections 2 and 3 in the next run for the cost of seconds.
- **P2, a runner setting that shortens the hop without touching `deploy/` (reversible):** a per-job `~/.config/containers/containers.conf` with `[containers]` `dns_options = ["timeout:1", "attempts:2"]`. Every container, including `web`, gets that `options` line, so a silent gateway costs 1 s instead of 5 s. Caveat: it hides the weakness in CI instead of fixing it for users; the Caddyfile `dial_timeout` fix (section 5 above) is the one that protects a self-hosted user, and it should be proven first. If both are in place a CI pass no longer shows the user-facing risk. I would use P2 only as an A/B experiment, not as a permanent setting.
- **P3, remove the second DNS hop at the source (experiment only):** on a throwaway run set `[network] network_backend = "cni"` in the same `containers.conf` (podman 4.9 supports it with the `dnsname` plugin on Ubuntu) to see whether the failures follow aardvark-dns. It changes the network stack under test and invalidates the Pi parity (Pi: netavark 1.14), so it is a diagnosis, not a fix.
- **P4, newer netavark and aardvark-dns on the runner:** not available from the Ubuntu 24.04 archive for podman 4.9.3. A source or PPA install is a supply-chain change (hash-pinning needed) and I do not recommend it before P1 shows the actual versions.
- I do not propose pointing `web` at an upstream IP or disabling `dns_enabled` on the CI network; both change the topology under test (ADR-0006).

Method note: counts come from a scratch script in the session scratchpad (not committed) that reads each stack's `*_web_1.log` JSON lines and each stack's headless container log for its first timestamp. The raw files are under `~/joplin-web-app-work/ci-evidence/<run>/extracted/`.

## Implementation (senior-engineer, 2026-10-24)

Change, in `deploy/web/**` only: `transport http { dial_timeout 10s }` inside `reverse_proxy` of the `(joplin_server_proxy)` snippet in `deploy/web/Caddyfile`, with a comment (Go's resolver waits 5 s per nameserver, Caddy's default dial timeout is 3 s, and the value has to stay at most 15 s). Both listeners import the snippet. `deploy/web/README.md` has the behaviour note: a slow first nameserver costs up to about 5 s instead of a 502, and an unreachable server is a 502 within about 10 s (it was 3 s). Nothing else changed; no `tests/**`, `packages/**` or ADR edits.

No ADR deviates. ADR-0006's name-based topology is kept. Upstream-first: this is plain Caddy configuration, no shim.

Commands and outcomes (Pi, arm64, one job at a time, `NOTESTEAD_KEEP_IMAGE=1`):
- `corepack yarn test:contract tests/contract/dns-1`: exit 0, 13 of 13 passed, 140 s. c1 6599 ms, c1b 6530, c2 6938, c2b 7094, c3d 11552 ms, c1-neg and c2-neg still see the 502 at about 3 s. dev1-c1 and dev1-neg pass.
- `corepack yarn test:contract tests/contract/m1-s4`: exit 0, 4 suites, 29 of 29 passed, 85 s.
- `corepack yarn jest -c jest.config.js tests/unit`: exit 0, 15 suites, 111 of 111 passed (includes `dns1-s1`).
- `corepack yarn lint` (eslint, three tsc projects): exit 0.
- A first attempt of the dns-1 run was lost because my own `pkill -f` killed the shell; it was rerun with no change to the code.

Follow-ups: compose `dns_opt` (M5) and the CI `containers.conf` experiments (P1 to P3 above) stay with the orchestrator.
