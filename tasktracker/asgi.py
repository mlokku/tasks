"""ASGI config for the Task Tracker project."""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tasktracker.settings")

application = get_asgi_application()
