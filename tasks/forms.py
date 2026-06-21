from django import forms

from .models import Project, Task


class ProjectForm(forms.ModelForm):
    class Meta:
        model = Project
        fields = ["name", "description", "status"]
        widgets = {
            "description": forms.Textarea(attrs={"rows": 4}),
        }


class TaskForm(forms.ModelForm):
    class Meta:
        model = Task
        fields = ["project", "title", "notes", "status", "priority", "due_date"]
        widgets = {
            "due_date": forms.DateInput(attrs={"type": "date"}),
            "notes": forms.Textarea(attrs={"rows": 5}),
        }

    def __init__(self, *args, owner=None, **kwargs):
        super().__init__(*args, **kwargs)
        if owner is not None:
            self.fields["project"].queryset = Project.objects.filter(owner=owner).exclude(status=Project.STATUS_ARCHIVED)
