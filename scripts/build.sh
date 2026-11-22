#!/usr/bin/env bash
# One entry point for building and running Alexandria.
#
#   scripts/build.sh image      build the Docker image
#   scripts/build.sh up         build if needed and start it (http://localhost:8090)
#   scripts/build.sh up-nginx   same, but published on 127.0.0.1 only, for nginx in front
#   scripts/build.sh down       stop it (the data folder is kept)
#   scripts/build.sh logs       follow the server log
#   scripts/build.sh desktop    build the desktop app for this computer (Tauri)
#   scripts/build.sh android    build the Android APK (needs the Android SDK, NDK and Java 17)
#   scripts/build.sh test       typecheck, unit tests and the web build
#
# Docker Hub rate limit or a blocked registry: NODE_IMAGE=mirror.gcr.io/library/node:24-alpine scripts/build.sh image
set -euo pipefail
cd "$(dirname "$0")/.."

export ALX_VERSION="$(tr -d '[:space:]' < VERSION)" ALX_RELEASE="$(tr -d '[:space:]' < RELEASE_NAME)"
COMPOSE=(docker compose)
NGINX_OVERRIDE=(-f docker-compose.yml -f deploy/examples/nginx.override.yml)

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }

cmd="${1:-help}"
case "$cmd" in
  image)
    need docker "install Docker: https://docs.docker.com/engine/install/"
    "${COMPOSE[@]}" build
    ;;
  up)
    need docker "install Docker: https://docs.docker.com/engine/install/"
    "${COMPOSE[@]}" up -d --build
    echo "Alexandria: http://localhost:${LIBRARIAN_PORT:-8090}  (health: /health)"
    ;;
  up-nginx)
    need docker "install Docker: https://docs.docker.com/engine/install/"
    "${COMPOSE[@]}" "${NGINX_OVERRIDE[@]}" up -d --build
    echo "Alexandria is on 127.0.0.1:8090: point nginx at it (deploy/nginx/alexandria.conf)"
    ;;
  down)
    "${COMPOSE[@]}" down
    ;;
  logs)
    "${COMPOSE[@]}" logs -f --tail 200
    ;;
  desktop)
    need node "install Node 22 or newer"
    need cargo "install Rust: https://rustup.rs"
    (cd desktop && npm install --no-audit --no-fund && npx tauri build)
    echo "Installers are in desktop/src-tauri/target/release/bundle/"
    ;;
  android)
    need node "install Node 22 or newer"
    need cargo "install Rust: https://rustup.rs"
    : "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK folder}"
    : "${NDK_HOME:?set NDK_HOME to the Android NDK folder}"
    (cd desktop && npm install --no-audit --no-fund && npx tauri android build --apk)
    echo "APK: desktop/src-tauri/gen/android/app/build/outputs/apk/"
    ;;
  test)
    need node "install Node 22 or newer"
    [ -d node_modules ] || npm install --no-audit --no-fund
    [ -d librarian/node_modules ] || (cd librarian && npm install --no-audit --no-fund)
    [ -d web/node_modules ] || (cd web && npm ci --no-audit --no-fund)
    (cd librarian && ../node_modules/.bin/tsc --noEmit -p . && npm test)
    (cd web && npx tsc --noEmit -p . && npm run build)
    ;;
  help|-h|--help|*)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
