import re

from django.db import migrations

# Los grupos de bastidor pasan a llamarse oficialmente bastidores (decision
# del usuario 2026-10-21). Solo se tocan los nombres por defecto ('Grupo 3');
# un alias puesto a mano ('Fachada') se respeta.
DEFECTO_ANTIGUO = re.compile(r'^Grupo (\d+)$')
DEFECTO_NUEVO = re.compile(r'^Bastidor (\d+)$')


def _renombrar(apps, patron, plantilla):
    GrupoBastidor = apps.get_model('api', 'GrupoBastidor')
    for grupo in GrupoBastidor.objects.exclude(nombre='').only('id', 'nombre'):
        encaja = patron.match(grupo.nombre or '')
        if encaja:
            grupo.nombre = plantilla.format(encaja.group(1))
            grupo.save(update_fields=['nombre'])


def grupo_a_bastidor(apps, schema_editor):
    _renombrar(apps, DEFECTO_ANTIGUO, 'Bastidor {}')


def bastidor_a_grupo(apps, schema_editor):
    _renombrar(apps, DEFECTO_NUEVO, 'Grupo {}')


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0079_turnos_desde_horario'),
    ]

    operations = [
        migrations.RunPython(grupo_a_bastidor, bastidor_a_grupo),
    ]
