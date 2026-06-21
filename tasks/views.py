from datetime import timedelta

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import redirect_to_login
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse, reverse_lazy
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.generic import CreateView, DetailView, UpdateView

from .forms import AreaForm, InboxCaptureForm, MilestoneForm, ProjectForm, TaskForm
from .models import Area, Milestone, Project, Task

DEV_USERNAME = "local"
DEFAULT_AREA_NAME = "General"


def private_login_required(view_func):
    def wrapped(request, *args, **kwargs):
        if settings.TRACKER_REQUIRE_LOGIN and not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path())
        return view_func(request, *args, **kwargs)

    return wrapped


class PrivateAccessMixin:
    def dispatch(self, request, *args, **kwargs):
        if settings.TRACKER_REQUIRE_LOGIN and not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path())
        return super().dispatch(request, *args, **kwargs)


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
        return area
    area, _created = Area.objects.get_or_create(owner=owner, name=DEFAULT_AREA_NAME, defaults={"is_default": True})
    if not area.is_default:
        area.is_default = True
        area.save(update_fields=["is_default"])
    return area


def open_task_queryset(owner):
    return (
        Task.objects.filter(owner=owner)
        .exclude(status=Task.STATUS_DONE)
        .select_related("area", "project", "milestone", "parent")
        .prefetch_related("dependencies", "subtasks", "tags")
    )


def actionable_tasks(owner):
    tasks = open_task_queryset(owner).exclude(status=Task.STATUS_INBOX)
    return [task for task in tasks if task.is_actionable]


def save_default_area(form, owner):
    area = form.save(commit=False)
    area.owner = owner
    if area.is_default:
        Area.objects.filter(owner=owner, is_default=True).exclude(pk=area.pk).update(is_default=False)
    area.save()
    return area


@private_login_required
def dashboard(request):
    owner = get_owner(request)
    get_default_area(owner)
    today = timezone.localdate()
    projects = (
        Project.objects.filter(owner=owner)
        .exclude(status=Project.STATUS_ARCHIVED)
        .select_related("area")
        .annotate(
            open_tasks=Count("tasks", filter=~Q(tasks__status=Task.STATUS_DONE)),
            done_tasks=Count("tasks", filter=Q(tasks__status=Task.STATUS_DONE)),
        )
    )
    tasks = open_task_queryset(owner)
    grouped_tasks = {
        status: tasks.filter(status=status)
        for status, _label in Task.STATUS_CHOICES
        if status != Task.STATUS_DONE
    }
    return render(
        request,
        "tasks/dashboard.html",
        {
            "projects": projects,
            "areas": Area.objects.filter(owner=owner).annotate(project_count=Count("projects")),
            "grouped_tasks": grouped_tasks,
            "status_labels": dict(Task.STATUS_CHOICES),
            "inbox_count": tasks.filter(status=Task.STATUS_INBOX).count(),
            "due_count": tasks.filter(due_date__lte=today).count(),
            "up_next_count": len(actionable_tasks(owner)),
        },
    )


@private_login_required
def inbox(request):
    owner = get_owner(request)
    if request.method == "POST":
        form = InboxCaptureForm(request.POST)
        if form.is_valid():
            task = form.save(commit=False)
            task.owner = owner
            task.area = get_default_area(owner)
            task.status = Task.STATUS_INBOX
            task.save()
            messages.success(request, "Captured in inbox.")
            return redirect("inbox")
    else:
        form = InboxCaptureForm()
    inbox_tasks = open_task_queryset(owner).filter(status=Task.STATUS_INBOX)
    return render(request, "tasks/inbox.html", {"form": form, "tasks": inbox_tasks})


@private_login_required
def up_next(request):
    owner = get_owner(request)
    tasks = actionable_tasks(owner)
    tasks.sort(key=lambda task: (task.due_date or timezone.datetime.max.date(), task.eisenhower, -task.priority, task.title.lower()))
    return render(request, "tasks/up_next.html", {"tasks": tasks})


@private_login_required
def day_view(request):
    owner = get_owner(request)
    today = timezone.localdate()
    open_tasks = open_task_queryset(owner).exclude(status=Task.STATUS_INBOX)
    due_tasks = open_tasks.filter(due_date__lte=today)
    reminders = open_tasks.filter(reminder_date__lte=today)
    undated_actionable = [task for task in actionable_tasks(owner) if task.due_date is None]
    undated_actionable.sort(key=lambda task: (task.eisenhower, -task.priority, task.title.lower()))
    return render(
        request,
        "tasks/day.html",
        {
            "today": today,
            "due_tasks": due_tasks,
            "reminders": reminders,
            "undated_tasks": undated_actionable,
        },
    )


@private_login_required
def weekly_review(request):
    owner = get_owner(request)
    today = timezone.localdate()
    stale_before = timezone.now() - timedelta(days=14)
    tasks = open_task_queryset(owner)
    projects = Project.objects.filter(owner=owner).exclude(status=Project.STATUS_ARCHIVED).select_related("area")
    milestones = Milestone.objects.filter(owner=owner, project__in=projects).select_related("project")
    return render(
        request,
        "tasks/weekly_review.html",
        {
            "areas": Area.objects.filter(owner=owner),
            "projects": projects,
            "milestones": milestones,
            "inbox_tasks": tasks.filter(status=Task.STATUS_INBOX),
            "blocked_tasks": tasks.filter(status__in=[Task.STATUS_BLOCKED, Task.STATUS_WAITING]),
            "stale_tasks": tasks.filter(updated_at__lt=stale_before).exclude(status__in=[Task.STATUS_INBOX]),
            "recurring_tasks": tasks.exclude(recurrence=Task.RECURRENCE_NONE),
            "upcoming_tasks": tasks.filter(due_date__gte=today, due_date__lte=today + timedelta(days=14)),
        },
    )


class OwnedQuerysetMixin(PrivateAccessMixin):
    model = None

    def get_queryset(self):
        return self.model.objects.filter(owner=get_owner(self.request))


class AreaCreateView(PrivateAccessMixin, CreateView):
    model = Area
    form_class = AreaForm
    template_name = "tasks/area_form.html"
    success_url = reverse_lazy("dashboard")

    def form_valid(self, form):
        save_default_area(form, get_owner(self.request))
        return redirect(self.success_url)


class ProjectCreateView(PrivateAccessMixin, CreateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        return kwargs

    def form_valid(self, form):
        form.instance.owner = get_owner(self.request)
        if form.instance.area_id is None:
            form.instance.area = get_default_area(form.instance.owner)
        return super().form_valid(form)


class ProjectDetailView(OwnedQuerysetMixin, DetailView):
    model = Project
    template_name = "tasks/project_detail.html"

    def get_queryset(self):
        return super().get_queryset().select_related("area")

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        owner = get_owner(self.request)
        context["tasks"] = self.object.tasks.filter(owner=owner).select_related("milestone", "area")
        context["milestones"] = self.object.milestones.filter(owner=owner)
        return context


class ProjectUpdateView(OwnedQuerysetMixin, UpdateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        return kwargs


class MilestoneCreateView(PrivateAccessMixin, CreateView):
    model = Milestone
    form_class = MilestoneForm
    template_name = "tasks/milestone_form.html"

    def dispatch(self, request, *args, **kwargs):
        if settings.TRACKER_REQUIRE_LOGIN and not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path())
        self.project = get_object_or_404(Project, pk=kwargs["project_pk"], owner=get_owner(request))
        return super().dispatch(request, *args, **kwargs)

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        kwargs["project"] = self.project
        return kwargs

    def form_valid(self, form):
        form.instance.owner = get_owner(self.request)
        form.instance.project = self.project
        return super().form_valid(form)

    def get_success_url(self):
        return self.project.get_absolute_url()


class TaskCreateView(PrivateAccessMixin, CreateView):
    model = Task
    form_class = TaskForm
    template_name = "tasks/task_form.html"
    success_url = reverse_lazy("dashboard")

    def get_initial(self):
        initial = super().get_initial()
        owner = get_owner(self.request)
        initial["area"] = get_default_area(owner)
        project_id = self.request.GET.get("project")
        milestone_id = self.request.GET.get("milestone")
        if project_id:
            initial["project"] = project_id
        if milestone_id:
            initial["milestone"] = milestone_id
        initial["status"] = self.request.GET.get("status", Task.STATUS_BACKLOG)
        return initial

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        return kwargs

    def form_valid(self, form):
        form.instance.owner = get_owner(self.request)
        if form.instance.area_id is None:
            form.instance.area = form.instance.project.area if form.instance.project_id else get_default_area(form.instance.owner)
        return super().form_valid(form)


class TaskDetailView(OwnedQuerysetMixin, DetailView):
    model = Task
    template_name = "tasks/task_detail.html"

    def get_queryset(self):
        return super().get_queryset().select_related("area", "project", "milestone", "parent").prefetch_related("dependencies", "subtasks", "tags")


class TaskUpdateView(OwnedQuerysetMixin, UpdateView):
    model = Task
    form_class = TaskForm
    template_name = "tasks/task_form.html"

    def get_success_url(self):
        return self.object.get_absolute_url()

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        return kwargs

    def form_valid(self, form):
        if form.instance.area_id is None:
            form.instance.area = form.instance.project.area if form.instance.project_id else get_default_area(get_owner(self.request))
        return super().form_valid(form)


@private_login_required
def complete_task(request, pk):
    task = get_object_or_404(Task, pk=pk, owner=get_owner(request))
    if request.method == "POST":
        task.status = Task.STATUS_DONE
        task.save(update_fields=["status", "completed_at", "updated_at"])
    return redirect(request.POST.get("next") or "dashboard")
