"""Seguimiento de una ferralla desde el admin: si esta trabajando ahora, su
turno y que proyectos tiene en las mesas.

Lo que lleva hecho en el dia (o la semana, el mes) no sale de aqui: son las
estadisticas de siempre con ``?usuario=``, las mismas cifras que ve ella.
"""
from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from .actividad import UMBRAL_EVENTOS, UMBRAL_FOTOS, senales_por_mesa
from .models import EventoFabricacion, FotoFabricacion, Mesa, MesaQueueItem, MesaQueueStatus, Proyecto
from .pausas import pausa_activa
from .planificacion import _es_oficina, _ferralla
from .planificacion_moden import ferrallas
from .planning import festivos_de
from .turnos import Jornada, vigencias_de


def _hora(momento):
    return timezone.localtime(momento).isoformat() if momento else None


def _tramo(tramo):
    if tramo is None:
        return None
    return {'nombre': tramo.turno.nombre, 'inicio': _hora(tramo.inicio), 'fin': _hora(tramo.fin)}


def ahora_de(usuario, ahora=None):
    """Como esta la ferralla en este momento (con el mismo criterio que las estadisticas:
    una mesa trabaja si su ultima senal es de hace menos de 20 minutos, 45 si es una foto)."""
    ahora = ahora or timezone.now()
    mesas = list(Mesa.objects.filter(usuario=usuario, activa=True).order_by('tipo', 'indice', 'id'))
    ids = [mesa.id for mesa in mesas]

    senales = senales_por_mesa(ids, ahora - UMBRAL_FOTOS, ahora + timedelta(minutes=1))
    trabajando = sum(
        1 for mesa in mesas
        if any(ahora - momento <= (UMBRAL_FOTOS if tipo == 'foto' else UMBRAL_EVENTOS) for momento, tipo in senales[mesa.id])
    )
    ultimas = [
        EventoFabricacion.objects.filter(mesa_id__in=ids, at__lte=ahora).order_by('-at').values_list('at', flat=True).first(),
        FotoFabricacion.objects.filter(mesa_id__in=ids, capturada_at__lte=ahora)
        .order_by('-capturada_at').values_list('capturada_at', flat=True).first(),
        MesaQueueItem.objects.filter(mesa_id__in=ids, status=MesaQueueStatus.HECHO, done_at__lte=ahora)
        .order_by('-done_at').values_list('done_at', flat=True).first(),
    ]
    ultimas = [momento for momento in ultimas if momento is not None]

    hoy = timezone.localtime(ahora).date()
    profile = getattr(usuario, 'profile', None)
    jornada = Jornada(vigencias_de(usuario.id, profile), hoy - timedelta(days=1), hoy + timedelta(days=8), festivos_de(usuario.id))
    siguiente = next((tramo for tramo in jornada.tramos if tramo.inicio > ahora), None)

    # Lo que hay en las mesas: el proyecto de cada fase que estan mostrando.
    en_mesa = []
    for proyecto_id in (
        MesaQueueItem.objects.filter(mesa_id__in=ids, status=MesaQueueStatus.MOSTRANDO)
        .order_by('mesa__tipo', 'mesa__indice', 'mesa_id').values_list('modulo__proyecto_id', flat=True)
    ):
        if proyecto_id not in en_mesa:
            en_mesa.append(proyecto_id)
    proyectos = {
        proyecto.id: proyecto
        for proyecto in Proyecto.objects.filter(pk__in=en_mesa).annotate(
            total=Count('modulos'), terminados=Count('modulos', filter=Q(modulos__completado_at__isnull=False)),
        )
    }

    return {
        'ahora': _hora(ahora),
        'mesas': len(mesas),
        'mesas_trabajando': trabajando,
        'mesas_en_pausa': sum(1 for mesa in mesas if pausa_activa(mesa, ahora)),
        'ultima_senal': _hora(max(ultimas)) if ultimas else None,
        'turno': _tramo(jornada.tramo_de(ahora)),
        'siguiente_turno': _tramo(siguiente),
        'en_mesa': [
            {
                'id': proyecto.id,
                'nombre': proyecto.nombre,
                'modulos': proyecto.total,
                'terminados': proyecto.terminados,
                'fecha_montaje': proyecto.fecha_montaje.isoformat() if proyecto.fecha_montaje else None,
            }
            for proyecto in (proyectos[pk] for pk in en_mesa if pk in proyectos)
        ],
    }


class SeguimientoFerrallaView(APIView):
    """``GET /api/seguimiento/``: solo la oficina; la ferralla se elige con ``?usuario=``."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not _es_oficina(request.user):
            return Response({'detail': 'Solo la oficina.'}, status=403)
        lista = ferrallas()
        elegida = request.query_params.get('usuario')
        datos = {'ferrallas': [_ferralla(usuario) for usuario in lista], 'ferralla': None}
        if not elegida:
            return Response(datos)
        usuario = next((u for u in lista if str(u.id) == str(elegida)), None)
        if usuario is None:
            raise NotFound('Ferralla no encontrada.')
        return Response({**datos, 'ferralla': _ferralla(usuario), **ahora_de(usuario)})
