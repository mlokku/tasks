# Personal Project Tracker

A small Django project/task tracker intended for self-hosting on a VPS. The app is server-rendered, uses Django auth, and only uses browser JavaScript if you decide to add interactive behavior later.

## Features

- User login via Django auth
- Projects with active, paused, done, and archived states
- Tasks with backlog, next, doing, waiting, and done states
- Priority, due dates, notes, overdue highlighting, and completion timestamps
- Mobile-friendly board layout
- SQLite by default, with settings ready to move to another Django database backend

## Local setup

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver 0.0.0.0:8000
```

Open `http://127.0.0.1:8000/` and log in with the superuser account.

## VPS notes

Set these environment variables in your service manager:

```bash
DJANGO_SECRET_KEY="replace-this"
DJANGO_DEBUG=0
DJANGO_ALLOWED_HOSTS="tracker.example.com,127.0.0.1"
DJANGO_SECURE_COOKIES=1
DJANGO_SSL_REDIRECT=1
```

Collect static files before starting Gunicorn:

```bash
python manage.py collectstatic --noinput
gunicorn tracker.wsgi:application --bind 127.0.0.1:8000
```

Put Nginx or Caddy in front for HTTPS and proxy traffic to Gunicorn.
