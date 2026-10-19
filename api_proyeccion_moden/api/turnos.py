"""Turnos de trabajo de una ferralla.

Cada ferralla tiene uno o varios turnos (Manana, Noche...). Cada turno tiene
su horario por dia de la semana y puede estar activo o no (un turno de noche
que se hace a demanda se apaga sin borrarlo). Un turno puede cruzar la
medianoche (19:00-05:00): cuenta para el dia en que empieza, su "dia de
produccion".

De aqui sale todo lo que depende del horario: las horas de jornada y el
tiempo por panel de las estadisticas, los dias y la capacidad del plan de
fabricacion (la capacidad es por turno) y la ventana de fotos de los mini-PC.
"""
from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime, time, timedelta

from django.utils import timezone

DAY_CODES = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
# Horario historico de una ferralla sin configurar.
HORARIO_POR_DEFECTO = {day: (time(6, 50), time(15, 0)) for day in DAY_CODES[:5]}


@dataclass(frozen=True)
class Turno:
    indice: int
    nombre: str
    activo: bool
    horario: dict  # {'MON': (time, time)}; fin <= inicio cruza la medianoche

    def cruza_medianoche(self, day):
        inicio, fin = self.horario[day]
        return fin <= inicio


@dataclass(frozen=True)
class Tramo:
    """Un turno concreto de un dia: el lunes de noche, de 19:00 a 05:00."""
    turno: Turno
    fecha: object  # date: dia de produccion (en el que empieza)
    inicio: datetime
    fin: datetime

    @property
    def segundos(self):
        return (self.fin - self.inicio).total_seconds()


def _hora(valor):
    if isinstance(valor, time):
        return valor
    return datetime.strptime(str(valor)[:5], '%H:%M').time()


def leer_turnos(raw):
    """Turnos guardados (JSON) -> lista de Turno; ignora lo que no se entiende."""
    turnos = []
    for indice, item in enumerate(raw or []):
        if not isinstance(item, dict):
            continue
        horario = {}
        for day, tramo in (item.get('horario') or {}).items():
            if day not in DAY_CODES or not tramo or len(tramo) != 2:
                continue
            try:
                inicio, fin = _hora(tramo[0]), _hora(tramo[1])
            except (TypeError, ValueError):
                continue
            if inicio != fin:
                horario[day] = (inicio, fin)
        turnos.append(Turno(
            indice=indice,
            nombre=str(item.get('nombre') or f'Turno {indice + 1}')[:40],
            activo=bool(item.get('activo', True)),
            horario=horario,
        ))
    return turnos


def turnos_a_json(turnos):
    return [
        {
            'nombre': turno.nombre,
            'activo': turno.activo,
            'horario': {
                day: [turno.horario[day][0].strftime('%H:%M'), turno.horario[day][1].strftime('%H:%M')]
                for day in DAY_CODES if day in turno.horario
            },
        }
        for turno in turnos
    ]


def turno_desde_horario_antiguo(profile):
    """El horario de antes (una franja por dia) como un unico turno."""
    if profile is None:
        horario = dict(HORARIO_POR_DEFECTO)
    else:
        horario = {}
        guardado = profile.capture_horario or {}
        if guardado:
            for day, tramo in guardado.items():
                try:
                    horario[day] = (_hora(tramo[0]), _hora(tramo[1]))
                except (TypeError, ValueError, IndexError):
                    continue
        else:
            for day in profile.capture_active_days or []:
                horario[day] = (profile.capture_start_time, profile.capture_end_time)
    return Turno(indice=0, nombre='Mañana', activo=True, horario=horario)


def turnos_de(profile, solo_activos=True):
    """Turnos de una ferralla (con su perfil); sin configurar, el horario antiguo."""
    if profile is not None and getattr(profile, 'turnos', None):
        turnos = leer_turnos(profile.turnos)
    else:
        turnos = [turno_desde_horario_antiguo(profile)]
    return [t for t in turnos if t.activo] if solo_activos else turnos


def turnos_por_dia(turnos):
    """{'MON': 2, 'SUN': 1}: cuantos turnos empiezan cada dia de la semana."""
    cuenta = {}
    for turno in turnos:
        for day in turno.horario:
            cuenta[day] = cuenta.get(day, 0) + 1
    return {day: cuenta[day] for day in DAY_CODES if day in cuenta}


def tramos(turnos, desde, hasta, festivos=frozenset(), tz=None):
    """Tramos cuyo dia de produccion esta en [desde, hasta], por hora de inicio.

    Un festivo no tiene turnos (el turno de noche que empezo la vispera si).
    """
    tz = tz or timezone.get_current_timezone()
    resultado = []
    fecha = desde
    while fecha <= hasta:
        if fecha not in festivos:
            day = DAY_CODES[fecha.weekday()]
            for turno in turnos:
                if day not in turno.horario:
                    continue
                hora_inicio, hora_fin = turno.horario[day]
                inicio = timezone.make_aware(datetime.combine(fecha, hora_inicio), tz)
                fin = timezone.make_aware(datetime.combine(fecha, hora_fin), tz)
                if fin <= inicio:
                    fin = timezone.make_aware(datetime.combine(fecha + timedelta(days=1), hora_fin), tz)
                resultado.append(Tramo(turno=turno, fecha=fecha, inicio=inicio, fin=fin))
        fecha += timedelta(days=1)
    resultado.sort(key=lambda tramo: (tramo.inicio, tramo.turno.indice))
    return resultado


class Jornada:
    """Los tramos de trabajo alrededor de un periodo, para preguntar rapido
    a que turno pertenece un momento y cuanto se trabajo entre dos."""

    def __init__(self, turnos, desde, hasta, festivos=frozenset(), tz=None):
        self.tz = tz or timezone.get_current_timezone()
        self.turnos = turnos
        self.festivos = festivos
        # Un dia antes: el turno de noche que empezo la vispera.
        self.tramos = tramos(turnos, desde - timedelta(days=1), hasta, festivos, self.tz)
        self._inicios = [tramo.inicio for tramo in self.tramos]

    def tramo_de(self, momento):
        """El tramo en el que cae un momento, o None si es fuera de turno."""
        if momento is None:
            return None
        pos = bisect_right(self._inicios, momento)
        for tramo in reversed(self.tramos[max(0, pos - 3):pos]):
            if tramo.inicio <= momento < tramo.fin:
                return tramo
        return None

    def dia_de(self, momento):
        """Dia de produccion de un momento: el de su turno o, fuera de turno, el del calendario."""
        tramo = self.tramo_de(momento)
        if tramo is not None:
            return tramo.fecha
        return timezone.localtime(momento, self.tz).date()

    def segundos_entre(self, desde, hasta):
        """Segundos de turno entre dos momentos (sin contar dos veces si se solapan)."""
        if desde is None or hasta is None or hasta <= desde:
            return 0.0
        total = 0.0
        cubierto = desde
        for tramo in self.tramos:
            if tramo.fin <= cubierto:
                continue
            if tramo.inicio >= hasta:
                break
            lo = max(tramo.inicio, cubierto)
            hi = min(tramo.fin, hasta)
            if hi > lo:
                total += (hi - lo).total_seconds()
                cubierto = hi
        return total


def segundos_de_trabajo(desde, hasta, turnos, festivos=frozenset(), tz=None):
    tz = tz or timezone.get_current_timezone()
    if desde is None or hasta is None or hasta <= desde:
        return 0.0
    jornada = Jornada(
        turnos, timezone.localtime(desde, tz).date(), timezone.localtime(hasta, tz).date(), festivos, tz,
    )
    return jornada.segundos_entre(desde, hasta)


def ventana_de_captura(turnos, margen_minutos=30):
    """Franja diaria de fotos del mini-PC: todos los turnos con un margen.

    El servicio del mini-PC solo entiende una franja para todos los dias y
    sin cruzar la medianoche: con un turno de noche, el dia entero.
    """
    tramos_dia = [tramo for turno in turnos for tramo in turno.horario.values()]
    if not tramos_dia:
        return '06:20', '15:30'
    if any(fin <= inicio for inicio, fin in tramos_dia):
        return '00:00', '23:59'
    base = datetime(2000, 1, 1)
    margen = timedelta(minutes=margen_minutos)
    inicio = max(datetime.combine(base.date(), min(t[0] for t in tramos_dia)) - margen, base)
    fin = min(datetime.combine(base.date(), max(t[1] for t in tramos_dia)) + margen, base.replace(hour=23, minute=59))
    return inicio.strftime('%H:%M'), fin.strftime('%H:%M')


def dias_de_captura(turnos):
    """Dias en que el mini-PC hace fotos: los de los turnos y, si uno cruza la
    medianoche, tambien el dia siguiente."""
    dias = set()
    for turno in turnos:
        for day in turno.horario:
            dias.add(day)
            if turno.cruza_medianoche(day):
                dias.add(DAY_CODES[(DAY_CODES.index(day) + 1) % 7])
    return [day for day in DAY_CODES if day in dias]
