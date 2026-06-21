from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Project, Task


class TaskModelTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("alex", password="password")
        self.project = Project.objects.create(owner=self.user, name="Homelab")

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


class DashboardTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("alex", password="password")
        self.other_user = get_user_model().objects.create_user("sam", password="password")
        self.project = Project.objects.create(owner=self.user, name="Homelab")
        other_project = Project.objects.create(owner=self.other_user, name="Private")
        Task.objects.create(owner=self.user, project=self.project, title="Visible task")
        Task.objects.create(owner=self.other_user, project=other_project, title="Hidden task")

    def test_dashboard_only_shows_current_users_tasks(self):
        self.client.login(username="alex", password="password")

        response = self.client.get(reverse("dashboard"))

        self.assertContains(response, "Visible task")
        self.assertNotContains(response, "Hidden task")
