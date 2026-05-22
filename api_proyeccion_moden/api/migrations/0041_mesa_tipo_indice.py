from django.db import migrations, models


def backfill_tipo_indice(apps, schema_editor):
    """Poblar tipo+indice a partir del rol legacy.

    INFERIOR_1 -> (INFERIOR, 1)
    INFERIOR_2 -> (INFERIOR, 2)
    SUPERIORES -> (SUPERIOR, 1)
    LEGACY     -> (LEGACY, n) -- indice secuencial por grupo, empezando en 1.
    """
    Mesa = apps.get_model('api', 'Mesa')

    rol_a_tipo_indice = {
        'INFERIOR_1': ('INFERIOR', 1),
        'INFERIOR_2': ('INFERIOR', 2),
        'SUPERIORES': ('SUPERIOR', 1),
    }

    # Asignar tipo/indice directo para roles conocidos.
    for mesa in Mesa.objects.exclude(rol='LEGACY'):
        mapped = rol_a_tipo_indice.get(mesa.rol)
        if mapped is None:
            continue
        mesa.tipo, mesa.indice = mapped
        mesa.save(update_fields=['tipo', 'indice'])

    # Para mesas LEGACY, asignar indices secuenciales dentro de cada grupo
    # (o globales si grupo es null) para no chocar entre si. Como tipo=LEGACY
    # esta excluido de la unique constraint, el indice es solo informativo.
    legacy_qs = Mesa.objects.filter(rol='LEGACY').order_by('grupo_id', 'id')
    grupo_actual = object()
    contador = 0
    for mesa in legacy_qs:
        if mesa.grupo_id != grupo_actual:
            grupo_actual = mesa.grupo_id
            contador = 1
        else:
            contador += 1
        mesa.tipo = 'LEGACY'
        mesa.indice = contador
        mesa.save(update_fields=['tipo', 'indice'])


def reverse_noop(apps, schema_editor):
    """El reverse no necesita hacer nada: los AddField se revertiran solos."""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0040_materialinformado_materialpieza'),
    ]

    operations = [
        migrations.AddField(
            model_name='mesa',
            name='tipo',
            field=models.CharField(
                choices=[('INFERIOR', 'Inferior'), ('SUPERIOR', 'Superior'), ('LEGACY', 'Legacy')],
                default='LEGACY',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='mesa',
            name='indice',
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AlterField(
            model_name='mesa',
            name='rol',
            field=models.CharField(
                choices=[
                    ('LEGACY', 'Mesa Legacy'),
                    ('INFERIOR_1', 'Inferior 1 + Montaje'),
                    ('INFERIOR_2', 'Inferior 2 + Montaje'),
                    ('SUPERIORES', 'Superiores'),
                ],
                default='LEGACY',
                help_text=(
                    'Rol legacy (INFERIOR_1/INFERIOR_2/SUPERIORES). Reemplazado por tipo+indice; '
                    'mesas extra usan LEGACY.'
                ),
                max_length=20,
            ),
        ),
        migrations.RunPython(backfill_tipo_indice, reverse_noop),
        migrations.AddConstraint(
            model_name='mesa',
            constraint=models.UniqueConstraint(
                condition=models.Q(('grupo__isnull', False), models.Q(('tipo', 'LEGACY'), _negated=True)),
                fields=('grupo', 'tipo', 'indice'),
                name='unique_tipo_indice_por_grupo_mesas',
            ),
        ),
    ]
