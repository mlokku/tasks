from django.contrib import admin

from .models import Area, Milestone, Project, Tag, Task


@admin.register(Area)
class AreaAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "is_default")
    list_filter = ("is_default",)
    search_fields = ("name",)


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "area", "owner", "status")
    list_filter = ("status", "area")
    search_fields = ("name", "description")


@admin.register(Milestone)
class MilestoneAdmin(admin.ModelAdmin):
    list_display = ("title", "project", "order", "status", "target_date", "progress_percent")
    list_filter = ("status", "project")
    search_fields = ("title", "notes")


@admin.register(Tag)
class TagAdmin(admin.ModelAdmin):
    list_display = ("name", "owner")
    search_fields = ("name",)


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ("title", "project", "area", "status", "eisenhower", "due_date", "recurrence")
    list_filter = ("status", "eisenhower", "recurrence", "project", "area")
    search_fields = ("title", "notes")
    filter_horizontal = ("dependencies", "tags")
