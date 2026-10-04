# ADR-0004: MCP server: our own endpoint over the REST Data API, with an allow-listed passthrough to upstream `/mcp`

## Status
**Accepted** at gate 1 (2026-10-04, tag `plan-approved-v1`), amended the same day (see Amendments). Proposed in Phase A (2026-10-03). Spike S4 part C: **GO-WITH-CONDITIONS**. Upstream `/mcp` works in the headless CLI 3.7.1 once enabled through `config --import`; see `docs/spikes/S4-browser-and-mcp.md` §C.

## Context
- **Upstream's MCP (3.7, beta) is served at `POST /mcp`** on the Data API port.
  - Implementation: `upstream:packages/lib/services/rest/routes/mcp.ts`, `…/services/mcp/McpServer.ts`.
  - Protocol `2025-06-18`. It handles `initialize`, `tools/list`, `tools/call` and `ping`, one JSON-RPC message or batch per POST, with no SSE and no stdio.
  - It is gated by `mcp.enabled` plus `ai.tool.<id>.enabled`, which are **all false by default** (`upstream:packages/lib/models/settings/builtInMetadata.ts:656, 872-1004` at `cli-v3.7.1`).
  - Disabled tools still appear in `tools/list` with a "(Disabled tool)" description and fail on `tools/call` (`…/ai/tools/ToolIndex.ts`).
  - The settings carry `appTypes: [Desktop]`, but `Setting.setValue` doesn't check app type. The CLI's `config` sets them, which S4 verified at runtime.
- **Upstream tools:** `search_notes`, `read_note`, `read_image`, `list_notebooks`, `list_tags` (only tags with notes), `create_note`, `update_note` (title/body/append/prepend/replace_text, move via `notebook_id`, `todo_completed`), `delete_note` (trash), `manage_tags`, `create_notebook`, and `semantic_search_notes` (desktop only, needs ONNX).
  - Write tools call `Note.save` directly, so **they don't download media** (`…/ai/tools/global/createNote.ts`).
- **Missing upstream:**
  - alarms/`todo_due`
  - notebook rename/move/delete
  - tag rename/delete and listing tags without notes
  - ordering
  - attachments
  - revisions
  - trash restore
  - sync
- **The REST Data API covers all of these** (`upstream:readme/api/references/rest_api.md`):
  - `PUT /notes/:id {todo_due, is_todo, todo_completed, order, parent_id, deleted_time}` (only `id` and the `*_time`/encryption fields are read-only: `…/rest/utils/readonlyProperties.ts`)
  - `PUT/DELETE /folders/:id`
  - `PUT/DELETE /tags/:id`
  - `POST /resources` (multipart)
  - `GET /revisions` (raw diff objects only)
- **The npm CLI (3.7.1) predates fix #16473** ("Return 202 for MCP notification requests"). That only matters to a client that forwards notifications. We don't.
- **ADR-0008** requires that untrusted bodies never reach `POST /notes`.
- **Public distribution** (`docs/delivery/channels.md`, approved at gate 1) makes a stand-alone stdio MCP package valuable. It is published as npm `notestead-mcp` and listed in the MCP Registry as `io.github.thescriptingguy/notestead`. Such a package works against any Joplin Data API: desktop, or our headless gateway.

## Decision
1. **We own the MCP endpoint** (`packages/mcp`, built on `@modelcontextprotocol/sdk`, MIT).
   - **Transports:**
     - **Streamable HTTP**, stateless, JSON responses, hosted by the headless supervisor at `/mcp` and published through `web` when `MCP_PUBLIC=true`.
     - **stdio** (`bin`), configured with a Data API base URL plus a token, for desktop Joplin or our gateway.
   - **Auth** (ADR-0008): bearer token, `Origin` validation, rate limits, read-only mode.
2. **Upstream passthrough, behind an allow-list.**
   - At startup the supervisor enables `mcp.enabled` and the `ai.tool.<id>.enabled` settings for the allow-listed tools: `search_notes`, `read_note`, `read_image`, `list_notebooks`, `list_tags`, `create_note`, `update_note`, `delete_note`, `manage_tags`, `create_notebook`.
   - It never enables `semantic_search_notes` or the editor tools.
   - Our server calls upstream `tools/list` and re-exports exactly the allow-listed tools with upstream's names, descriptions and input schemas. Our MCP annotations are added (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
   - `tools/call` is forwarded as JSON-RPC to `http://127.0.0.1:<api.port>/mcp?token=…`.
   - **Before forwarding**, string arguments that become note bodies (`create_note.body`; `update_note.body`/`append`/`prepend`/`replace_text`) pass through the **body sanitizer** (ADR-0008).
   - **Snapshot test:** `tools/list` of the allow-listed tools is snapshot-tested on every bump (`mcp-upstream` contract suite), so upstream changes are never silent. The S4 baseline snapshot: `read_note`/`update_note`/`delete_note`/`read_image` take `id`, `manage_tags` takes `note_id`, `create_notebook` takes `parent_id`, and `update_note.append` concatenates without a separator. Our descriptions document these quirks; we don't rename upstream's arguments.
   - **Notifications are never forwarded** to upstream. CLI 3.7.1 answers them with 200 and an empty body, and upstream #16473 later changed that to 202. Our server answers notifications itself.
   - **If the passthrough is unavailable** at runtime (upstream `/mcp` missing, or a tool missing), the server serves the **REST-backed equivalents** for the same names. Those are already needed for the stdio-against-desktop case, where the user may not have enabled upstream MCP.
3. **Gap tools**, implemented with the documented REST Data API only, through `packages/data-api-client`:

   | Tool | REST calls | Notes |
   |---|---|---|
   | `create_todo` {title, body?, notebook_id?, due?, tags?} | `POST /notes` (metadata only) → `PUT /notes/:id {body}` → `POST /tags/:id/notes` | `due` is ISO-8601 with an offset, or epoch ms. Without an offset it is resolved in `MCP_TIMEZONE`. The alarm fires on the user's devices after they sync. |
   | `set_todo_due` {note_id, due \| null} | `PUT /notes/:id {is_todo:1, todo_due}` | `null` clears the alarm |
   | `set_todo_completed` {note_id, completed} | `PUT /notes/:id {todo_completed: now \| 0}` | reopen is supported |
   | `rename_notebook`, `move_notebook` {notebook_id, parent_id \| null} | `PUT /folders/:id` | refuses cycles |
   | `delete_notebook` {notebook_id} | `DELETE /folders/:id` (trash) | permanent only with the flag, `destructiveHint` |
   | `list_all_tags` | `GET /tags` (paginated) | includes tags without notes |
   | `rename_tag` {tag_id, title} | `PUT /tags/:id` | |
   | `delete_tag` {tag_id} | `DELETE /tags/:id` | irreversible, so behind `MCP_ALLOW_PERMANENT_DELETE`, `destructiveHint` |
   | `reorder_note` {note_id, before_id \| after_id} | `GET` neighbours → `PUT /notes/:id {order}` | custom sort order only |
   | `attach_file` {note_id, filename, mime, content_base64, insert} | `POST /resources` multipart → `PUT /notes/:id {body+link}` | content, never a path. Size cap (default 25 MiB). |
   | `list_trash` | `GET /notes?include_deleted=1`, `GET /folders?include_deleted=1` (paginated, filter `deleted_time>0`) | |
   | `restore_from_trash` {id} | `PUT /notes/:id {deleted_time:0}` (+ parent folders if deleted) | mirrors upstream behaviour where possible. Edge cases are documented and tested. |
   | `list_note_revisions` {note_id} | `GET /revisions` (filter `item_id`) | metadata only. Restore is **deferred to upstream** (needs a REST endpoint that reconstructs a revision). |
   | `sync_now` {wait?} | supervisor `SyncStrategy.requestSync()` | coalesces with a running cycle; `wait` returns after the cycle or after at most `MCP_SYNC_WAIT_MAX` (default and maximum 90 s) with `{state:"running"}`, so a response always beats the front's 125 s timeout (ADR-0006) |
   | `sync_status` | supervisor | last result, last success, next run, queued writes |

4. **Write semantics:**
   - After any write tool, the supervisor **debounces a sync** (default 30 s), so changes reach the user's devices without waiting for the timer.
   - Every tool's result includes `synced: false|true` and `next_sync_eta`, so the LLM can tell the user when the change will appear on their devices.

## Alternatives considered
- **Reuse upstream as-is: point MCP clients directly at the CLI's `/mcp`.**
  - It needs the `?token=` query string and a `127.0.0.1` bind, so it is unreachable from outside the container, and the token would leak (ADR-0008).
  - No alarms, notebook/tag management, attachments or sync.
  - It is HTTP-only and stateless with no SSE. Clients that require streamable-HTTP session semantics or stdio need a bridge such as `mcp-remote`.
  - Not enough on its own. Reused through the passthrough instead.
- **REST-only (no passthrough).** Simpler: one code path and no beta dependency. But we would re-implement `search_notes`/`read_note`/`update_note` semantics that upstream maintains and improves (e.g. `replace_text`, filter syntax handling), and we'd lose free upstream improvements. Kept as the automatic fallback, not the default.
- **Existing community MCP servers** (alondmnt/joplin-mcp in Python, happyeric77/mcp-joplin in TypeScript with `todo_due` support, jordanburke/joplin-mcp-server).
  - The different language, licence or maintenance cadence doesn't fit the reuse-of-*upstream* rule. None has our guards (file:// exfiltration, permanent-delete flag, Origin checks).
  - happyeric77/mcp-joplin's tool shapes were reviewed as prior art only.
- **Contribute the gap tools upstream and wait.** That is the long-term goal (upstream-first). We can't block on it.

## Consequences
- Two implementations of some tools exist (passthrough and REST fallback). The contract suite runs both against the same expectations.
- Tool names are stable across both modes, so clients never see renames when the fallback is used.
- Upstream's `list_tags` semantics (only tags with notes) differ from `list_all_tags`. Both are documented in the tool descriptions.

## Upgrade impact
- **Upstream tool changes** surface as `mcp-upstream` snapshot diffs in bump PRs (M6-AC3).
- **If upstream adds gap tools** (e.g. `set_todo_due`), we can switch the name to the passthrough after review. The `upstream-first.md` ledger tracks this.
- **If upstream renames settings keys**, the supervisor's enablement fails loudly. Contract test `mcp-upstream-enable` (M4-AC3).

## Verification
- **S4:** upstream `/mcp` with the CLI headless (`initialize`, `tools/list`, `tools/call` for create/search/update), with the settings enabled through `config`.
- **Backlog M4:**
  - M4-AC1–AC4 (transports, auth, passthrough, snapshot)
  - M4-AC5–AC14 (gap tools)
  - M4-AC7 (sanitizer and the file:// negative test)
  - M4-AC15–AC16 (cross-surface E2E)

## Amendments (2026-10-04, gate 1)
- **`sync_now {wait:true}` is capped at 90 s** (`MCP_SYNC_WAIT_MAX`), then reports the cycle as running; clients poll `sync_status`. Reason: the Cloudflare Tunnel front answers 524 after 125 s without response headers (ADR-0006, S6). Test: M4-AC14.
- With the tunnel, the `Origin` allow-list (`MCP_ALLOWED_ORIGINS`) contains the tunnel hostname, and Cloudflare Access with a service token can optionally sit in front of `/mcp` (ADR-0006/0008). The bearer token stays mandatory.
- Package names: npm `notestead-mcp`, MCP Registry `io.github.thescriptingguy/notestead`.
