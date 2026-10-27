"""Elementos sueltos de un proyecto (barras, vigas, zunchos...).

Son piezas que van a obra fuera de los modulos, antes o despues que ellos.
Vienen en la pestaña ELEMENTOS SUELTOS del Excel de despiece que la oficina
sube en el admin; el dashboard de la ferralla la ve como tablas y puede
descargar el despiece. Aqui solo se lee. Un proyecto de antes del despiece
puede tener aun su Excel de elementos sueltos aparte: de ese se leen todas
las hojas visibles.

La pestaña (ESN27_P1_componentes_resumen.xlsx) apila varios bloques, cada
uno asi::

    ARMADURA SUPLEMENTARIA PILARES INFERIOR (PRE-MODULOS)   <- titulo, una celda
    CANTIDAD | DIAMETRO(mm) | LONGITUD(m)                   <- cabecera del bloque
    34       | 8            | 0.83                          <- filas
    150      | TOTAL                                        <- total del bloque
                                                            <- linea en blanco

Cada titulo (fila de una sola celda de texto) abre una seccion con su propia
cabecera; las filas que empiezan por "TOTAL" van como pie de la seccion. Un
Excel con una sola tabla, con o sin titulo, sale como una seccion.
"""
import os
import re
import unicodedata
from datetime import date, datetime, time

# Extensiones que se aceptan al subir. Los .xls antiguos se guardan y se
# pueden descargar, pero openpyxl no los lee, asi que no se previsualizan.
EXTENSIONES = ('.xlsx', '.xlsm', '.xls')
PREVISUALIZABLES = ('.xlsx', '.xlsm')
# Tope de filas por hoja que viajan al navegador; el resto, en el Excel.
MAX_FILAS = 2000
# Pestaña del despiece con los elementos sueltos.
HOJA_DESPIECE = 'ELEMENTOS SUELTOS'

_TOTAL = re.compile(r'^\s*total\b', re.IGNORECASE)
# PRE-MODULOS en ESN27, PRE-MONTAJE en Ripagaña108: los dos, antes de los modulos.
_ANTES = re.compile(r'\bPRE[\s-]*(MODULO|MONTAJE)|\bANTES\b')
_DESPUES = re.compile(r'\bPOST[\s-]*(MODULO|MONTAJE)|\bDESPUES\b')


def _valor(celda):
    """Valor de celda listo para JSON: numeros como numeros, fechas en texto."""
    if celda is None:
        return None
    if isinstance(celda, bool):
        return 'Sí' if celda else 'No'
    if isinstance(celda, datetime):
        if celda.time() == time(0, 0):
            return celda.strftime('%d/%m/%Y')
        return celda.strftime('%d/%m/%Y %H:%M')
    if isinstance(celda, date):
        return celda.strftime('%d/%m/%Y')
    if isinstance(celda, time):
        return celda.strftime('%H:%M')
    if isinstance(celda, float):
        if celda.is_integer():
            return int(celda)
        return round(celda, 4)
    if isinstance(celda, int):
        return celda
    texto = str(celda).strip()
    return texto or None


def _rellenas(fila):
    return [valor for valor in fila if valor is not None]


def _es_total(fila):
    return any(isinstance(valor, str) and _TOTAL.match(valor) for valor in fila)


def _plano(texto):
    """Sin tildes, en mayusculas y sin espacios de sobra, para comparar."""
    return ' '.join(unicodedata.normalize('NFKD', texto).encode('ascii', 'ignore').decode().upper().split())


def _momento(titulo):
    """'antes' o 'despues' de los modulos si el titulo lo dice (PRE-MODULOS...)."""
    if not titulo:
        return None
    plano = _plano(titulo)
    if _ANTES.search(plano):
        return 'antes'
    if _DESPUES.search(plano):
        return 'despues'
    return None


def _nueva_seccion(titulo=None):
    return {'titulo': titulo, 'cabecera': None, 'filas': [], 'totales': [], 'total_filas': 0}


def _vacia(seccion):
    return seccion['cabecera'] is None and not seccion['filas'] and not seccion['totales']


def _cerrar(seccion):
    """Columnas usadas, nombres de columna y filas recortadas a esas columnas."""
    tabla = [fila for fila in [seccion['cabecera'], *seccion['filas'], *seccion['totales']] if fila]
    ancho = max((len(fila) for fila in tabla), default=0)
    usadas = [
        indice for indice in range(ancho)
        if any(indice < len(fila) and fila[indice] is not None for fila in tabla)
    ]

    def recortar(fila):
        return [fila[indice] if indice < len(fila) else None for indice in usadas]

    cabecera = seccion['cabecera'] or []
    columnas = []
    for posicion, indice in enumerate(usadas, start=1):
        titulo = cabecera[indice] if indice < len(cabecera) else None
        columnas.append(str(titulo) if titulo is not None else f'Columna {posicion}')
    return {
        'titulo': seccion['titulo'],
        'momento': _momento(seccion['titulo']),
        'columnas': columnas,
        'filas': [recortar(fila) for fila in seccion['filas']],
        'totales': [recortar(fila) for fila in seccion['totales']],
        'total_filas': seccion['total_filas'],
        'recortado': seccion['total_filas'] > len(seccion['filas']),
    }


def _leer_hoja(hoja):
    notas = []
    secciones = []
    actual = None
    enviadas = 0
    for fila in hoja.iter_rows(values_only=True):
        valores = [_valor(celda) for celda in fila]
        rellenas = _rellenas(valores)
        if not rellenas:
            continue
        unica = rellenas[0] if len(rellenas) == 1 else None
        if isinstance(unica, str) and not _es_total(valores):
            # Titulo: abre seccion. Dos titulos seguidos: el primero es una nota de la hoja.
            if actual is not None and _vacia(actual):
                if actual['titulo']:
                    notas.append(actual['titulo'])
                secciones.pop()
            actual = _nueva_seccion(unica)
            secciones.append(actual)
            continue
        if actual is None:
            actual = _nueva_seccion()
            secciones.append(actual)
        if actual['cabecera'] is None and not actual['filas'] and len(rellenas) >= 2 and not _es_total(valores):
            actual['cabecera'] = valores
            continue
        if _es_total(valores):
            actual['totales'].append(valores)
            continue
        actual['total_filas'] += 1
        if enviadas < MAX_FILAS:
            actual['filas'].append(valores)
            enviadas += 1

    if actual is not None and _vacia(actual):
        if actual['titulo']:
            notas.append(actual['titulo'])
        secciones.pop()
    if not secciones:
        return None
    return {
        'nombre': hoja.title,
        'notas': notas,
        'secciones': [_cerrar(seccion) for seccion in secciones],
    }


def es_excel(field_file):
    return bool(field_file) and os.path.splitext(field_file.name)[1].lower() in EXTENSIONES


def fuente(proyecto):
    """(fichero, hoja) de donde salen los elementos sueltos del proyecto.

    Manda el despiece si es un Excel, y de el solo su pestaña ELEMENTOS
    SUELTOS. Sin despiece Excel, el Excel aparte de antes, entero (hoja None).
    (None, None) si no hay ninguno.
    """
    if es_excel(proyecto.despiece_archivo):
        return proyecto.despiece_archivo, HOJA_DESPIECE
    if proyecto.elementos_sueltos_archivo:
        return proyecto.elementos_sueltos_archivo, None
    return None, None


def leer_elementos_sueltos(field_file, hoja=None):
    """Hojas del Excel, cada una con sus secciones.

    Con ``hoja`` solo esa pestaña (sin mirar tildes ni mayusculas); sin ella,
    todas las visibles. Nunca lanza: si el fichero no se puede leer o no trae
    la pestaña, ``previsualizable`` es False y ``motivo`` lo explica, para que
    el dashboard ofrezca la descarga.
    """
    nombre = os.path.basename(field_file.name)
    extension = os.path.splitext(nombre)[1].lower()
    resultado = {
        'nombre_archivo': nombre,
        'previsualizable': False,
        'motivo': None,
        'hojas': [],
    }
    if extension not in PREVISUALIZABLES:
        resultado['motivo'] = (
            'Este Excel está en formato antiguo (.xls) y no se puede ver aquí. '
            'Descárgalo para abrirlo.'
        )
        return resultado

    from openpyxl import load_workbook

    libro = None
    try:
        field_file.open('rb')
        libro = load_workbook(field_file, read_only=True, data_only=True)
        if hoja is None:
            hojas = [h for h in libro.worksheets if getattr(h, 'sheet_state', 'visible') == 'visible']
        else:
            hojas = [h for h in libro.worksheets if _plano(h.title) == _plano(hoja)]
        if hoja is not None and not hojas:
            resultado['motivo'] = f'El despiece no trae la pestaña {hoja}. Descárgalo para abrirlo.'
        else:
            for libro_hoja in hojas:
                contenido = _leer_hoja(libro_hoja)
                if contenido is not None:
                    resultado['hojas'].append(contenido)
            resultado['previsualizable'] = True
    except FileNotFoundError:
        resultado['motivo'] = 'El archivo no está disponible en el servidor.'
    except Exception:
        resultado['motivo'] = 'No se ha podido leer el Excel. Descárgalo para abrirlo.'
    finally:
        if libro is not None:
            libro.close()
        try:
            field_file.close()
        except Exception:
            pass
    return resultado
