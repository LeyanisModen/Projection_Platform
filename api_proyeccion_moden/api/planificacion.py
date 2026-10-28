"""Planificacion de una ferralla a tres meses vista y los kilos de cada proyecto.

La grafica: los modulos al dia que exigen las entregas a obra (el plan por
tramos de montaje de ``api.planning``) y el dia de entrega de cada forjado,
que para Moden es el de montaje y para la ferralla el de suministrar a obra.
Las tarjetas: los kilos de cada proyecto, lo que la ferralla mira de verdad:
los de los modulos y los de los elementos sueltos que van a obra fuera de
ellos (de la base tecnica). Confirmados, los de lo que ya esta subido (todo,
lo fabricado y su desperdicio, como Estadisticas); previstos, los de los
modulos que faltan por subir hasta los previstos, a su peso medio.
"""
import calendar
import os
import sqlite3
import tempfile
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.contrib.auth.models import User
from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import permissions
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DetalleModuloFase, Proyecto
from .planning import annotated_projects, dias_laborables, fecha_de_montaje, festivos_de, plan_ferralla

MESES_VISTA = 3
# Lo que pesa una fase (DetalleModuloFase.peso_total_kg): el mallazo recortado
# (o hecho a mano) y lo que lleva encima.
CAMPOS_PESO = (
    'peso_malla_final_kg', 'peso_malla_manual_kg', 'peso_refuerzos_kg',
    'peso_zunchos_kg', 'peso_separadores_kg', 'peso_punzos_kg',
)
# Tabla de la base tecnica con las piezas que van a obra fuera de los modulos
# (propuesta al companero de BD en docs/09_elementos_sueltos_base_tecnica.md).
TABLA_SUELTOS = 'elementos_sueltos'
EXTENSIONES_SQLITE = ('.db', '.sqlite', '.sqlite3')


def _es_oficina(user):
    return bool(user and (user.is_staff or user.is_superuser))


def sumar_meses(dia, meses):
    """El mismo dia ``meses`` despues (o el ultimo de ese mes si no existe)."""
    indice = dia.month - 1 + meses
    anio, mes = dia.year + indice // 12, indice % 12 + 1
    return date(anio, mes, min(dia.day, calendar.monthrange(anio, mes)[1]))


def _kg(valor):
    return round(float(valor or 0), 2)


def peso_sueltos_de_base_tecnica(fichero):
    """Suma de ``peso_kg`` de la tabla de elementos sueltos de una base .db.

    None si el fichero no es SQLite o aun no trae la tabla (o su peso).
    """
    if not (fichero.name or '').lower().endswith(EXTENSIONES_SQLITE):
        return None
    with tempfile.NamedTemporaryFile(delete=False, suffix='.db') as temporal:
        for trozo in fichero.chunks():
            temporal.write(trozo)
        ruta = temporal.name
    conexion = None
    try:
        conexion = sqlite3.connect(ruta)
        columnas = {fila[1] for fila in conexion.execute(f'PRAGMA table_info({TABLA_SUELTOS})')}
        if 'peso_kg' not in columnas:
            return None
        total = conexion.execute(f'SELECT SUM(peso_kg) FROM {TABLA_SUELTOS}').fetchone()[0]
    except sqlite3.Error:
        return None
    finally:
        if conexion is not None:
            conexion.close()
        os.unlink(ruta)
    try:
        return Decimal(str(total or 0)).quantize(Decimal('0.01'))
    except InvalidOperation:
        return None


def kilos_de_modulos(proyectos):
    """{proyecto_id: (todo, fabricado, desperdicio)} en kg, de los detalles de fase.

    Fabricado y desperdicio, de los modulos terminados, como Estadisticas. Un
    proyecto sin modulos subidos no sale: sus kilos aun no se saben.
    """
    hecho = Q(modulo__completado_at__isnull=False)
    agregados = {'desperdicio': Sum('desperdicio_kg', filter=hecho)}
    for campo in CAMPOS_PESO:
        agregados[f'todo_{campo}'] = Sum(campo)
        agregados[f'hecho_{campo}'] = Sum(campo, filter=hecho)
    filas = (
        DetalleModuloFase.objects.filter(modulo__proyecto__in=proyectos)
        .order_by().values('modulo__proyecto').annotate(**agregados)
    )
    return {
        fila['modulo__proyecto']: (
            sum(_kg(fila[f'todo_{campo}']) for campo in CAMPOS_PESO),
            sum(_kg(fila[f'hecho_{campo}']) for campo in CAMPOS_PESO),
            _kg(fila['desperdicio']),
        )
        for fila in filas
    }


def pesos_medios(usuario_id):
    """Kilos medios de un modulo de la ferralla: por proyecto, por edificio y en total.

    De los modulos subidos con sus detalles, archivados incluidos (sus datos
    siguen). Con ellos se preven los kilos de los modulos que aun no estan.
    """
    filas = (
        DetalleModuloFase.objects.filter(modulo__proyecto__usuario_id=usuario_id)
        .order_by().values('modulo__proyecto', 'modulo__proyecto__edificio')
        .annotate(modulos=Count('modulo', distinct=True), **{campo: Sum(campo) for campo in CAMPOS_PESO})
    )
    sumas = {'proyecto': {}, 'edificio': {}, 'ferralla': {}}
    for fila in filas:
        kg = sum(_kg(fila[campo]) for campo in CAMPOS_PESO)
        if kg <= 0:
            continue
        claves = [('proyecto', fila['modulo__proyecto']), ('ferralla', None)]
        if fila['modulo__proyecto__edificio'] is not None:
            claves.append(('edificio', fila['modulo__proyecto__edificio']))
        for nivel, clave in claves:
            total_kg, modulos = sumas[nivel].get(clave, (0.0, 0))
            sumas[nivel][clave] = (total_kg + kg, modulos + fila['modulos'])
    return {
        nivel: {clave: kg / modulos for clave, (kg, modulos) in por_clave.items()}
        for nivel, por_clave in sumas.items()
    }


def _previstos(proyecto, medios):
    """Los modulos que faltan por subir hasta los previstos y sus kilos, a su peso medio:
    el del propio proyecto, el de su edificio o el de la ferralla. None si no falta ninguno."""
    faltan = max((proyecto.modulos_previstos or 0) - proyecto._modulos_count, 0)
    if not faltan:
        return None
    for de, medio in (
        ('proyecto', medios['proyecto'].get(proyecto.pk)),
        ('edificio', medios['edificio'].get(proyecto.edificio_id)),
        ('ferralla', medios['ferralla'].get(None)),
    ):
        if medio:
            return {'modulos': faltan, 'peso_medio': round(medio, 1), 'de': de, 'kg': round(faltan * medio, 2)}
    # Sin ningun modulo pesado en la ferralla: no hay con que prever.
    return {'modulos': faltan, 'peso_medio': None, 'de': None, 'kg': None}


def _tarjeta(proyecto, modulos_kg, fila_plan, medios):
    todo, fabricado, desperdicio = modulos_kg or (None, 0.0, 0.0)
    sueltos = None if proyecto.peso_elementos_sueltos_kg is None else _kg(proyecto.peso_elementos_sueltos_kg)
    previstos = _previstos(proyecto, medios)
    previsto_kg = previstos['kg'] if previstos else None
    confirmado = None if todo is None and sueltos is None else round((todo or 0) + (sueltos or 0), 2)
    entrega = fecha_de_montaje(proyecto)
    return {
        'id': proyecto.id,
        'nombre': proyecto.nombre,
        'planta_etiqueta': proyecto.planta_etiqueta,
        # La pagina agrupa las tarjetas en una columna por edificio.
        'edificio': proyecto.edificio_id,
        'edificio_nombre': proyecto.edificio.nombre if proyecto.edificio_id else None,
        'fecha_entrega': entrega.isoformat() if entrega else None,
        'entrega_orientativa': entrega is not None and not proyecto.fecha_montaje_obra,
        'modulos_total': max(proyecto._modulos_count, proyecto.modulos_previstos or 0),
        'modulos_completados': proyecto._modulos_completados,
        'estado': fila_plan['estado'],
        'kilos': {
            # Los de los modulos subidos; None: aun sin modulos subidos.
            'modulos': None if todo is None else round(todo, 2),
            'modulos_subidos': proyecto._modulos_count,
            'fabricado': round(fabricado, 2),
            'desperdicio': round(desperdicio, 2),
            # None: la base tecnica aun no trae los elementos sueltos.
            'sueltos': sueltos,
            # Los modulos que faltan por subir, a su peso medio; None si no falta ninguno.
            'previstos': previstos,
            # Lo que va a obra (el desperdicio no): lo confirmado mas lo previsto.
            'confirmado': confirmado,
            'previsto': previsto_kg,
            'total': None if confirmado is None and previsto_kg is None else round((confirmado or 0) + (previsto_kg or 0), 2),
        },
    }


def planificacion_de(usuario_id, desde=None):
    """Grafica de tres meses, entregas y tarjetas de kilos de una ferralla."""
    desde = desde or timezone.localdate()
    hasta = sumar_meses(desde, MESES_VISTA)
    festivos = festivos_de(usuario_id)
    plan = plan_ferralla(usuario_id, desde)

    # Cada dia laborable, el ritmo de su tramo; pasado el ultimo montaje, nada.
    ritmos = {}
    for tramo in plan['tramos']:
        for dia in dias_laborables(date.fromisoformat(tramo['desde']), date.fromisoformat(tramo['hasta']), festivos):
            ritmos[dia] = tramo['ritmo']
    dias = [
        {'fecha': dia.isoformat(), 'modulos': ritmos.get(dia, 0)}
        for dia in dias_laborables(desde, hasta + timedelta(days=1), festivos)
    ]

    # Lo que la ferralla ve en su dashboard (aceptado y sin archivar): lo que
    # se entrega en estos tres meses y lo que aun no esta hecho (sin fecha o
    # con la entrega ya pasada).
    proyectos = []
    for proyecto in annotated_projects(
        Proyecto.objects.filter(usuario_id=usuario_id, archivado_at__isnull=True, aceptado_por_ferralla_at__isnull=False)
    ).select_related('edificio'):
        entrega = fecha_de_montaje(proyecto)
        if entrega is not None and entrega > hasta:
            continue
        en_vista = entrega is not None and entrega >= desde
        if en_vista or plan['proyectos'][proyecto.pk]['estado'] != 'COMPLETADO':
            proyectos.append(proyecto)
    proyectos.sort(key=lambda p: (fecha_de_montaje(p) or date.max, p.orden_planta, p.nombre))
    kilos = kilos_de_modulos(proyectos)
    medios = pesos_medios(usuario_id)

    entregas = []
    for proyecto in proyectos:
        entrega = fecha_de_montaje(proyecto)
        if entrega is None or entrega < desde:
            continue
        entregas.append({
            'proyecto': proyecto.id,
            'nombre': proyecto.nombre,
            'fecha': entrega.isoformat(),
            'orientativa': not proyecto.fecha_montaje_obra,
            'modulos_pendientes': plan['proyectos'][proyecto.pk]['modulos_pendientes'],
        })
    return {
        'desde': desde.isoformat(),
        'hasta': hasta.isoformat(),
        'dias': dias,
        'festivos': sorted(dia.isoformat() for dia in festivos if desde <= dia <= hasta),
        'tramos': [{'desde': t['desde'], 'hasta': t['hasta'], 'ritmo': t['ritmo']} for t in plan['tramos']],
        'entregas': entregas,
        'proyectos': [
            _tarjeta(proyecto, kilos.get(proyecto.pk), plan['proyectos'][proyecto.pk], medios)
            for proyecto in proyectos
        ],
    }


def _ferralla(usuario):
    return {'id': usuario.id, 'nombre': usuario.first_name or usuario.username}


class PlanificacionFerrallaView(APIView):
    """``GET /api/planificacion/``: la de la propia ferralla; la oficina elige con ``?usuario=``."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not _es_oficina(request.user):
            return Response({'ferrallas': None, 'ferralla': _ferralla(request.user), **planificacion_de(request.user.id)})
        ferrallas = User.objects.filter(
            is_staff=False, is_superuser=False, proyectos__archivado_at__isnull=True,
        ).distinct()
        lista = sorted((_ferralla(usuario) for usuario in ferrallas), key=lambda f: f['nombre'].lower())
        elegida = request.query_params.get('usuario')
        if not elegida:
            return Response({'ferrallas': lista, 'ferralla': None})
        try:
            usuario = ferrallas.get(pk=int(elegida))
        except (ValueError, User.DoesNotExist):
            raise NotFound('Ferralla no encontrada.')
        return Response({'ferrallas': lista, 'ferralla': _ferralla(usuario), **planificacion_de(usuario.id)})

