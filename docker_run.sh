#!/bin/bash
set -e

python manage.py migrate --noinput
python manage.py import_legacy --if-empty
python manage.py seed

exec gunicorn tasktracker.wsgi:application \
    --bind "${HOST}:${PORT}" \
    --worker-class gthread \
    --workers "${WEB_CONCURRENCY:-3}" \
    --threads "${WEB_THREADS:-4}" \
    --timeout "${WEB_TIMEOUT:-30}"
