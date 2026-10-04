#!/usr/bin/env bash
# Spike S4 (MCP part): can upstream's built-in /mcp be enabled and used in the headless CLI?
# Prereq: docs/spikes/S3/run-s3.sh has run (container s3-headless, profile /data/headless, server running on 41184).
set -uo pipefail
WORK="${S4_WORK:-$HOME/joplin-web-app-work/spikes/S4}"
source "$HOME/joplin-web-app-work/spikes/S3/token.env"   # TOKEN=..., SESSION=...
X() { podman exec s3-headless "$@"; }
rpc() { # $1 = JSON body
  X sh -c "curl -s -o /tmp/rpc.out -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary '$1' 'http://127.0.0.1:41184/mcp?token=$TOKEN'; echo; cat /tmp/rpc.out; echo"
}

echo "### M0 /mcp before enabling (expect 403 'MCP server is disabled')"
rpc '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'

echo "### enable mcp.enabled + allow-listed tools via config --import (stdin), then restart the CLI server"
TOOLS="search_notes read_note read_image list_notebooks list_tags create_note update_note delete_note manage_tags create_notebook"
JSON=$(python3 -c 'import json,sys; d={"mcp.enabled":True}; d.update({f"ai.tool.{t}.enabled":True for t in sys.argv[1:]}); print(json.dumps(d))' $TOOLS)
echo "$JSON" | podman exec -i s3-headless joplin --profile /data/headless config --import
X sh -c 'cycle.sh /data/headless 41184'   # restart (also a sync cycle)
X joplin --profile /data/headless config mcp.enabled

echo "### M1 initialize"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"s4","version":"0"}}}'
echo "### M2 notifications/initialized (CLI 3.7.1 predates upstream fix #16473: what status code?)"
rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "### M3 tools/list (names + disabled markers)"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | tail -1 | python3 -c '
import json,sys
d=json.load(sys.stdin)
for t in d["result"]["tools"]:
    print(("DISABLED " if t["description"].startswith("(Disabled tool)") else "enabled  ")+t["name"], "| required:", t["inputSchema"].get("required"))
'
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | tail -1 > /dev/null
X sh -c "curl -s -X POST -H 'Content-Type: application/json' --data-binary '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' 'http://127.0.0.1:41184/mcp?token=$TOKEN'" > "$WORK/tools-list.cli-3.7.1.json"
echo "saved tools/list snapshot: $WORK/tools-list.cli-3.7.1.json ($(wc -c < "$WORK/tools-list.cli-3.7.1.json") bytes)"

echo "### M4 tools/call list_notebooks"
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_notebooks","arguments":{}}}' | cut -c1-400
echo "### M5 tools/call create_note (E2EE profile) with a file:// image in the body -> must NOT create a resource"
BEFORE=$(X sh -c "curl -s 'http://127.0.0.1:41184/resources?token=$TOKEN&limit=100'" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"MCP created epsilon","body":"epsilonword ![x](file:///data/headless/settings.json)","is_todo":true}}}' | cut -c1-400
AFTER=$(X sh -c "curl -s 'http://127.0.0.1:41184/resources?token=$TOKEN&limit=100'" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
echo "resources before=$BEFORE after=$AFTER (equal => upstream create_note does not download file: URLs)"
echo "### M6 tools/call search_notes (existing synced note)"
rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"zebracorn"}}}' | cut -c1-400
echo "### M7 tools/call update_note append"
NID=$(X sh -c "curl -s 'http://127.0.0.1:41184/search?token=$TOKEN&query=zebracorn&fields=id'" | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["id"])')
rpc "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"update_note\",\"arguments\":{\"note_id\":\"$NID\",\"append\":\"appended-by-mcp\"}}}" | cut -c1-300
X sh -c "curl -s 'http://127.0.0.1:41184/notes/$NID?token=$TOKEN&fields=body'"; echo
echo "### M8 disabled tool call (semantic_search_notes not enabled)"
rpc '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"semantic_search_notes","arguments":{"query":"x"}}}' | cut -c1-300
echo "### M9 /mcp without token -> expect 403"
X sh -c "curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data-binary '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}' http://127.0.0.1:41184/mcp"
echo "### M10 POST /notes with file:// image via REST (the exfiltration path) -> resource created?"
BEFORE=$(X sh -c "curl -s 'http://127.0.0.1:41184/resources?token=$TOKEN&limit=100'" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
X sh -c "printf 'harmless-fixture-secret\n' > /tmp/fixture.txt; curl -s -X POST 'http://127.0.0.1:41184/notes?token=$TOKEN' -d '{\"title\":\"REST file url probe\",\"body\":\"![x](file:///tmp/fixture.txt)\"}'" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("body after POST:", d["body"][:120])'
AFTER=$(X sh -c "curl -s 'http://127.0.0.1:41184/resources?token=$TOKEN&limit=100'" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
echo "resources before=$BEFORE after=$AFTER (after>before => POST /notes copied the local file into a resource)"
