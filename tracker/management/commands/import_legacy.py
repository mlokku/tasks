"""
Migrate data from the original single-blob SQLite database into the relational
schema. Reads the ``app_state`` JSON document and the ``passkeys`` table from the
legacy DB and writes them through the normal sync path.
"""
from pathlib import Path
import json
import sqlite3

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from tracker.common import iso_now
from tracker.models import Passkey, Settings
from tracker.state import sync_state


class Command(BaseCommand):
    help = "Import data from the legacy data/task-tracker.sqlite blob database."

    def add_arguments(self, parser):
        parser.add_argument(
            "--source",
            default=str(Path(settings.BASE_DIR) / "data" / "task-tracker.sqlite"),
            help="Path to the legacy SQLite database.",
        )
        parser.add_argument(
            "--if-empty",
            action="store_true",
            help="Only import when the relational database has no workspace yet.",
        )

    def handle(self, *args, **options):
        if options["if_empty"] and Settings.objects.exists():
            self.stdout.write("Relational database already populated; skipping legacy import.")
            return

        source = Path(options["source"])
        if not source.exists():
            message = f"Legacy database not found at {source}."
            if options["if_empty"]:
                self.stdout.write(message + " Nothing to import.")
                return
            raise CommandError(message)

        connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
        try:
            state_row = self._fetch_one(connection, "SELECT data FROM app_state WHERE id = 1")
            if state_row:
                sync_state(json.loads(state_row[0]))
                self.stdout.write(self.style.SUCCESS("Imported workspace state from app_state blob."))
            else:
                self.stdout.write("No app_state row found; skipping state import.")

            passkey_rows = self._fetch_all(
                connection,
                "SELECT id, public_key, counter, transports, name, created_at FROM passkeys",
            )
            for pid, public_key, counter, transports, name, created_at in passkey_rows:
                Passkey.objects.update_or_create(
                    id=pid,
                    defaults={
                        "public_key": public_key,
                        "counter": counter or 0,
                        "transports": transports or "[]",
                        "name": name or "Passkey",
                        "created_at": created_at or iso_now(),
                    },
                )
            self.stdout.write(self.style.SUCCESS(f"Imported {len(passkey_rows)} passkey(s)."))
        finally:
            connection.close()

    @staticmethod
    def _fetch_one(connection, query):
        try:
            return connection.execute(query).fetchone()
        except sqlite3.OperationalError:
            return None

    @staticmethod
    def _fetch_all(connection, query):
        try:
            return connection.execute(query).fetchall()
        except sqlite3.OperationalError:
            return []
