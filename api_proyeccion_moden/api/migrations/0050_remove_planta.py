from django.db import migrations, models


def move_plant_data_to_project(apps, schema_editor):
    Proyecto = apps.get_model('api', 'Proyecto')
    Planta = apps.get_model('api', 'Planta')
    Modulo = apps.get_model('api', 'Modulo')

    for proyecto in Proyecto.objects.all().iterator():
        plantas = Planta.objects.filter(proyecto_id=proyecto.pk).order_by(
            'orden', 'id'
        )
        plano = plantas.exclude(plano_imagen__isnull=True).exclude(
            plano_imagen=''
        ).values_list('plano_imagen', flat=True).first()
        planilla = plantas.exclude(fichero_corte__isnull=True).exclude(
            fichero_corte=''
        ).values_list('fichero_corte', flat=True).first()

        updates = {}
        if plano:
            updates['plano_archivo'] = plano
        if planilla:
            updates['planilla_archivo'] = planilla
        if updates:
            Proyecto.objects.filter(pk=proyecto.pk).update(**updates)

    # Proyecto is already the authoritative module relationship. Repair any
    # legacy mismatch before the redundant plant relation disappears.
    for modulo in Modulo.objects.exclude(planta_id=None).iterator():
        planta = Planta.objects.filter(pk=modulo.planta_id).only(
            'proyecto_id'
        ).first()
        if planta and modulo.proyecto_id != planta.proyecto_id:
            Modulo.objects.filter(pk=modulo.pk).update(
                proyecto_id=planta.proyecto_id
            )


def restore_general_plants(apps, schema_editor):
    Proyecto = apps.get_model('api', 'Proyecto')
    Planta = apps.get_model('api', 'Planta')
    Modulo = apps.get_model('api', 'Modulo')

    for proyecto in Proyecto.objects.all().iterator():
        planta = Planta.objects.create(
            nombre='General',
            proyecto_id=proyecto.pk,
            orden=1,
            plano_imagen=proyecto.plano_archivo,
            fichero_corte=proyecto.planilla_archivo,
        )
        Modulo.objects.filter(proyecto_id=proyecto.pk).update(
            planta_id=planta.pk
        )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0049_mesa_capture_config_applied_at_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='proyecto',
            name='plano_archivo',
            field=models.FileField(
                blank=True,
                help_text='Plano PDF del proyecto.',
                null=True,
                upload_to='planos/',
            ),
        ),
        migrations.AddField(
            model_name='proyecto',
            name='planilla_archivo',
            field=models.FileField(
                blank=True,
                help_text='Planilla PDF del proyecto.',
                null=True,
                upload_to='planillas/',
            ),
        ),
        migrations.RunPython(
            move_plant_data_to_project,
            restore_general_plants,
        ),
        migrations.RemoveField(
            model_name='modulo',
            name='planta',
        ),
        migrations.DeleteModel(
            name='Planta',
        ),
    ]
