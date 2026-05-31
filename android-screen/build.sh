#!/usr/bin/env bash
# Build the debug APK in a container (no Android tooling needed on the host).
# Output: dist/yt-zero-screen.apk
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=yt-zero-screen-build

echo "==> Building Android SDK image (first run is slow; cached afterwards)…"
podman build -t "$IMAGE" -f Containerfile .

echo "==> Assembling debug APK…"
podman run --rm -v "$PWD":/work:Z -w /work "$IMAGE" \
    gradle --no-daemon assembleDebug

mkdir -p dist
cp app/build/outputs/apk/debug/app-debug.apk dist/yt-zero-screen.apk
echo "==> Done: dist/yt-zero-screen.apk"
