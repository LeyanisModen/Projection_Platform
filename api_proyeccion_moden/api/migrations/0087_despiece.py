from django.db import migrations, models


class Migration(migrations.Migration):
    """Los documentos del proyecto (ZIP) pasan a ser el despiece (Excel).

    Se renombra la columna: lo ya subido se queda donde estaba. El Excel de
    elementos sueltos aparte deja de subirse; su pestaña viene en el despiece.
    """

    dependencies = [
        ('api', '0086_kilos_planificacion'),
    ]

    operations = [
        migrations.RenameField(
            model_name='proyecto',
            old_name='documentos_archivo',
            new_name='despiece_archivo',
        ),
        migrations.AlterField(
            model_name='proyecto',
            name='despiece_archivo',
            field=models.FileField(
                blank=True,
                help_text=(
                    'Excel de despiece del proyecto. Su pestaña ELEMENTOS SUELTOS es '
                    'la que ve la ferralla en el dashboard.'
                ),
                null=True,
                upload_to='despieces/',
            ),
        ),
        migrations.AlterField(
            model_name='proyecto',
            name='elementos_sueltos_archivo',
            field=models.FileField(
                blank=True,
                help_text=(
                    'Excel aparte de elementos sueltos, de antes del despiece. Ya no '
                    'se sube; solo se lee si el proyecto no tiene despiece en Excel.'
                ),
                null=True,
                upload_to='elementos_sueltos/',
            ),
        ),
    ]
