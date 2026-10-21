from django.db import migrations
from django.db.models import Q

# Arranque de la fecha de montaje en obra de la ferralla (decision del
# usuario 2026-10-21): a los proyectos que ya se fabrican o estan terminados
# se les copia la fecha de Moden como punto de partida; los que aun no han
# empezado se dejan vacios para que la ferralla ponga la suya.


def sembrar_fecha_obra(apps, schema_editor):
    Proyecto = apps.get_model('api', 'Proyecto')
    Modulo = apps.get_model('api', 'Modulo')
    GrupoMesasProyecto = apps.get_model('api', 'GrupoMesasProyecto')

    en_marcha = set(GrupoMesasProyecto.objects.values_list('proyecto_id', flat=True))
    en_marcha |= set(
        Modulo.objects.filter(Q(inferior_hecho=True) | Q(superior_hecho=True) | Q(cerrado=True))
        .values_list('proyecto_id', flat=True)
    )
    pendientes = Proyecto.objects.filter(
        pk__in=en_marcha, fecha_montaje_obra__isnull=True, fecha_montaje__isnull=False,
    )
    for proyecto in pendientes.only('id', 'fecha_montaje'):
        proyecto.fecha_montaje_obra = proyecto.fecha_montaje
        proyecto.save(update_fields=['fecha_montaje_obra'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0081_fecha_montaje_obra'),
    ]

    operations = [
        migrations.RunPython(sembrar_fecha_obra, migrations.RunPython.noop),
    ]
