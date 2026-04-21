from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0035_grupo_mesas_proyecto'),
    ]

    operations = [
        migrations.AddField(
            model_name='grupobastidor',
            name='asignado_a',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='grupos_bastidor_reservados',
                to='api.grupomesas',
                help_text='Grupo operativo al que se ha reservado este bastidor. Null => disponible.',
            ),
        ),
    ]
