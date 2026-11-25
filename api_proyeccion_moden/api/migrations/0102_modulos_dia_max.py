from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0101_reparto_camiones'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='modulos_dia_max',
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
    ]
