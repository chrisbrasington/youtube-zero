#!/usr/bin/env bash
# Build both debug APKs in a container (no Android tooling needed on the host).
# Outputs:
#   dist/yt-zero-screen.apk             → /tv flavor (browse + play + receiver)
#   dist/yt-zero-screen-watch-only.apk  → /watch flavor (idle cast receiver only)
# Same applicationId, so only install one at a time.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=yt-zero-screen-build

echo "==> Building Android SDK image (first run is slow; cached afterwards)…"
podman build -t "$IMAGE" -f Containerfile .

echo "==> Assembling debug APKs (tv + watch flavors)…"
podman run --rm -v "$PWD":/work:Z -w /work "$IMAGE" \
    gradle --no-daemon assembleDebug

mkdir -p dist
cp app/build/outputs/apk/tv/debug/app-tv-debug.apk       dist/yt-zero-screen.apk
cp app/build/outputs/apk/watch/debug/app-watch-debug.apk dist/yt-zero-screen-watch-only.apk
echo "==> Done:"
echo "    dist/yt-zero-screen.apk             (/tv)"
echo "    dist/yt-zero-screen-watch-only.apk  (/watch)"
