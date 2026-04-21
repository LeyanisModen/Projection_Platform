from django.db import migrations, models
import django.db.models.deletion


def backfill_queue(apps, schema_editor):
    """Every GrupoMesas with a proyecto_actual becomes its first queue entry."""
    GrupoMesas = apps.get_model('api', 'GrupoMesas')
    GrupoMesasProyecto = apps.get_model('api', 'GrupoMesasProyecto')
    for grupo in GrupoMesas.objects.filter(proyecto_actual__isnull=False):
        GrupoMesasProyecto.objects.get_or_create(
            grupo_mesas=grupo,
            proyecto_id=grupo.proyecto_actual_id,
            defaults={'orden': 0},
        )


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0034_backfill_grupo_nombre'),
    ]

    operations = [
        migrations.CreateModel(
            name='GrupoMesasProyecto',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('orden', models.PositiveIntegerField(
                    default=0,
                    help_text='Posicion en la cola. Menor => antes se fabrica.'
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('grupo_mesas', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='proyectos_cola',
                    to='api.grupomesas'
                )),
                ('proyecto', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='colas_grupos_mesas',
                    to='api.proyecto'
                )),
            ],
            options={
                'db_table': 'api_grupo_mesas_proyecto',
                'ordering': ['grupo_mesas', 'orden'],
            },
        ),
        migrations.AddConstraint(
            model_name='grupomesasproyecto',
            constraint=models.UniqueConstraint(
                fields=['grupo_mesas', 'proyecto'],
                name='unique_proyecto_por_grupo_mesas',
            ),
        ),
        migrations.RunPython(backfill_queue, noop),
    ]
