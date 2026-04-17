from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0030_move_capacidad_to_userprofile'),
    ]

    operations = [
        migrations.AddField(
            model_name='detallemodulofase',
            name='metros_refuerzos',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
        migrations.AddField(
            model_name='detallemodulofase',
            name='metros_zunchos',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
        migrations.AddField(
            model_name='detallemodulofase',
            name='metros_separadores',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
        migrations.AddField(
            model_name='detallemodulofase',
            name='metros_punzos',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
    ]
