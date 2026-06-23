"""WSGI config for the Task Tracker project."""
import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tasktracker.settings")

application = get_wsgi_application()
