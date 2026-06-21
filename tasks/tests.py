from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .models import Area, Milestone, Project, Task
from .views import DEV_USERNAME, get_default_area


class TaskModelTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("alex", password="password")
        self.area = Area.objects.create(owner=self.user, name="Ops", is_default=True)
        self.project = Project.objects.create(owner=self.user, area=self.area, name="Homelab")

    def test_completed_at_is_set_when_task_is_done(self):
        task = Task.objects.create(owner=self.user, project=self.project, title="Wire backups")

        task.status = Task.STATUS_DONE
        task.save()

        self.assertIsNotNone(task.completed_at)

    def test_completed_at_is_cleared_when_task_is_reopened(self):
        task = Task.objects.create(
            owner=self.user,
            project=self.project,
            title="Wire backups",
            status=Task.STATUS_DONE,
        )

        task.status = Task.STATUS_DOING
        task.save()

        self.assertIsNone(task.completed_at)

    def test_overdue_excludes_done_tasks(self):
        task = Task.objects.create(
            owner=self.user,
            project=self.project,
            title="Pay invoice",
            due_date=timezone.localdate() - timezone.timedelta(days=1),
        )

        self.assertTrue(task.is_overdue)
        task.status = Task.STATUS_DONE
        self.assertFalse(task.is_overdue)

    def test_dependency_blocks_actionability_until_complete(self):
        blocked_by = Task.objects.create(owner=self.user, project=self.project, title="Buy disks", status=Task.STATUS_NEXT)
        task = Task.objects.create(owner=self.user, project=self.project, title="Install disks", status=Task.STATUS_NEXT)
        task.dependencies.add(blocked_by)

        self.assertFalse(task.is_actionable)
        blocked_by.status = Task.STATUS_DONE
        blocked_by.save()
        self.assertTrue(task.is_actionable)

    def test_later_milestone_is_gated_by_incomplete_prior_milestone(self):
        first = Milestone.objects.create(owner=self.user, project=self.project, title="Phase 1", order=1)
        second = Milestone.objects.create(owner=self.user, project=self.project, title="Phase 2", order=2)
        task = Task.objects.create(owner=self.user, project=self.project, milestone=second, title="Ship", status=Task.STATUS_NEXT)

        self.assertFalse(task.is_actionable)
        first.status = Milestone.STATUS_DONE
        first.save()
        self.assertTrue(task.is_actionable)

    def test_parent_auto_completes_when_all_subtasks_are_done(self):
        parent = Task.objects.create(owner=self.user, project=self.project, title="Launch", status=Task.STATUS_NEXT)
        child = Task.objects.create(owner=self.user, project=self.project, parent=parent, title="Checklist", status=Task.STATUS_NEXT)

        child.status = Task.STATUS_DONE
        child.save()
        parent.refresh_from_db()

        self.assertEqual(parent.status, Task.STATUS_DONE)


class DashboardTests(TestCase):
    def setUp(self):
        self.local_user = get_user_model().objects.create_user(DEV_USERNAME)
        self.other_user = get_user_model().objects.create_user("sam", password="password")
        self.area = get_default_area(self.local_user)
        self.project = Project.objects.create(owner=self.local_user, area=self.area, name="Homelab")
        other_area = Area.objects.create(owner=self.other_user, name="Private", is_default=True)
        other_project = Project.objects.create(owner=self.other_user, area=other_area, name="Private")
        Task.objects.create(owner=self.local_user, area=self.area, project=self.project, title="Visible task")
        Task.objects.create(owner=self.other_user, area=other_area, project=other_project, title="Hidden task")

    def test_dashboard_shows_local_development_tasks_without_login(self):
        response = self.client.get(reverse("dashboard"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Visible task")
        self.assertNotContains(response, "Hidden task")

    @override_settings(TRACKER_REQUIRE_LOGIN=True)
    def test_private_mode_requires_login(self):
        response = self.client.get(reverse("dashboard"))

        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse("login"), response["Location"])


class WorkflowViewTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(DEV_USERNAME)
        self.area = get_default_area(self.user)
        self.project = Project.objects.create(owner=self.user, area=self.area, name="Homelab")

    def test_inbox_capture_creates_inbox_task(self):
        response = self.client.post(reverse("inbox"), {"title": "Capture this", "notes": ""})

        self.assertRedirects(response, reverse("inbox"))
        task = Task.objects.get(title="Capture this")
        self.assertEqual(task.status, Task.STATUS_INBOX)
        self.assertEqual(task.area, self.area)

    def test_up_next_excludes_inbox_and_blocked_tasks(self):
        Task.objects.create(owner=self.user, area=self.area, title="Inbox task", status=Task.STATUS_INBOX)
        Task.objects.create(owner=self.user, area=self.area, title="Blocked task", status=Task.STATUS_BLOCKED)
        Task.objects.create(owner=self.user, area=self.area, title="Ready task", status=Task.STATUS_NEXT)

        response = self.client.get(reverse("up_next"))

        self.assertContains(response, "Ready task")
        self.assertNotContains(response, "Inbox task")
        self.assertNotContains(response, "Blocked task")
