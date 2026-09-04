from django.core.validators import RegexValidator
from django.db import migrations, models


def assign_existing_colors(apps, schema_editor):
    Worker = apps.get_model('api', 'TrabajadorOficina')
    palette = ('#2563eb', '#b45309', '#0f766e', '#be185d', '#7c3aed', '#4d7c0f', '#0369a1', '#b91c1c')
    workers = Worker.objects.using(schema_editor.connection.alias).order_by('id')
    for index, worker in enumerate(workers.iterator()):
        workers.filter(pk=worker.pk).update(color=palette[index % len(palette)])


class Migration(migrations.Migration):
    dependencies = [('api', '0054_office_planning_and_phase_dates')]
    operations = [
        migrations.AddField(
            model_name='trabajadoroficina', name='color',
            field=models.CharField(
                max_length=7, default='#2563eb',
                validators=[RegexValidator(r'^#[0-9a-fA-F]{6}$', 'Usa un color hexadecimal como #2563eb.')],
            ),
        ),
        migrations.RunPython(assign_existing_colors, migrations.RunPython.noop),
    ]
