#!/usr/bin/env bash
# Launch the Django Task Tracker: prepare the virtualenv, apply migrations,
# seed/import data on first run, then serve the app (API + compiled React UI).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
PYTHON="${PYTHON:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"

# 1. Virtualenv + dependencies
if [[ ! -d "${VENV_DIR}" ]]; then
  printf 'Creating virtualenv at %s...\n' "${VENV_DIR}"
  "${PYTHON}" -m venv "${VENV_DIR}"
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
printf 'Installing Python dependencies...\n'
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

# 2. Database: migrate, then import the legacy blob (if present) or seed.
printf 'Applying database migrations...\n'
python manage.py migrate --noinput
printf 'Initialising workspace data (import legacy if present, else seed)...\n'
python manage.py import_legacy --if-empty
python manage.py seed

# 3. Frontend: build the React bundle if it is missing.
if [[ ! -f dist/index.html ]]; then
  if command -v npm >/dev/null 2>&1; then
    printf 'No frontend build found; building production assets with Vite...\n'
    npm install
    npm run build
  else
    printf 'WARNING: dist/ is missing and npm is unavailable; the UI will not load.\n'
  fi
fi

# 4. Serve (API + compiled SPA).
printf 'Starting Task Tracker at http://localhost:%s/ ...\n' "${PORT}"
exec python -m gunicorn tasktracker.wsgi:application \
  --bind "${HOST}:${PORT}" \
  --workers "${WEB_CONCURRENCY:-3}" \
  --timeout "${WEB_TIMEOUT:-30}"
