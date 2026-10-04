# Spike S5: compatibility matrix (pinned web / CLI / server vs the user's server and clients)

## Question
- Are the versions we propose to pin (web bundle, CLI, test server) compatible with each other and with the user's existing Joplin Server and desktop/mobile clients?
- What is the sync-target version constant?
- What do we need to know from the user?

## Timebox
1 h of desk research plus evidence from S2/S3/S4. Used: ~45 min.

## Setup
```bash
cd ~/joplin-web-app-work/upstream-joplin            # blobless clone, release-3.7 checked out
git ls-remote --tags origin 'v3.7*' 'android-v3.7*' 'cli-v3.7*' 'server-v3.7*'
for t in v3.7.21 cli-v3.7.1 server-v3.7.2 android-v3.7.11; do
  git show $t:packages/lib/models/Setting.ts | grep -o 'syncVersion: [0-9]*'
  git show $t:packages/lib/services/database/migrations/index.ts | grep '^import migration' | tail -1
  git show $t:packages/{app-mobile,app-cli,server,lib}/package.json | grep '"version"'
done
git log --oneline android-v3.7.11..v3.7.21 -- packages/app-mobile packages/lib packages/renderer packages/editor
npm view joplin@3.7.1 dependencies ; npm view @joplin/lib versions
curl -s 'https://hub.docker.com/v2/repositories/joplin/server/tags?page_size=8&ordering=last_updated'
git show server-v3.7.2:packages/server/src/middleware/apiVersionHandler.ts
```

## Evidence

**Upstream refs (2026-10-03):**

| Ref | Commit | Date | app-mobile pkg | app-cli pkg | server pkg | lib pkg | `syncVersion` | last DB migration |
|---|---|---|---|---|---|---|---|---|
| `v3.7.21` = `release-3.7` head (**web pin**) | `e41516e66` | 2026-09-25 | 3.7.0 | 3.7.1 | 3.7.1 | 3.7.3 | **3** | 54 |
| `android-v3.7.11` (latest mobile release) | `70eac1b2e` | 2026-09-25 | 3.7.0 | 3.7.1 | 3.7.1 | 3.7.1 | **3** | 54 |
| `cli-v3.7.1` = npm `joplin@3.7.1` (**CLI pin**) | `425a05ac4` | 2026-09-07 | 3.7.0 | 3.7.1 | 3.7.1 | 3.7.1 | **3** | 53 |
| `server-v3.7.2` = `joplin/server:3.7.2` (**test server pin**) | `e2f30308f` (branched from `425a05ac4`) | 2026-09-07 | – | – | 3.7.2 | 3.7.1 | **3** | 53 |

- `syncVersion` is defined at `upstream:packages/lib/models/Setting.ts:306` in every ref.
- Between `android-v3.7.11` and `v3.7.21`, app-mobile, lib, renderer and editor changed only in bookkeeping commits:
  ```
  97b655510 Update lock files
  003f4bf9b Releasing sub-packages
  6061d506e Releasing sub-packages
  fdd400552 iOS 13.7.6
  ```
- Between `cli-v3.7.1` and `v3.7.21` there are 41 commits. The relevant ones for us:
  ```
  c3c0d56e3 Desktop: Fixes #16414: Return 202 for MCP notification requests (#16473)   <- not in the CLI pin
  51560e808 Desktop: Resolves #16498: AI Chat: Persist conversation history …        <- migration 54 (desktop AI chat)
  ```
- **npm:** `joplin@3.7.1` declares `"@joplin/lib": "~3.7"`, `"@joplin/renderer": "~3.7"` and `"@joplin/utils": "~3.7"` (floating). Only 3.7.1 of each is published, so our lockfile must pin them (ADR-0005).
- **Docker Hub:** `joplin/server:3.7.2`, `latest`, `3.7` and `3` are multi-arch (amd64 + arm64), updated 2026-09-07.
- **Client/server handshake:**
  - The client sends `X-API-MIN-VERSION: 2.6.0` (`upstream:packages/lib/JoplinServerApi.ts:184`).
  - The server rejects only if it is *older* than that (`upstream:packages/server/src/middleware/apiVersionHandler.ts`).
  - Our clients therefore work with any Joplin Server ≥ 2.6 whose sync target is at version 3.
- **Sync-target behaviour:** a client whose `syncVersion` is greater than the target's `info.json` version upgrades the target, after which older clients get "Sync version of the target (N) is greater than the version supported by the app" (`upstream:packages/lib/services/synchronizer/MigrationHandler.ts:72-90`). Since every 3.x ref has `syncVersion` 3, no upgrade is triggered.
- **Runtime evidence:**
  - S3: CLI 3.7.1 syncs with server 3.7.2, and the target's `info.json` reports `version: 3` after the first sync.
  - S4 §B: the web bundle `v3.7.21` syncs with the same target, and `info.json` still reports `version: 3` afterwards.

  See those reports for the outputs.

## Result
**GO-WITH-CONDITIONS.**
- The pins (web `v3.7.21`, CLI `3.7.1` + lockfile, server `3.7.2`) are mutually compatible: same minor, the same `syncVersion` 3, and runtime sync proven in S3/S4.
- The web/CLI skew (3.7.21 vs 3.7.1) only touches local DB migrations (each client has its own database) and MCP notification status codes (which our design never forwards).

**Conditions, which depended on the user's answers** (Q3/Q4; all resolved at gate 1, see below):
1. The user's Joplin Server runs 3.x (≥ 2.6 works technically; same minor 3.7 is the policy) and its sync target reports `info.json` `version: 3`.
2. The user's desktop and mobile clients are 3.x. Older 2.x clients also have `syncVersion` 3, but they are outside the tested matrix.
3. **All E2EE master keys on the account can be unlocked with one master password.** Older accounts can have keys with different passwords. The headless service uses `encryption.masterPassword` only (`upstream:packages/lib/services/e2ee/utils.ts:142-153`), so items under other keys would stay encrypted (reported as `degraded`, M3-AC5).
4. The user's front proxy (if any) allows request bodies up to the attachment sizes they use, and forwards the client IP (S2 condition 2).

## Resolution at gate 1 (2026-10-04)
The user answered Q3/Q4 at gate 1. The result becomes **GO** for the pinned set.

| Condition | Resolution |
|---|---|
| 1. Server on 3.x, sync target at version 3 | **Resolved:** the server is on 3.7.x (same minor as the pins). The target's `info.json` `version: 3` is still asserted before and after the user's smoke test (M5-AC11 NEG). |
| 2. Clients on 3.x | **Resolved:** all desktop and mobile clients are on 3.7.x. |
| 3. One master password unlocks all E2EE keys | **Resolved:** confirmed by the user. The `degraded` path (M3-AC5) stays as a guard. |
| 4. Front allows the needed body sizes and forwards the client IP | **Resolved by design:** the front is Cloudflare Tunnel; client IP from `CF-Connecting-IP` (ADR-0002 rule 4); the body limit is documented as L16 (`docs/spikes/S6-cloudflare-tunnel.md`). |

The remaining server details (`APP_BASE_URL`, a direct `JOPLIN_SERVER_URL`, `USER_CONTENT_BASE_URL`, the Cloudflare plan) are deploy-time configuration, collected in M5-S4 (M5-S6 prerequisites), not design questions.

## Follow-ups (original list; answered at gate 1 except where M5-S4 collects deploy details)
- **Joplin Server:** its version (admin UI footer, or `podman/docker image inspect`), its `APP_BASE_URL`, how it is fronted (proxy or tunnel, upload limit, whether it sets `X-Real-IP`/`X-Forwarded-For`), and whether `USER_CONTENT_BASE_URL` is set.
- **Clients:** desktop and mobile versions (Help → About), and confirmation that they are 3.7.x.
- **E2EE:** in desktop Settings → Encryption, do all master keys show as decryptable with the master password? An approximate number of notes and attachments and the total size, to size the headless volume and initial sync.
- After approval, the compatibility matrix moves to `docs/architecture/compatibility.md` and is updated by every bump PR (M6).
