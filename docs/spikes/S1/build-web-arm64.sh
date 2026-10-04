#!/usr/bin/env bash
# Spike S1: build the upstream app-mobile web bundle natively (arm64 Pi).
# Mirrors github.com/joplin/web-app deploy-github-pages.yml:
#   checkout release-X.Y -> corepack enable -> yarn install -> cd packages/app-mobile -> yarn web
# Usage: build-web-arm64.sh [git-ref]   (default: v3.7.21 = release-3.7 head on 2026-10-03)
set -euo pipefail
REF="${1:-v3.7.21}"
WORK="${S1_WORK:-$HOME/joplin-web-app-work/spikes/S1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$WORK/joplin"

mkdir -p "$WORK"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$REF" https://github.com/laurent22/joplin.git "$SRC"
fi
cd "$SRC"
echo "ref=$REF commit=$(git rev-parse HEAD) node=$(node --version) arch=$(uname -m)"

export SKIP_ONENOTE_CONVERTER_BUILD=1   # no Rust/wasm-pack on the Pi (only built when IS_CONTINUOUS_INTEGRATION is set anyway)
export BUILD_SEQUENCIAL=1               # upstream's sequential build mode (lower peak memory than buildParallel)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

python3 "$HERE/measure.py" install "${INSTALL_TIMEOUT:-7200}" -- corepack yarn install
cd packages/app-mobile
python3 "$HERE/measure.py" web "${WEB_TIMEOUT:-3600}" -- corepack yarn web
du -sh web/dist
find web/dist -maxdepth 1 -type f | sort | head -50
