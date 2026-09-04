"""Deadline demand using the assigned factory's configured working days."""
import math

from django.db.models import Count, Q
from django.utils import timezone

from .models import default_capture_active_days

DAY_CODES = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')


def production_day_count(start, end, days):
    """Count days in [start, end); mounting day is reserved for site assembly."""
    span = max(0, (end - start).days)
    weeks, extra = divmod(span, 7)
    active = set(days)
    return weeks * len(active) + sum(
        DAY_CODES[(start.weekday() + offset) % 7] in active
        for offset in range(extra)
    )


def factory_production_days(project):
    if project.usuario_id is None:
        return []
    profile = getattr(project.usuario, 'profile', None)
    # Match the factory configuration default without creating a profile on reads.
    days = profile.capture_active_days if profile is not None else default_capture_active_days()
    return [day for day in DAY_CODES if day in (days or [])]


def project_demand(project, today=None):
    today = today or timezone.localdate()
    total = getattr(project, '_modulos_count', None)
    done = getattr(project, '_modulos_completados', None)
    if total is None or done is None:
        counts = project.modulos.aggregate(
            total=Count('id'),
            done=Count('id', filter=Q(estado__in=['COMPLETADO', 'CERRADO'])),
        )
        total, done = counts['total'], counts['done']
    remaining = max(0, total - done)
    date = project.fecha_montaje
    active_days = factory_production_days(project)
    days = production_day_count(today, date, active_days) if date else None
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
        'dias_disponibles': days,
        'modulos_por_dia': daily,
        'estado': state,
        'fecha_calculo': today.isoformat(),
        'dias_produccion': active_days,
    }


def annotated_projects(queryset):
    return queryset.select_related('usuario__profile').annotate(
        _modulos_count=Count('modulos', distinct=True),
        _modulos_completados=Count('modulos', distinct=True, filter=Q(
            modulos__estado__in=['COMPLETADO', 'CERRADO'],
        )),
    )


def demand_summary(projects, today=None):
    today = today or timezone.localdate()
    rows = [{'id': p.id, 'nombre': p.nombre, 'fecha_montaje': p.fecha_montaje,
             **project_demand(p, today)} for p in projects]
    return {
        'modulos_por_dia': sum(r['modulos_por_dia'] or 0 for r in rows),
        'modulos_hoy': sum((r['modulos_por_dia'] or 0) for r in rows
                           if DAY_CODES[today.weekday()] in r['dias_produccion']),
        'sin_planificar': sum(r['estado'] in ('SIN_FECHA', 'SIN_MODULOS', 'SIN_FERRALLA') for r in rows),
        'urgentes': sum(r['estado'] in ('VENCIDO', 'SIN_DIAS') for r in rows),
        'proyectos': rows,
    }
