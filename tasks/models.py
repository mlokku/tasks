from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.urls import reverse
from django.utils import timezone


class Area(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["owner", "name"], name="unique_area_name_per_owner"),
            models.UniqueConstraint(
                fields=["owner"],
                condition=models.Q(is_default=True),
                name="unique_default_area_per_owner",
            ),
        ]

    def __str__(self):
        return self.name


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
    area = models.ForeignKey(Area, on_delete=models.PROTECT, related_name="projects", blank=True, null=True)
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


class Milestone(models.Model):
    STATUS_PLANNED = "planned"
    STATUS_ACTIVE = "active"
    STATUS_DONE = "done"
    STATUS_SKIPPED = "skipped"
    STATUS_CHOICES = [
        (STATUS_PLANNED, "Planned"),
        (STATUS_ACTIVE, "Active"),
        (STATUS_DONE, "Done"),
        (STATUS_SKIPPED, "Skipped"),
    ]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="milestones")
    title = models.CharField(max_length=180)
    notes = models.TextField(blank=True)
    order = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PLANNED)
    target_date = models.DateField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "target_date", "title"]
        constraints = [
            models.UniqueConstraint(fields=["project", "order"], name="unique_milestone_order_per_project"),
        ]

    def __str__(self):
        return f"{self.project}: {self.title}"

    @property
    def progress_percent(self):
        total = self.tasks.count()
        if total == 0:
            return 0
        done = self.tasks.filter(status=Task.STATUS_DONE).count()
        return round((done / total) * 100)

    @property
    def is_complete(self):
        return self.status in {self.STATUS_DONE, self.STATUS_SKIPPED}


class Tag(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["owner", "name"], name="unique_tag_name_per_owner"),
        ]

    def __str__(self):
        return self.name


class Task(models.Model):
    STATUS_INBOX = "inbox"
    STATUS_BACKLOG = "backlog"
    STATUS_NEXT = "next"
    STATUS_DOING = "doing"
    STATUS_WAITING = "waiting"
    STATUS_BLOCKED = "blocked"
    STATUS_DONE = "done"
    STATUS_CHOICES = [
        (STATUS_INBOX, "Inbox"),
        (STATUS_BACKLOG, "Backlog"),
        (STATUS_NEXT, "Next"),
        (STATUS_DOING, "Doing"),
        (STATUS_WAITING, "Waiting"),
        (STATUS_BLOCKED, "Blocked"),
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

    EISENHOWER_DO = "do"
    EISENHOWER_SCHEDULE = "schedule"
    EISENHOWER_DELEGATE = "delegate"
    EISENHOWER_ELIMINATE = "eliminate"
    EISENHOWER_CHOICES = [
        (EISENHOWER_DO, "Urgent and important"),
        (EISENHOWER_SCHEDULE, "Important, not urgent"),
        (EISENHOWER_DELEGATE, "Urgent, not important"),
        (EISENHOWER_ELIMINATE, "Neither urgent nor important"),
    ]

    RECURRENCE_NONE = "none"
    RECURRENCE_DAILY = "daily"
    RECURRENCE_WEEKLY = "weekly"
    RECURRENCE_MONTHLY = "monthly"
    RECURRENCE_CHOICES = [
        (RECURRENCE_NONE, "Does not repeat"),
        (RECURRENCE_DAILY, "Daily"),
        (RECURRENCE_WEEKLY, "Weekly"),
        (RECURRENCE_MONTHLY, "Monthly"),
    ]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    area = models.ForeignKey(Area, on_delete=models.PROTECT, related_name="tasks", blank=True, null=True)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks", blank=True, null=True)
    milestone = models.ForeignKey(Milestone, on_delete=models.SET_NULL, related_name="tasks", blank=True, null=True)
    parent = models.ForeignKey("self", on_delete=models.CASCADE, related_name="subtasks", blank=True, null=True)
    dependencies = models.ManyToManyField("self", symmetrical=False, related_name="dependents", blank=True)
    tags = models.ManyToManyField(Tag, related_name="tasks", blank=True)
    title = models.CharField(max_length=220)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_INBOX)
    priority = models.PositiveSmallIntegerField(choices=PRIORITY_CHOICES, default=PRIORITY_MEDIUM)
    eisenhower = models.CharField(max_length=20, choices=EISENHOWER_CHOICES, default=EISENHOWER_SCHEDULE)
    due_date = models.DateField(blank=True, null=True)
    reminder_date = models.DateField(blank=True, null=True)
    recurrence = models.CharField(max_length=20, choices=RECURRENCE_CHOICES, default=RECURRENCE_NONE)
    recur_next_date = models.DateField(blank=True, null=True)
    completed_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status", "due_date", "eisenhower", "-priority", "title"]

    def __str__(self):
        return self.title

    def get_absolute_url(self):
        return reverse("task_detail", kwargs={"pk": self.pk})

    @property
    def is_overdue(self):
        return bool(self.due_date and self.status != self.STATUS_DONE and self.due_date < timezone.localdate())

    @property
    def is_inbox(self):
        return self.status == self.STATUS_INBOX

    @property
    def is_inactive(self):
        return self.status in {self.STATUS_INBOX, self.STATUS_WAITING, self.STATUS_BLOCKED, self.STATUS_DONE}

    @property
    def dependency_blockers(self):
        if not self.pk:
            return Task.objects.none()
        return self.dependencies.exclude(status=self.STATUS_DONE)

    @property
    def is_actionable(self):
        if self.is_inactive:
            return False
        if self.subtasks.exclude(status=self.STATUS_DONE).exists():
            return False
        if self.dependency_blockers.exists():
            return False
        if self.milestone_id:
            prior_milestones = Milestone.objects.filter(
                project=self.milestone.project,
                order__lt=self.milestone.order,
            ).exclude(status__in=[Milestone.STATUS_DONE, Milestone.STATUS_SKIPPED])
            if prior_milestones.exists():
                return False
        return True

    def clean(self):
        if self.project_id and self.area_id and self.project.area_id and self.area_id != self.project.area_id:
            raise ValidationError({"area": "Task area must match the selected project area."})
        if self.milestone_id and self.project_id and self.milestone.project_id != self.project_id:
            raise ValidationError({"milestone": "Milestone must belong to the selected project."})
        if self.milestone_id and not self.project_id:
            raise ValidationError({"milestone": "A milestone task must belong to a project."})
        if self.parent_id and self.parent_id == self.pk:
            raise ValidationError({"parent": "A task cannot be its own parent."})

    def _sync_parent_completion(self):
        if not self.parent_id:
            return
        parent = self.parent
        if parent.subtasks.exists() and not parent.subtasks.exclude(status=self.STATUS_DONE).exists():
            if parent.status != self.STATUS_DONE:
                parent.status = self.STATUS_DONE
                parent.save(update_fields=["status", "completed_at", "updated_at"])
        elif parent.status == self.STATUS_DONE:
            parent.status = self.STATUS_NEXT
            parent.save(update_fields=["status", "completed_at", "updated_at"])

    def save(self, *args, **kwargs):
        if self.project_id and self.area_id is None and self.project.area_id:
            self.area = self.project.area
        if self.status == self.STATUS_DONE and self.completed_at is None:
            self.completed_at = timezone.now()
        if self.status != self.STATUS_DONE:
            self.completed_at = None
        super().save(*args, **kwargs)
        self._sync_parent_completion()
