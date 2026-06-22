#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
URL="http://localhost:${PORT}/"
SERVER_PID=""
BUILD_PID=""

cleanup() {
  local exit_code=$?
  trap - INT TERM EXIT

  if [[ -n "${BUILD_PID}" ]] && kill -0 "${BUILD_PID}" 2>/dev/null; then
    printf '
Stopping background rebuild...
'
    kill -TERM "${BUILD_PID}" 2>/dev/null || true
    wait "${BUILD_PID}" 2>/dev/null || true
  fi

  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    printf '
Shutting down web server...
'
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi

  exit "${exit_code}"
}

trap cleanup INT TERM EXIT

cd "${ROOT_DIR}"

printf 'Preparing SQLite database...
'
npm run db:init

if [[ ! -f dist/index.html ]]; then
  printf 'No existing build found; building production assets first...
'
  npm run build
else
  printf 'Using existing build for immediate startup; rebuilding Tailwind/Vite assets in the background...
'
  npm run build &
  BUILD_PID=$!
fi

printf 'Starting webapp and API at %s...
' "${URL}"
HOST="${HOST}" PORT="${PORT}" npm run server &
SERVER_PID=$!

sleep 1
printf 'Open %s in your browser when ready.
' "${URL}"

if [[ -n "${BUILD_PID}" ]]; then
  wait "${BUILD_PID}"
  BUILD_PID=""
  printf 'Background rebuild complete. Refresh the browser for the newest assets.
'
fi

wait "${SERVER_PID}"
