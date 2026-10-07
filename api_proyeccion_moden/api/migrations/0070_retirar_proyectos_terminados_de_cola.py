from django.db import migrations
from django.db.models import Q


def retirar_proyectos_terminados(apps, schema_editor):
    """Saca de las colas de las lineas los proyectos ya fabricados enteros.

    Hasta ahora solo salian al pulsar "Planificar"; desde esta version salen
    al completarse su ultimo modulo (queue_sync.retirar_proyecto_terminado).
    Un proyecto sin modulos se queda: espera su importacion.
    """
    GrupoMesas = apps.get_model('api', 'GrupoMesas')
    GrupoMesasProyecto = apps.get_model('api', 'GrupoMesasProyecto')
    Modulo = apps.get_model('api', 'Modulo')

    grupo_ids = set()
    for entrada in list(GrupoMesasProyecto.objects.all()):
        modulos = Modulo.objects.filter(proyecto_id=entrada.proyecto_id)
        if not modulos.exists():
            continue
        if modulos.filter(cerrado=False).filter(
            Q(inferior_hecho=False) | Q(superior_hecho=False)
        ).exists():
            continue
        grupo_ids.add(entrada.grupo_mesas_id)
        entrada.delete()

    for grupo in GrupoMesas.objects.filter(id__in=grupo_ids):
        entradas = list(
            GrupoMesasProyecto.objects.filter(grupo_mesas_id=grupo.id).order_by('orden', 'id')
        )
        for indice, entrada in enumerate(entradas):
            if entrada.orden != indice:
                entrada.orden = indice
                entrada.save(update_fields=['orden'])
        cabeza = entradas[0].proyecto_id if entradas else None
        if grupo.proyecto_actual_id != cabeza:
            grupo.proyecto_actual_id = cabeza
            grupo.save(update_fields=['proyecto_actual'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0069_imagen_monitor'),
    ]

    operations = [
        migrations.RunPython(retirar_proyectos_terminados, migrations.RunPython.noop),
    ]
