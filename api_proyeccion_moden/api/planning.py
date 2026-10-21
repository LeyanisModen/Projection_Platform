"""Plan de fabricacion de cada ferralla: lo que exigen los montajes.

El objetivo no sale de lo que la ferralla esta haciendo ni de lo que Moden
cree que puede hacer, sino de los forjados que vienen. Los modulos tienen
que estar hechos el dia laborable anterior al montaje y cuentan los dias
laborables (lunes a viernes) menos los festivos del calendario; si para
llegar hay que doblar turno, eso lo decide la ferralla.

- Ritmo necesario por tramos: ordenados los forjados por montaje, el que
  mas aprieta (modulos acumulados hasta el entre los dias laborables hasta
  el) fija el ritmo hasta esa fecha; con los que quedan se repite desde ahi.
  Es el ritmo minimo que llega a todos los montajes, y siempre va bajando.
- Con ese ritmo se calcula cuando se fabrica cada forjado (uno detras de
  otro, por montaje) y la holgura que le queda hasta su ultimo dia.
- El objetivo de un periodo es la suma del ritmo de cada dia laborable.
"""
from datetime import datetime, time, timedelta

from django.db.models import Count, Q
from django.utils import timezone

DAY_CODES = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
# Dias de fabricacion: de lunes a viernes. Un turno de noche o un domingo
# son cosa de la ferralla; no cambian el objetivo.
DIAS_LABORABLES = DAY_CODES[:5]
_EPS = 1e-9


def production_day_count(start, end, days=DIAS_LABORABLES, festivos=frozenset()):
    """Working days in [start, end); the mounting day is for site assembly."""
    pesos = {day: n for day, n in days.items() if n} if isinstance(days, dict) else {day: 1 for day in days}
    span = max(0, (end - start).days)
    weeks, extra = divmod(span, 7)
    count = weeks * sum(pesos.values()) + sum(
        pesos.get(DAY_CODES[(start.weekday() + offset) % 7], 0)
        for offset in range(extra)
    )
    if festivos:
        count -= sum(
            pesos.get(DAY_CODES[dia.weekday()], 0) for dia in festivos
            if start <= dia < end
        )
    return count


def factory_production_days(project):
    """Dias en que se fabrica: de lunes a viernes (sin ferralla, ninguno)."""
    return [] if project.usuario_id is None else list(DIAS_LABORABLES)


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


def festivos_oficina():
    """Los festivos de todas las ferrallas tampoco los trabaja la oficina."""
    return festivos_de(None)


def es_laborable_oficina(dia, festivos):
    return dia.weekday() < 5 and dia not in festivos


def laborable_oficina_anterior(dia, festivos=None):
    """La oficina no trabaja fines de semana ni festivos: el dia laborable anterior."""
    festivos = festivos_oficina() if festivos is None else festivos
    while not es_laborable_oficina(dia, festivos):
        dia -= timedelta(days=1)
    return dia


def es_laborable(dia, festivos):
    return DAY_CODES[dia.weekday()] in DIAS_LABORABLES and dia not in festivos


def dias_laborables(desde, hasta, festivos):
    """Dias laborables de [desde, hasta)."""
    dia = desde
    while dia < hasta:
        if es_laborable(dia, festivos):
            yield dia
        dia += timedelta(days=1)


def tramos_de_ritmo(forjados, desde, festivos):
    """Ritmo necesario por tramos.

    ``forjados``: [(fecha_montaje, pendientes, clave)], solo con montaje
    posterior a ``desde`` y algun dia laborable por delante. Devuelve
    [{desde, hasta, dias, modulos, ritmo, claves}], de mayor a menor ritmo.
    """
    pendientes = sorted(forjados, key=lambda f: f[0])
    tramos = []
    inicio = desde
    while pendientes:
        mejor = None
        acumulado = 0
        for indice, (montaje, modulos, _clave) in enumerate(pendientes):
            acumulado += modulos
            dias = production_day_count(inicio, montaje, DIAS_LABORABLES, festivos)
            ritmo = acumulado / dias if dias else float('inf')
            # Con el mismo ritmo manda el montaje mas lejano: los de antes
            # llevan holgura.
            if mejor is None or ritmo >= mejor['ritmo'] - _EPS:
                mejor = {'indice': indice, 'ritmo': ritmo, 'modulos': acumulado, 'dias': dias, 'hasta': montaje}
        tramo = pendientes[:mejor['indice'] + 1]
        tramos.append({
            'desde': inicio,
            'hasta': mejor['hasta'],
            'dias': mejor['dias'],
            'modulos': mejor['modulos'],
            'ritmo': mejor['ritmo'],
            'claves': [clave for _m, _p, clave in tramo],
        })
        pendientes = pendientes[mejor['indice'] + 1:]
        inicio = mejor['hasta']
    return tramos


class _Produccion:
    """Modulos acumulados que exige el plan, dia laborable a dia laborable."""

    def __init__(self, tramos, festivos):
        self.dias = []       # dia laborable de cada posicion
        self.acumulado = []  # modulos exigidos hasta el final de ese dia
        self.ritmos = []
        total = 0.0
        for tramo in tramos:
            for dia in dias_laborables(tramo['desde'], tramo['hasta'], festivos):
                total += tramo['ritmo']
                self.dias.append(dia)
                self.acumulado.append(total)
                self.ritmos.append(tramo['ritmo'])

    def posicion(self, dia):
        for indice, candidato in enumerate(self.dias):
            if candidato >= dia:
                return indice
        return len(self.dias)

    def ritmo_de(self, dia):
        for candidato, ritmo in zip(self.dias, self.ritmos):
            if candidato == dia:
                return ritmo
        return 0.0

    def dia_en_que_llega(self, modulos):
        """Primer dia laborable en que el acumulado cubre ``modulos``."""
        for dia, acumulado in zip(self.dias, self.acumulado):
            if acumulado >= modulos - _EPS:
                return dia
        return self.dias[-1] if self.dias else None

    def dia_en_que_supera(self, modulos):
        """Primer dia laborable en que se fabrica algo por encima de ``modulos``."""
        for dia, acumulado in zip(self.dias, self.acumulado):
            if acumulado > modulos + _EPS:
                return dia
        return self.dias[-1] if self.dias else None

    def modulos_entre(self, posiciones, desde_modulo, hasta_modulo):
        """Parte de [desde_modulo, hasta_modulo) que cae en esas posiciones."""
        total = 0.0
        for posicion in posiciones:
            if posicion < 0 or posicion >= len(self.dias):
                continue
            bajo = self.acumulado[posicion - 1] if posicion else 0.0
            alto = self.acumulado[posicion]
            total += max(0.0, min(alto, hasta_modulo) - max(bajo, desde_modulo))
        return total


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


def _base_demand(project, today, festivos):
    total, done = _counts(project)
    # Los modulos se suben por tandas: el ritmo se calcula sobre el total
    # previsto del proyecto cuando es mayor que lo ya subido.
    subidos = total
    previstos = project.modulos_previstos or 0
    total = max(total, previstos)
    remaining = max(0, total - done)
    date = project.fecha_montaje
    # Sin ferralla no hay dias de fabricacion.
    days = production_day_count(today, date, DIAS_LABORABLES, festivos) if date and project.usuario_id is not None else None
    # Ritmo si el forjado se fabricara solo; el plan de la ferralla manda.
    daily = round(remaining / days, 1) if days else (0 if remaining == 0 else None)
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
        'dias_produccion': list(DIAS_LABORABLES) if project.usuario_id is not None else [],
        # Plan de la ferralla (se rellena en plan_ferralla).
        'ritmo_ferralla': None,
        'tramo': None,
        'ritmo_tramo': None,
        'tramo_hasta': None,
        'cierra_tramo': False,
        'fabricacion_inicio': None,
        'fabricacion_fin': None,
        'ultimo_dia': None,
        'margen_dias': None,
        'modulos_hoy': 0,
        'modulos_semana': 0,
        # Lo mismo para toda la ferralla (la lista de proyectos lo ensena una vez).
        'tramos_ferralla': [],
        'manda_nombre': None,
        'cola_fuera_de_orden': [],
    }


def _serie(proyectos, filas):
    """Orden de fabricacion: por montaje y, el mismo dia, el forjado de abajo."""
    pendientes = [p for p in proyectos if filas[p.pk]['estado'] == 'PLANIFICADO']
    return sorted(pendientes, key=lambda p: (p.fecha_montaje, p.orden_planta, p.pk))


def _cola_fuera_de_orden(serie, usuario_id):
    """Forjados en la cola de una linea por delante de otro de esa misma
    cola que monta antes (cada linea lleva su propio orden)."""
    from .models import GrupoMesasProyecto

    por_pk = {p.pk: p for p in serie}
    colas = {}
    for grupo_id, proyecto_id in (
        GrupoMesasProyecto.objects.filter(proyecto__usuario_id=usuario_id)
        .order_by('grupo_mesas_id', 'orden', 'id')
        .values_list('grupo_mesas_id', 'proyecto_id')
    ):
        if proyecto_id in por_pk:
            colas.setdefault(grupo_id, []).append(por_pk[proyecto_id])
    fuera = set()
    for cola in colas.values():
        for indice, proyecto in enumerate(cola):
            if any(otro.fecha_montaje < proyecto.fecha_montaje for otro in cola[indice + 1:]):
                fuera.add(proyecto.nombre)
    return sorted(fuera)


def _redondeo(valor):
    return round(valor + _EPS, 1)


def plan_ferralla(usuario_id, today=None, override=None):
    """Plan de fabricacion de todos los proyectos de una ferralla.

    ``override``: proyecto con cambios aun no guardados que sustituye a su
    copia en la base de datos.
    """
    from .models import Proyecto

    today = today or timezone.localdate()
    # Los archivados ya no se fabrican: fuera del plan.
    proyectos = list(annotated_projects(
        Proyecto.objects.filter(usuario_id=usuario_id, archivado_at__isnull=True)
    ))
    if override is not None:
        proyectos = [p for p in proyectos if p.pk != override.pk]
        if not override.archivado_at:
            proyectos.append(override)
    if not proyectos:
        return {'ritmo': None, 'tramos': [], 'manda': None, 'objetivo_hoy': 0, 'objetivo_semana': 0,
                'cola_fuera_de_orden': [], 'trabaja_hoy': False, 'proyectos': {}}

    festivos = festivos_de(usuario_id)
    filas = {p.pk: _base_demand(p, today, festivos) for p in proyectos}
    serie = _serie(proyectos, filas)
    tramos = tramos_de_ritmo(
        [(p.fecha_montaje, filas[p.pk]['modulos_pendientes'], p.pk) for p in serie], today, festivos,
    )
    produccion = _Produccion(tramos, festivos)
    hoy_trabaja = es_laborable(today, festivos)
    hoy = [pos for pos, dia in enumerate(produccion.dias) if dia == today]
    semana = [pos for pos, dia in enumerate(produccion.dias) if today < dia <= today + timedelta(days=7)]
    montajes = {p.pk: p.fecha_montaje for p in serie}

    acumulado = 0.0
    for indice, tramo in enumerate(tramos):
        for clave in tramo['claves']:
            fila = filas[clave]
            pendientes = fila['modulos_pendientes']
            inicio_modulo, fin_modulo = acumulado, acumulado + pendientes
            # Dias laborables hasta el montaje: el ultimo es el plazo real.
            propios = list(dias_laborables(today, montajes[clave], festivos))
            fin = produccion.dia_en_que_llega(fin_modulo) or today
            # Hoy y la semana no pueden sumar mas que lo pendiente (medios modulos).
            hoy_modulos = min(pendientes, round(produccion.modulos_entre(hoy, inicio_modulo, fin_modulo)))
            fila.update({
                'tramo': indice,
                'ritmo_tramo': _redondeo(tramo['ritmo']),
                'tramo_hasta': tramo['hasta'].isoformat(),
                'cierra_tramo': clave == tramo['claves'][-1],
                'fabricacion_inicio': (produccion.dia_en_que_supera(inicio_modulo) or today).isoformat(),
                'fabricacion_fin': fin.isoformat(),
                'ultimo_dia': propios[-1].isoformat() if propios else None,
                # Holgura: dias laborables entre terminarlo y su plazo.
                'margen_dias': max(0, len(propios) - 1 - produccion.posicion(fin)) if propios else 0,
                'modulos_hoy': hoy_modulos,
                'modulos_semana': min(pendientes - hoy_modulos, round(produccion.modulos_entre(semana, inicio_modulo, fin_modulo))),
            })
            acumulado = fin_modulo

    ritmo = _redondeo(tramos[0]['ritmo']) if tramos else None
    manda = tramos[0]['claves'][-1] if tramos else None
    manda_nombre = next((p.nombre for p in serie if p.pk == manda), None)
    cola_fuera_de_orden = _cola_fuera_de_orden(serie, usuario_id)
    resumen_tramos = [{
        'desde': t['desde'].isoformat(), 'hasta': t['hasta'].isoformat(), 'dias': t['dias'],
        'modulos': t['modulos'], 'ritmo': _redondeo(t['ritmo']), 'proyectos': t['claves'],
    } for t in tramos]
    for fila in filas.values():
        fila.update({
            'ritmo_ferralla': ritmo,
            'tramos_ferralla': [{'hasta': t['hasta'], 'ritmo': t['ritmo']} for t in resumen_tramos],
            'manda_nombre': manda_nombre,
            'cola_fuera_de_orden': cola_fuera_de_orden,
        })
    return {
        'ritmo': ritmo,
        'tramos': resumen_tramos,
        'manda': manda,
        'manda_nombre': manda_nombre,
        'objetivo_hoy': _redondeo(produccion.ritmo_de(today)) if hoy_trabaja else 0,
        'objetivo_semana': _redondeo(sum(produccion.ritmos[pos] for pos in semana)),
        'cola_fuera_de_orden': cola_fuera_de_orden,
        'trabaja_hoy': hoy_trabaja,
        'proyectos': filas,
    }


def project_demand(project, today=None, plan=None):
    today = today or timezone.localdate()
    if getattr(project, 'archivado_at', None):
        demanda = _base_demand(project, today, frozenset())
        demanda['estado'] = 'ARCHIVADO'
        return demanda
    if project.usuario_id is None:
        return _base_demand(project, today, frozenset())
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
        # Ritmo necesario de cada ferralla (el tramo en curso), no la suma de sus proyectos.
        'modulos_por_dia': _redondeo(sum(plan['ritmo'] or 0 for plan in planes.values())),
        'modulos_hoy': _redondeo(sum(plan['objetivo_hoy'] for plan in planes.values())),
        'sin_planificar': sum(r['estado'] in ('SIN_FECHA', 'SIN_MODULOS', 'SIN_FERRALLA') for r in rows),
        'urgentes': sum(r['estado'] in ('VENCIDO', 'SIN_DIAS') for r in rows),
        'cola_fuera_de_orden': sorted(set(n for plan in planes.values() for n in plan['cola_fuera_de_orden'])),
        'proyectos': rows,
    }


def period_target_summary(projects, start, end):
    """Objetivo de un periodo con los montajes de hoy y los pendientes a su inicio.

    Desde el primer dia del periodo, los tramos de ritmo necesario de cada
    ferralla; el objetivo de cada dia laborable es el ritmo de su tramo y el
    del periodo, la suma. El de los proyectos elegidos es lo que la serie
    (por montaje) les fabrica dentro del periodo.

    Lo terminado desde la medianoche del inicio sigue contando como
    pendiente, asi fabricar no baja el objetivo. Es un objetivo recalculado,
    no una foto guardada del plan.
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
    target = 0.0
    por_dia = {}
    for factory_id in factories:
        factory_projects = list(
            Proyecto.objects.filter(usuario_id=factory_id, archivado_at__isnull=True)
            .annotate(
                _period_total=Count('modulos', distinct=True),
                _period_done_before=Count('modulos', distinct=True, filter=done_before),
            )
        )
        festivos = festivos_de(factory_id)
        forjados = []
        for project in factory_projects:
            total = max(project._period_total, project.modulos_previstos or 0)
            if total == 0:
                unknown += project.pk in selected
                continue
            remaining = max(0, total - project._period_done_before)
            if not remaining:
                continue
            deadline = project.fecha_montaje
            if not deadline or not production_day_count(start, deadline, DIAS_LABORABLES, festivos):
                unknown += project.pk in selected
                continue
            forjados.append((deadline, remaining, project.pk, project.orden_planta))
        if not forjados:
            continue
        forjados.sort(key=lambda f: (f[0], f[3], f[2]))
        tramos = tramos_de_ritmo([(f[0], f[1], f[2]) for f in forjados], start, festivos)
        produccion = _Produccion(tramos, festivos)
        posiciones = [pos for pos, dia in enumerate(produccion.dias) if start <= dia <= end]
        for pos in posiciones:
            dia = produccion.dias[pos].isoformat()
            por_dia[dia] = por_dia.get(dia, 0.0) + produccion.ritmos[pos]
        acumulado = 0.0
        for deadline, remaining, pk, _orden in forjados:
            if pk in selected:
                target += produccion.modulos_entre(posiciones, acumulado, acumulado + remaining)
            acumulado += remaining
    return {
        'modulos_esperados': int(round(target + _EPS)) if target or not unknown else None,
        'proyectos_sin_objetivo': unknown,
        'fecha_referencia': start.isoformat(),
        'por_dia': {dia: _redondeo(valor) for dia, valor in sorted(por_dia.items())},
    }
