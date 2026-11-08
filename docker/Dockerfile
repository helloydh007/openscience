# Reproducible AppImage builder for the local-first OpenScience fork.
#
# Ubuntu 22.04 keeps the produced sidecar and AppImage on glibc 2.35, so the
# artifact runs on 22.04+ and on current Debian/Fedora/Arch desktops.
FROM nvidia/cuda:12.4.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
    xz-utils \
    python3 \
    build-essential \
    file \
    libarchive-tools \
    desktop-file-utils \
    libfuse2 \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
  && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24.21.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && node --version && npm --version

# Bun is installed from its platform npm package: the bun.sh installer pulls a
# GitHub release, which is unavailable on some networks. The npm tarball is the
# same upstream binary and needs no postinstall download.
ARG BUN_VERSION=1.3.14
RUN npm install -g "@oven/bun-linux-x64@${BUN_VERSION}" --no-audit --no-fund \
  && ln -s /usr/local/lib/node_modules/@oven/bun-linux-x64/bin/bun /usr/local/bin/bun \
  && bun --version

# GitHub release assets are unreachable from this network; use the maintained
# binary mirrors by default. Override the build args for other environments.
ARG ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ARG ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
ENV ELECTRON_MIRROR=${ELECTRON_MIRROR}
ENV ELECTRON_BUILDER_BINARIES_MIRROR=${ELECTRON_BUILDER_BINARIES_MIRROR}

WORKDIR /work
COPY . /work

CMD ["bash", "docker/build-appimage.sh"]
