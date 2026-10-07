from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0070_retirar_proyectos_terminados_de_cola'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AlterField(
            model_name='eventocalendario',
            name='tipo',
            field=models.CharField(
                choices=[('EVENTO', 'Evento'), ('VACACIONES', 'Vacaciones'), ('FESTIVO', 'Festivo')],
                default='EVENTO', max_length=16,
            ),
        ),
        migrations.AddField(
            model_name='eventocalendario',
            name='ferralla',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name='festivos', to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name='userprofile',
            name='capacidad_diaria_modulos',
            field=models.PositiveIntegerField(
                default=35,
                help_text=(
                    'Modulos por dia que se espera que saque la ferralla. El plan de '
                    'fabricacion solo avisa de los proyectos que piden mas.'
                ),
            ),
        ),
    ]
