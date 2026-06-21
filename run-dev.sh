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
exec "$VENV_DIR/bin/python" manage.py runserver "$HOST:$PORT"
