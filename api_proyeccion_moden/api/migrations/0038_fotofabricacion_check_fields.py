from django.db import migrations, models


def dedup_fotofabricacion(apps, schema_editor):
    """Keep only the most recent FotoFabricacion per (modulo, fase, paso).

    The upcoming unique_together would otherwise fail on any project
    that already has multiple captures for the same paso. Older rows
    are deleted from the DB; their files are left on disk (harmless,
    cleaned up lazily).
    """
    FotoFabricacion = apps.get_model('api', 'FotoFabricacion')
    seen = set()
    for foto in FotoFabricacion.objects.order_by('-capturada_at').iterator():
        key = (foto.modulo_id, foto.fase, foto.paso)
        if key in seen:
            foto.delete()
        else:
            seen.add(key)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0037_mesa_capture_health'),
    ]

    operations = [
        migrations.RunPython(dedup_fotofabricacion, noop_reverse),
        migrations.AddField(
            model_name='fotofabricacion',
            name='updated_at',
            field=models.DateTimeField(auto_now=True),
        ),
        migrations.AddField(
            model_name='fotofabricacion',
            name='check_result',
            field=models.BooleanField(
                null=True,
                blank=True,
                help_text='Resultado de la validacion de colores. null = foto no pasada por check.',
            ),
        ),
        migrations.AddField(
            model_name='fotofabricacion',
            name='check_detail',
            field=models.JSONField(
                null=True,
                blank=True,
                help_text='Detalle del algoritmo: expected, detected, pixel_ratios, min_ratio.',
            ),
        ),
        migrations.AlterUniqueTogether(
            name='fotofabricacion',
            unique_together={('modulo', 'fase', 'paso')},
        ),
    ]
