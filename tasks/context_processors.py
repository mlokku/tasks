from django.contrib.auth import get_user_model
from django.db.models import Count, Q

from .forms import AreaForm, ProjectForm, QuickTaskForm
from .models import Area, Project, Task

DEV_USERNAME = "local"
DEFAULT_AREA_NAME = "General"


def get_owner(request):
    if request.user.is_authenticated:
        return request.user

    user, created = get_user_model().objects.get_or_create(username=DEV_USERNAME)
    if created:
        user.set_unusable_password()
        user.save(update_fields=["password"])
    return user


def get_default_area(owner):
    area = Area.objects.filter(owner=owner, is_default=True).first()
    if area:
        if area.name != DEFAULT_AREA_NAME:
            area.name = DEFAULT_AREA_NAME
            area.save(update_fields=["name"])
        return area
    area, _created = Area.objects.get_or_create(owner=owner, name=DEFAULT_AREA_NAME, defaults={"is_default": True})
    if not area.is_default:
        area.is_default = True
        area.save(update_fields=["is_default"])
    return area


def tracker_sidebar(request):
    if not hasattr(request, "resolver_match") or request.resolver_match is None:
        return {}

    owner = get_owner(request)
    general = get_default_area(owner)
    projects = list(
        Project.objects.filter(owner=owner)
        .exclude(status=Project.STATUS_ARCHIVED)
        .select_related("area")
        .annotate(open_tasks=Count("tasks", filter=~Q(tasks__status=Task.STATUS_DONE)))
        .order_by("name")
    )
    projects_by_area = {}
    for project in projects:
        projects_by_area.setdefault(project.area_id, []).append(project)

    areas = list(
        Area.objects.filter(owner=owner)
        .exclude(pk=general.pk)
        .annotate(project_count=Count("projects"))
        .order_by("name")
    )
    general.project_count = len(projects_by_area.get(general.pk, []))
    general.sidebar_projects = projects_by_area.get(general.pk, [])
    for area in areas:
        area.sidebar_projects = projects_by_area.get(area.pk, [])

    match = request.resolver_match
    active_project_id = None
    active_area_id = None
    if match.url_name in {"project_detail", "project_update"}:
        active_project_id = match.kwargs.get("pk")
    elif match.url_name == "milestone_create":
        active_project_id = match.kwargs.get("project_pk")
    if active_project_id:
        active_project = next((project for project in projects if project.pk == active_project_id), None)
        if active_project:
            active_area_id = active_project.area_id

    general_task_form = QuickTaskForm(owner=owner)
    general_task_form.fields["dependencies"].queryset = Task.objects.none()

    return {
        "app_name": "TaskTracker",
        "sidebar_general_area": general,
        "sidebar_areas": areas,
        "sidebar_active_project_id": active_project_id,
        "sidebar_active_area_id": active_area_id or general.pk,
        "sidebar_area_form": AreaForm(),
        "sidebar_project_form": ProjectForm(owner=owner),
        "sidebar_general_task_form": general_task_form,
    }
