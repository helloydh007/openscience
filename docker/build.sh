#!/usr/bin/env bash
# One command: build the Ubuntu 22.04 image, build inside it, and place the
# AppImage in ./dist under the conventional x64 name.
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -f docker/Dockerfile -t openscience-appimage:local .

mkdir -p dist
docker run --rm \
  --name "openscience-appimage-$$" \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -v "$PWD/dist:/out" \
  openscience-appimage:local \
  bash -lc 'bash docker/build-appimage.sh && cp /work/frontend/desktop/dist/OpenScience-linux-*.AppImage /out/OpenScience-linux-x64.AppImage.new && chown "$HOST_UID:$HOST_GID" /out/OpenScience-linux-x64.AppImage.new && mv -f /out/OpenScience-linux-x64.AppImage.new /out/OpenScience-linux-x64.AppImage'

sha256sum dist/OpenScience-linux-x64.AppImage > dist/OpenScience-linux-x64.AppImage.sha256
ls -lh dist/OpenScience-linux-x64.AppImage
cat dist/OpenScience-linux-x64.AppImage.sha256
