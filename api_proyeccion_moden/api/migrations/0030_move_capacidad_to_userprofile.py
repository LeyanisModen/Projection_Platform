from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0029_modulo_completado_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='capacidad_diaria_modulos',
            field=models.PositiveIntegerField(
                default=12,
                help_text='Modulos que la ferralla produce por dia (se reparten entre sus mesas INF).'
            ),
        ),
        migrations.RemoveField(
            model_name='proyecto',
            name='capacidad_diaria_modulos',
        ),
    ]
