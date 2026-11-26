"""Planificacion de Moden: todas las ferrallas a seis meses vista.

Lo que mira Moden es cuantos modulos al dia tendria que fabricar cada ferralla
para llegar a sus entregas (el plan por tramos de montaje de ``api.planning``),
con su trabajo real y sumandole los proyectos fantasma: los que Moden simula
para ver si esa ferralla los aguantaria. La capacidad la deciden ellos fuera de
la plataforma (turnos, mesas): aqui solo sale el ritmo necesario.

Se ve una ferralla cada vez (``?ferralla=``); sin decir cual, la que mas
fabrico el ultimo dia con fabricacion. Dos pestanas (``?vista=``):

1. El plan de siempre, el minimo que se le pide a la ferralla, y lo que eso
   deja en su patio si cada obra sale entera el dia antes de su montaje y
   cuando se fabrica cada obra. Informa; como se apanan, es cosa suya.
2. Con lo que cabe en su patio y los camiones de cada obra (api/acopio.py):
   donde frena, que sale de mas y que no llega.
"""
from datetime import date, timedelta

from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from .acopio import acopio_para_grafica, capacidad_el, capacidades_de, modulos_dia_max_de
from .models import AcopioCapacidad, Camion, Modulo, Proyecto, UserProfile
from .planificacion import _es_oficina, _ferralla, _tarjeta, kilos_de_modulos, pesos_medios, sumar_meses
from .planning import (
    PATIO_AL_MONTAJE, PATIO_LIMITA, annotated_projects, dias_laborables, fecha_de_montaje, festivos_de,
    plan_ferralla,
)

MESES_VISTA = 6
# Hasta cuantos dias atras se busca el ultimo dia con fabricacion.
DIAS_ULTIMA_FABRICACION = 14
# Las dos pestanas de la planificacion de Moden.
VISTA_MINIMO = 1
VISTA_PATIO = 2


def _ritmo_por_dia(plan, festivos):
    """Cada dia laborable, el ritmo de su tramo; pasado el ultimo montaje, nada."""
    ritmos = {}
    for tramo in plan['tramos']:
        for dia in dias_laborables(date.fromisoformat(tramo['desde']), date.fromisoformat(tramo['hasta']), festivos):
            ritmos[dia] = tramo['ritmo']
    return ritmos


def _sobrecargas(plan, hasta):
    return [
        {'fecha': dia.isoformat(), 'camiones': round(camiones, 1)}
        for dia, camiones in plan['sobrecargas'] if dia <= hasta
    ]


def planificacion_ferralla(usuario, desde, hasta, vista=VISTA_MINIMO):
    festivos = festivos_de(usuario.id)
    patio = PATIO_LIMITA if vista == VISTA_PATIO else PATIO_AL_MONTAJE
    real = plan_ferralla(usuario.id, desde, patio=patio)
    con_fantasmas = plan_ferralla(usuario.id, desde, con_fantasmas=True, patio=patio)
    ritmo_real = _ritmo_por_dia(real, festivos)
    ritmo_con = _ritmo_por_dia(con_fantasmas, festivos)
    dias_vista = list(dias_laborables(desde, hasta + timedelta(days=1), festivos))
    dias = [
        {'fecha': dia.isoformat(), 'real': ritmo_real.get(dia, 0), 'con_fantasmas': ritmo_con.get(dia, 0)}
        for dia in dias_vista
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
            # Cuando se fabrica y (en la vista del patio) cuando salen sus
            # camiones, con lo que esta en estudio.
            'fabricacion_inicio': plan['fabricacion_inicio'],
            'fabricacion_fin': plan['fabricacion_fin'],
        })
        if vista == VISTA_PATIO:
            fila['envio'] = con_fantasmas['envios'].get(proyecto.pk)
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

    datos = {
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
            # Si el ritmo de hoy lo frena el patio lleno, hasta cuando.
            'acopio_frena_real': _frena(real),
            'acopio_frena_con_fantasmas': _frena(con_fantasmas),
            'fantasmas': sum(fila['fantasma'] for fila in filas),
            'modulos_real': suma('modulos_pendientes', False),
            'modulos_fantasmas': suma('modulos_pendientes', True),
            'kilos_real': kilos_de(False),
            'kilos_fantasmas': kilos_de(True),
        },
    }
    if vista != VISTA_PATIO:
        # Lo que habria en el patio si cada obra sale entera el dia antes de su montaje.
        datos['patio'] = _patio_al_montaje(usuario, real, con_fantasmas, dias_vista)
        return datos
    datos.update({
        'acopio': _acopio(real, con_fantasmas, dias_vista),
        # Lo que puede fabricar al dia como mucho (Moden) y, con eso y el patio, lo que no llega.
        'modulos_dia_max': modulos_dia_max_de(usuario.id),
        'no_llegan_real': real['no_llegan'],
        'no_llegan_con_fantasmas': con_fantasmas['no_llegan'],
        'camiones': {
            'por_dia': con_fantasmas['camiones_por_dia'],
            # Dias en que salen mas camiones de los que puede: con lo real y con lo que esta en estudio.
            'sobrecargas_real': _sobrecargas(real, hasta),
            'sobrecargas_con_fantasmas': _sobrecargas(con_fantasmas, hasta),
        },
    })
    return datos


def _patio_al_montaje(usuario, real, con_fantasmas, dias):
    """Bastidores en el patio cada dia con lo real y con lo que esta en
    estudio, y lo que cabe (None si Moden no lo ha dicho), solo para verlo."""
    capacidades = capacidades_de(usuario.id)

    def en_patio(plan, dia):
        return round(plan['acopio'].ocupacion(dia)[0], 1) if plan['acopio'] else 0.0

    return {
        'capacidades': [{'desde': d.isoformat(), 'bastidores': b} for d, b in capacidades],
        'dias': [{
            'fecha': dia.isoformat(),
            'real': en_patio(real, dia),
            'con_fantasmas': en_patio(con_fantasmas, dia),
            'capacidad': capacidad_el(dia, capacidades),
        } for dia in dias],
    }


def _frena(plan):
    tramos = plan['tramos']
    return tramos[0]['hasta'] if tramos and tramos[0].get('motivo') == 'acopio' else None


def _acopio(real, con_fantasmas, dias):
    """El patio cada dia con lo real y con los proyectos en estudio; None sin capacidad."""
    solo_real = acopio_para_grafica(real['acopio'], dias)
    con = acopio_para_grafica(con_fantasmas['acopio'], dias)
    if solo_real is None and con is None:
        return None
    # Sin nada real (o solo real) el otro lado esta vacio.
    vacio = {'excesos': [], 'dias': [{'bastidores': 0.0} for _dia in dias]}
    solo_real, con = solo_real or {**con, **vacio}, con or {**solo_real, **vacio}
    def llenos(plan):
        acopio = plan['acopio']
        return [dia.isoformat() for dia in (acopio.llenos if acopio else [])]

    return {
        'capacidades': solo_real['capacidades'],
        'excesos_real': solo_real['excesos'],
        'excesos_con_fantasmas': con['excesos'],
        # Dias que empiezan con el patio lleno: solo se fabrica lo que sale.
        'llenos_real': llenos(real),
        'llenos_con_fantasmas': llenos(con_fantasmas),
        'dias': [
            {'fecha': a['fecha'], 'real': a['bastidores'], 'con_fantasmas': b['bastidores'], 'capacidad': a['capacidad']}
            for a, b in zip(solo_real['dias'], con['dias'])
        ],
    }


def ferrallas():
    """Las ferrallas con mesas o con algun proyecto vivo, por nombre."""
    usuarios = User.objects.filter(is_staff=False, is_superuser=False, is_active=True).filter(
        Q(mesas__isnull=False) | Q(proyectos__archivado_at__isnull=True, proyectos__isnull=False)
    ).distinct()
    return sorted(usuarios, key=lambda u: (u.first_name or u.username).lower())


def ferralla_por_defecto(lista, hoy):
    """La que mas modulos termino el ultimo dia con fabricacion antes de hoy
    (ayer, o el viernes un lunes); sin fabricacion en dos semanas, la que mas
    tiene por fabricar; si no, la primera."""
    if not lista:
        return None
    por_id = {usuario.pk: usuario for usuario in lista}
    hechos = Modulo.objects.filter(
        proyecto__usuario__in=lista,
        completado_at__date__lt=hoy,
        completado_at__date__gte=hoy - timedelta(days=DIAS_ULTIMA_FABRICACION),
    )
    ultimo = hechos.order_by('-completado_at').values_list('completado_at', flat=True).first()
    if ultimo is not None:
        dia = timezone.localtime(ultimo).date()
        cuentas = hechos.filter(completado_at__date=dia).values('proyecto__usuario').annotate(n=Count('id'))
    else:
        cuentas = (
            Modulo.objects.filter(proyecto__usuario__in=lista, proyecto__archivado_at__isnull=True, proyecto__fantasma=False)
            .exclude(estado__in=['COMPLETADO', 'CERRADO'])
            .values('proyecto__usuario').annotate(n=Count('id'))
        )
    orden = {usuario.pk: indice for indice, usuario in enumerate(lista)}
    mejor = sorted(cuentas, key=lambda c: (-c['n'], orden[c['proyecto__usuario']]))
    return por_id[mejor[0]['proyecto__usuario']] if mejor else lista[0]


def planificacion_moden(desde=None, vista=VISTA_MINIMO, ferralla=None):
    """La planificacion de una ferralla (``ferralla``: su id; sin el o si no
    esta, la de ``ferralla_por_defecto``) y la lista para elegir otra."""
    desde = desde or timezone.localdate()
    hasta = sumar_meses(desde, MESES_VISTA)
    lista = ferrallas()
    elegida = next((usuario for usuario in lista if usuario.pk == ferralla), None) or ferralla_por_defecto(lista, desde)
    return {
        'desde': desde.isoformat(),
        'hasta': hasta.isoformat(),
        'vista': vista,
        'opciones': [_ferralla(usuario) for usuario in lista],
        'elegida': elegida.pk if elegida else None,
        'ferrallas': [planificacion_ferralla(elegida, desde, hasta, vista)] if elegida else [],
    }


class PlanificacionModenView(APIView):
    """``GET /api/planificacion-moden/?vista=1|2&ferralla=<id>``: la pestana 1
    (el minimo, por defecto) o la 2 (con el patio y los camiones) de una
    ferralla. Solo la oficina."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not _es_oficina(request.user):
            return Response({'detail': 'Solo la oficina.'}, status=403)
        vista = VISTA_PATIO if request.query_params.get('vista') == str(VISTA_PATIO) else VISTA_MINIMO
        try:
            ferralla = int(request.query_params.get('ferralla') or 0) or None
        except ValueError:
            ferralla = None
        return Response(planificacion_moden(vista=vista, ferralla=ferralla))


MAX_CAPACIDADES = 50
MAX_MODULOS_DIA = 1000


def _ferralla_o_404(request, usuario_id):
    if not _es_oficina(request.user):
        return None, Response({'detail': 'Solo la oficina.'}, status=403)
    usuario = User.objects.filter(pk=usuario_id, is_staff=False, is_superuser=False).first()
    if usuario is None:
        return None, Response({'detail': 'Ferralla no encontrada.'}, status=404)
    return usuario, None


MAX_CAMIONES_DIA = 50
MAX_DIAS_ENVIO = 60


class CamionesFerrallaView(APIView):
    """``/api/planificacion-moden/camiones/<usuario>/``, solo la oficina.

    GET: los camiones de cada forjado por montar, como en su ficha
    (``acopio.camiones_de_la_ferralla``); se cambian con el PUT de cada
    proyecto. PUT: los camiones que saca la ferralla al dia y en cuantos dias
    salen los de cada forjado. {camiones_por_dia, proyectos: [{id,
    dias_envio}]} (``dias_envio`` vacio: los justos). Al cambiar los dias de
    un forjado, sus camiones por enviar vuelven al reparto aunque se movieran
    en la ficha."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, usuario_id):
        from .acopio import camiones_de_la_ferralla

        usuario, error = _ferralla_o_404(request, usuario_id)
        if error:
            return error
        return Response(camiones_de_la_ferralla(usuario.pk))

    def put(self, request, usuario_id):
        usuario, error = _ferralla_o_404(request, usuario_id)
        if error:
            return error
        datos = request.data if isinstance(request.data, dict) else {}
        por_dia = datos.get('camiones_por_dia')
        filas = datos.get('proyectos', [])
        if not isinstance(filas, list):
            return Response({'detail': 'Envia {camiones_por_dia, proyectos: [{id, dias_envio}]}.'}, status=400)
        try:
            por_dia = None if por_dia is None else int(por_dia)
            cambios = {int(fila['id']): (None if fila.get('dias_envio') in (None, '') else int(fila['dias_envio']))
                       for fila in filas}
        except (KeyError, TypeError, ValueError):
            return Response({'detail': 'Los camiones al dia y los dias de envio son numeros.'}, status=400)
        if por_dia is not None and not 1 <= por_dia <= MAX_CAMIONES_DIA:
            return Response({'detail': f'Los camiones al dia van de 1 a {MAX_CAMIONES_DIA}.'}, status=400)
        if any(dias is not None and not 1 <= dias <= MAX_DIAS_ENVIO for dias in cambios.values()):
            return Response({'detail': f'Los dias de envio van de 1 a {MAX_DIAS_ENVIO}.'}, status=400)
        proyectos = {p.pk: p for p in Proyecto.objects.filter(usuario=usuario, archivado_at__isnull=True, pk__in=cambios)}
        if len(proyectos) != len(cambios):
            return Response({'detail': 'Algun proyecto no es de esta ferralla o esta archivado.'}, status=400)
        with transaction.atomic():
            if por_dia is not None and not UserProfile.objects.filter(user=usuario).update(camiones_por_dia=por_dia):
                UserProfile.objects.create(user=usuario, camiones_por_dia=por_dia)
            for pk, dias in cambios.items():
                if proyectos[pk].dias_envio != dias:
                    # update(): sin las senales de guardar un proyecto.
                    Proyecto.objects.filter(pk=pk).update(dias_envio=dias)
                    Camion.objects.filter(proyecto_id=pk, enviado=False).update(fecha=None)
        perfil = UserProfile.objects.filter(user=usuario).values_list('camiones_por_dia', flat=True).first()
        return Response({
            'camiones_por_dia': perfil or 4,
            'proyectos': [{'id': pk, 'dias_envio': dias} for pk, dias in sorted(cambios.items())],
        })


class AcopioCapacidadView(APIView):
    """``GET/PUT /api/planificacion-moden/acopio/<usuario>/``: los bastidores que
    caben en el patio de una ferralla, por fechas. PUT {capacidades: [{desde,
    bastidores}], modulos_dia_max} las sustituye todas (lista vacia: sin
    limite) y, si viene, lo que fabrica al dia como mucho (vacio: no se sabe).
    Solo la oficina."""

    permission_classes = [permissions.IsAuthenticated]

    def _lista(self, usuario_id):
        return [{'desde': d.isoformat(), 'bastidores': b} for d, b in capacidades_de(usuario_id)]

    def get(self, request, usuario_id):
        usuario, error = _ferralla_o_404(request, usuario_id)
        return error or Response(self._lista(usuario.pk))

    def put(self, request, usuario_id):
        usuario, error = _ferralla_o_404(request, usuario_id)
        if error:
            return error
        filas = request.data.get('capacidades') if isinstance(request.data, dict) else None
        if not isinstance(filas, list) or len(filas) > MAX_CAPACIDADES:
            return Response({'detail': 'Envia {capacidades: [{desde, bastidores}]}.'}, status=400)
        cambia_maximo = 'modulos_dia_max' in request.data
        maximo = request.data.get('modulos_dia_max')
        if cambia_maximo and maximo not in (None, ''):
            try:
                maximo = int(maximo)
            except (TypeError, ValueError):
                return Response({'detail': 'Lo que fabrican al dia es un numero.'}, status=400)
            if not 1 <= maximo <= MAX_MODULOS_DIA:
                return Response({'detail': f'Lo que fabrican al dia va de 1 a {MAX_MODULOS_DIA} modulos.'}, status=400)
        else:
            maximo = None
        limpias = {}
        for fila in filas:
            try:
                desde = date.fromisoformat(str(fila.get('desde')))
                bastidores = int(fila.get('bastidores'))
            except (AttributeError, TypeError, ValueError):
                return Response({'detail': 'Cada capacidad necesita una fecha y un numero de bastidores.'}, status=400)
            if bastidores < 0 or bastidores > 100000:
                return Response({'detail': 'Los bastidores tienen que ser 0 o mas.'}, status=400)
            if desde in limpias:
                return Response({'detail': f'Hay dos capacidades para el {desde:%d/%m/%Y}.'}, status=400)
            limpias[desde] = bastidores
        with transaction.atomic():
            if cambia_maximo and not UserProfile.objects.filter(user=usuario).update(modulos_dia_max=maximo):
                UserProfile.objects.create(user=usuario, modulos_dia_max=maximo)
            AcopioCapacidad.objects.filter(usuario=usuario).delete()
            AcopioCapacidad.objects.bulk_create([
                AcopioCapacidad(usuario=usuario, desde=desde, bastidores=bastidores)
                for desde, bastidores in sorted(limpias.items())
            ])
        return Response(self._lista(usuario.pk))
