#!/usr/bin/env bash
# Build the headless runtime image: stage the prebuilt sidecar into a temporary
# sidecar/ build-context directory, docker build it, clean up, and print the
# docker run commands for local and remote (ssh + tunnel) use.
set -euo pipefail
cd "$(dirname "$0")/.."

BINARY="backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience"
IMAGE="openscience-runtime:local"

if [[ ! -x "$BINARY" ]]; then
  echo "error: $BINARY is missing or not executable." >&2
  echo "Build the sidecar first:" >&2
  echo "  bun run --cwd backend/cli build   # see backend/cli/script/build.ts" >&2
  exit 1
fi

if [[ -e sidecar ]]; then
  echo "error: $PWD/sidecar already exists; remove it first (rm -rf sidecar) and retry." >&2
  exit 1
fi

# The Dockerfile copies ./sidecar/openscience from the build context, which is
# the repo root. Stage a copy there and always remove it, even on failure.
mkdir sidecar
cleanup() { rm -rf sidecar; }
trap cleanup EXIT

cp "$BINARY" sidecar/openscience

docker build -f docker/Dockerfile.runtime -t "$IMAGE" .

cat <<EOF
Built $IMAGE

Why --network host: the server binds loopback only by design
(backend/cli/src/cli/network.ts:24-27), and a published port (-p ...) forwards
to the container's eth0, which the loopback-only server never answers. With
--network host the container's 127.0.0.1:4096 is the host's 127.0.0.1:4096, so
the loopback-only security boundary is unchanged.

# Local (this machine). -v keeps sessions, credentials and projects across
# restarts; drop the line for a throwaway server.
docker run --rm --init --network host \\
  -v "\$PWD/openscience-data:/data" \\
  $IMAGE
# Verify:  curl http://127.0.0.1:4096/global/health

# Remote GPU host. Requires NVIDIA Container Toolkit on that host
# (nvidia-container-toolkit installed, docker configured with the nvidia
# runtime, e.g. via: sudo nvidia-ctk runtime configure --runtime=docker
# && sudo systemctl restart docker; smoke test:
# docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi).
# Without a GPU, remove --gpus all.
ssh gpu-host 'docker run -d --rm --init --network host --gpus all \\
  -v ~/openscience-data:/data \\
  $IMAGE'

# Then tunnel the remote loopback port to this machine (keep it running):
ssh -N -L 4096:127.0.0.1:4096 gpu-host
# Verify from here: curl http://127.0.0.1:4096/global/health

# Copy the prebuilt image to the remote host if it has no build context:
#   docker save $IMAGE | ssh gpu-host 'docker load'
EOF
