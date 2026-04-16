from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0028_proyecto_capacidad_diaria_modulos'),
    ]

    operations = [
        migrations.AddField(
            model_name='modulo',
            name='completado_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
