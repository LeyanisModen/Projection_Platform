from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0026_mesaqueueitem_plan_group_index_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='proyecto',
            name='datos_tecnicos_importados',
            field=models.BooleanField(
                default=False,
                help_text='Indica si ya se importo el fichero de datos tecnicos y se calcularon los grupos.'
            ),
        ),
        migrations.CreateModel(
            name='GrupoBastidor',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('indice', models.PositiveIntegerField(help_text='Numero de grupo dentro del proyecto (1, 2, 3...).')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('proyecto', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='grupos_bastidor',
                    to='api.proyecto',
                )),
            ],
            options={
                'db_table': 'api_grupo_bastidor',
                'ordering': ['proyecto', 'indice'],
            },
        ),
        migrations.AddConstraint(
            model_name='grupobastidor',
            constraint=models.UniqueConstraint(
                fields=('proyecto', 'indice'),
                name='unique_grupo_indice_per_proyecto',
            ),
        ),
        migrations.AddField(
            model_name='modulo',
            name='grupo_bastidor',
            field=models.ForeignKey(
                blank=True,
                help_text='Grupo de bastidor al que pertenece el modulo. Se asigna al calcular los grupos.',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='modulos',
                to='api.grupobastidor',
            ),
        ),
    ]
