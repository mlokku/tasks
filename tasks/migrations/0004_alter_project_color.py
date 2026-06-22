# Generated manually for color palette default update.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tasks', '0003_milestone_color_project_color'),
    ]

    operations = [
        migrations.AlterField(
            model_name='project',
            name='color',
            field=models.CharField(blank=True, default='#FEFDF8', max_length=7),
        ),
    ]
