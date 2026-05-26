import re
from django.db import migrations, models


def _natural_key(name):
    """A01 < A02 < A10 < A100 (mismo criterio que views._natural_sort_key)."""
    parts = re.split(r'(\d+)', name or '')
    return [int(p) if p.isdigit() else p for p in parts]


def backfill_orden_intra(apps, schema_editor):
    GrupoBastidor = apps.get_model('api', 'GrupoBastidor')
    Modulo = apps.get_model('api', 'Modulo')

    # Modulos con grupo: orden 1..N por nombre natural dentro del grupo.
    for grupo in GrupoBastidor.objects.all():
        modulos = sorted(grupo.modulos.all(), key=lambda m: _natural_key(m.nombre))
        for idx, m in enumerate(modulos, start=1):
            if m.orden_intra != idx:
                m.orden_intra = idx
                m.save(update_fields=['orden_intra'])

    # Modulos sin grupo: dejan orden_intra=0 (default). Si en algun momento
    # los asignan a un grupo, _assign_modulo_to_group_on_create les pondra
    # el orden correcto.


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0045_tipo_modulo_estrategia_bastidor'),
    ]

    operations = [
        migrations.AddField(
            model_name='modulo',
            name='orden_intra',
            field=models.PositiveIntegerField(
                default=0,
                help_text=(
                    'Posicion del modulo dentro de su GrupoBastidor (1..N). '
                    'Se respeta tanto en la visualizacion del admin como en la cola '
                    'operativa. Se reindexa al mover/reordenar via drag-drop.'
                ),
            ),
        ),
        migrations.RunPython(backfill_orden_intra, reverse_code=noop_reverse),
    ]
