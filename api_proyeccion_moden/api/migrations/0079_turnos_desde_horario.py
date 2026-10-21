from django.db import migrations

DAY_CODES = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')


def horario_como_turno(apps, schema_editor):
    """El horario de cada ferralla pasa a ser su turno de manana, y la
    capacidad, que ahora es por turno, baja de 35 a 25 (lo que sacan de
    verdad, decision del usuario 2026-10-19)."""
    UserProfile = apps.get_model('api', 'UserProfile')
    for profile in UserProfile.objects.all():
        cambios = []
        if not profile.turnos:
            horario = {}
            guardado = profile.capture_horario or {}
            if guardado:
                for day in DAY_CODES:
                    tramo = guardado.get(day)
                    if tramo and len(tramo) == 2 and tramo[0] != tramo[1]:
                        horario[day] = [str(tramo[0])[:5], str(tramo[1])[:5]]
            else:
                for day in DAY_CODES:
                    if day in (profile.capture_active_days or []):
                        horario[day] = [
                            profile.capture_start_time.strftime('%H:%M'),
                            profile.capture_end_time.strftime('%H:%M'),
                        ]
            profile.turnos = [{'nombre': 'Mañana', 'activo': True, 'horario': horario}]
            cambios.append('turnos')
        # El campo se quito en la 0085: al reejecutar la funcion (tests) ya no existe.
        if getattr(profile, 'capacidad_diaria_modulos', None) == 35:
            profile.capacidad_diaria_modulos = 25
            cambios.append('capacidad_diaria_modulos')
        if cambios:
            profile.save(update_fields=cambios)


class Migration(migrations.Migration):
    # Aparte de 0078: en PostgreSQL los datos no van en la misma migracion
    # que cambia el esquema.

    dependencies = [
        ('api', '0078_turnos'),
    ]

    operations = [
        migrations.RunPython(horario_como_turno, migrations.RunPython.noop),
    ]
