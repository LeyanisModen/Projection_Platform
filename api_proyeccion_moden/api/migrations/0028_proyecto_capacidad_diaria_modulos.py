from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0027_grupo_bastidor'),
    ]

    operations = [
        migrations.AddField(
            model_name='proyecto',
            name='capacidad_diaria_modulos',
            field=models.PositiveIntegerField(
                default=6,
                help_text='Numero estimado de modulos que la ferralla produce por dia.'
            ),
        ),
    ]
