from django.urls import path

from . import views

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("inbox/", views.inbox, name="inbox"),
    path("day/", views.day_view, name="day"),
    path("up-next/", views.up_next, name="up_next"),
    path("weekly-review/", views.weekly_review, name="weekly_review"),
    path("areas/new/", views.AreaCreateView.as_view(), name="area_create"),
    path("sidebar/areas/new/", views.sidebar_area_create, name="sidebar_area_create"),
    path("projects/new/", views.ProjectCreateView.as_view(), name="project_create"),
    path("sidebar/projects/new/", views.sidebar_project_create, name="sidebar_project_create"),
    path("projects/<int:pk>/", views.ProjectDetailView.as_view(), name="project_detail"),
    path("projects/<int:pk>/edit/", views.ProjectUpdateView.as_view(), name="project_update"),
    path("projects/<int:project_pk>/milestones/new/", views.MilestoneCreateView.as_view(), name="milestone_create"),
    path("tasks/new/", views.TaskCreateView.as_view(), name="task_create"),
    path("tasks/quick-create/", views.quick_task_create, name="quick_task_create"),
    path("tasks/<int:pk>/", views.TaskDetailView.as_view(), name="task_detail"),
    path("tasks/<int:pk>/edit/", views.TaskUpdateView.as_view(), name="task_update"),
    path("tasks/<int:pk>/quick-edit/", views.quick_task_update, name="quick_task_update"),
    path("tasks/<int:pk>/delete/", views.task_delete, name="task_delete"),
    path("tasks/<int:pk>/done/", views.complete_task, name="task_complete"),
]
