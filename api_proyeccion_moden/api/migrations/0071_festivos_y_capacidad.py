from datetime import date

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion

# Fiestas nacionales (BOE). Las que caen en domingo y algunas comunidades
# pasan al lunes, y los festivos locales, se anaden desde el calendario.
FESTIVOS_NACIONALES = [
    (date(2026, 10, 12), 'Fiesta Nacional de España'),
    (date(2026, 11, 1), 'Todos los Santos'),
    (date(2026, 12, 6), 'Día de la Constitución Española'),
    (date(2026, 12, 8), 'Inmaculada Concepción'),
    (date(2026, 12, 25), 'Natividad del Señor'),
    (date(2027, 1, 1), 'Año Nuevo'),
    (date(2027, 1, 6), 'Epifanía del Señor'),
    (date(2027, 3, 26), 'Viernes Santo'),
    (date(2027, 5, 1), 'Fiesta del Trabajo'),
    (date(2027, 8, 15), 'Asunción de la Virgen'),
    (date(2027, 10, 12), 'Fiesta Nacional de España'),
    (date(2027, 11, 1), 'Todos los Santos'),
    (date(2027, 12, 6), 'Día de la Constitución Española'),
    (date(2027, 12, 8), 'Inmaculada Concepción'),
    (date(2027, 12, 25), 'Natividad del Señor'),
]


def festivos_y_capacidad(apps, schema_editor):
    EventoCalendario = apps.get_model('api', 'EventoCalendario')
    UserProfile = apps.get_model('api', 'UserProfile')
    for dia, titulo in FESTIVOS_NACIONALES:
        if not EventoCalendario.objects.filter(tipo='FESTIVO', inicio=dia, ferralla__isnull=True).exists():
            EventoCalendario.objects.create(
                titulo=titulo, tipo='FESTIVO', inicio=dia, fin=dia,
                notas='Festivo nacional.',
            )
    # 12 era el valor por defecto, nunca configurado: pasa a la media esperada.
    UserProfile.objects.filter(capacidad_diaria_modulos=12).update(capacidad_diaria_modulos=35)


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
        migrations.RunPython(festivos_y_capacidad, migrations.RunPython.noop),
    ]
