"""
Django settings for the Task Tracker project.

The application is a single-user, self-hosted task tracker. Authentication is
handled by WebAuthn passkeys + a signed JWT session cookie (see
``tracker/auth.py``), so Django's own auth/sessions/admin apps are intentionally
not installed. The compiled React UI in ``dist/`` is served by ``tracker.views``.
"""
from pathlib import Path
import os
import secrets

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Load a local .env file if present (no-op when absent).
load_dotenv(BASE_DIR / ".env")


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_secret_key() -> str:
    """Django signing key: env override, else a persisted local file."""
    env_value = os.environ.get("DJANGO_SECRET_KEY")
    if env_value:
        return env_value
    secret_file = BASE_DIR / "data" / "django-secret.local"
    try:
        return secret_file.read_text(encoding="utf-8").strip()
    except OSError:
        generated = secrets.token_urlsafe(50)
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        secret_file.write_text(generated, encoding="utf-8")
        os.chmod(secret_file, 0o600)
        return generated


SECRET_KEY = _resolve_secret_key()

DEBUG = _env_bool("DEBUG", False)

# Single-user self-hosted deployment; host is fronted by the operator's proxy.
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "tracker",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "tasktracker.urls"

WSGI_APPLICATION = "tasktracker.wsgi.application"

# The frontend talks to bespoke /api/* routes with no trailing slash; never
# rewrite them.
APPEND_SLASH = False

# The relational Django DB. The legacy single-blob DB (data/task-tracker.sqlite)
# is left untouched and can be migrated in with `manage.py import_legacy`.
_database_path = os.environ.get("DATABASE_PATH", str(BASE_DIR / "data" / "tasktracker.sqlite3"))

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": _database_path,
        "OPTIONS": {
            # WAL for concurrent reads/writes (matches the original server).
            # Django's SQLite backend already enforces PRAGMA foreign_keys=ON
            # on every connection, so the relational constraints below are live.
            "init_command": "PRAGMA journal_mode=WAL",
            "transaction_mode": "IMMEDIATE",
        },
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Behind HTTPS the session cookie must be Secure; mirrors the Express server,
# which keyed this off the configured WebAuthn origin.
SESSION_COOKIE_SECURE = os.environ.get("WEBAUTHN_RP_ORIGIN", "http://localhost:8000").startswith("https")
