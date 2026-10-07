from datetime import timedelta

from django.db import migrations


def mover_a_dia_laborable(apps, schema_editor):
    """Los controles pendientes no pueden caer en fin de semana ni festivo:
    pasan al dia laborable anterior de la oficina."""
    EventoCalendario = apps.get_model('api', 'EventoCalendario')
    ProyectoCheck = apps.get_model('api', 'ProyectoCheck')
    festivos = set()
    for inicio, fin in EventoCalendario.objects.filter(tipo='FESTIVO', ferralla__isnull=True).values_list('inicio', 'fin'):
        dia = inicio
        while dia <= fin:
            festivos.add(dia)
            dia += timedelta(days=1)
    for paso in ProyectoCheck.objects.filter(completado=False, fecha_limite__isnull=False):
        dia = paso.fecha_limite
        while dia.weekday() >= 5 or dia in festivos:
            dia -= timedelta(days=1)
        if dia != paso.fecha_limite:
            paso.fecha_limite = dia
            paso.save(update_fields=['fecha_limite'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0072_festivos_nacionales'),
    ]

    operations = [
        migrations.RunPython(mover_a_dia_laborable, migrations.RunPython.noop),
    ]
