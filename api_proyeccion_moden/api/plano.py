"""Plano de la planta, dibujado desde la base tecnica del proyecto.

La base trae la losa (``contorno``), sus huecos (``huecos_pol`` y
``huecos_circ``), los pilares y el rectangulo de encaje de cada modulo
(``rectangulos_encaje``), en metros con las coordenadas del CAD (Y hacia
arriba). Aqui se pasan a las del dibujo (origen arriba a la izquierda, Y
hacia abajo) y se cruzan con el estado de los modulos y sus bastidores.
"""
import os
import sqlite3
import tempfile
from collections import defaultdict
from functools import lru_cache

from django.core.files.storage import default_storage

from .models import Modulo, ModuloEstado

TABLAS_PLANO = {'contorno', 'rectangulos_encaje'}
MARGEN_M = 0.5
TERMINADO = (ModuloEstado.COMPLETADO, ModuloEstado.CERRADO)


def _poligonos(conexion, tabla, con_nombre=False):
    columnas = 'posX1, posY1, id_hueco' + (', name' if con_nombre else '')
    grupos, nombres = defaultdict(list), {}
    for fila in conexion.execute(f'SELECT {columnas} FROM {tabla} ORDER BY id'):
        grupos[fila[2]].append((fila[0], fila[1]))
        if con_nombre:
            nombres.setdefault(fila[2], fila[3])
    return [(nombres.get(clave), puntos) for clave, puntos in grupos.items() if len(puntos) >= 3]


def _leer_base(ruta):
    conexion = sqlite3.connect(ruta)
    try:
        tablas = {nombre for (nombre,) in conexion.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not TABLAS_PLANO <= tablas:
            return None
        canto = None
        if 'detalles' in tablas:
            fila = conexion.execute("SELECT valor FROM detalles WHERE detalle = 'CANTO_LOSA'").fetchone()
            try:
                canto = float(fila[0]) if fila else None
            except (TypeError, ValueError):
                canto = None
        return {
            'contorno': list(conexion.execute('SELECT posX1, posY1 FROM contorno ORDER BY id')),
            'huecos': _poligonos(conexion, 'huecos_pol') if 'huecos_pol' in tablas else [],
            'huecos_circulares': (
                list(conexion.execute('SELECT posX1, posY1, radio FROM huecos_circ ORDER BY id'))
                if 'huecos_circ' in tablas else []
            ),
            'pilares': _poligonos(conexion, 'pilares', con_nombre=True) if 'pilares' in tablas else [],
            'encajes': list(conexion.execute('SELECT modulo, pt1X, pt1Y, pt3X, pt3Y FROM rectangulos_encaje ORDER BY id')),
            'canto_losa_cm': canto,
        }
    finally:
        conexion.close()


@lru_cache(maxsize=64)
def _geometria(nombre_fichero, firma):
    """Geometria ya en coordenadas del dibujo; None si la base no trae el plano.

    ``firma`` (tamano y fecha del fichero) solo cuenta para la cache: si un
    nombre se reutiliza con otra base, no sale el plano de la anterior.
    """
    if not nombre_fichero.lower().endswith(('.db', '.sqlite', '.sqlite3')):
        return None
    try:
        with default_storage.open(nombre_fichero, 'rb') as fichero, \
                tempfile.NamedTemporaryFile(delete=False, suffix='.db') as temporal:
            for trozo in fichero.chunks():
                temporal.write(trozo)
            ruta = temporal.name
    except OSError:
        return None
    try:
        base = _leer_base(ruta)
    except sqlite3.Error:
        return None
    finally:
        os.unlink(ruta)
    if not base or len(base['contorno']) < 3 or not base['encajes']:
        return None

    puntos = list(base['contorno'])
    for _, x1, y1, x2, y2 in base['encajes']:
        puntos += [(x1, y1), (x2, y2)]
    x0 = min(x for x, _ in puntos) - MARGEN_M
    y_arriba = max(y for _, y in puntos) + MARGEN_M

    def punto(x, y):
        return [round(x - x0, 3), round(y_arriba - y, 3)]

    return {
        'ancho': round(max(x for x, _ in puntos) + MARGEN_M - x0, 3),
        'alto': round(y_arriba - (min(y for _, y in puntos) - MARGEN_M), 3),
        'canto_losa_cm': base['canto_losa_cm'],
        'contorno': [punto(x, y) for x, y in base['contorno']],
        'huecos': [[punto(x, y) for x, y in poligono] for _, poligono in base['huecos']],
        'huecos_circulares': [
            {'x': punto(x, y)[0], 'y': punto(x, y)[1], 'r': round(r, 3)}
            for x, y, r in base['huecos_circulares'] if r
        ],
        'pilares': [
            {'nombre': nombre or '', 'puntos': [punto(x, y) for x, y in poligono]}
            for nombre, poligono in base['pilares']
        ],
        'encajes': [
            (str(nombre or '').strip(), *punto(min(x1, x2), max(y1, y2)),
             round(abs(x2 - x1), 3), round(abs(y2 - y1), 3))
            for nombre, x1, y1, x2, y2 in base['encajes']
        ],
    }


def geometria(proyecto):
    fichero = proyecto.fichero_datos_tecnicos
    if not fichero or not fichero.name:
        return None
    try:
        firma = (default_storage.size(fichero.name), default_storage.get_modified_time(fichero.name).timestamp())
    except (OSError, NotImplementedError):
        return None
    return _geometria(fichero.name, firma)


def tiene_plano(proyecto):
    return geometria(proyecto) is not None


def _estado(modulo):
    if modulo.estado in TERMINADO:
        return 'terminado'
    if modulo.estado == ModuloEstado.EN_PROGRESO or modulo.inferior_hecho or modulo.superior_hecho:
        return 'en_curso'
    return 'pendiente'


def plano(proyecto):
    """El plano con el estado de cada modulo y de cada bastidor; None si no hay."""
    datos = geometria(proyecto)
    if datos is None:
        return None
    modulos = {}
    for modulo in Modulo.objects.filter(proyecto=proyecto).select_related(
        'grupo_bastidor', 'grupo_bastidor__dividido_de',
    ):
        nombre = modulo.nombre.strip()
        modulos[nombre] = modulo
        # Un modulo repetido (A01-R) ocupa el sitio del original.
        if nombre.upper().endswith('-R'):
            modulos.setdefault(nombre[:-2], modulo)

    bastidores = {}
    for modulo in set(modulos.values()):
        if modulo.grupo_bastidor_id is None:
            continue
        raiz = modulo.grupo_bastidor.raiz
        bastidor = bastidores.setdefault(raiz.id, {
            'id': raiz.id, 'indice': raiz.indice, 'etiqueta': raiz.etiqueta, 'modulos': 0, 'terminados': 0,
        })
        bastidor['modulos'] += 1
        bastidor['terminados'] += modulo.estado in TERMINADO

    dibujados = []
    for nombre, x, y, ancho, alto in datos['encajes']:
        modulo = modulos.get(nombre)
        estado = _estado(modulo) if modulo else None
        sd_de = None
        # SDB05: segundo superior de B05, se hace con su superior.
        if modulo is None and nombre.upper().startswith('SD') and nombre[2:] in modulos:
            modulo = modulos[nombre[2:]]
            sd_de = modulo.nombre
            estado = 'terminado' if modulo.superior_hecho or modulo.estado in TERMINADO else 'pendiente'
        raiz = modulo.grupo_bastidor.raiz if modulo and modulo.grupo_bastidor_id else None
        dibujados.append({
            'nombre': nombre, 'x': x, 'y': y, 'ancho': ancho, 'alto': alto,
            # Sin modulo: una pieza del encaje que no se fabrica en mesa.
            'estado': estado, 'sd_de': sd_de,
            'inferior_hecho': bool(modulo and modulo.inferior_hecho),
            'superior_hecho': bool(modulo and modulo.superior_hecho),
            'bastidor': raiz.id if raiz else None,
        })
    return {
        'ancho': datos['ancho'], 'alto': datos['alto'], 'canto_losa_cm': datos['canto_losa_cm'],
        'contorno': datos['contorno'], 'huecos': datos['huecos'],
        'huecos_circulares': datos['huecos_circulares'], 'pilares': datos['pilares'],
        'modulos': dibujados,
        'bastidores': [
            {**bastidor, 'terminado': bastidor['terminados'] == bastidor['modulos']}
            for bastidor in sorted(bastidores.values(), key=lambda b: b['indice'])
        ],
    }
