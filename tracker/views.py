"""HTTP endpoints: a faithful reimplementation of the Express API surface."""
from __future__ import annotations

from mimetypes import guess_type
from pathlib import Path
import json

from django.conf import settings
from django.http import FileResponse, HttpResponse, HttpResponseNotAllowed, JsonResponse

from .auth import (
    ChallengeExpired,
    UnknownCredential,
    build_authentication_options,
    build_registration_options,
    clear_session_cookie,
    complete_authentication,
    complete_registration,
    is_authenticated,
    issue_jwt,
    require_auth,
    set_session_cookie,
    verify_jwt,
)
from .common import date_to_str, iso_now, parse_date, uid
import jwt as pyjwt
from .models import ApiKey, InboxMessage, InboxTask, Passkey, Project
from .state import serialize_state, sync_state

_VALID_URGENCIES = {"low", "medium", "high"}


def _json_body(request):
    """Parse a JSON object body; returns None when the body is not an object."""
    if not request.body:
        return {}
    try:
        data = json.loads(request.body)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


# --------------------------------------------------------------------------- #
# Health + whole-state sync
# --------------------------------------------------------------------------- #

def health(request):
    return JsonResponse({"ok": True})


@require_auth
def state(request):
    if request.method == "GET":
        return JsonResponse(serialize_state())
    if request.method == "PUT":
        data = _json_body(request)
        if data is None:
            return JsonResponse({"error": "State payload must be an object."}, status=400)
        return JsonResponse(sync_state(data))
    return HttpResponseNotAllowed(["GET", "PUT"])


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #

def _require_auth_when_registered(request):
    """Bootstrap rule: open while no passkeys exist, locked once one does."""
    if Passkey.objects.count() == 0:
        return None
    token = request.COOKIES.get("session")
    if not token:
        return JsonResponse({"error": "Not authenticated."}, status=401)
    try:
        verify_jwt(token)
    except pyjwt.PyJWTError:
        response = JsonResponse({"error": "Session expired."}, status=401)
        clear_session_cookie(response)
        return response
    return None


def auth_status(request):
    return JsonResponse(
        {"authenticated": is_authenticated(request), "bootstrapMode": Passkey.objects.count() == 0}
    )


def register_options(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    guard = _require_auth_when_registered(request)
    if guard is not None:
        return guard
    return JsonResponse(build_registration_options())


def register_verify(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    guard = _require_auth_when_registered(request)
    if guard is not None:
        return guard
    data = _json_body(request)
    if data is None:
        return JsonResponse({"error": "Invalid request body."}, status=400)
    passkey_name = data.pop("passkeyName", "")
    try:
        complete_registration(data, passkey_name if isinstance(passkey_name, str) else "")
    except ChallengeExpired:
        return JsonResponse({"error": "Challenge expired. Please try again."}, status=400)
    except Exception as exc:  # noqa: BLE001 - surface verification errors like the original
        return JsonResponse({"error": str(exc) or "Registration verification failed."}, status=400)
    response = JsonResponse({"verified": True})
    set_session_cookie(response, issue_jwt())
    return response


def authenticate_options(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    return JsonResponse(build_authentication_options())


def authenticate_verify(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    data = _json_body(request)
    if data is None:
        return JsonResponse({"error": "Invalid request body."}, status=400)
    try:
        complete_authentication(data)
    except UnknownCredential:
        return JsonResponse({"error": "Unknown credential."}, status=400)
    except ChallengeExpired:
        return JsonResponse({"error": "Challenge expired. Please try again."}, status=400)
    except Exception as exc:  # noqa: BLE001
        return JsonResponse({"error": str(exc) or "Authentication failed."}, status=401)
    response = JsonResponse({"verified": True})
    set_session_cookie(response, issue_jwt())
    return response


def logout(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    response = JsonResponse({"ok": True})
    clear_session_cookie(response)
    return response


@require_auth
def passkeys(request):
    if request.method != "GET":
        return HttpResponseNotAllowed(["GET"])
    data = [
        {
            "id": p.id,
            "name": p.name,
            "createdAt": p.created_at,
            "transports": _safe_transports(p.transports),
        }
        for p in Passkey.objects.all()
    ]
    return JsonResponse(data, safe=False)


@require_auth
def passkey_detail(request, passkey_id):
    if request.method != "DELETE":
        return HttpResponseNotAllowed(["DELETE"])
    if Passkey.objects.count() <= 1:
        return JsonResponse({"error": "Cannot delete the only passkey."}, status=409)
    Passkey.objects.filter(id=passkey_id).delete()
    return JsonResponse({"ok": True})


def _safe_transports(raw):
    try:
        value = json.loads(raw or "[]")
        return value if isinstance(value, list) else []
    except (TypeError, ValueError):
        return []


# --------------------------------------------------------------------------- #
# API-key protected ingestion + read endpoints
# --------------------------------------------------------------------------- #

def _resolve_api_key(request):
    header = request.headers.get("Authorization")
    if isinstance(header, str) and header.startswith("Bearer "):
        return header[7:].strip()
    x_key = request.headers.get("X-Api-Key")
    if isinstance(x_key, str):
        return x_key.strip()
    return None


def _valid_api_key(request) -> bool:
    provided = _resolve_api_key(request)
    if not provided:
        return False
    return ApiKey.objects.filter(key=provided).exists()


def _first_str(body: dict, *keys: str) -> str:
    for key in keys:
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def message(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    if not _valid_api_key(request):
        return JsonResponse({"error": "Invalid or missing API key."}, status=401)
    body = _json_body(request) or {}
    sender = _first_str(body, "from")
    text = _first_str(body, "message")
    if not sender:
        return JsonResponse({"error": '"from" is required.'}, status=400)
    if not text:
        return JsonResponse({"error": '"message" is required.'}, status=400)
    created = InboxMessage.objects.create(
        id=uid("inbox"), sender=sender, message=text, received_at=iso_now(), read=False
    )
    return JsonResponse({"id": created.id}, status=201)


def task(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    if not _valid_api_key(request):
        return JsonResponse({"error": "Invalid or missing API key."}, status=401)
    body = _json_body(request) or {}
    name = _first_str(body, "task name", "name")
    if not name:
        return JsonResponse({"error": 'Task "name" or "task name" is required.'}, status=400)
    urgency = body.get("urgency")
    urgency = urgency if urgency in _VALID_URGENCIES else "medium"
    due = _first_str(body, "due date", "dueDate", "due_date")
    notes = _first_str(body, "notes")
    created = InboxTask.objects.create(
        id=uid("inbox-task"),
        name=name,
        urgency=urgency,
        due_date=parse_date(due),
        notes=notes,
        received_at=iso_now(),
    )
    return JsonResponse({"id": created.id}, status=201)


def projects_list(request):
    if request.method != "GET":
        return HttpResponseNotAllowed(["GET"])
    if not _valid_api_key(request):
        return JsonResponse({"error": "Invalid or missing API key."}, status=401)
    out = []
    for project in Project.objects.all():
        item = {"id": project.id, "name": project.name, "priority": project.priority, "color": project.color}
        if project.notes:
            item["notes"] = project.notes
        out.append(item)
    return JsonResponse({"projects": out})


def project_detail(request, project_id):
    if request.method != "GET":
        return HttpResponseNotAllowed(["GET"])
    if not _valid_api_key(request):
        return JsonResponse({"error": "Invalid or missing API key."}, status=401)
    project = (
        Project.objects.prefetch_related(
            "milestones", "milestones__tasks", "milestones__tasks__dependency_links"
        )
        .filter(id=project_id)
        .first()
    )
    if project is None:
        return JsonResponse({"error": "Project not found."}, status=404)

    all_tasks = [t for m in project.milestones.all() for t in m.tasks.all()]
    by_id = {t.id: t for t in all_tasks}
    # Reverse edges: who depends on each task (for the "blocking" view).
    dependents: dict[str, list] = {}
    for t in all_tasks:
        for link in t.dependency_links.all():
            dependents.setdefault(link.depends_on_id, []).append(t)

    result = {"id": project.id, "name": project.name, "priority": project.priority, "color": project.color}
    if project.notes:
        result["notes"] = project.notes

    milestones = []
    for milestone in project.milestones.all():
        m_out = {"id": milestone.id, "name": milestone.name}
        if milestone.notes:
            m_out["notes"] = milestone.notes
        tasks = []
        for t in milestone.tasks.all():
            dependencies = []
            blocked_by = []
            for link in t.dependency_links.all():
                dep = by_id.get(link.depends_on_id)
                if dep is None:
                    dependencies.append({"id": link.depends_on_id})
                    continue
                dependencies.append({"id": dep.id, "name": dep.name})
                if not dep.completed:
                    blocked_by.append({"id": dep.id, "name": dep.name})
            blocking = [{"id": o.id, "name": o.name} for o in dependents.get(t.id, []) if not o.completed]
            t_out = {"id": t.id, "name": t.name, "completed": t.completed, "urgency": t.urgency}
            due = date_to_str(t.due_date)
            if due:
                t_out["dueDate"] = due
            if t.notes:
                t_out["notes"] = t.notes
            t_out["dependencies"] = dependencies
            t_out["blockedBy"] = blocked_by
            t_out["blocking"] = blocking
            tasks.append(t_out)
        m_out["tasks"] = tasks
        milestones.append(m_out)
    result["milestones"] = milestones
    return JsonResponse(result)


# --------------------------------------------------------------------------- #
# Compiled React SPA (served from dist/) with history-fallback
# --------------------------------------------------------------------------- #

def spa(request, path=""):
    if request.method not in ("GET", "HEAD"):
        return HttpResponseNotAllowed(["GET", "HEAD"])
    dist_dir = (Path(settings.BASE_DIR) / "dist").resolve()
    if path:
        candidate = (dist_dir / path).resolve()
        if str(candidate).startswith(str(dist_dir)) and candidate.is_file():
            content_type = guess_type(str(candidate))[0] or "application/octet-stream"
            return FileResponse(open(candidate, "rb"), content_type=content_type)
    index = dist_dir / "index.html"
    if not index.is_file():
        return HttpResponse(
            "Frontend build not found. Run `npm run build` to produce dist/.",
            status=503,
            content_type="text/plain",
        )
    return FileResponse(open(index, "rb"), content_type="text/html")
