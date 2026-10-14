import re

from django.db import migrations

# Misma convencion que api/edificios.py: OBRA[_B<bloque>]_P<planta>.
_NOMBRE = re.compile(
    r'^(?P<obra>.+?)(?:_B(?P<bloque>[A-Za-z0-9]{1,4}))?_P(?P<planta>SS|S\d{1,2}|B|M\d{0,2}|C\d{0,2}|\d{1,3})$',
    re.IGNORECASE,
)


def _leer(nombre):
    m = _NOMBRE.match((nombre or '').strip())
    if not m:
        return None
    obra, bloque, planta = m.group('obra'), m.group('bloque'), m.group('planta').upper()
    edificio = f'{obra}_B{bloque.upper()}' if bloque else obra
    if planta == 'SS':
        return edificio, 'SEMISOTANO', None
    if planta.startswith('S'):
        return edificio, 'SOTANO', int(planta[1:])
    if planta == 'B':
        return edificio, 'BAJA', None
    if planta.startswith('M'):
        return edificio, 'ENTREPLANTA', int(planta[1:]) if planta[1:] else None
    if planta.startswith('C'):
        return edificio, 'CUBIERTA', int(planta[1:]) if planta[1:] else None
    return edificio, 'PLANTA', int(planta)


def asignar_edificios(apps, schema_editor):
    """Los proyectos existentes pasan a su edificio y planta segun su nombre."""
    Edificio = apps.get_model('api', 'Edificio')
    Proyecto = apps.get_model('api', 'Proyecto')
    for proyecto in Proyecto.objects.filter(edificio__isnull=True, usuario__isnull=False):
        datos = _leer(proyecto.nombre)
        if datos is None:
            continue
        nombre, tipo, numero = datos
        edificio, _ = Edificio.objects.get_or_create(usuario_id=proyecto.usuario_id, nombre=nombre)
        proyecto.edificio_id = edificio.pk
        if not proyecto.planta_tipo:
            proyecto.planta_tipo = tipo
            proyecto.planta_numero = numero
        proyecto.save(update_fields=['edificio', 'planta_tipo', 'planta_numero'])


class Migration(migrations.Migration):
    # Aparte de 0075: en PostgreSQL los datos no van en la misma migracion
    # que crea la tabla y sus indices.

    dependencies = [
        ('api', '0075_edificios'),
    ]

    operations = [
        migrations.RunPython(asignar_edificios, migrations.RunPython.noop),
    ]
