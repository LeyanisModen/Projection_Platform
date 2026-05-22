from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0041_mesa_tipo_indice'),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name='mesa',
            name='unique_rol_por_grupo_mesas',
        ),
        migrations.RemoveField(
            model_name='mesa',
            name='rol',
        ),
    ]
