from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0043_mesa_global_indice_activa_y_sin_legacy'),
    ]

    operations = [
        # Quita LEGACY del enum tipo (verificacion ya hecha en 0043).
        migrations.AlterField(
            model_name='mesa',
            name='tipo',
            field=models.CharField(
                choices=[('INFERIOR', 'Inferior'), ('SUPERIOR', 'Superior')],
                default='INFERIOR',
                max_length=20,
            ),
        ),

        # Nueva constraint: indice unico por grupo (sin restriccion por tipo).
        migrations.AddConstraint(
            model_name='mesa',
            constraint=models.UniqueConstraint(
                condition=models.Q(('grupo__isnull', False)),
                fields=('grupo', 'indice'),
                name='unique_indice_por_grupo_mesas',
            ),
        ),
    ]
