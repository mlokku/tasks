from django import forms

from .models import Area, Milestone, Project, Tag, Task


class AreaForm(forms.ModelForm):
    class Meta:
        model = Area
        fields = ["name", "description", "is_default"]
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
        }


class ProjectForm(forms.ModelForm):
    class Meta:
        model = Project
        fields = ["area", "name", "description", "status"]
        widgets = {
            "description": forms.Textarea(attrs={"rows": 4}),
        }

    def __init__(self, *args, owner=None, **kwargs):
        super().__init__(*args, **kwargs)
        if owner is not None:
            self.fields["area"].queryset = Area.objects.filter(owner=owner)


class MilestoneForm(forms.ModelForm):
    class Meta:
        model = Milestone
        fields = ["project", "title", "notes", "order", "status", "target_date"]
        widgets = {
            "target_date": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, owner=None, project=None, **kwargs):
        super().__init__(*args, **kwargs)
        if owner is not None:
            self.fields["project"].queryset = Project.objects.filter(owner=owner).exclude(status=Project.STATUS_ARCHIVED)
        if project is not None:
            self.fields["project"].initial = project
            self.fields["project"].queryset = Project.objects.filter(pk=project.pk)


class TaskForm(forms.ModelForm):
    tag_names = forms.CharField(
        required=False,
        label="Tags",
        help_text="Comma-separated tags, for example: billing, errands, review.",
    )

    class Meta:
        model = Task
        fields = [
            "area",
            "project",
            "milestone",
            "parent",
            "dependencies",
            "title",
            "notes",
            "status",
            "priority",
            "eisenhower",
            "due_date",
            "reminder_date",
            "recurrence",
            "recur_next_date",
        ]
        widgets = {
            "due_date": forms.DateInput(attrs={"type": "date"}),
            "reminder_date": forms.DateInput(attrs={"type": "date"}),
            "recur_next_date": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 5}),
            "dependencies": forms.CheckboxSelectMultiple,
        }

    def __init__(self, *args, owner=None, **kwargs):
        self.owner = owner
        super().__init__(*args, **kwargs)
        if self.instance.pk:
            self.fields["tag_names"].initial = ", ".join(self.instance.tags.values_list("name", flat=True))
        if owner is not None:
            projects = Project.objects.filter(owner=owner).exclude(status=Project.STATUS_ARCHIVED)
            tasks = Task.objects.filter(owner=owner).exclude(pk=self.instance.pk)
            self.fields["area"].queryset = Area.objects.filter(owner=owner)
            self.fields["project"].queryset = projects
            self.fields["milestone"].queryset = Milestone.objects.filter(owner=owner, project__in=projects)
            self.fields["parent"].queryset = tasks
            self.fields["dependencies"].queryset = tasks.exclude(status=Task.STATUS_DONE)

    def clean(self):
        cleaned = super().clean()
        project = cleaned.get("project")
        milestone = cleaned.get("milestone")
        parent = cleaned.get("parent")
        dependencies = cleaned.get("dependencies")
        if milestone and project and milestone.project_id != project.pk:
            self.add_error("milestone", "Milestone must belong to the selected project.")
        if milestone and not project:
            self.add_error("milestone", "Milestone tasks must belong to a project.")
        if parent and self.instance.pk and parent.pk == self.instance.pk:
            self.add_error("parent", "A task cannot be its own parent.")
        if dependencies:
            for dependency in dependencies:
                if dependency.project_id != project.pk:
                    self.add_error("dependencies", "Dependencies must be in the same project as this task.")
                    break
        return cleaned

    def save(self, commit=True):
        task = super().save(commit=commit)
        if commit:
            names = [name.strip() for name in self.cleaned_data.get("tag_names", "").split(",") if name.strip()]
            tags = [Tag.objects.get_or_create(owner=self.owner, name=name)[0] for name in names]
            task.tags.set(tags)
        return task


class InboxCaptureForm(forms.ModelForm):
    class Meta:
        model = Task
        fields = ["title", "notes", "due_date", "reminder_date"]
        widgets = {
            "due_date": forms.DateInput(attrs={"type": "date"}),
            "reminder_date": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }
