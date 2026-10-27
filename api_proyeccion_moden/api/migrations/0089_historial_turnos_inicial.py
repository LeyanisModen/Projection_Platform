from datetime import date

from django.db import migrations

# Hasta los turnos por ferralla (20/10/2026) cada ferralla tenia un solo
# horario, el del turno de manana, que es el de ahora. El turno de noche de la
# unica ferralla con dos empezo el domingo 18/10/2026 (dato del usuario).
PRINCIPIO = date(2000, 1, 1)
VARIOS_TURNOS_DESDE = date(2026, 10, 18)


def turnos_iniciales(apps, schema_editor):
    """El historial de partida: los turnos de hoy valen desde siempre, salvo
    los que no son el primero, que solo cuentan desde el 18/10/2026."""
    from api.turnos import turnos_a_json, turnos_de

    UserProfile = apps.get_model('api', 'UserProfile')
    HistorialTurnos = apps.get_model('api', 'HistorialTurnos')
    for profile in UserProfile.objects.all():
        if HistorialTurnos.objects.filter(ferralla_id=profile.user_id).exists():
            continue
        actuales = turnos_a_json(turnos_de(profile, solo_activos=False))
        if len(actuales) > 1:
            solo_el_primero = [
                dict(turno, activo=turno['activo'] and indice == 0) for indice, turno in enumerate(actuales)
            ]
            HistorialTurnos.objects.create(ferralla_id=profile.user_id, desde=PRINCIPIO, turnos=solo_el_primero)
            HistorialTurnos.objects.create(ferralla_id=profile.user_id, desde=VARIOS_TURNOS_DESDE, turnos=actuales)
        else:
            HistorialTurnos.objects.create(ferralla_id=profile.user_id, desde=PRINCIPIO, turnos=actuales)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0088_historial_turnos'),
    ]

    operations = [
        migrations.RunPython(turnos_iniciales, migrations.RunPython.noop),
    ]
