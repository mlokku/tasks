#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
SERVER_PID=""

shutdown() {
  local signal="${1:-TERM}"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping Django dev server"
    kill "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap 'shutdown INT; exit 130' INT
trap 'shutdown TERM; exit 143' TERM
trap 'shutdown TERM' EXIT

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "Creating virtualenv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [[ "$INSTALL_DEPS" == "1" ]]; then
  echo "Installing Python dependencies"
  "$VENV_DIR/bin/python" -m pip install --no-compile -r requirements.txt
fi

if [[ "$RUN_MIGRATIONS" == "1" ]]; then
  echo "Running database migrations"
  "$VENV_DIR/bin/python" manage.py migrate
fi

echo "Starting Django dev server on http://$HOST:$PORT/"
setsid "$VENV_DIR/bin/python" manage.py runserver "$HOST:$PORT" &
SERVER_PID="$!"
wait "$SERVER_PID"
SERVER_PID=""
