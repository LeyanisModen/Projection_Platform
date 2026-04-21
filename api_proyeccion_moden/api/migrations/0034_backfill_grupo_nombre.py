from django.db import migrations


def backfill_nombre(apps, schema_editor):
    GrupoBastidor = apps.get_model('api', 'GrupoBastidor')
    for grupo in GrupoBastidor.objects.filter(nombre=''):
        grupo.nombre = f'Grupo {grupo.indice}'
        grupo.save(update_fields=['nombre'])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0033_grupobastidor_nombre'),
    ]

    operations = [
        migrations.RunPython(backfill_nombre, noop),
    ]
