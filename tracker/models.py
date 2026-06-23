"""
Relational schema for the Task Tracker.

The previous implementation stored the *entire* application state as a single
JSON document in one ``app_state`` row. This module replaces that with a proper
normalized schema: projects own milestones, milestones own tasks, task
dependencies live in a real join table, and every other collection (general /
daily / inbox / API keys / passkeys) is its own table.

Primary keys are the client-minted string identifiers (e.g. ``project-task-1``,
``general-lx9f-ab12``). The React UI generates these ids and references them
across the payload (dependency ids, etc.), so we preserve them verbatim as the
canonical entity identity instead of inventing surrogate keys.
"""
from django.db import models


class Urgency(models.TextChoices):
    LOW = "low", "Low"
    MEDIUM = "medium", "Medium"
    HIGH = "high", "High"


class Stage(models.TextChoices):
    NOT_STARTED = "notStarted", "Not started"
    IN_PROGRESS = "inProgress", "In progress"
    WAITING_REVIEW = "waitingReview", "Waiting for review"
    COMPLETE = "complete", "Complete"


class Settings(models.Model):
    """Single-row workspace settings (always ``id=1``)."""

    SINGLETON_ID = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_ID)
    timezone = models.CharField(max_length=64, default="America/Edmonton")
    theme = models.CharField(max_length=16, default="dark")
    general_color = models.CharField(max_length=32)
    daily_color = models.CharField(max_length=32)
    # IANA-local calendar date (YYYY-MM-DD) of the last daily-task reset.
    last_daily_reset_date = models.CharField(max_length=10, blank=True, default="")

    class Meta:
        db_table = "settings"

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_ID
        super().save(*args, **kwargs)


class AbstractTask(models.Model):
    """Shared columns for the standalone (general / daily) task lists."""

    id = models.CharField(primary_key=True, max_length=80)
    name = models.CharField(max_length=500)
    completed = models.BooleanField(default=False)
    stage = models.CharField(max_length=16, choices=Stage.choices, default=Stage.NOT_STARTED)
    urgency = models.CharField(max_length=8, choices=Urgency.choices, default=Urgency.MEDIUM)
    due_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    # Preserves the ordering of the client's array.
    position = models.PositiveIntegerField(default=0)

    class Meta:
        abstract = True
        ordering = ["position"]


class GeneralTask(AbstractTask):
    class Meta(AbstractTask.Meta):
        db_table = "general_task"


class DailyTask(AbstractTask):
    # Calendar date the task was last completed on (for the timezone-aware reset).
    completed_on = models.CharField(max_length=10, blank=True, default="")

    class Meta(AbstractTask.Meta):
        db_table = "daily_task"


class Project(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    name = models.CharField(max_length=500)
    priority = models.PositiveSmallIntegerField(default=5)
    color = models.CharField(max_length=32)
    notes = models.TextField(blank=True, default="")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "project"
        ordering = ["position"]


class Milestone(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="milestones")
    name = models.CharField(max_length=500)
    notes = models.TextField(blank=True, default="")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "milestone"
        ordering = ["position"]


class ProjectTask(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    milestone = models.ForeignKey(Milestone, on_delete=models.CASCADE, related_name="tasks")
    name = models.CharField(max_length=500)
    completed = models.BooleanField(default=False)
    stage = models.CharField(max_length=16, choices=Stage.choices, default=Stage.NOT_STARTED)
    urgency = models.CharField(max_length=8, choices=Urgency.choices, default=Urgency.MEDIUM)
    due_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    position = models.PositiveIntegerField(default=0)
    # Tasks this task depends on. Asymmetric: A depends-on B does not imply the
    # reverse. The spec confines dependencies to within a single project.
    dependencies = models.ManyToManyField(
        "self",
        through="TaskDependency",
        symmetrical=False,
        related_name="dependents",
    )

    class Meta:
        db_table = "project_task"
        ordering = ["position"]


class TaskDependency(models.Model):
    """Join row: ``task`` cannot complete until ``depends_on`` is complete."""

    task = models.ForeignKey(ProjectTask, on_delete=models.CASCADE, related_name="dependency_links")
    depends_on = models.ForeignKey(ProjectTask, on_delete=models.CASCADE, related_name="dependent_links")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "task_dependency"
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(fields=["task", "depends_on"], name="uniq_task_dependency"),
            models.CheckConstraint(
                condition=~models.Q(task=models.F("depends_on")),
                name="no_self_dependency",
            ),
        ]


class InboxMessage(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    sender = models.CharField(max_length=500, db_column="from")
    message = models.TextField()
    received_at = models.CharField(max_length=40)
    read = models.BooleanField(default=False)

    class Meta:
        db_table = "inbox_message"
        ordering = ["received_at"]


class InboxTask(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    name = models.CharField(max_length=500)
    urgency = models.CharField(max_length=8, choices=Urgency.choices, default=Urgency.MEDIUM)
    due_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    received_at = models.CharField(max_length=40)

    class Meta:
        db_table = "inbox_task"
        ordering = ["received_at"]


class ApiKey(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    name = models.CharField(max_length=200)
    key = models.CharField(max_length=128, unique=True)
    created_at = models.CharField(max_length=40)

    class Meta:
        db_table = "api_key"
        ordering = ["created_at"]


class Passkey(models.Model):
    """A registered WebAuthn credential. ``id`` is the base64url credential id."""

    id = models.CharField(primary_key=True, max_length=512)
    public_key = models.TextField()  # base64url-encoded COSE public key
    counter = models.BigIntegerField(default=0)
    transports = models.TextField(blank=True, default="[]")  # JSON array
    name = models.CharField(max_length=200, default="Passkey")
    created_at = models.CharField(max_length=40)

    class Meta:
        db_table = "passkey"
        ordering = ["created_at"]


class PendingChallenge(models.Model):
    """Single-row store for the in-flight WebAuthn challenge (90s TTL)."""

    SINGLETON_ID = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_ID)
    value = models.TextField()  # base64url challenge
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "pending_challenge"

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_ID
        super().save(*args, **kwargs)
