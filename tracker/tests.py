"""Tests for the relational sync layer, daily reset, auth gating and APIs."""
import json

from django.test import TestCase

from tracker.auth import issue_jwt
from tracker.common import iso_now
from tracker.management.commands.seed import build_initial_state
from tracker.models import (
    ApiKey,
    DailyTask,
    Milestone,
    Project,
    ProjectTask,
    Settings,
    TaskDependency,
)
from tracker.state import serialize_state, sync_state


class StateSyncTests(TestCase):
    def setUp(self):
        sync_state(build_initial_state())

    def test_seed_populates_relational_tables(self):
        self.assertEqual(Project.objects.count(), 2)
        self.assertEqual(Milestone.objects.count(), 3)
        self.assertEqual(ProjectTask.objects.count(), 5)
        # project-task-2 depends on project-task-1; project-task-3 on -2.
        self.assertEqual(TaskDependency.objects.count(), 2)

    def test_roundtrip_is_stable(self):
        state = serialize_state()
        again = sync_state(json.loads(json.dumps(state)))
        self.assertEqual(state, again)

    def test_add_then_delete_project_cascades(self):
        state = serialize_state()
        state["projects"].append(
            {
                "id": "project-new",
                "name": "Fresh",
                "priority": 4,
                "color": "#123456",
                "milestones": [
                    {
                        "id": "m-new",
                        "name": "Backlog",
                        "tasks": [
                            {"id": "t-new", "name": "Do it", "completed": False,
                             "stage": "notStarted", "urgency": "low", "dependencyIds": []}
                        ],
                    }
                ],
            }
        )
        sync_state(state)
        self.assertTrue(Project.objects.filter(id="project-new").exists())
        self.assertTrue(ProjectTask.objects.filter(id="t-new").exists())

        # Now remove it again -> milestone + task cascade away.
        state2 = serialize_state()
        state2["projects"] = [p for p in state2["projects"] if p["id"] != "project-new"]
        sync_state(state2)
        self.assertFalse(Project.objects.filter(id="project-new").exists())
        self.assertFalse(Milestone.objects.filter(id="m-new").exists())
        self.assertFalse(ProjectTask.objects.filter(id="t-new").exists())

    def test_reparent_task_between_milestones(self):
        """A task moved to another milestone must not be deleted by pruning."""
        state = serialize_state()
        warehouse = next(p for p in state["projects"] if p["id"] == "project-1")
        plan = next(m for m in warehouse["milestones"] if m["id"] == "milestone-1")
        rollout = next(m for m in warehouse["milestones"] if m["id"] == "milestone-2")
        moving = next(t for t in plan["tasks"] if t["id"] == "project-task-2")
        plan["tasks"] = [t for t in plan["tasks"] if t["id"] != "project-task-2"]
        rollout["tasks"].append(moving)
        sync_state(state)

        task = ProjectTask.objects.get(id="project-task-2")
        self.assertEqual(task.milestone_id, "milestone-2")
        # Its dependency on project-task-1 (still in milestone-1) survives.
        self.assertTrue(
            TaskDependency.objects.filter(task_id="project-task-2", depends_on_id="project-task-1").exists()
        )

    def test_cross_project_dependency_is_rejected(self):
        state = serialize_state()
        onboarding = next(p for p in state["projects"] if p["id"] == "project-2")
        task = onboarding["milestones"][0]["tasks"][0]
        # Point it at a task in project-1 -> must be dropped (spec: same project only).
        task["dependencyIds"] = ["project-task-1"]
        sync_state(state)
        self.assertFalse(
            TaskDependency.objects.filter(task_id="project-task-5", depends_on_id="project-task-1").exists()
        )

    def test_self_dependency_is_rejected(self):
        state = serialize_state()
        task = state["projects"][0]["milestones"][0]["tasks"][0]
        task["dependencyIds"] = [task["id"]]
        sync_state(state)
        self.assertFalse(TaskDependency.objects.filter(task_id=task["id"], depends_on_id=task["id"]).exists())

    def test_daily_reset_clears_completion_on_new_day(self):
        daily = DailyTask.objects.first()
        daily.completed = True
        daily.stage = "complete"
        daily.completed_on = "2020-01-01"
        daily.save()
        settings = Settings.objects.get(id=1)
        settings.last_daily_reset_date = "2020-01-01"
        settings.save()

        serialize_state()  # triggers apply_daily_reset for "today"

        daily.refresh_from_db()
        self.assertFalse(daily.completed)
        self.assertEqual(daily.stage, "notStarted")
        self.assertEqual(daily.completed_on, "")
        self.assertNotEqual(Settings.objects.get(id=1).last_daily_reset_date, "2020-01-01")


class HttpApiTests(TestCase):
    def setUp(self):
        sync_state(build_initial_state())

    def test_health(self):
        self.assertEqual(self.client.get("/api/health").json(), {"ok": True})

    def test_state_requires_auth(self):
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_state_get_and_put_with_session(self):
        self.client.cookies["session"] = issue_jwt()
        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        state = response.json()
        self.assertEqual({p["name"] for p in state["projects"]}, {"Warehouse Refresh", "Client Onboarding"})

        put = self.client.put("/api/state", data=json.dumps(state), content_type="application/json")
        self.assertEqual(put.status_code, 200)
        self.assertEqual(put.json(), state)

    def test_auth_status_bootstrap_when_no_passkeys(self):
        self.assertEqual(
            self.client.get("/api/auth/status").json(),
            {"authenticated": False, "bootstrapMode": True},
        )

    def test_authentication_options_available(self):
        response = self.client.post("/api/auth/authenticate/options")
        self.assertEqual(response.status_code, 200)
        self.assertIn("challenge", response.json())

    def test_api_key_required_for_ingest(self):
        self.assertEqual(self.client.post("/api/message").status_code, 401)

    def test_api_key_message_and_task(self):
        ApiKey.objects.create(id="api-key-1", name="Bot", key="tt_secret", created_at=iso_now())
        auth = {"HTTP_AUTHORIZATION": "Bearer tt_secret"}

        msg = self.client.post(
            "/api/message",
            data=json.dumps({"from": "Slack", "message": "hi"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(msg.status_code, 201)

        task = self.client.post(
            "/api/task",
            data=json.dumps({"task name": "Follow up", "urgency": "high"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(task.status_code, 201)

        state = serialize_state()
        self.assertEqual(len(state["inboxMessages"]), 1)
        self.assertEqual(len(state["inboxTasks"]), 1)
        self.assertEqual(state["inboxTasks"][0]["urgency"], "high")

    def test_project_detail_blocking_relationships(self):
        ApiKey.objects.create(id="api-key-2", name="Bot", key="tt_read", created_at=iso_now())
        response = self.client.get("/api/projects/project-1", HTTP_X_API_KEY="tt_read")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        task2 = next(t for m in data["milestones"] for t in m["tasks"] if t["id"] == "project-task-2")
        self.assertEqual([d["id"] for d in task2["blockedBy"]], ["project-task-1"])
        task1 = next(t for m in data["milestones"] for t in m["tasks"] if t["id"] == "project-task-1")
        self.assertEqual([b["id"] for b in task1["blocking"]], ["project-task-2"])

    def test_spa_history_fallback(self):
        # Unknown non-API route serves the SPA shell (200 or 503 if dist absent).
        self.assertIn(self.client.get("/projects/project-1").status_code, (200, 503))
