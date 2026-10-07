from datetime import date

from django.db import migrations

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
    # Va aparte de 0071: PostgreSQL no deja crear el indice de ``ferralla``
    # con filas recien insertadas en la misma transaccion.

    dependencies = [
        ('api', '0071_festivos_y_capacidad'),
    ]

    operations = [
        migrations.RunPython(festivos_y_capacidad, migrations.RunPython.noop),
    ]
