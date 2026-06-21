from django.contrib.auth import get_user_model
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse_lazy
from django.views.generic import CreateView, DetailView, UpdateView

from .forms import ProjectForm, TaskForm
from .models import Project, Task

DEV_USERNAME = "local"


def get_owner(request):
    if request.user.is_authenticated:
        return request.user

    user, created = get_user_model().objects.get_or_create(username=DEV_USERNAME)
    if created:
        user.set_unusable_password()
        user.save(update_fields=["password"])
    return user


def dashboard(request):
    owner = get_owner(request)
    projects = (
        Project.objects.filter(owner=owner)
        .exclude(status=Project.STATUS_ARCHIVED)
        .annotate(
            open_tasks=Count("tasks", filter=~Q(tasks__status=Task.STATUS_DONE)),
            done_tasks=Count("tasks", filter=Q(tasks__status=Task.STATUS_DONE)),
        )
    )
    tasks = (
        Task.objects.filter(owner=owner)
        .exclude(status=Task.STATUS_DONE)
        .select_related("project")
    )
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
            "grouped_tasks": grouped_tasks,
            "status_labels": dict(Task.STATUS_CHOICES),
        },
    )


class OwnedQuerysetMixin:
    model = None

    def get_queryset(self):
        return self.model.objects.filter(owner=get_owner(self.request))


class ProjectCreateView(CreateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"

    def form_valid(self, form):
        form.instance.owner = get_owner(self.request)
        return super().form_valid(form)


class ProjectDetailView(OwnedQuerysetMixin, DetailView):
    model = Project
    template_name = "tasks/project_detail.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["tasks"] = self.object.tasks.filter(owner=get_owner(self.request))
        return context


class ProjectUpdateView(OwnedQuerysetMixin, UpdateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"


class TaskCreateView(CreateView):
    model = Task
    form_class = TaskForm
    template_name = "tasks/task_form.html"
    success_url = reverse_lazy("dashboard")

    def get_initial(self):
        initial = super().get_initial()
        project_id = self.request.GET.get("project")
        if project_id:
            initial["project"] = project_id
        return initial

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["owner"] = get_owner(self.request)
        return kwargs

    def form_valid(self, form):
        form.instance.owner = get_owner(self.request)
        return super().form_valid(form)


class TaskDetailView(OwnedQuerysetMixin, DetailView):
    model = Task
    template_name = "tasks/task_detail.html"

    def get_queryset(self):
        return super().get_queryset().select_related("project")


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


def complete_task(request, pk):
    task = get_object_or_404(Task, pk=pk, owner=get_owner(request))
    if request.method == "POST":
        task.status = Task.STATUS_DONE
        task.save(update_fields=["status", "completed_at", "updated_at"])
    return redirect("dashboard")
