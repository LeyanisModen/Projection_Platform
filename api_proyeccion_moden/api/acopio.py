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

Cada forjado sale en camiones de 4 bastidores. La ferralla saca como mucho
unos camiones al dia (``UserProfile.camiones_por_dia``), asi que un forjado
grande empieza a salir unos dias antes de su montaje: por defecto los justos,
lo mas tarde posible; Moden puede elegir en cuantos dias sale (``dias_envio``)
y en la ficha se cambia un camion suelto (``Camion``). Cada camion se lleva
sus bastidores en orden: tienen que estar hechos el dia que sale, y su sitio
en el patio queda libre ese mismo dia para lo que se fabrica.
Un bastidor de un forjado ocupa lo que sus modulos: sus modulos subidos entre
sus bastidores; sin bastidores, la media de la ferralla.
"""
from datetime import date, timedelta
from math import ceil, inf

from django.db.models import Count

BASTIDORES_POR_CAMION = 4
# Camiones que saca una ferralla al dia mientras Moden no dice otra cosa.
CAMIONES_POR_DIA = 4
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


def camiones_por_dia_de(usuario_id):
    """Camiones que puede sacar la ferralla al dia (su perfil); sin perfil, 4."""
    from .models import UserProfile

    if usuario_id is None:
        return CAMIONES_POR_DIA
    valor = UserProfile.objects.filter(user_id=usuario_id).values_list('camiones_por_dia', flat=True).first()
    return valor or CAMIONES_POR_DIA


def camiones_del_forjado(guardados, bastidores):
    """Los camiones de un forjado, en orden de bastidor: los guardados hasta
    llevarlo entero y lo que no llevan, de 4 en 4 (el ultimo, lo que quede).
    Cada uno {'orden', 'bastidores', 'fecha' (la fija o None), 'fija',
    'enviado', 'enviado_at', 'guardado'}; ``repartir`` pone fecha a los demas."""
    lista, llevan = [], 0
    for camion in guardados:
        if llevan >= bastidores:
            break
        cuantos = min(camion['bastidores'], bastidores - llevan)
        lista.append({**camion, 'bastidores': cuantos, 'guardado': True})
        llevan += cuantos
    quedan = bastidores - llevan
    while quedan > 0:
        cuantos = min(BASTIDORES_POR_CAMION, quedan)
        lista.append({'bastidores': cuantos, 'fecha': None, 'enviado': False, 'enviado_at': None, 'guardado': False})
        quedan -= cuantos
    for orden, camion in enumerate(lista, start=1):
        camion['orden'] = orden
        camion['fija'] = camion['fecha'] is not None
    return lista


def bastidores_del_forjado(total_modulos, bastidores_calculados, por_bastidor):
    """Los calculados; si faltan modulos por subir (o no hay), los que saldran a su media."""
    estimados = ceil(total_modulos / por_bastidor - _EPS) if total_modulos else 0
    return max(bastidores_calculados or 0, estimados)


def _laborable_desde(dia, festivos, paso):
    """El primer dia laborable desde ``dia`` (incluido) hacia delante (paso 1) o hacia atras (-1)."""
    from .planning import es_laborable

    for _ in range(60):
        if es_laborable(dia, festivos):
            return dia
        dia += timedelta(days=paso)
    return dia


def dia_de_salida(montaje, festivos):
    """Dia laborable anterior al montaje: el ultimo de fabricacion, cuando sale."""
    if montaje is None:
        return None
    return _laborable_desde(montaje - timedelta(days=1), festivos, -1)


def dias_de_envio(salida, cuantos, festivos):
    """Los ``cuantos`` dias laborables que acaban en ``salida``, de antes a despues."""
    dias = [salida]
    while len(dias) < cuantos:
        dias.insert(0, _laborable_desde(dias[0] - timedelta(days=1), festivos, -1))
    return dias


def dias_minimos(bastidores, por_dia):
    """Dias que hacen falta para sacar un forjado con los camiones al dia de la ferralla."""
    return max(1, ceil(bastidores / (por_dia * BASTIDORES_POR_CAMION) - _EPS))


def _parejos(n, dias):
    """El dia de cada uno de ``n`` camiones repartidos parejos en ``dias``: el
    primero el primer dia y el ultimo el ultimo; los dias con uno de mas, al
    final (lo mas tarde)."""
    k = len(dias)
    if n <= k:
        if n == 1:
            return [dias[0]]
        return [dias[round(i * (k - 1) / (n - 1))] for i in range(n)]
    base, extra = divmod(n, k)
    return [dia for j, dia in enumerate(dias) for _ in range(base + (1 if j >= k - extra else 0))]


def repartir(forjados, festivos, desde, por_dia):
    """Pone dia a los camiones que no lo tienen fijo y devuelve {dia: bastidores que salen}.

    ``forjados``: [{'salida', 'dias' (los elegidos o None), 'fantasma',
    'orden', 'camiones'}]. Al dia salen como mucho ``por_dia`` camiones (en
    bastidores, para que dos medios camiones de dos plantas cuenten como uno).
    Primero cuentan los fijos (movidos a mano o ya enviados); despues lo real
    y luego lo que esta en estudio, que se acomoda sin mover lo real. Un
    forjado con dias elegidos reparte sus camiones parejos en esos dias (nunca
    menos de los que hacen falta); los demas salen lo mas tarde posible antes
    de su montaje, empezando por el que se monta despues, asi cada forjado
    sale seguido y en el orden de sus montajes. Nada sale antes de ``desde``:
    lo que tendria que haber salido y no consta como enviado sale ese dia.
    """
    cabe = por_dia * BASTIDORES_POR_CAMION
    carga = {}

    def cargar(camion, dia):
        camion['fecha'] = dia
        carga[dia] = carga.get(dia, 0) + camion['bastidores']

    for forjado in forjados:
        for camion in forjado['camiones']:
            if camion['fecha'] is not None:
                carga[camion['fecha']] = carga.get(camion['fecha'], 0) + camion['bastidores']
    primero = _laborable_desde(desde, festivos, 1)
    for fantasma in (False, True):
        grupo = [f for f in forjados if bool(f['fantasma']) == fantasma and f['salida'] is not None]
        elegidos = [f for f in grupo if f['dias']]
        solos = sorted((f for f in grupo if not f['dias']), key=lambda f: (f['salida'], f['orden']), reverse=True)
        for forjado in elegidos + solos:
            libres = [c for c in forjado['camiones'] if c['fecha'] is None]
            salida = forjado['salida']
            if not libres:
                continue
            if salida < primero:
                # Su montaje ya paso: salio entonces.
                for camion in libres:
                    cargar(camion, salida)
            elif forjado['dias']:
                total = sum(c['bastidores'] for c in libres)
                dias = dias_de_envio(salida, max(forjado['dias'], dias_minimos(total, por_dia)), festivos)
                dias = [d for d in dias if d >= primero] or [primero]
                for camion, dia in zip(libres, _parejos(len(libres), dias)):
                    cargar(camion, dia)
            else:
                dia = salida
                for camion in reversed(libres):
                    while carga.get(dia, 0) + camion['bastidores'] > cabe + _EPS and dia > primero:
                        dia = _laborable_desde(dia - timedelta(days=1), festivos, -1)
                    cargar(camion, max(dia, primero))
    return carga


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
    """{pk: [camion]} de los forjados con camiones cambiados, en orden."""
    from .models import Camion

    guardados = {}
    for camion in Camion.objects.filter(proyecto_id__in=pks).order_by('proyecto_id', 'orden'):
        guardados.setdefault(camion.proyecto_id, []).append({
            'fecha': camion.fecha, 'bastidores': camion.bastidores,
            'enviado': camion.enviado, 'enviado_at': camion.enviado_at,
        })
    return guardados


def _laborables_entre(desde, hasta, festivos):
    from .planning import dias_laborables

    return len(list(dias_laborables(desde, hasta + timedelta(days=1), festivos)))


class Almacen(dict):
    """{pk: datos del forjado} de ``almacen()`` con el reparto de la ferralla:
    ``por_dia`` (camiones al dia), ``carga`` {dia: bastidores que salen} y
    ``desde``."""

    def __init__(self, info, por_dia, carga, desde):
        super().__init__(info)
        self.por_dia = por_dia
        self.carga = carga
        self.desde = desde

    def sobrecargas(self):
        """[(dia, camiones)] de los dias en que salen mas de los que puede."""
        cabe = self.por_dia * BASTIDORES_POR_CAMION
        return [
            (dia, bastidores / BASTIDORES_POR_CAMION)
            for dia, bastidores in sorted(self.carga.items())
            if dia >= self.desde and bastidores > cabe + _EPS
        ]

    def envio(self, pk):
        """Cuando salen los camiones de un forjado: {camiones, bastidores,
        desde, hasta, dias (laborables de uno a otro), dias_elegidos,
        dias_minimos}."""
        datos = self[pk]
        fechas = [c['fecha'] for c in datos['camiones'] if c['fecha'] is not None]
        desde, hasta = (min(fechas), max(fechas)) if fechas else (None, None)
        return {
            'camiones': len(datos['camiones']),
            'bastidores': datos['bastidores'],
            'desde': desde.isoformat() if desde else None,
            'hasta': hasta.isoformat() if hasta else None,
            'dias': _laborables_entre(desde, hasta, datos['festivos']) if fechas else 0,
            'dias_elegidos': datos['dias_envio'],
            'dias_minimos': dias_minimos(datos['bastidores'], self.por_dia) if datos['bastidores'] else 0,
        }


def almacen(proyectos, subidos, hechos, totales, festivos, desde, por_dia=None):
    """Lo que cada forjado vivo ocupa y cuando sale cada camion.

    ``subidos``/``hechos``/``totales``: modulos por pk (los subidos, los
    hechos al empezar y los que tendra, previstos incluidos). Un forjado ya
    montado salio entero el dia que se monto. ``por_dia``: camiones al dia de
    la ferralla (sin decir, 4). Devuelve un ``Almacen``: {pk: {'salida',
    'por_bastidor', 'hechos', 'total', 'bastidores', 'calculados',
    'camiones' (en orden de salida), 'dias_envio', 'festivos'}}.
    """
    from .planning import fecha_de_montaje

    por_dia = por_dia or CAMIONES_POR_DIA
    pks = [p.pk for p in proyectos]
    calculados = bastidores_calculados(pks)
    media = media_por_bastidor(subidos, calculados)
    guardados = camiones_guardados(pks)
    info, forjados = {}, []
    for proyecto in proyectos:
        pk = proyecto.pk
        tiene = bool(calculados.get(pk) and subidos.get(pk))
        por_bastidor = max(subidos[pk] / calculados[pk] if tiene else media, _EPS)
        total = totales.get(pk, 0)
        bastidores = bastidores_del_forjado(total, calculados.get(pk), por_bastidor)
        salida = dia_de_salida(fecha_de_montaje(proyecto), festivos)
        camiones = camiones_del_forjado(guardados.get(pk, []), bastidores)
        montado = getattr(proyecto, 'montaje_realizado_at', None)
        if montado is not None and montado.date() < desde:
            # Ya montado: salio del patio aunque sus camiones digan otra cosa.
            salida = montado.date()
            camiones = [{'orden': 1, 'bastidores': bastidores, 'fecha': salida, 'fija': True, 'enviado': True,
                         'enviado_at': None, 'guardado': False}] if bastidores else []
        dias_envio = getattr(proyecto, 'dias_envio', None)
        info[pk] = {
            'salida': salida,
            'por_bastidor': por_bastidor,
            'hechos': hechos.get(pk, 0),
            'total': total,
            'bastidores': bastidores,
            'calculados': calculados.get(pk) or 0,
            'camiones': camiones,
            'dias_envio': dias_envio,
            'festivos': festivos,
        }
        forjados.append({
            'salida': salida, 'dias': dias_envio, 'fantasma': getattr(proyecto, 'fantasma', False),
            'orden': (proyecto.orden_planta, pk), 'camiones': camiones,
        })
    carga = repartir(forjados, festivos, desde, por_dia)
    for datos in info.values():
        # Los primeros bastidores van en el camion que sale antes.
        datos['camiones'].sort(key=lambda c: (c['fecha'] or date.max, c['orden']))
    return Almacen(info, por_dia, carga, desde)


def todos_el_dia_de_salida(info):
    """Si cada forjado sale entero el dia antes de su montaje (el plan de siempre)."""
    return all(
        camion['fecha'] == datos['salida']
        for datos in info.values() for camion in datos['camiones'] if camion['fecha'] is not None
    )


def _por_camion(datos):
    """[(fecha, modulos por fabricar que tienen que estar, bastidores que libera)]
    de cada camion: lleva los bastidores en orden y los primeros ya estan hechos."""
    total, hechos, por_bastidor = datos['total'], datos['hechos'], datos['por_bastidor']
    filas, llevan, antes = [], 0, 0.0
    for camion in datos['camiones']:
        if camion['fecha'] is None:
            continue
        llevan += camion['bastidores']
        hasta = min(total, llevan * por_bastidor)
        filas.append((camion['fecha'], max(0.0, hasta - hechos), (hasta - antes) / por_bastidor))
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


def _salido_hasta(salidas, dia):
    """Bastidores que han salido hasta ese dia, incluidos los de ese dia."""
    return sum(b for salida, b in salidas.items() if salida <= dia)


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
        """(bastidores en el patio al acabar el dia, ya salidos los camiones
        de ese dia; los que caben)."""
        fabricado = 0.0
        for candidato, acumulado in zip(self.dias, self.hecho):
            if candidato > dia:
                break
            fabricado = acumulado
        en_patio = self.inicial + self.serie.bastidores(fabricado) - _salido_hasta(self.salidas, dia)
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
    ``capacidades`` vacio: sin limite (solo cuentan los camiones).
    Cada camion se lleva sus bastidores (en orden) y tienen que estar hechos
    ese dia; su sitio queda libre ese mismo dia. Se fabrica por camiones: lo
    de cada camion en el orden en que salen (el mismo dia, por la serie), asi
    un forjado que empieza a salir antes no obliga a hacerlo entero antes que
    los demas. Devuelve (tramos, Acopio, rangos); cada tramo como los de
    ``tramos_de_ritmo`` mas ``motivo``: 'montaje' si acaba porque llega a un
    plazo, 'acopio' si porque el patio se llena; ``rangos``: {clave:
    [(desde, hasta)]} los modulos de cada forjado en lo que se va fabricando.
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

    # Lo que falta de cada camion, en el orden en que se fabrica.
    posicion = {clave: indice for indice, (_m, _p, clave) in enumerate(serie)}
    trozos = []
    for _m, pendientes, clave in serie:
        antes = 0.0
        for fecha, falta, _libera in camiones[clave]:
            if falta > antes + _EPS:
                trozos.append((fecha, posicion[clave], clave, falta - antes))
                antes = falta
        if pendientes - antes > _EPS:
            # Sin camion que se lo lleve (no deberia pasar): al final.
            trozos.append((date.max, posicion[clave], clave, pendientes - antes))
    trozos.sort(key=lambda t: (t[0], t[1]))
    rangos, acumulado = {}, 0.0
    for _fecha, _pos, clave, modulos in trozos:
        rangos.setdefault(clave, []).append((acumulado, acumulado + modulos))
        acumulado += modulos

    tramos_serie = _Serie([(modulos, info[clave]['por_bastidor']) for _f, _p, clave, modulos in trozos])
    vacio = Acopio(capacidades, inicial, salidas, tramos_serie, [], [], [])
    plazos = [fecha for fecha, _p, _c, _m in trozos if fecha != date.max]
    if not plazos:
        return [], vacio, rangos
    dias = list(dias_laborables(desde, max(max(plazos), desde) + timedelta(days=1), festivos))
    if not dias:
        return [], vacio, rangos

    def minimo_el(dia):
        """Lo que tiene que estar fabricado al acabar el dia: lo de los camiones que ya han salido."""
        return sum(modulos for fecha, _p, _c, modulos in trozos if fecha <= dia)

    # Lo que sale un dia deja su sitio ese mismo dia para lo que se fabrica.
    minimos, caben = [], []
    for dia in dias:
        minimos.append(minimo_el(dia))
        cabe = capacidad_el(dia, capacidades)
        caben.append(inf if cabe is None else cabe + _salido_hasta(salidas, dia) - inicial)

    # Donde ni asi se llega (un forjado no cabe entero antes de salir) se pasa
    # lo justo: desde que salio el camion anterior cuenta con el sitio que
    # falta, para repartirlo en vez de dejarlo todo para el ultimo dia.
    faltan = [max(0.0, tramos_serie.bastidores(minimos[k]) - caben[k]) for k in range(len(dias))]
    excesos = [(dias[k], faltan[k]) for k in range(len(dias)) if faltan[k] > _EPS]
    extra, mayor = [0.0] * len(dias), 0.0
    for k in range(len(dias) - 1, -1, -1):
        mayor = max(mayor, faltan[k])
        extra[k] = mayor
        anterior = dias[k - 1] if k else desde - timedelta(days=1)
        if any(anterior < salida <= dias[k] for salida in salidas):
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

    # Cuando acaba cada forjado: el dia en que se hace lo de su ultimo camion.
    fines = {}
    for clave, partes in rangos.items():
        k = 0
        while k < len(hecho) - 1 and hecho[k] < partes[-1][1] - _EPS:
            k += 1
        fines[clave] = k
    por_fin = sorted(rangos, key=lambda clave: rangos[clave][-1][1])

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
            'claves': [clave for clave in por_fin if inicio <= fines[clave] <= fin],
            'motivo': motivo,
        })
        inicio = k
    return tramos, Acopio(capacidades, inicial, salidas, tramos_serie, dias, hecho, excesos), rangos


def acopio_para_grafica(acopio, dias):
    """Capacidades, excesos y {fecha, bastidores, capacidad} de cada dia; None
    si la ferralla no tiene capacidad de acopio."""
    if acopio is None or not acopio.capacidades:
        return None
    filas = []
    for dia in dias:
        en_patio, caben = acopio.ocupacion(dia)
        filas.append({'fecha': dia.isoformat(), 'bastidores': round(en_patio, 1), 'capacidad': caben})
    return {**acopio.resumen(), 'dias': filas}


def camiones_del_proyecto(proyecto, desde=None):
    """Los camiones de un forjado para su ficha, cada uno con el dia que le
    toca en el reparto de su ferralla (con lo real; uno en estudio, tambien
    con lo demas en estudio)."""
    from django.utils import timezone

    from .models import Proyecto
    from .planning import almacen_de, annotated_projects, festivos_de, proyectos_del_plan

    desde = desde or timezone.localdate()
    if proyecto.usuario_id is not None and not proyecto.archivado_at:
        proyectos = proyectos_del_plan(proyecto.usuario_id, con_fantasmas=proyecto.fantasma)
        festivos = festivos_de(proyecto.usuario_id)
    else:
        # Archivado o sin ferralla: solo, sin festivos.
        proyectos, festivos = [], frozenset()
    if not any(p.pk == proyecto.pk for p in proyectos):
        proyectos += list(annotated_projects(Proyecto.objects.filter(pk=proyecto.pk)))
    info = almacen_de(proyectos, festivos, desde, proyecto.usuario_id)
    datos = info[proyecto.pk]
    llevan = sum(c.bastidores for c in proyecto.camiones.all())
    return {
        'bastidores': datos['bastidores'],
        'bastidores_estimados': datos['bastidores'] > datos['calculados'],
        'salida': datos['salida'].isoformat() if datos['salida'] else None,
        'por_defecto': not llevan,
        # Mas bastidores en los camiones guardados que en el forjado (se recalcularon).
        'sobran': max(0, llevan - datos['bastidores']),
        'camiones_por_dia': info.por_dia,
        'envio': info.envio(proyecto.pk),
        'camiones': [{
            'orden': camion['orden'],
            'fecha': camion['fecha'].isoformat() if camion['fecha'] else None,
            'fecha_fija': camion['fija'],
            'bastidores': camion['bastidores'],
            'enviado': camion['enviado'],
            'enviado_at': camion['enviado_at'],
            'por_defecto': not camion['guardado'],
        } for camion in sorted(datos['camiones'], key=lambda c: c['orden'])],
    }
