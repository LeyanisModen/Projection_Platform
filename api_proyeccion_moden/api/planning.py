"""Plan de fabricacion de cada ferralla: un proyecto detras de otro.

La ferralla fabrica en serie: primero lo que esta en la cola de sus lineas
(en ese orden) y despues el resto por fecha de montaje; al acabar un
proyecto se pone con el siguiente. Los modulos tienen que estar hechos el
dia laborable anterior al montaje. Cuentan solo los dias que trabaja la
ferralla y no los festivos del calendario (los de todas y los suyos).

- Ritmo necesario: todos los modulos pendientes entre los dias laborables
  que quedan hasta el ultimo montaje. Es la media que hay que sostener.
- Capacidad: los modulos por dia que se espera sacar (se configura en cada
  ferralla). A ese ritmo se calcula cuando se fabrica cada proyecto. Si un
  proyecto no llega, se avisa de cuantos modulos de mas necesita (horas
  extra, sabados...) y se supone que se cubren: el siguiente empieza a
  tiempo y el retraso no se arrastra.
"""
import math
from datetime import datetime, time, timedelta

from django.db.models import Count, Min, Q
from django.utils import timezone

from .models import default_capture_active_days

DAY_CODES = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
# Media que se espera de una ferralla si su ficha no dice otra cosa.
CAPACIDAD_POR_DEFECTO = 35
_EPS = 1e-9


def production_day_count(start, end, days, festivos=frozenset()):
    """Count days in [start, end); mounting day is reserved for site assembly."""
    span = max(0, (end - start).days)
    weeks, extra = divmod(span, 7)
    active = set(days)
    count = weeks * len(active) + sum(
        DAY_CODES[(start.weekday() + offset) % 7] in active
        for offset in range(extra)
    )
    if festivos:
        count -= sum(
            1 for dia in festivos
            if start <= dia < end and DAY_CODES[dia.weekday()] in active
        )
    return count


def factory_production_days(project):
    if project.usuario_id is None:
        return []
    profile = getattr(project.usuario, 'profile', None)
    # Match the factory configuration default without creating a profile on reads.
    days = profile.capture_active_days if profile is not None else default_capture_active_days()
    return [day for day in DAY_CODES if day in (days or [])]


def factory_capacity(project):
    profile = getattr(project.usuario, 'profile', None) if project.usuario_id else None
    capacidad = getattr(profile, 'capacidad_diaria_modulos', None)
    return capacidad or CAPACIDAD_POR_DEFECTO


def festivos_de(usuario_id):
    """Festivos que aplican a una ferralla: los de todas y los suyos.

    Sin ferralla (vista de todas), solo los de todas.
    """
    from .models import EventoCalendario

    filtro = Q(ferralla__isnull=True)
    if usuario_id is not None:
        filtro |= Q(ferralla_id=usuario_id)
    dias = set()
    rangos = EventoCalendario.objects.filter(
        filtro, tipo=EventoCalendario.Tipo.FESTIVO,
    ).values_list('inicio', 'fin')
    for inicio, fin in rangos:
        for offset in range(min((fin - inicio).days, 366) + 1):
            dias.add(inicio + timedelta(days=offset))
    return frozenset(dias)


class _DiasDeFabricacion:
    """Dias de fabricacion desde una fecha: el indice 0 es el primero."""

    def __init__(self, desde, days, festivos):
        self._activos = set(days)
        self._festivos = festivos
        self._siguiente = desde
        self._dias = []

    def __getitem__(self, indice):
        if not self._activos:
            return None
        limite = 4000
        while len(self._dias) <= indice and limite:
            dia = self._siguiente
            self._siguiente += timedelta(days=1)
            limite -= 1
            if DAY_CODES[dia.weekday()] in self._activos and dia not in self._festivos:
                self._dias.append(dia)
        return self._dias[indice] if indice < len(self._dias) else None


def _counts(project):
    total = getattr(project, '_modulos_count', None)
    done = getattr(project, '_modulos_completados', None)
    if total is None or done is None:
        counts = project.modulos.aggregate(
            total=Count('id'),
            done=Count('id', filter=Q(estado__in=['COMPLETADO', 'CERRADO'])),
        )
        total, done = counts['total'], counts['done']
    return total, done


def _base_demand(project, today, active_days, festivos):
    total, done = _counts(project)
    # Los modulos se suben por tandas: el ritmo diario se calcula sobre el
    # total previsto del proyecto cuando es mayor que lo ya subido.
    subidos = total
    previstos = project.modulos_previstos or 0
    total = max(total, previstos)
    remaining = max(0, total - done)
    date = project.fecha_montaje
    days = production_day_count(today, date, active_days, festivos) if date else None
    # Ritmo si el proyecto se fabricara solo; el plan de la ferralla manda.
    daily = math.ceil(remaining / days) if days else (0 if remaining == 0 else None)
    state = (
        'COMPLETADO' if remaining == 0 and total > 0 else
        'SIN_FERRALLA' if project.usuario_id is None else
        'SIN_FECHA' if date is None else
        'SIN_MODULOS' if total == 0 else
        'VENCIDO' if date <= today else
        'SIN_DIAS' if not days else 'PLANIFICADO'
    )
    return {
        'modulos_pendientes': remaining,
        'modulos_subidos': subidos,
        'modulos_previstos': project.modulos_previstos,
        'dias_disponibles': days,
        'modulos_por_dia': daily,
        'estado': state,
        'fecha_calculo': today.isoformat(),
        'dias_produccion': active_days,
        # Plan de la ferralla (se rellena en plan_ferralla).
        'ritmo_ferralla': None,
        'capacidad_ferralla': None,
        'aprietan_ferralla': 0,
        'fabricacion_inicio': None,
        'fabricacion_fin': None,
        'ultimo_dia': None,
        'margen_dias': None,
        'modulos_extra': 0,
        'modulos_hoy': 0,
        'modulos_semana': 0,
    }


def _serie(proyectos, filas, usuario_id):
    """Orden de fabricacion: la cola de las lineas y luego por montaje."""
    from .models import GrupoMesasProyecto

    posiciones = dict(
        GrupoMesasProyecto.objects.filter(proyecto__usuario_id=usuario_id)
        .values('proyecto_id').annotate(pos=Min('orden'))
        .values_list('proyecto_id', 'pos')
    )
    pendientes = [p for p in proyectos if filas[p.pk]['estado'] == 'PLANIFICADO']
    return sorted(pendientes, key=lambda p: (
        (0, posiciones[p.pk]) if p.pk in posiciones else (1, 0),
        p.fecha_montaje, p.pk,
    ))


def _modulos_entre(inicio, fin, pendientes, desde, hasta):
    """Modulos del proyecto que caen en los dias [desde, hasta) del plan."""
    if hasta <= desde:
        return 0.0
    if fin <= inicio + _EPS:
        # Todo en horas extra: cuenta el dia en que le toca empezar.
        return float(pendientes) if desde <= math.floor(inicio) < hasta else 0.0
    solape = max(0.0, min(fin, hasta) - max(inicio, desde))
    return pendientes * solape / (fin - inicio)


def plan_ferralla(usuario_id, today=None, override=None):
    """Plan de fabricacion de todos los proyectos de una ferralla.

    ``override``: proyecto con cambios aun no guardados que sustituye a su
    copia en la base de datos.
    """
    from .models import Proyecto

    today = today or timezone.localdate()
    proyectos = list(annotated_projects(Proyecto.objects.filter(usuario_id=usuario_id)))
    if override is not None:
        proyectos = [p for p in proyectos if p.pk != override.pk] + [override]
    if not proyectos:
        return {'ritmo': None, 'capacidad': None, 'aprietan': 0, 'proyectos': {}}

    referencia = proyectos[0]
    active_days = factory_production_days(referencia)
    capacidad = factory_capacity(referencia)
    festivos = festivos_de(usuario_id)
    filas = {p.pk: _base_demand(p, today, active_days, festivos) for p in proyectos}
    serie = _serie(proyectos, filas, usuario_id)

    pendientes = sum(filas[p.pk]['modulos_pendientes'] for p in serie)
    horizonte = max((filas[p.pk]['dias_disponibles'] for p in serie), default=0)
    ritmo = math.ceil(pendientes / horizonte) if horizonte else None

    dias = _DiasDeFabricacion(today, active_days, festivos)
    hoy_trabaja = dias[0] == today
    primero_semana = 1 if hoy_trabaja else 0
    dias_semana = production_day_count(
        today + timedelta(days=1), today + timedelta(days=7), active_days, festivos,
    )
    t = 0.0
    aprietan = 0
    for proyecto in serie:
        fila = filas[proyecto.pk]
        pend = fila['modulos_pendientes']
        limite = fila['dias_disponibles']
        inicio = t
        fin = t + pend / capacidad
        if fin <= limite + _EPS:
            extra = 0
            t = fin
        else:
            # No llega: lo que falta se cubre con horas extra y el siguiente
            # proyecto empieza a tiempo.
            extra = min(pend, math.ceil((fin - limite) * capacidad - _EPS))
            t = max(inicio, float(limite))
            aprietan += 1
        ultimo_dia_plan = max(math.ceil(t - _EPS) - 1, math.floor(inicio))
        hoy = _modulos_entre(inicio, t, pend, 0, 1) if hoy_trabaja else 0.0
        semana = _modulos_entre(inicio, t, pend, primero_semana, primero_semana + dias_semana)
        fila.update({
            'fabricacion_inicio': dias[math.floor(inicio + _EPS)].isoformat(),
            'fabricacion_fin': dias[ultimo_dia_plan].isoformat(),
            'ultimo_dia': dias[limite - 1].isoformat(),
            'margen_dias': 0 if extra else max(0, limite - math.ceil(t - _EPS)),
            'modulos_extra': extra,
            'modulos_hoy': min(pend, round(hoy)),
            'modulos_semana': min(pend - min(pend, round(hoy)), round(semana)),
        })

    for fila in filas.values():
        fila.update({
            'ritmo_ferralla': ritmo,
            'capacidad_ferralla': capacidad,
            'aprietan_ferralla': aprietan,
        })
    return {
        'ritmo': ritmo,
        'capacidad': capacidad,
        'aprietan': aprietan,
        'trabaja_hoy': hoy_trabaja,
        'proyectos': filas,
    }


def project_demand(project, today=None, plan=None):
    today = today or timezone.localdate()
    if project.usuario_id is None:
        return _base_demand(project, today, [], frozenset())
    if plan is None or project.pk not in plan['proyectos']:
        plan = plan_ferralla(project.usuario_id, today, override=project)
    return plan['proyectos'][project.pk]


def annotated_projects(queryset):
    return queryset.select_related('usuario__profile').annotate(
        _modulos_count=Count('modulos', distinct=True),
        _modulos_completados=Count('modulos', distinct=True, filter=Q(
            modulos__estado__in=['COMPLETADO', 'CERRADO'],
        )),
    )


def demand_summary(projects, today=None):
    today = today or timezone.localdate()
    planes = {}
    rows = []
    for p in projects:
        plan = None
        if p.usuario_id is not None:
            plan = planes.get(p.usuario_id)
            if plan is None:
                plan = planes[p.usuario_id] = plan_ferralla(p.usuario_id, today)
        rows.append({'id': p.id, 'nombre': p.nombre, 'fecha_montaje': p.fecha_montaje,
                     **project_demand(p, today, plan)})
    return {
        # Ritmo necesario de cada ferralla, no la suma de sus proyectos.
        'modulos_por_dia': sum(plan['ritmo'] or 0 for plan in planes.values()),
        'modulos_hoy': sum(plan['ritmo'] or 0 for plan in planes.values() if plan.get('trabaja_hoy')),
        'sin_planificar': sum(r['estado'] in ('SIN_FECHA', 'SIN_MODULOS', 'SIN_FERRALLA') for r in rows),
        'urgentes': sum(r['estado'] in ('VENCIDO', 'SIN_DIAS') for r in rows),
        'aprietan': sum(r['modulos_extra'] > 0 for r in rows),
        'proyectos': rows,
    }


def period_target_summary(projects, start, end):
    """Reconstruct the period's target using current deadlines and workdays.

    Each factory makes its projects one after another (same order as
    plan_ferralla) at the average pace needed from the period start to its
    last mounting date. The target of the selected projects is what that
    sequence makes inside the period.

    Completions on/after its first local midnight stay in the baseline so
    producing a module increases progress without decreasing the denominator.
    This is a recalculated target, not a stored historical planning snapshot.
    """
    from .models import Proyecto

    start_at = timezone.make_aware(datetime.combine(start, time.min))
    done_before = Q(modulos__completado_at__lt=start_at) | Q(
        modulos__estado__in=['COMPLETADO', 'CERRADO'],
        modulos__completado_at__isnull=True,
    )
    selected = set(projects.values_list('id', flat=True))
    unknown = projects.filter(usuario__isnull=True).count()
    factories = set(
        projects.filter(usuario__isnull=False).values_list('usuario_id', flat=True)
    )
    target = 0
    for factory_id in factories:
        factory_projects = list(
            Proyecto.objects.filter(usuario_id=factory_id)
            .select_related('usuario__profile')
            .annotate(
                _period_total=Count('modulos', distinct=True),
                _period_done_before=Count('modulos', distinct=True, filter=done_before),
            )
        )
        days = factory_production_days(factory_projects[0])
        festivos = festivos_de(factory_id)
        rows = {}
        for project in factory_projects:
            total = max(project._period_total, project.modulos_previstos or 0)
            if total == 0:
                unknown += project.pk in selected
                continue
            remaining = max(0, total - project._period_done_before)
            if not remaining:
                continue
            deadline = project.fecha_montaje
            available = production_day_count(start, deadline, days, festivos) if deadline else 0
            if not available:
                unknown += project.pk in selected
                continue
            rows[project.pk] = {
                'estado': 'PLANIFICADO', 'remaining': remaining,
                'available': available, 'deadline': deadline,
            }
        if not rows:
            continue
        sequence = _serie(
            [p for p in factory_projects if p.pk in rows], rows, factory_id,
        )
        pending = sum(rows[p.pk]['remaining'] for p in sequence)
        horizon = max(rows[p.pk]['available'] for p in sequence)
        last_deadline = max(rows[p.pk]['deadline'] for p in sequence)
        pace = math.ceil(pending / horizon)
        covered = production_day_count(
            start, min(end + timedelta(days=1), last_deadline), days, festivos,
        )
        made = min(pending, pace * covered)
        cumulative = 0
        for project in sequence:
            remaining = rows[project.pk]['remaining']
            if project.pk in selected:
                target += min(remaining, max(0, made - cumulative))
            cumulative += remaining
    return {
        'modulos_esperados': target if target or not unknown else None,
        'proyectos_sin_objetivo': unknown,
        'fecha_referencia': start.isoformat(),
    }
