from collections import Counter
from decimal import Decimal

from django.core.validators import MinValueValidator
from django.db import migrations, models


def seed_ferralla_rack_lengths(apps, schema_editor):
    Proyecto = apps.get_model('api', 'Proyecto')
    UserProfile = apps.get_model('api', 'UserProfile')

    project_values = {}
    for user_id, value in (
        Proyecto.objects.exclude(usuario_id=None)
        .order_by('id')
        .values_list('usuario_id', 'bastidor_longitud_cm')
    ):
        if value is not None and value > 0:
            project_values.setdefault(user_id, []).append(value)

    for user_id, values in project_values.items():
        counts = Counter(values)
        selected = max(counts, key=lambda value: (counts[value], -values.index(value)))
        UserProfile.objects.update_or_create(
            user_id=user_id,
            defaults={'bastidor_longitud_cm': selected},
        )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0052_fotofabricacion_capture_history'),
    ]

    operations = [
        migrations.AddField(
            model_name='proyecto',
            name='peso_maximo_grua_kg',
            field=models.DecimalField(
                blank=True,
                decimal_places=2,
                help_text=(
                    'Peso maximo que puede elevar la grua de la obra. '
                    'Vacio significa sin limite configurado.'
                ),
                max_digits=10,
                null=True,
                validators=[MinValueValidator(Decimal('0.01'))],
            ),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='bastidor_longitud_cm',
            field=models.DecimalField(
                decimal_places=2,
                default=114,
                help_text='Longitud util de los bastidores de esta ferralla.',
                max_digits=6,
                validators=[MinValueValidator(Decimal('0.01'))],
            ),
        ),
        migrations.RenameField(
            model_name='proyecto',
            old_name='planilla_archivo',
            new_name='documentos_archivo',
        ),
        migrations.AlterField(
            model_name='proyecto',
            name='documentos_archivo',
            field=models.FileField(
                blank=True,
                help_text='Archivo ZIP con la documentacion del proyecto.',
                null=True,
                upload_to='documentos/',
            ),
        ),
        migrations.RunPython(seed_ferralla_rack_lengths, migrations.RunPython.noop),
    ]
