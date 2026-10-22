"""Trabajo y tiempo muerto deducidos de las senales del player.

La ferralla no informa de nada: lo unico que hay son las senales que deja
el player (cambio de diapositiva, foto, fase marcada hecha), por mesa. Una
mesa trabaja mientras sus senales van a menos de UMBRAL_EVENTOS; en los dias
en que esa mesa solo tiene fotos y hechos (antes de que existieran los
eventos, o con el registro apagado) se usa UMBRAL_FOTOS y ese trabajo va
marcado como estimado. La fabrica trabaja cuando alguna mesa trabaja (union):
la mesa parada mientras otra trabaja se ve en amarillo dentro de esa hora.

Tiempo muerto = horas de turno - trabajo dentro del turno, con la causa
deducida de las propias senales: sin registro (ningun dato en el turno),
empezo tarde, acabo pronto, paradas. Lo trabajado fuera de turno se suma
como trabajo, nunca se tira. Todo el tiempo muerto es de la ferralla.
"""
from bisect import bisect_right
from datetime import timedelta

from django.utils import timezone

CRITERIO = {'version': 'v1', 'umbral_min': 20, 'umbral_fotos_min': 45}
UMBRAL_EVENTOS = timedelta(minutes=CRITERIO['umbral_min'])
UMBRAL_FOTOS = timedelta(minutes=CRITERIO['umbral_fotos_min'])
# Dentro de una fase, un hueco entre el umbral y 90 minutos es "sin pulsar":
# el operario sigue con el panel sin pasar diapositiva. Cuenta como trabajo
# del modulo (si no, su tiempo dependeria del umbral); mas de 90 min es parado.
CRITERIO['sin_pulsar_min'] = 90
TOLERANCIA_SIN_PULSAR = timedelta(minutes=CRITERIO['sin_pulsar_min'])
# Una mesa con fases hechas y ninguna otra senal ese dia (camara y registro
# caidos) no puede salir a 0 h de trabajo: cada fase cuenta al menos esto.
PISO_POR_FASE = {'INFERIOR': timedelta(minutes=40), 'SUPERIOR': timedelta(minutes=25)}


def senales_por_mesa(mesa_ids, desde, hasta):
    """{mesa_id: [(momento, tipo)]} ordenadas; tipo = 'evento' | 'fin' | 'foto' | 'hecho:<fase>'.

    'evento' son las senales del operario en el player (PASO, PAUSA y el
    INICIO si siguio enseguida: si no, es el player, que avanzo solo al cerrar
    la fase anterior). El FIN lo pone el servidor al marcar hecho: es senal,
    pero no dice que esa mesa tenga registro de eventos.
    """
    from .models import EventoFabricacion, FotoFabricacion, MesaQueueItem, MesaQueueStatus

    senales = {mesa_id: [] for mesa_id in mesa_ids}
    por_item = {}
    for mesa_id, item_id, tipo, at in EventoFabricacion.objects.filter(
        mesa_id__in=mesa_ids, at__gte=desde, at__lt=hasta,
    ).order_by('at', 'id').values_list('mesa_id', 'item_id', 'tipo', 'at'):
        por_item.setdefault(item_id, []).append((mesa_id, tipo, at))
    for eventos in por_item.values():
        for indice, (mesa_id, tipo, at) in enumerate(eventos):
            if tipo == 'INICIO':
                siguiente = eventos[indice + 1][2] if indice + 1 < len(eventos) else None
                if siguiente is None or siguiente - at > UMBRAL_EVENTOS:
                    continue
            senales[mesa_id].append((at, 'fin' if tipo == 'FIN' else 'evento'))
    for mesa_id, at in FotoFabricacion.objects.filter(
        mesa_id__in=mesa_ids, capturada_at__gte=desde, capturada_at__lt=hasta,
    ).values_list('mesa_id', 'capturada_at'):
        senales[mesa_id].append((at, 'foto'))
    for mesa_id, at, fase in MesaQueueItem.objects.filter(
        mesa_id__in=mesa_ids, status=MesaQueueStatus.HECHO, done_at__gte=desde, done_at__lt=hasta,
    ).values_list('mesa_id', 'done_at', 'fase'):
        senales[mesa_id].append((at, 'hecho:' + fase))
    for lista in senales.values():
        lista.sort(key=lambda s: s[0])
    return senales


def sesiones(senales, umbral):
    """[(inicio, fin)] uniendo senales separadas menos de ``umbral``."""
    estimadas = umbral > UMBRAL_EVENTOS
    return [(a, b) for a, b, _e in sesiones_con_umbral([(m, estimadas) for m, _t in senales])]


def sesiones_con_umbral(senales):
    """[(inicio, fin, estimada)] de ``[(momento, estimada)]`` ordenados.

    Cada senal se une a la sesion anterior si llega a menos de su umbral:
    UMBRAL_FOTOS si es estimada (dia sin eventos de esa mesa), si no
    UMBRAL_EVENTOS. Una sesion es estimada si lo es alguna de sus senales.
    """
    resultado = []
    for momento, estimada in senales:
        umbral = UMBRAL_FOTOS if estimada else UMBRAL_EVENTOS
        if resultado and momento - resultado[-1][1] <= umbral:
            resultado[-1][1] = momento
            resultado[-1][2] = resultado[-1][2] or estimada
        else:
            resultado.append([momento, momento, estimada])
    return [(a, b, e) for a, b, e in resultado]


def union(intervalos):
    """Union de intervalos [(inicio, fin)] de cualquier numero de mesas."""
    return [(a, b) for a, b, _e in union_con_flag([(a, b, False) for a, b in intervalos])]


def union_con_flag(intervalos):
    """Union de [(inicio, fin, estimada)]; lo unido es estimado si lo era alguna parte."""
    resultado = []
    for inicio, fin, estimada in sorted(intervalos):
        if resultado and inicio <= resultado[-1][1]:
            resultado[-1][1] = max(resultado[-1][1], fin)
            resultado[-1][2] = resultado[-1][2] or estimada
        else:
            resultado.append([inicio, fin, estimada])
    return [(a, b, e) for a, b, e in resultado]


def solape(intervalos, desde, hasta):
    """Segundos de los intervalos que caen dentro de [desde, hasta)."""
    total = 0.0
    for inicio, fin in intervalos:
        lo, hi = max(inicio, desde), min(fin, hasta)
        if hi > lo:
            total += (hi - lo).total_seconds()
    return total


def huecos(intervalos, desde, hasta):
    """Tramos de [desde, hasta) que no cubren los intervalos."""
    resultado = []
    cursor = desde
    for inicio, fin in sorted(intervalos):
        if fin <= cursor or inicio >= hasta:
            continue
        if inicio > cursor:
            resultado.append((cursor, min(inicio, hasta)))
        cursor = max(cursor, min(fin, hasta))
    if cursor < hasta:
        resultado.append((cursor, hasta))
    return resultado


class _Tramos:
    """Intervalos ordenados y sin solapes, con busqueda rapida de los que tocan una
    ventana: un rango de meses tiene miles de sesiones y cientos de ventanas."""

    def __init__(self, intervalos=()):
        self.lista = list(intervalos)
        self.fines = [b for _a, b in self.lista]

    def tocan(self, desde, hasta):
        """Los intervalos con algo dentro de [desde, hasta) (o que acaban justo despues de desde)."""
        indice = bisect_right(self.fines, desde)
        resultado = []
        while indice < len(self.lista) and self.lista[indice][0] < hasta:
            resultado.append(self.lista[indice])
            indice += 1
        return resultado

    def solape(self, desde, hasta):
        return solape(self.tocan(desde, hasta), desde, hasta)


class Actividad:
    """Sesiones de trabajo de las mesas de una ferralla en una ventana."""

    def __init__(self, mesas, desde, hasta, tz=None):
        self.tz = tz or timezone.get_current_timezone()
        self.mesas = list(mesas)
        self.desde, self.hasta = desde, hasta
        self._dias = {}
        self.senales = senales_por_mesa([m.id for m in self.mesas], desde, hasta)
        self.sesiones_mesa = {}
        # Las sesiones que salen de fotos o fases hechas en dias sin eventos de esa mesa.
        self.estimadas_mesa = {}
        for mesa in self.mesas:
            lista = self.senales[mesa.id]
            dias_eventos = {self._dia(m) for m, tipo in lista if tipo == 'evento'}
            dias_con_senal = dias_eventos | {self._dia(m) for m, tipo in lista if tipo in ('foto', 'fin')}
            propias = sesiones_con_umbral([(m, self._dia(m) not in dias_eventos) for m, _t in lista])
            propias = self._con_piso(propias, lista, dias_con_senal)
            self.sesiones_mesa[mesa.id] = [(a, b) for a, b, _e in propias]
            self.estimadas_mesa[mesa.id] = [(a, b) for a, b, e in propias if e]
        self.fabrica = union([s for lista in self.sesiones_mesa.values() for s in lista])
        self._fabrica = _Tramos(self.fabrica)
        self._mesa = {mesa_id: _Tramos(lista) for mesa_id, lista in self.sesiones_mesa.items()}
        self._estimadas = {mesa_id: _Tramos(lista) for mesa_id, lista in self.estimadas_mesa.items()}

    def _dia(self, momento):
        # El cambio de hora va por horas enteras: el dia local de la hora en punto
        # (en UTC) es el del momento. Se calcula una vez por hora, no por senal.
        hora = momento.replace(minute=0, second=0, microsecond=0)
        dia = self._dias.get(hora)
        if dia is None:
            dia = self._dias[hora] = timezone.localtime(hora, self.tz).date()
        return dia

    def _con_piso(self, propias, lista, dias_con_senal):
        """Un dia sin camara ni registro, cada fase hecha cuenta al menos su piso
        (si ninguna sesion con duracion la cubre); va como estimado."""
        hechos = [
            (m, tipo.split(':')[1]) for m, tipo in lista
            if tipo.startswith('hecho:') and self._dia(m) not in dias_con_senal
        ]
        if not hechos:
            return propias
        resultado = list(propias)
        for momento, fase in hechos:
            inicio = momento - PISO_POR_FASE.get(fase, PISO_POR_FASE['INFERIOR'])
            if any(b > a and b > inicio and a < momento for a, b, _e in propias):
                continue
            resultado.append((inicio, momento, True))
        return union_con_flag(resultado)

    def estimado_en(self, ventanas):
        """True si parte del trabajo en esas ventanas es estimado (fotos o hechos sin eventos)."""
        return any(
            estimadas.solape(a, b) > 0
            for estimadas in self._estimadas.values() for a, b in ventanas
        )

    def desglose(self, ventanas):
        """Trabajo y muerto de la fabrica en unas ventanas de turno [(inicio, fin)].

        Devuelve segundos: trabajo (dentro de las ventanas), muerto y sus
        causas (sin_registro, empezo_tarde, acabo_pronto, paradas), y
        abre/cierra (primera y ultima senal dentro de las ventanas).
        """
        total = {'turno': 0.0, 'trabajo': 0.0, 'muerto': 0.0, 'sin_registro': 0.0,
                 'empezo_tarde': 0.0, 'acabo_pronto': 0.0, 'paradas': 0.0}
        abre = cierra = None
        for inicio, fin in ventanas:
            duracion = (fin - inicio).total_seconds()
            total['turno'] += duracion
            tocan = self._fabrica.tocan(inicio, fin)
            trabajado = solape(tocan, inicio, fin)
            total['trabajo'] += trabajado
            muerto = duracion - trabajado
            total['muerto'] += muerto
            # Sesiones (aunque sean una senal suelta, o el piso de una fase hecha
            # al acabar la ventana) que tocan la ventana; sin ninguna, sin registro.
            dentro = [(max(a, inicio), min(b, fin)) for a, b in tocan]
            if not dentro:
                total['sin_registro'] += muerto
                continue
            primera, ultima = min(a for a, _b in dentro), max(b for _a, b in dentro)
            abre = primera if abre is None or primera < abre else abre
            cierra = ultima if cierra is None or ultima > cierra else cierra
            tarde = (primera - inicio).total_seconds()
            pronto = (fin - ultima).total_seconds()
            total['empezo_tarde'] += tarde
            total['acabo_pronto'] += pronto
            total['paradas'] += max(0.0, muerto - tarde - pronto)
        return {**total, 'abre': abre, 'cierra': cierra}

    def trabajo_fuera(self, ventanas, desde, hasta):
        """Segundos trabajados en [desde, hasta) fuera de las ventanas de turno."""
        return sum(self._fabrica.solape(a, b) for a, b in huecos(ventanas, desde, hasta))

    def mesa_desglose(self, mesa_id, ventanas):
        """Trabajo, muerto y paradas de una mesa en unas ventanas de turno."""
        propias = self._mesa.get(mesa_id) or _Tramos()
        estimadas = self._estimadas.get(mesa_id) or _Tramos()
        turno = sum((b - a).total_seconds() for a, b in ventanas)
        trabajo = 0.0
        paradas = 0
        for inicio, fin in ventanas:
            dentro = propias.tocan(inicio, fin)
            trabajo += solape(dentro, inicio, fin)
            if len(dentro) > 1:
                paradas += len(dentro) - 1
        return {
            'turno': turno, 'trabajo': trabajo, 'muerto': max(0.0, turno - trabajo), 'paradas': paradas,
            'estimado': any(estimadas.solape(a, b) > 0 for a, b in ventanas),
        }


def horas(segundos):
    return round(segundos / 3600.0, 2)
