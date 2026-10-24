# DNS-1: the web proxy intermittently fails to resolve `server` (502). Investigation briefs

- **Origin:** CI-M2-S2 finding I (`docs/test-plans/CI-M2-S2-x64-arm64.md`, proof run 3, e2e 40020973008). The user split it out of M2-S2 on 2026-10-24.
- **Symptom:** `web` (Caddy, `reverse_proxy {$JOPLIN_SERVER_URL}` = `http://server:22300`, `deploy/web/Caddyfile:58`) logs `dial tcp: lookup server: i/o timeout`, and the client gets a 502.
  - **How often:** arm64 runner 46 `web` lines plus 12 in headless (the 502s it received through `web`); x64 14 plus 7; the Pi 6.
  - **Not arm64-only:** it also occurs in passing runs and on every platform.
  - **One known hard failure:** M1-AC21 NEG's positive-control ping in run 40020973008, at 21:03:41 and 21:04:08 (both attempts).
- **User-facing:** a self-hosted user's `web` resolves `server` through the same container-network DNS. **The tests are not changed to wait or retry around it.**
- **Status:** investigation only. A fix needs the orchestrator's decision. QA writes the regression test once a fix is chosen.

## Brief for the senior engineer (investigation first, no fix without a decision)
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

## Brief for the ci-cd-specialist (runner side; read-only, no workflow change)
1. From e2e runs 39663284028, 39768694985, 39957733152 and 40020973008, tabulate the `lookup server: i/o timeout` lines per runner and container, with timestamps relative to stack start.
2. From the runner images, report:
   - the podman, netavark and aardvark-dns versions;
   - whether the host's `resolv.conf` (systemd-resolved, `127.0.0.53`) leaks into the containers' DNS chain.
3. Propose, and do not apply, any runner-side setting that removes a DNS hop.

Deliver this as a section of `docs/worklog/DNS-1.md`, or in `docs/delivery/`, as the orchestrator assigns.
