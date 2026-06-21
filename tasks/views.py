from django.contrib.auth.decorators import login_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse_lazy
from django.views.generic import CreateView, DetailView, UpdateView

from .forms import ProjectForm, TaskForm
from .models import Project, Task


@login_required
def dashboard(request):
    projects = (
        Project.objects.filter(owner=request.user)
        .exclude(status=Project.STATUS_ARCHIVED)
        .annotate(
            open_tasks=Count("tasks", filter=~Q(tasks__status=Task.STATUS_DONE)),
            done_tasks=Count("tasks", filter=Q(tasks__status=Task.STATUS_DONE)),
        )
    )
    tasks = (
        Task.objects.filter(owner=request.user)
        .exclude(status=Task.STATUS_DONE)
        .select_related("project")
    )
    grouped_tasks = {
        status: tasks.filter(status=status)
        for status, _label in Task.STATUS_CHOICES
        if status != Task.STATUS_DONE
    }
    return render_dashboard(request, projects, grouped_tasks)


def render_dashboard(request, projects, grouped_tasks):
    from django.shortcuts import render

    return render(
        request,
        "tasks/dashboard.html",
        {
            "projects": projects,
            "grouped_tasks": grouped_tasks,
            "status_labels": dict(Task.STATUS_CHOICES),
        },
    )


class OwnedQuerysetMixin(LoginRequiredMixin):
    model = None

    def get_queryset(self):
        return self.model.objects.filter(owner=self.request.user)


class ProjectCreateView(LoginRequiredMixin, CreateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"

    def form_valid(self, form):
        form.instance.owner = self.request.user
        return super().form_valid(form)


class ProjectDetailView(OwnedQuerysetMixin, DetailView):
    model = Project
    template_name = "tasks/project_detail.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["tasks"] = self.object.tasks.filter(owner=self.request.user)
        return context


class ProjectUpdateView(OwnedQuerysetMixin, UpdateView):
    model = Project
    form_class = ProjectForm
    template_name = "tasks/project_form.html"


class TaskCreateView(LoginRequiredMixin, CreateView):
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
        kwargs["owner"] = self.request.user
        return kwargs

    def form_valid(self, form):
        form.instance.owner = self.request.user
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
        kwargs["owner"] = self.request.user
        return kwargs


@login_required
def complete_task(request, pk):
    task = get_object_or_404(Task, pk=pk, owner=request.user)
    if request.method == "POST":
        task.status = Task.STATUS_DONE
        task.save(update_fields=["status", "completed_at", "updated_at"])
    return redirect("dashboard")
