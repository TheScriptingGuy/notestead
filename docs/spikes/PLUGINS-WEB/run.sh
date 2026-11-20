#!/usr/bin/env bash
# PLUGINS-WEB study: read-only GETs from the official plugin repository, then a text-only scan. Light job.
# Usage: bash docs/spikes/PLUGINS-WEB/run.sh [work-dir]   (default ~/joplin-web-app-work/spikes/PLUGINS-WEB)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-$HOME/joplin-web-app-work/spikes/PLUGINS-WEB}"
upstream="$HOME/joplin-web-app-work/upstream-joplin"
base=https://raw.githubusercontent.com/joplin/plugins/master
mkdir -p "$work/repo" "$work/jpl" "$work/x"
curl -fsS -A generic-client -o "$work/repo/manifests.json" "$base/manifests.json"
curl -fsS -A generic-client -o "$work/repo/stats.json" "$base/stats.json"
IDS_OUT="$work/ids.txt" TOP="${TOP:-40}" node "$here/analyse-manifests.cjs" "$work/repo/manifests.json" "$work/repo/stats.json" "$upstream"
while read -r id; do
	mkdir -p "$work/jpl/$id" "$work/x/$id"
	curl -fsS -A generic-client -o "$work/jpl/$id/plugin.jpl" "$base/plugins/$id/plugin.jpl"
	tar -xf "$work/jpl/$id/plugin.jpl" -C "$work/x/$id"
done < "$work/ids.txt"
node "$here/scan-jpl.cjs" "$work/x"
