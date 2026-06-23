"""
Translation between the relational schema and the ``AppState`` JSON shape the
React UI expects.

``serialize_state()`` reads the normalized tables and assembles the nested
document the client loads via ``GET /api/state``. ``sync_state()`` takes the
document the client PUTs back and diffs it into the normalized tables inside a
single transaction (upsert present rows, delete absent ones). The JSON blob is
purely a wire format here — it is never stored.
"""
from __future__ import annotations

from django.db import transaction

from .common import date_to_str, iso_now, parse_date, uid, zoned_today
from .models import (
    ApiKey,
    DailyTask,
    GeneralTask,
    InboxMessage,
    InboxTask,
    Milestone,
    Project,
    ProjectTask,
    Settings,
    Stage,
    TaskDependency,
    Urgency,
)

_VALID_STAGES = {s.value for s in Stage}
_VALID_URGENCIES = {u.value for u in Urgency}


# --------------------------------------------------------------------------- #
# Settings singleton + daily reset
# --------------------------------------------------------------------------- #

def get_settings() -> Settings:
    obj, _ = Settings.objects.get_or_create(
        id=Settings.SINGLETON_ID,
        defaults={
            "general_color": "#00C2A8",
            "daily_color": "#F97316",
            "timezone": "America/Edmonton",
            "theme": "dark",
            "last_daily_reset_date": zoned_today("America/Edmonton"),
        },
    )
    return obj


def apply_daily_reset(settings: Settings | None = None) -> None:
    """Reset daily tasks when the local calendar day has rolled over."""
    settings = settings or get_settings()
    today = zoned_today(settings.timezone)
    if settings.last_daily_reset_date == today:
        return
    DailyTask.objects.update(completed=False, stage=Stage.NOT_STARTED, completed_on="")
    settings.last_daily_reset_date = today
    settings.save(update_fields=["last_daily_reset_date"])


# --------------------------------------------------------------------------- #
# Serialization (DB -> AppState dict)
# --------------------------------------------------------------------------- #

def _serialize_task(task, *, daily: bool = False, project: bool = False) -> dict:
    data = {
        "id": task.id,
        "name": task.name,
        "completed": task.completed,
        "stage": task.stage,
        "urgency": task.urgency,
    }
    due = date_to_str(task.due_date)
    if due:
        data["dueDate"] = due
    if task.notes:
        data["notes"] = task.notes
    if daily and task.completed_on:
        data["completedOn"] = task.completed_on
    if project:
        data["dependencyIds"] = [link.depends_on_id for link in task.dependency_links.all()]
    return data


def _serialize_project(project: Project) -> dict:
    data = {
        "id": project.id,
        "name": project.name,
        "priority": project.priority,
        "color": project.color,
    }
    if project.notes:
        data["notes"] = project.notes
    data["milestones"] = [
        {
            **({"notes": m.notes} if m.notes else {}),
            "id": m.id,
            "name": m.name,
            "tasks": [_serialize_task(t, project=True) for t in m.tasks.all()],
        }
        for m in project.milestones.all()
    ]
    return data


def serialize_state() -> dict:
    settings = get_settings()
    apply_daily_reset(settings)

    projects = (
        Project.objects.prefetch_related(
            "milestones",
            "milestones__tasks",
            "milestones__tasks__dependency_links",
        ).all()
    )

    return {
        "generalColor": settings.general_color,
        "dailyColor": settings.daily_color,
        "settings": {"timezone": settings.timezone, "theme": settings.theme},
        "lastDailyResetDate": settings.last_daily_reset_date,
        "inboxMessages": [
            {
                "id": m.id,
                "from": m.sender,
                "message": m.message,
                "receivedAt": m.received_at,
                "read": m.read,
            }
            for m in InboxMessage.objects.all()
        ],
        "inboxTasks": [_serialize_inbox_task(t) for t in InboxTask.objects.all()],
        "apiKeys": [
            {"id": k.id, "name": k.name, "key": k.key, "createdAt": k.created_at}
            for k in ApiKey.objects.all()
        ],
        "generalTasks": [_serialize_task(t) for t in GeneralTask.objects.all()],
        "dailyTasks": [_serialize_task(t, daily=True) for t in DailyTask.objects.all()],
        "projects": [_serialize_project(p) for p in projects],
    }


def _serialize_inbox_task(task: InboxTask) -> dict:
    data = {
        "id": task.id,
        "name": task.name,
        "urgency": task.urgency,
        "receivedAt": task.received_at,
    }
    due = date_to_str(task.due_date)
    if due:
        data["dueDate"] = due
    if task.notes:
        data["notes"] = task.notes
    return data


# --------------------------------------------------------------------------- #
# Sync (AppState dict -> DB)
# --------------------------------------------------------------------------- #

def _stage_and_completed(item: dict) -> tuple[str, bool]:
    stage = item.get("stage")
    if stage not in _VALID_STAGES:
        stage = Stage.COMPLETE if item.get("completed") else Stage.NOT_STARTED
    return stage, stage == Stage.COMPLETE


def _urgency_of(item: dict) -> str:
    urgency = item.get("urgency")
    return urgency if urgency in _VALID_URGENCIES else Urgency.MEDIUM


def _task_defaults(item: dict, position: int) -> dict:
    stage, completed = _stage_and_completed(item)
    return {
        "name": str(item.get("name") or "").strip(),
        "completed": completed,
        "stage": stage,
        "urgency": _urgency_of(item),
        "due_date": parse_date(item.get("dueDate")),
        "notes": item.get("notes") or "",
        "position": position,
    }


def _sync_general(items: list[dict]) -> None:
    keep = []
    for i, item in enumerate(items):
        tid = item.get("id") or uid("general")
        GeneralTask.objects.update_or_create(id=tid, defaults=_task_defaults(item, i))
        keep.append(tid)
    GeneralTask.objects.exclude(id__in=keep).delete()


def _sync_daily(items: list[dict]) -> None:
    keep = []
    for i, item in enumerate(items):
        tid = item.get("id") or uid("daily")
        defaults = _task_defaults(item, i)
        defaults["completed_on"] = item.get("completedOn") or ""
        DailyTask.objects.update_or_create(id=tid, defaults=defaults)
        keep.append(tid)
    DailyTask.objects.exclude(id__in=keep).delete()


def _clamp_priority(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 5
    return max(1, min(10, n))


def _sync_projects(projects: list[dict]) -> None:
    keep_projects: list[str] = []
    keep_milestones: list[str] = []
    keep_tasks: list[str] = []
    # (task_id, project_id, [dependency ids]) gathered for a second pass once
    # every task row exists, so cross-milestone dependencies resolve.
    dep_specs: list[tuple[str, str, list]] = []
    task_project: dict[str, str] = {}

    for pi, p in enumerate(projects):
        pid = p.get("id") or uid("project")
        Project.objects.update_or_create(
            id=pid,
            defaults={
                "name": str(p.get("name") or "").strip(),
                "priority": _clamp_priority(p.get("priority")),
                "color": p.get("color") or "",
                "notes": p.get("notes") or "",
                "position": pi,
            },
        )
        keep_projects.append(pid)

        for mi, m in enumerate(p.get("milestones") or []):
            mid = m.get("id") or uid("milestone")
            Milestone.objects.update_or_create(
                id=mid,
                defaults={
                    "project_id": pid,
                    "name": str(m.get("name") or "").strip(),
                    "notes": m.get("notes") or "",
                    "position": mi,
                },
            )
            keep_milestones.append(mid)

            for ti, t in enumerate(m.get("tasks") or []):
                tid = t.get("id") or uid("project-task")
                defaults = _task_defaults(t, ti)
                defaults["milestone_id"] = mid
                ProjectTask.objects.update_or_create(id=tid, defaults=defaults)
                keep_tasks.append(tid)
                task_project[tid] = pid
                deps = t.get("dependencyIds")
                dep_specs.append((tid, pid, deps if isinstance(deps, list) else []))

    # Prune in child-first order (cascades would cover it, but be explicit).
    ProjectTask.objects.exclude(id__in=keep_tasks).delete()
    Milestone.objects.exclude(id__in=keep_milestones).delete()
    Project.objects.exclude(id__in=keep_projects).delete()

    _rebuild_dependencies(dep_specs, task_project)


def _rebuild_dependencies(dep_specs, task_project) -> None:
    TaskDependency.objects.all().delete()
    rows = []
    for task_id, pid, dep_ids in dep_specs:
        seen = set()
        position = 0
        for dep_id in dep_ids:
            if not isinstance(dep_id, str) or dep_id == task_id or dep_id in seen:
                continue
            # Dependencies are confined to the same project (spec rule).
            if task_project.get(dep_id) != pid:
                continue
            seen.add(dep_id)
            rows.append(TaskDependency(task_id=task_id, depends_on_id=dep_id, position=position))
            position += 1
    if rows:
        TaskDependency.objects.bulk_create(rows)


def _sync_inbox_messages(items: list[dict]) -> None:
    keep = []
    for m in items:
        mid = m.get("id") or uid("inbox")
        InboxMessage.objects.update_or_create(
            id=mid,
            defaults={
                "sender": m.get("from") or "",
                "message": m.get("message") or "",
                "received_at": m.get("receivedAt") or iso_now(),
                "read": bool(m.get("read")),
            },
        )
        keep.append(mid)
    InboxMessage.objects.exclude(id__in=keep).delete()


def _sync_inbox_tasks(items: list[dict]) -> None:
    keep = []
    for t in items:
        tid = t.get("id") or uid("inbox-task")
        InboxTask.objects.update_or_create(
            id=tid,
            defaults={
                "name": str(t.get("name") or "").strip(),
                "urgency": _urgency_of(t),
                "due_date": parse_date(t.get("dueDate")),
                "notes": t.get("notes") or "",
                "received_at": t.get("receivedAt") or iso_now(),
            },
        )
        keep.append(tid)
    InboxTask.objects.exclude(id__in=keep).delete()


def _sync_api_keys(items: list[dict]) -> None:
    keep = []
    for k in items:
        kid = k.get("id") or uid("api-key")
        ApiKey.objects.update_or_create(
            id=kid,
            defaults={
                "name": k.get("name") or "",
                "key": k.get("key") or "",
                "created_at": k.get("createdAt") or iso_now(),
            },
        )
        keep.append(kid)
    ApiKey.objects.exclude(id__in=keep).delete()


@transaction.atomic
def sync_state(data: dict) -> dict:
    settings = get_settings()
    incoming_settings = data.get("settings") or {}
    settings.timezone = incoming_settings.get("timezone") or settings.timezone
    settings.theme = incoming_settings.get("theme") or settings.theme
    settings.general_color = data.get("generalColor") or settings.general_color
    settings.daily_color = data.get("dailyColor") or settings.daily_color
    if isinstance(data.get("lastDailyResetDate"), str) and data["lastDailyResetDate"]:
        settings.last_daily_reset_date = data["lastDailyResetDate"]
    settings.save()

    _sync_general(data.get("generalTasks") or [])
    _sync_daily(data.get("dailyTasks") or [])
    _sync_projects(data.get("projects") or [])
    _sync_inbox_messages(data.get("inboxMessages") or [])
    _sync_inbox_tasks(data.get("inboxTasks") or [])
    _sync_api_keys(data.get("apiKeys") or [])

    return serialize_state()
