"""Acopio: lo fabricado espera en el patio de la ferralla, en bastidores,
hasta que sale en camion hacia la obra.

El plan de ``api.planning`` solo tenia un limite por abajo (cada forjado
hecho antes de su montaje), asi que con holgura adelantaba fabricacion como
si el patio no tuviera fin. Con la capacidad de acopio de la ferralla
(``AcopioCapacidad``: bastidores que caben a partir de una fecha) tiene
tambien un limite por arriba: lo fabricado y aun no enviado no puede pasar de
lo que cabe. El plan es la cuerda tensa entre los dos: el ritmo mas suave que
llega a todos los montajes sin llenar el patio de mas. Si el patio esta lleno,
frena; despues aprieta. Si no hay forma de llegar sin pasarse (un forjado no
cabe entero antes de salir), se pasa lo justo y lo apunta como exceso.

Por ahora todo un forjado sale el dia laborable anterior a su montaje (el
mismo plazo que ya tenia la fabricacion), en camiones de 4 bastidores. Ese
dia tiene que estar entero en el patio: el hueco queda libre al siguiente.
Un bastidor de un forjado ocupa lo que sus modulos: sus modulos subidos entre
sus bastidores; sin bastidores, la media de la ferralla.
"""
from datetime import timedelta
from math import ceil, inf

from django.db.models import Count

BASTIDORES_POR_CAMION = 4
# Sin ningun forjado con bastidores en la ferralla (no deberia pasar).
MODULOS_POR_BASTIDOR = 6.0
_EPS = 1e-6


def capacidades_de(usuario_id):
    """[(desde, bastidores)] por fecha; vacio: el acopio no limita."""
    from .models import AcopioCapacidad

    return list(
        AcopioCapacidad.objects.filter(usuario_id=usuario_id)
        .order_by('desde').values_list('desde', 'bastidores')
    )


def capacidad_el(dia, capacidades):
    """Lo que cabe ese dia: la ultima que ya vale; antes de la primera, la
    primera. Sin capacidades, None: no hay limite."""
    if not capacidades:
        return None
    cabe = capacidades[0][1]
    for desde, bastidores in capacidades:
        if desde <= dia:
            cabe = bastidores
    return cabe


def hay_camiones_guardados(pks):
    from .models import Camion

    return Camion.objects.filter(proyecto_id__in=pks).exists()


def camiones_por_defecto(bastidores, salida):
    """[(fecha, bastidores)]: de 4 en 4 el dia de salida; el ultimo, lo que quede."""
    if salida is None or bastidores <= 0:
        return []
    lista, quedan = [], bastidores
    while quedan > 0:
        lista.append((salida, min(BASTIDORES_POR_CAMION, quedan)))
        quedan -= BASTIDORES_POR_CAMION
    return lista


def camiones_completos(guardados, bastidores, salida):
    """Los guardados, en orden, hasta llevar todo el forjado; lo que no
    llevan sale por defecto el dia de salida. [(fecha, bastidores)]."""
    lista, llevan = [], 0
    for fecha, cuantos in guardados:
        if llevan >= bastidores:
            break
        cuantos = min(cuantos, bastidores - llevan)
        lista.append((fecha, cuantos))
        llevan += cuantos
    return lista + camiones_por_defecto(bastidores - llevan, salida)


def bastidores_del_forjado(total_modulos, bastidores_calculados, por_bastidor):
    """Los calculados; si faltan modulos por subir (o no hay), los que saldran a su media."""
    estimados = ceil(total_modulos / por_bastidor - _EPS) if total_modulos else 0
    return max(bastidores_calculados or 0, estimados)


def dia_de_salida(montaje, festivos):
    """Dia laborable anterior al montaje: el ultimo de fabricacion, cuando sale."""
    from .planning import es_laborable

    if montaje is None:
        return None
    dia = montaje - timedelta(days=1)
    for _ in range(60):
        if es_laborable(dia, festivos):
            return dia
        dia -= timedelta(days=1)
    return montaje - timedelta(days=1)


def media_por_bastidor(subidos, bastidores):
    """Modulos por bastidor de la ferralla: los subidos entre sus bastidores."""
    con = [pk for pk in subidos if bastidores.get(pk) and subidos.get(pk)]
    if not con:
        return MODULOS_POR_BASTIDOR
    return sum(subidos[pk] for pk in con) / sum(bastidores[pk] for pk in con)


def bastidores_calculados(pks):
    """{pk: bastidores} (las raices: las partes solo existen para fabricar)."""
    from .models import GrupoBastidor

    return dict(
        GrupoBastidor.objects.filter(proyecto_id__in=pks, dividido_de__isnull=True)
        .values('proyecto_id').annotate(n=Count('id')).values_list('proyecto_id', 'n')
    )


def camiones_guardados(pks):
    """{pk: [(fecha, bastidores)]} de los forjados con camiones movidos."""
    from .models import Camion

    guardados = {}
    for pk, fecha, cuantos in (
        Camion.objects.filter(proyecto_id__in=pks).order_by('proyecto_id', 'orden')
        .values_list('proyecto_id', 'fecha', 'bastidores')
    ):
        guardados.setdefault(pk, []).append((fecha, cuantos))
    return guardados


def almacen(proyectos, subidos, hechos, totales, festivos, desde):
    """Lo que cada forjado vivo ocupa y cuando sale cada camion.

    ``subidos``/``hechos``/``totales``: modulos por pk (los subidos, los
    hechos al empezar y los que tendra, previstos incluidos). Un forjado ya
    montado salio entero el dia que se monto. {pk: {'salida', 'por_bastidor',
    'hechos', 'total', 'bastidores', 'camiones'}}.
    """
    from .planning import fecha_de_montaje

    pks = [p.pk for p in proyectos]
    calculados = bastidores_calculados(pks)
    media = media_por_bastidor(subidos, calculados)
    guardados = camiones_guardados(pks)
    info = {}
    for proyecto in proyectos:
        pk = proyecto.pk
        tiene = bool(calculados.get(pk) and subidos.get(pk))
        por_bastidor = max(subidos[pk] / calculados[pk] if tiene else media, _EPS)
        total = totales.get(pk, 0)
        bastidores = bastidores_del_forjado(total, calculados.get(pk), por_bastidor)
        salida = dia_de_salida(fecha_de_montaje(proyecto), festivos)
        camiones = camiones_completos(guardados.get(pk, []), bastidores, salida)
        montado = getattr(proyecto, 'montaje_realizado_at', None)
        if montado is not None and montado.date() < desde:
            # Ya montado: salio del patio aunque sus camiones digan otra cosa.
            salida = montado.date()
            camiones = [(salida, bastidores)]
        info[pk] = {
            'salida': salida,
            'por_bastidor': por_bastidor,
            'hechos': hechos.get(pk, 0),
            'total': total,
            'bastidores': bastidores,
            'camiones': camiones,
        }
    return info


def _por_camion(datos):
    """[(fecha, modulos por fabricar que tienen que estar, bastidores que libera)]
    de cada camion: lleva los bastidores en orden y los primeros ya estan hechos."""
    total, hechos, por_bastidor = datos['total'], datos['hechos'], datos['por_bastidor']
    filas, llevan, antes = [], 0, 0.0
    for fecha, cuantos in datos['camiones']:
        llevan += cuantos
        hasta = min(total, llevan * por_bastidor)
        filas.append((fecha, max(0.0, hasta - hechos), (hasta - antes) / por_bastidor))
        antes = hasta
    return filas


def primera_salida(datos):
    """El primer camion que se lleva algo aun por fabricar (orden de la serie)."""
    return next((fecha for fecha, falta, _b in _por_camion(datos) if falta > _EPS), None)


def cuerda(minimos, maximos):
    """Fabricacion acumulada mas suave entre dos curvas.

    ``minimos[k]``/``maximos[k]``: lo minimo y lo maximo fabricado al acabar el
    dia k (crecientes y ``maximos >= minimos``). Devuelve el acumulado de cada
    dia empezando de 0: la cuerda tensa entre las dos, que hace el ritmo mas
    alto lo mas bajo posible. Sin techo es el plan por tramos de siempre: con
    el mismo ritmo manda el plazo mas lejano.
    """
    n = len(minimos)
    hecho = [0.0] * n
    x0, v0 = 0, 0.0
    while x0 < n:
        bajo, alto = -inf, inf
        x_bajo = x_alto = None
        codo = None
        for x in range(x0 + 1, n + 1):
            d = x - x0
            s_bajo = (minimos[x - 1] - v0) / d
            s_alto = (maximos[x - 1] - v0) / d
            if s_bajo > alto + _EPS:
                # El suelo se mete por encima del techo: la cuerda toca el techo.
                codo = (x_alto, alto)
                break
            if s_alto < bajo - _EPS:
                # El techo baja del suelo: la cuerda toca el suelo.
                codo = (x_bajo, bajo)
                break
            if s_bajo >= bajo - _EPS:
                bajo, x_bajo = max(bajo, s_bajo), x
            if s_alto <= alto + _EPS:
                alto, x_alto = min(alto, s_alto), x
        if codo is None:
            # Hasta el final: el ritmo mas bajo que llega a lo que queda.
            codo = (x_bajo, bajo) if bajo > _EPS else (n, 0.0)
        x1, pendiente = codo
        for x in range(x0 + 1, x1 + 1):
            hecho[x - 1] = v0 + pendiente * (x - x0)
        v0 += pendiente * (x1 - x0)
        x0 = x1
    return hecho


class _Serie:
    """Bastidores que ocupan los primeros modulos de la serie, y al reves."""

    def __init__(self, tramos):
        self.tramos = tramos  # [(modulos, por_bastidor)]

    def bastidores(self, modulos):
        total = 0.0
        for cuantos, por_bastidor in self.tramos:
            parte = min(modulos, cuantos)
            total += parte / por_bastidor
            modulos -= parte
            if modulos <= 0:
                break
        return total

    def modulos(self, bastidores):
        total = 0.0
        for cuantos, por_bastidor in self.tramos:
            caben = bastidores * por_bastidor
            if caben < cuantos:
                return total + max(0.0, caben)
            total += cuantos
            bastidores -= cuantos / por_bastidor
        return total


class Acopio:
    """Lo que hay en el patio cada dia con el plan, y donde no cabe."""

    def __init__(self, capacidades, inicial, salidas, serie, dias, hecho, excesos):
        self.capacidades = capacidades
        self.inicial = inicial
        self.salidas = salidas      # {dia: bastidores que salen}
        self.serie = serie
        self.dias = dias
        self.hecho = hecho
        self.excesos = excesos      # [(dia, bastidores de mas)]

    def ocupacion(self, dia):
        """(bastidores en el patio al acabar el dia, antes de cargar los
        camiones de ese dia: todo lo que sale tiene que estar; los que caben)."""
        fabricado = 0.0
        for candidato, acumulado in zip(self.dias, self.hecho):
            if candidato > dia:
                break
            fabricado = acumulado
        salido = sum(b for salida, b in self.salidas.items() if salida < dia)
        en_patio = self.inicial + self.serie.bastidores(fabricado) - salido
        return max(0.0, en_patio), capacidad_el(dia, self.capacidades)

    def resumen(self):
        return {
            'capacidades': [{'desde': d.isoformat(), 'bastidores': b} for d, b in self.capacidades],
            'excesos': [{'fecha': d.isoformat(), 'bastidores': round(b, 1)} for d, b in self.excesos],
        }


def plan_con_acopio(serie, info, desde, festivos, capacidades):
    """Tramos del plan con el limite del patio y los camiones de cada forjado.

    ``serie``: [(montaje, pendientes, clave)] en orden de fabricacion (como
    ``tramos_de_ritmo``); ``info``: ``almacen()`` de los forjados vivos;
    ``capacidades`` vacio: sin limite (solo cuentan los camiones movidos).
    Cada camion se lleva sus bastidores (en orden) y tienen que estar hechos
    ese dia; deja el hueco al siguiente. Como se fabrica un forjado detras de
    otro, para que salga un camion tienen que estar los forjados de antes.
    Devuelve (tramos, Acopio); cada tramo como los de ``tramos_de_ritmo`` mas
    ``motivo``: 'montaje' si acaba porque llega a un plazo, 'acopio' si
    porque el patio se llena.
    """
    from .planning import dias_laborables, es_laborable

    salidas, inicial, camiones = {}, 0.0, {}
    for clave, datos in info.items():
        camiones[clave] = _por_camion(datos)
        salido_antes = 0.0
        for fecha, _falta, libera in camiones[clave]:
            if fecha < desde:
                salido_antes += libera
            else:
                salidas[fecha] = salidas.get(fecha, 0.0) + libera
        inicial += max(0.0, datos['hechos'] / datos['por_bastidor'] - salido_antes)
    tramos_serie = _Serie([(pendientes, info[clave]['por_bastidor']) for _m, pendientes, clave in serie])
    vacio = Acopio(capacidades, inicial, salidas, tramos_serie, [], [], [])
    plazos = [fecha for _m, _p, clave in serie for fecha, falta, _l in camiones[clave] if falta > _EPS]
    if not plazos:
        return [], vacio
    dias = list(dias_laborables(desde, max(max(plazos), desde) + timedelta(days=1), festivos))
    if not dias:
        return [], vacio

    def minimo_el(dia):
        """Lo que tiene que estar fabricado al acabar el dia: el camion que
        sale con mas, mas todo lo de los forjados de antes en la serie."""
        minimo, antes = 0.0, 0.0
        for _m, pendientes, clave in serie:
            falta = max((f for fecha, f, _l in camiones[clave] if fecha <= dia), default=0.0)
            if falta > _EPS:
                minimo = max(minimo, antes + falta)
            antes += pendientes
        return minimo

    # Lo que sale un dia deja hueco al siguiente: ese dia tiene que estar todo.
    minimos, caben = [], []
    salido = sum(b for salida, b in salidas.items() if salida < dias[0])
    for dia in dias:
        minimos.append(minimo_el(dia))
        cabe = capacidad_el(dia, capacidades)
        caben.append(inf if cabe is None else cabe + salido - inicial)
        salido += salidas.get(dia, 0.0)

    # Donde ni asi se llega (un forjado no cabe entero antes de salir) se pasa
    # lo justo: hasta que sale ese camion cuenta con el sitio que falta, para
    # repartirlo en vez de dejarlo todo para el ultimo dia.
    faltan = [max(0.0, tramos_serie.bastidores(minimos[k]) - caben[k]) for k in range(len(dias))]
    excesos = [(dias[k], faltan[k]) for k in range(len(dias)) if faltan[k] > _EPS]
    extra, mayor = [0.0] * len(dias), 0.0
    for k in range(len(dias) - 1, -1, -1):
        mayor = max(mayor, faltan[k])
        extra[k] = mayor
        if k and salidas.get(dias[k - 1]):
            mayor = 0.0
    maximos = []
    for k in range(len(dias)):
        sitio = caben[k] + extra[k]
        maximos.append(max(minimos[k], tramos_serie.modulos(sitio) if sitio > 0 else 0.0))
    # Lo fabricado no vuelve atras: si mas adelante cabe menos, ya hoy cuenta.
    for k in range(len(maximos) - 2, -1, -1):
        maximos[k] = min(maximos[k], maximos[k + 1])

    hecho = cuerda(minimos, maximos)
    ritmos = [hecho[0]] + [hecho[k] - hecho[k - 1] for k in range(1, len(hecho))]

    # Cuando acaba cada forjado (por orden de serie).
    fines, acumulado, k = {}, 0.0, 0
    for _m, pendientes, clave in serie:
        acumulado += pendientes
        while k < len(hecho) - 1 and hecho[k] < acumulado - _EPS:
            k += 1
        fines[clave] = k

    def siguiente_laborable(dia):
        dia += timedelta(days=1)
        for _ in range(60):
            if es_laborable(dia, festivos):
                return dia
            dia += timedelta(days=1)
        return dia

    tramos, inicio = [], 0
    for k in range(1, len(dias) + 1):
        if k < len(dias) and abs(ritmos[k] - ritmos[inicio]) <= _EPS:
            continue
        fin = k - 1
        # La cuerda sube de ritmo solo donde toca el techo (el patio lleno) y
        # baja donde toca el suelo (un montaje): asi se sabe que corto el tramo.
        motivo = 'acopio' if k < len(dias) and ritmos[k] > ritmos[inicio] else 'montaje'
        tramos.append({
            'desde': dias[inicio],
            'hasta': siguiente_laborable(dias[fin]),
            'dias': fin - inicio + 1,
            'modulos': sum(ritmos[inicio:fin + 1]),
            'ritmo': ritmos[inicio],
            'claves': [clave for _m, _p, clave in serie if inicio <= fines[clave] <= fin],
            'motivo': motivo,
        })
        inicio = k
    return tramos, Acopio(capacidades, inicial, salidas, tramos_serie, dias, hecho, excesos)


def acopio_para_grafica(acopio, dias):
    """Capacidades, excesos y {fecha, bastidores, capacidad} de cada dia; None
    si la ferralla no tiene capacidad de acopio."""
    if acopio is None:
        return None
    filas = []
    for dia in dias:
        en_patio, caben = acopio.ocupacion(dia)
        filas.append({'fecha': dia.isoformat(), 'bastidores': round(en_patio, 1), 'capacidad': caben})
    return {**acopio.resumen(), 'dias': filas}


def camiones_del_proyecto(proyecto):
    """Los camiones de un forjado para su ficha: los guardados y, si no llevan
    todo, lo que queda por defecto el dia de salida (o todos por defecto)."""
    from .models import Proyecto
    from .planning import fecha_de_montaje, festivos_de

    if proyecto.usuario_id is not None:
        hermanos = Proyecto.objects.filter(usuario_id=proyecto.usuario_id)
        festivos = festivos_de(proyecto.usuario_id)
    else:
        hermanos = Proyecto.objects.filter(pk=proyecto.pk)
        festivos = frozenset()
    subidos = dict(hermanos.annotate(n=Count('modulos', distinct=True)).values_list('pk', 'n'))
    subidos.setdefault(proyecto.pk, proyecto.modulos.count())
    calculados = bastidores_calculados(list(subidos))
    pk = proyecto.pk
    tiene = bool(calculados.get(pk) and subidos.get(pk))
    por_bastidor = max(subidos[pk] / calculados[pk] if tiene else media_por_bastidor(subidos, calculados), _EPS)
    total = max(subidos[pk], proyecto.modulos_previstos or 0)
    bastidores = bastidores_del_forjado(total, calculados.get(pk), por_bastidor)
    salida = dia_de_salida(fecha_de_montaje(proyecto), festivos)

    guardados = list(proyecto.camiones.order_by('orden'))
    filas = [{
        'orden': camion.orden, 'fecha': camion.fecha.isoformat(), 'bastidores': camion.bastidores,
        'enviado': camion.enviado, 'enviado_at': camion.enviado_at, 'por_defecto': False,
    } for camion in guardados]
    llevan = sum(camion.bastidores for camion in guardados)
    for fecha, cuantos in camiones_por_defecto(bastidores - llevan, salida):
        filas.append({
            'orden': len(filas) + 1, 'fecha': fecha.isoformat(), 'bastidores': cuantos,
            'enviado': False, 'enviado_at': None, 'por_defecto': True,
        })
    return {
        'bastidores': bastidores,
        'bastidores_estimados': not tiene or bastidores > (calculados.get(pk) or 0),
        'salida': salida.isoformat() if salida else None,
        'por_defecto': not guardados,
        # Mas bastidores en los camiones guardados que en el forjado (se recalcularon).
        'sobran': max(0, llevan - bastidores),
        'camiones': filas,
    }
