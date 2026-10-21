from django.db import migrations
from django.utils import timezone

# Los proyectos que ya estaban asignados a una ferralla antes de existir la
# aceptacion se dan por aceptados: solo los nuevos pasan por notificaciones.


def aceptar_los_existentes(apps, schema_editor):
    Proyecto = apps.get_model('api', 'Proyecto')
    Proyecto.objects.filter(
        usuario__isnull=False, aceptado_por_ferralla_at__isnull=True,
    ).update(aceptado_por_ferralla_at=timezone.now())


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0083_proyecto_aceptado_por_ferralla'),
    ]

    operations = [
        migrations.RunPython(aceptar_los_existentes, migrations.RunPython.noop),
    ]
