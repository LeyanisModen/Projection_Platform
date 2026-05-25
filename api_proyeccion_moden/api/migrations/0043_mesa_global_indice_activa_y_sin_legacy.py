from django.db import migrations, models


def assert_no_legacy_mesas(apps, schema_editor):
    """Aborta si hay mesas con tipo=LEGACY (no esperadas en produccion)."""
    Mesa = apps.get_model('api', 'Mesa')
    legacy_count = Mesa.objects.filter(tipo='LEGACY').count()
    if legacy_count > 0:
        raise RuntimeError(
            f"No se puede aplicar 0043: hay {legacy_count} mesa(s) con tipo=LEGACY. "
            "Cambia su tipo a INFERIOR o SUPERIOR antes de migrar."
        )


def recompact_global_indices_and_rename(apps, schema_editor):
    """Por cada grupo, recalcula indice global 1..N (ordenado por
    tipo INFERIOR<SUPERIOR<LEGACY, indice viejo, id) y renombra cada
    mesa a 'Mesa N'. Usa indices temporales >=10000 durante la fase
    intermedia para no chocar con la unique constraint vieja (que
    todavia esta vigente cuando se ejecuta este RunPython, antes del
    AddConstraint final).
    """
    Mesa = apps.get_model('api', 'Mesa')
    GrupoMesas = apps.get_model('api', 'GrupoMesas')

    tipo_order = {'INFERIOR': 0, 'SUPERIOR': 1, 'LEGACY': 2}
    TEMP_BASE = 10000

    for grupo in GrupoMesas.objects.all():
        mesas_ordered = sorted(
            grupo.mesas.all(),
            key=lambda m: (tipo_order.get(m.tipo, 99), m.indice, m.id),
        )

        # Fase 1: indices temporales para liberar los huecos finales.
        for offset, mesa in enumerate(mesas_ordered, start=1):
            mesa.indice = TEMP_BASE + offset
            mesa.save(update_fields=['indice'])

        # Fase 2: indices definitivos 1..N + rename.
        for new_idx, mesa in enumerate(mesas_ordered, start=1):
            mesa.indice = new_idx
            mesa.nombre = f"Mesa {new_idx}"
            mesa.save(update_fields=['indice', 'nombre'])

    # Mesas huerfanas (sin grupo) tambien se renombran por consistencia.
    for mesa in Mesa.objects.filter(grupo__isnull=True):
        mesa.nombre = f"Mesa {mesa.id}"
        mesa.save(update_fields=['nombre'])


def reverse_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0042_remove_mesa_rol'),
    ]

    operations = [
        # 1. Aborta si hay mesas LEGACY (esperamos cero en prod).
        migrations.RunPython(assert_no_legacy_mesas, reverse_noop),

        # 2. Anade `activa` (default True para no apagar nada existente).
        migrations.AddField(
            model_name='mesa',
            name='activa',
            field=models.BooleanField(
                default=True,
                help_text='Si False, el planificador la ignora pero se conserva (mesa en mantenimiento o proyector roto).',
            ),
        ),

        # 3. Quita la constraint vieja (tipo, indice) por grupo.
        migrations.RemoveConstraint(
            model_name='mesa',
            name='unique_tipo_indice_por_grupo_mesas',
        ),

        # 4. Recompacta indices globalmente 1..N por grupo + rename a 'Mesa N'.
        #    El AddConstraint nuevo y el AlterField para quitar LEGACY se hacen
        #    en 0044, en una transaccion aparte: PostgreSQL no permite CREATE
        #    INDEX en la misma transaccion que un RunPython que escribe a la
        #    misma tabla ('pending trigger events').
        migrations.RunPython(recompact_global_indices_and_rename, reverse_noop),
    ]
