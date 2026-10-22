#!/bin/sh
# Runs an npx command with the host Node if available, otherwise inside node:22 (Debian image, ships git).
# Used by git hooks so they also work on machines without Node installed.
set -e
if command -v npx >/dev/null 2>&1; then
  exec npx --no-install "$@"
fi
root=$(git rev-parse --show-toplevel)
exec docker run --rm -i -v "$root":/app -w /app -u "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/app \
  node:22 npx --no-install "$@"
