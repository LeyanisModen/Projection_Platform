"""Planificacion de Moden: todas las ferrallas a seis meses vista.

Lo que mira Moden es cuantos modulos al dia tendria que fabricar cada ferralla
para llegar a sus entregas (el plan por tramos de montaje de ``api.planning``),
con su trabajo real y sumandole los proyectos fantasma: los que Moden simula
para ver si esa ferralla los aguantaria. La capacidad la deciden ellos fuera de
la plataforma (turnos, mesas): aqui solo sale el ritmo necesario.
"""
from datetime import date, timedelta

from django.contrib.auth.models import User
from django.db.models import Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Proyecto
from .planificacion import _es_oficina, _ferralla, _tarjeta, kilos_de_modulos, pesos_medios, sumar_meses
from .planning import annotated_projects, dias_laborables, fecha_de_montaje, festivos_de, plan_ferralla

MESES_VISTA = 6


def _ritmo_por_dia(plan, festivos):
    """Cada dia laborable, el ritmo de su tramo; pasado el ultimo montaje, nada."""
    ritmos = {}
    for tramo in plan['tramos']:
        for dia in dias_laborables(date.fromisoformat(tramo['desde']), date.fromisoformat(tramo['hasta']), festivos):
            ritmos[dia] = tramo['ritmo']
    return ritmos


def planificacion_ferralla(usuario, desde, hasta):
    festivos = festivos_de(usuario.id)
    real = plan_ferralla(usuario.id, desde)
    con_fantasmas = plan_ferralla(usuario.id, desde, con_fantasmas=True)
    ritmo_real = _ritmo_por_dia(real, festivos)
    ritmo_con = _ritmo_por_dia(con_fantasmas, festivos)
    dias = [
        {'fecha': dia.isoformat(), 'real': ritmo_real.get(dia, 0), 'con_fantasmas': ritmo_con.get(dia, 0)}
        for dia in dias_laborables(desde, hasta + timedelta(days=1), festivos)
    ]

    # Lo que se entrega en estos seis meses y lo que aun no esta hecho (sin
    # fecha o con la entrega ya pasada), aceptado o no por la ferralla.
    proyectos = []
    for proyecto in annotated_projects(
        Proyecto.objects.filter(usuario=usuario, archivado_at__isnull=True)
    ).select_related('edificio'):
        entrega = fecha_de_montaje(proyecto)
        if entrega is not None and entrega > hasta:
            continue
        en_vista = entrega is not None and entrega >= desde
        if en_vista or con_fantasmas['proyectos'][proyecto.pk]['estado'] != 'COMPLETADO':
            proyectos.append(proyecto)
    proyectos.sort(key=lambda p: (fecha_de_montaje(p) or date.max, p.orden_planta, p.nombre))
    kilos = kilos_de_modulos(proyectos)
    medios = pesos_medios(usuario.id, con_fantasmas=True)

    filas = []
    for proyecto in proyectos:
        plan = con_fantasmas['proyectos'][proyecto.pk]
        fila = _tarjeta(proyecto, kilos.get(proyecto.pk), plan, medios)
        fila.update({
            'fantasma': proyecto.fantasma,
            'pendiente_aceptar': not proyecto.fantasma and proyecto.aceptado_por_ferralla_at is None,
            'modulos_pendientes': plan['modulos_pendientes'],
        })
        filas.append(fila)

    entregas = [
        {
            'proyecto': fila['id'],
            'nombre': fila['nombre'],
            'fecha': fila['fecha_entrega'],
            'orientativa': fila['entrega_orientativa'],
            'fantasma': fila['fantasma'],
            'modulos_pendientes': fila['modulos_pendientes'],
        }
        for fila in filas
        if fila['fecha_entrega'] and fila['fecha_entrega'] >= desde.isoformat()
    ]

    def suma(campo, fantasma):
        return sum(fila[campo] or 0 for fila in filas if fila['fantasma'] == fantasma)

    def kilos_de(fantasma):
        return round(sum(fila['kilos']['total'] or 0 for fila in filas if fila['fantasma'] == fantasma), 2)

    return {
        'ferralla': _ferralla(usuario),
        'dias': dias,
        'festivos': sorted(dia.isoformat() for dia in festivos if desde <= dia <= hasta),
        'entregas': entregas,
        'proyectos': filas,
        'resumen': {
            # Lo que hay que sacar al dia en el tramo mas apretado (el primero).
            'ritmo_real': real['ritmo'],
            'ritmo_con_fantasmas': con_fantasmas['ritmo'],
            'manda_real': real.get('manda_nombre'),
            'manda_con_fantasmas': con_fantasmas.get('manda_nombre'),
            'fantasmas': sum(fila['fantasma'] for fila in filas),
            'modulos_real': suma('modulos_pendientes', False),
            'modulos_fantasmas': suma('modulos_pendientes', True),
            'kilos_real': kilos_de(False),
            'kilos_fantasmas': kilos_de(True),
        },
    }


def ferrallas():
    """Las ferrallas con mesas o con algun proyecto vivo, por nombre."""
    usuarios = User.objects.filter(is_staff=False, is_superuser=False, is_active=True).filter(
        Q(mesas__isnull=False) | Q(proyectos__archivado_at__isnull=True, proyectos__isnull=False)
    ).distinct()
    return sorted(usuarios, key=lambda u: (u.first_name or u.username).lower())


def planificacion_moden(desde=None):
    desde = desde or timezone.localdate()
    hasta = sumar_meses(desde, MESES_VISTA)
    return {
        'desde': desde.isoformat(),
        'hasta': hasta.isoformat(),
        'ferrallas': [planificacion_ferralla(usuario, desde, hasta) for usuario in ferrallas()],
    }


class PlanificacionModenView(APIView):
    """``GET /api/planificacion-moden/``: solo la oficina."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not _es_oficina(request.user):
            return Response({'detail': 'Solo la oficina.'}, status=403)
        return Response(planificacion_moden())
