#!/usr/bin/env bash
# Runs inside docker/Dockerfile. Produces:
#   frontend/desktop/dist/OpenScience-linux-x64.AppImage
set -euo pipefail
cd /work

mkdir -p .build
# models.dev is not reachable from every network. The repository ships a
# catalog snapshot used by its provider tests; it contains opencode-go with the
# documented endpoint and env var, so the build is deterministic and offline.
python3 -I - <<'PY'
import gzip
src = "backend/cli/test/fixture/models-catalog.json.gz"
dst = ".build/models-dev.json"
with gzip.open(src, "rb") as source, open(dst, "wb") as target:
    target.write(source.read())
print("models snapshot:", dst)
PY

export MODELS_DEV_API_JSON="/work/.build/models-dev.json"
export OPENSCIENCE_VERSION="${OPENSCIENCE_VERSION:-2.0.153-local.1}"
export CSC_IDENTITY_AUTO_DISCOVERY=false

bun install

# Native CLI + embedded SolidJS workspace, compiled in Ubuntu 22.04.
bun run --cwd backend/cli build --skip-install --target=linux-x64

SIDECAR="/work/backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience"
chmod +x "$SIDECAR"
export OPENSCIENCE_DESKTOP_SIDECAR="$SIDECAR"

# Electron shell -> AppImage. The main process and the desktop entry both set
# the Wayland/Ozone switches; afterPack drops any bundled libwayland client.
bun run --cwd frontend/desktop dist -- --linux --x64

ls -lh frontend/desktop/dist/OpenScience-linux-*.AppImage
