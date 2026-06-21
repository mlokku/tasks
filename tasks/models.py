from django.conf import settings
from django.db import models
from django.urls import reverse
from django.utils import timezone


class Project(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_PAUSED = "paused"
    STATUS_DONE = "done"
    STATUS_ARCHIVED = "archived"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_PAUSED, "Paused"),
        (STATUS_DONE, "Done"),
        (STATUS_ARCHIVED, "Archived"),
    ]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=160)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        unique_together = [("owner", "name")]

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("project_detail", kwargs={"pk": self.pk})


class Task(models.Model):
    STATUS_BACKLOG = "backlog"
    STATUS_NEXT = "next"
    STATUS_DOING = "doing"
    STATUS_WAITING = "waiting"
    STATUS_DONE = "done"
    STATUS_CHOICES = [
        (STATUS_BACKLOG, "Backlog"),
        (STATUS_NEXT, "Next"),
        (STATUS_DOING, "Doing"),
        (STATUS_WAITING, "Waiting"),
        (STATUS_DONE, "Done"),
    ]

    PRIORITY_LOW = 1
    PRIORITY_MEDIUM = 2
    PRIORITY_HIGH = 3
    PRIORITY_URGENT = 4
    PRIORITY_CHOICES = [
        (PRIORITY_LOW, "Low"),
        (PRIORITY_MEDIUM, "Medium"),
        (PRIORITY_HIGH, "High"),
        (PRIORITY_URGENT, "Urgent"),
    ]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    title = models.CharField(max_length=220)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_BACKLOG)
    priority = models.PositiveSmallIntegerField(choices=PRIORITY_CHOICES, default=PRIORITY_MEDIUM)
    due_date = models.DateField(blank=True, null=True)
    completed_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status", "-priority", "due_date", "title"]

    def __str__(self):
        return self.title

    def get_absolute_url(self):
        return reverse("task_detail", kwargs={"pk": self.pk})

    @property
    def is_overdue(self):
        return bool(self.due_date and self.status != self.STATUS_DONE and self.due_date < timezone.localdate())

    def save(self, *args, **kwargs):
        if self.status == self.STATUS_DONE and self.completed_at is None:
            self.completed_at = timezone.now()
        if self.status != self.STATUS_DONE:
            self.completed_at = None
        super().save(*args, **kwargs)
