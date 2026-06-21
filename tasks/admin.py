from django.contrib import admin

from .models import Project, Task


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "status", "updated_at")
    list_filter = ("status",)
    search_fields = ("name", "description")


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ("title", "project", "owner", "status", "priority", "due_date")
    list_filter = ("status", "priority", "project")
    search_fields = ("title", "notes", "project__name")
