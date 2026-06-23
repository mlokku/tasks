"""Seed a fresh workspace with the original server's initial sample data."""
from django.core.management.base import BaseCommand

from tracker.common import zoned_today
from tracker.models import Settings
from tracker.state import sync_state

DEFAULT_TIMEZONE = "America/Edmonton"


def build_initial_state() -> dict:
    return {
        "generalColor": "#00C2A8",
        "dailyColor": "#F97316",
        "settings": {"timezone": DEFAULT_TIMEZONE, "theme": "dark"},
        "lastDailyResetDate": zoned_today(DEFAULT_TIMEZONE),
        "inboxMessages": [],
        "inboxTasks": [],
        "apiKeys": [],
        "generalTasks": [
            {
                "id": "general-1",
                "name": "Return supplier quote with chosen option",
                "completed": False,
                "stage": "notStarted",
                "urgency": "high",
                "dueDate": "2026-06-24",
                "notes": "Confirm price hold before replying.",
            },
            {
                "id": "general-2",
                "name": "Order replacement label rolls",
                "completed": False,
                "stage": "notStarted",
                "urgency": "medium",
            },
        ],
        "dailyTasks": [
            {
                "id": "daily-1",
                "name": "Check the dispatch box",
                "completed": False,
                "stage": "notStarted",
                "urgency": "high",
            },
            {
                "id": "daily-2",
                "name": "Review incoming requests",
                "completed": False,
                "stage": "notStarted",
                "urgency": "medium",
                "notes": "Capture anything actionable as a general or project task.",
            },
        ],
        "projects": [
            {
                "id": "project-1",
                "name": "Warehouse Refresh",
                "priority": 9,
                "color": "#38BDF8",
                "notes": "Layout, labeling, and work queue cleanup.",
                "milestones": [
                    {
                        "id": "milestone-1",
                        "name": "Plan",
                        "tasks": [
                            {
                                "id": "project-task-1",
                                "name": "Confirm aisle map changes",
                                "completed": False,
                                "stage": "notStarted",
                                "urgency": "high",
                                "dueDate": "2026-06-25",
                                "notes": "Needed before labels are printed.",
                                "dependencyIds": [],
                            },
                            {
                                "id": "project-task-2",
                                "name": "Approve final label format",
                                "completed": False,
                                "stage": "notStarted",
                                "urgency": "medium",
                                "dependencyIds": ["project-task-1"],
                            },
                        ],
                    },
                    {
                        "id": "milestone-2",
                        "name": "Rollout",
                        "tasks": [
                            {
                                "id": "project-task-3",
                                "name": "Print bin labels",
                                "completed": False,
                                "stage": "notStarted",
                                "urgency": "high",
                                "dependencyIds": ["project-task-2"],
                            },
                            {
                                "id": "project-task-4",
                                "name": "Update picking checklist",
                                "completed": False,
                                "stage": "notStarted",
                                "urgency": "low",
                                "dependencyIds": [],
                            },
                        ],
                    },
                ],
            },
            {
                "id": "project-2",
                "name": "Client Onboarding",
                "priority": 6,
                "color": "#E11D48",
                "milestones": [
                    {
                        "id": "milestone-3",
                        "name": "Setup",
                        "tasks": [
                            {
                                "id": "project-task-5",
                                "name": "Create kickoff checklist",
                                "completed": False,
                                "stage": "notStarted",
                                "urgency": "high",
                                "dependencyIds": [],
                            }
                        ],
                    }
                ],
            },
        ],
    }


class Command(BaseCommand):
    help = "Populate an empty database with the initial sample workspace."

    def handle(self, *args, **options):
        if Settings.objects.exists():
            self.stdout.write("Workspace already initialised; leaving data untouched.")
            return
        sync_state(build_initial_state())
        self.stdout.write(self.style.SUCCESS("Seeded initial workspace state."))
