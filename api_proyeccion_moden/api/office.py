"""Internal project checklists, staff and calendar endpoints."""
from datetime import date

from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from rest_framework import serializers, viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from .models import (Proyecto, ProyectoCheck, ProyectoCheckAdjunto,
                     ProyectoCheckDefinicion, TrabajadorOficina, EventoCalendario)

# Documento de confirmacion por paso: correos exportados, PDF, capturas...
CHECK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024


# ---------------------------------------------------------------------------
# Lista de control maestra (plantilla)
# ---------------------------------------------------------------------------
class CheckDefinitionSerializer(serializers.ModelSerializer):
    requisitos = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=ProyectoCheckDefinicion.objects.all(),
    )

    class Meta:
        model = ProyectoCheckDefinicion
        fields = [
            'id', 'titulo', 'orden', 'requiere_fecha', 'requiere_documento',
            'dias_antes_montaje', 'bloquea_produccion', 'requisitos',
        ]
        extra_kwargs = {'orden': {'required': False}}

    def validate_titulo(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Indica un titulo para el paso.')
        duplicados = ProyectoCheckDefinicion.objects.filter(titulo__iexact=value)
        if self.instance:
            duplicados = duplicados.exclude(pk=self.instance.pk)
        if duplicados.exists():
            raise serializers.ValidationError('Ya hay un paso con ese titulo.')
        return value

    def validate_requisitos(self, value):
        if self.instance and self.instance in value:
            raise serializers.ValidationError('Un paso no puede requerirse a si mismo.')
        return value

    def validate(self, attrs):
        # Un plazo relativo a D solo tiene sentido con fecha limite.
        dias = attrs.get('dias_antes_montaje', getattr(self.instance, 'dias_antes_montaje', None))
        if dias is not None:
            attrs['requiere_fecha'] = True
        return attrs


class CheckDefinitionViewSet(viewsets.ModelViewSet):
    """CRUD de la lista maestra. Cada cambio se propaga a todos los proyectos."""
    queryset = ProyectoCheckDefinicion.objects.all()
    serializer_class = CheckDefinitionSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    @transaction.atomic
    def perform_create(self, serializer):
        if 'orden' in serializer.validated_data:
            serializer.save()
        else:
            siguiente = (ProyectoCheckDefinicion.objects.aggregate(m=Max('orden'))['m'] or 0) + 1
            serializer.save(orden=siguiente)
        propagar_definicion(serializer.instance)

    @transaction.atomic
    def perform_update(self, serializer):
        serializer.save()
        propagar_definicion(serializer.instance)

    @transaction.atomic
    def perform_destroy(self, instance):
        retirar_definicion(instance)
        instance.delete()

    @action(detail=False, methods=['post'])
    @transaction.atomic
    def reorder(self, request):
        """Recibe {"ids": [...]} con el orden completo deseado."""
        ids = request.data.get('ids')
        if not isinstance(ids, list) or not all(isinstance(i, int) for i in ids):
            raise ValidationError({'ids': 'Envia la lista de ids en el orden deseado.'})
        existentes = set(ProyectoCheckDefinicion.objects.values_list('id', flat=True))
        if set(ids) != existentes or len(ids) != len(existentes):
            raise ValidationError({'ids': 'La lista debe incluir todos los pasos exactamente una vez.'})
        for posicion, pk in enumerate(ids, start=1):
            ProyectoCheckDefinicion.objects.filter(pk=pk).update(orden=posicion)
            ProyectoCheck.objects.filter(definicion_id=pk).update(orden=posicion)
        return Response(CheckDefinitionSerializer(ProyectoCheckDefinicion.objects.all(), many=True).data)


# ---------------------------------------------------------------------------
# Lista de control de cada proyecto
# ---------------------------------------------------------------------------
def _clave_titulo(titulo):
    return (titulo or '').strip().casefold()


def _campos_copia(definicion, proyecto):
    """Campos de ProyectoCheck que siguen a la definicion."""
    return {
        'titulo': definicion.titulo,
        'orden': definicion.orden,
        'origen': ProyectoCheck.Origen.PLANTILLA,
        # Un plazo relativo implica fecha limite aunque la plantilla se haya
        # creado sin la marca (ORM, admin).
        'requiere_fecha': definicion.requiere_fecha or definicion.dias_antes_montaje is not None,
        'requiere_documento': definicion.requiere_documento,
        'dias_antes_montaje': definicion.dias_antes_montaje,
        'bloquea_produccion': definicion.bloquea_produccion,
    }


def _sincronizar_requisitos(definiciones, proyectos):
    """Los requisitos del proyecto son las copias de los requisitos de la plantilla."""
    for proyecto in proyectos:
        copias = {c.definicion_id: c for c in proyecto.checks.filter(definicion__isnull=False)}
        for definicion in definiciones:
            copia = copias.get(definicion.id)
            if copia is None:
                continue
            copia.requisitos.set([copias[r.id] for r in definicion.requisitos.all() if r.id in copias])


def sembrar_checklist(proyecto):
    """Proyecto nuevo: copia de toda la lista maestra. Devuelve cuantos pasos crea."""
    definiciones = list(ProyectoCheckDefinicion.objects.prefetch_related('requisitos'))
    existentes = set(proyecto.checks.filter(definicion__isnull=False).values_list('definicion_id', flat=True))
    titulos = {_clave_titulo(t) for t in proyecto.checks.values_list('titulo', flat=True)}
    nuevos = []
    for definicion in definiciones:
        if definicion.id in existentes or _clave_titulo(definicion.titulo) in titulos:
            continue
        nuevos.append(ProyectoCheck(
            proyecto=proyecto, definicion=definicion,
            fecha_limite=ProyectoCheck.fecha_limite_para(proyecto.fecha_montaje, definicion.dias_antes_montaje),
            **_campos_copia(definicion, proyecto),
        ))
    if nuevos:
        ProyectoCheck.objects.bulk_create(nuevos)
    _sincronizar_requisitos(definiciones, [proyecto])
    return len(nuevos)


def propagar_definicion(definicion):
    """Paso creado o editado en la lista maestra: todos los proyectos lo siguen.

    Crea la copia donde falte y actualiza titulo, orden, marcas, plazo y
    bloqueo donde exista. La fecha limite solo se recalcula en copias
    pendientes con plazo relativo; lo completado no se toca.
    """
    proyectos = list(Proyecto.objects.all())
    for proyecto in proyectos:
        copia = proyecto.checks.filter(definicion=definicion).first()
        if copia is None:
            # Pasos sembrados antes de existir el enlace: se reconocen por titulo.
            copia = proyecto.checks.filter(
                definicion__isnull=True, origen=ProyectoCheck.Origen.PLANTILLA,
                titulo__iexact=definicion.titulo,
            ).first()
        campos = _campos_copia(definicion, proyecto)
        if copia is None:
            ProyectoCheck.objects.create(
                proyecto=proyecto, definicion=definicion,
                fecha_limite=ProyectoCheck.fecha_limite_para(proyecto.fecha_montaje, definicion.dias_antes_montaje),
                **campos,
            )
            continue
        for campo, valor in campos.items():
            setattr(copia, campo, valor)
        copia.definicion = definicion
        if not copia.completado:
            if not copia.requiere_fecha:
                copia.fecha_limite = None
            elif definicion.dias_antes_montaje is not None:
                copia.fecha_limite = ProyectoCheck.fecha_limite_para(
                    proyecto.fecha_montaje, definicion.dias_antes_montaje,
                )
        copia.save()
    _sincronizar_requisitos(
        list(ProyectoCheckDefinicion.objects.prefetch_related('requisitos')), proyectos,
    )


def retirar_definicion(definicion):
    """Paso borrado de la lista maestra.

    Las copias pendientes y sin documentos desaparecen; las completadas o con
    documentos se conservan como pasos propios del proyecto.
    """
    copias = ProyectoCheck.objects.filter(definicion=definicion)
    conservar = copias.filter(Q(completado=True) | Q(adjuntos__isnull=False)).distinct()
    conservar.update(origen=ProyectoCheck.Origen.MANUAL, definicion=None)
    copias.delete()


def recalcular_fechas_checklist(proyecto):
    """Fecha de montaje nueva: recalcula los pasos pendientes con plazo relativo.

    Los completados y los pasos sin plazo relativo (fecha puesta a mano) no
    se tocan. Devuelve cuantos pasos han cambiado de fecha.
    """
    cambiados = 0
    for paso in proyecto.checks.filter(completado=False, dias_antes_montaje__isnull=False):
        nueva = ProyectoCheck.fecha_limite_para(proyecto.fecha_montaje, paso.dias_antes_montaje)
        if nueva != paso.fecha_limite:
            paso.fecha_limite = nueva
            paso.save(update_fields=['fecha_limite'])
            cambiados += 1
    return cambiados


def checks_bloqueantes_pendientes(proyecto):
    """Titulos de los pasos que impiden meter el proyecto en produccion."""
    return list(
        proyecto.checks.filter(bloquea_produccion=True, completado=False)
        .order_by('orden', 'id').values_list('titulo', flat=True)
    )


class ProjectCheckAttachmentSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    subido_por = serializers.SerializerMethodField()

    class Meta:
        model = ProyectoCheckAdjunto
        fields = ['id', 'nombre_original', 'tamano', 'url', 'subido_at', 'subido_por']

    def get_url(self, obj):
        # Ruta relativa: pasa por el nginx del frontend con la cookie de /media/.
        return obj.archivo.url if obj.archivo else None

    def get_subido_por(self, obj):
        return obj.subido_por.get_username() if obj.subido_por else None


class ProjectCheckSerializer(serializers.ModelSerializer):
    completado_por = serializers.SerializerMethodField()
    adjuntos = ProjectCheckAttachmentSerializer(many=True, read_only=True)
    requisitos = serializers.PrimaryKeyRelatedField(many=True, read_only=True)
    requisitos_pendientes = serializers.SerializerMethodField()

    class Meta:
        model = ProyectoCheck
        fields = [
            'id', 'titulo', 'orden', 'origen', 'definicion',
            'requiere_fecha', 'requiere_documento', 'fecha_limite',
            'dias_antes_montaje', 'bloquea_produccion', 'requisitos', 'requisitos_pendientes',
            'completado', 'completado_at', 'completado_por', 'creado_at', 'adjuntos',
        ]
        read_only_fields = [
            'orden', 'origen', 'definicion', 'dias_antes_montaje', 'bloquea_produccion',
            'completado_at', 'completado_por', 'creado_at',
        ]

    def get_completado_por(self, obj):
        return obj.completado_por.get_username() if obj.completado_por else None

    def get_requisitos_pendientes(self, obj):
        return [r.titulo for r in obj.requisitos.all() if not r.completado]

    def validate_titulo(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Indica un titulo para el paso.')
        return value

    def validate(self, attrs):
        # Sin fecha requerida no hay fecha limite: se limpia para que no quede
        # una fecha fantasma en el calendario.
        requiere = attrs.get('requiere_fecha', getattr(self.instance, 'requiere_fecha', False))
        if not requiere:
            attrs['fecha_limite'] = None
        return attrs


class ProjectChecklistViewSet(viewsets.GenericViewSet):
    """GET lista, POST checks/ (manual), PATCH/DELETE checks/<id>/,
    POST/DELETE checks/<id>/adjuntos[/<id>]/, GET vencimientos/.

    Todas las mutaciones devuelven la lista completa para que el front la
    sustituya sin recomponer estado.
    """
    queryset = Proyecto.objects.all()
    permission_classes = [permissions.IsAdminUser]
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def _rows(self, project):
        return ProjectCheckSerializer(
            project.checks.select_related('completado_por')
            .prefetch_related('adjuntos__subido_por', 'requisitos'),
            many=True,
        ).data

    def _check_or_400(self, project, check_id):
        check = project.checks.filter(pk=check_id).first()
        if check is None:
            raise ValidationError('Este paso ya no existe en el proyecto.')
        return check

    def retrieve(self, request, pk=None):
        return Response(self._rows(self.get_object()))

    @action(detail=False, methods=['get'])
    def vencimientos(self, request):
        """Pasos con fecha limite dentro de [desde, hasta], para el calendario."""
        bounds = {}
        for param, lookup in [('desde', 'fecha_limite__gte'), ('hasta', 'fecha_limite__lte')]:
            raw = request.query_params.get(param)
            if raw:
                try:
                    bounds[lookup] = date.fromisoformat(raw)
                except ValueError:
                    raise ValidationError({param: 'Usa una fecha AAAA-MM-DD.'})
        rows = (
            ProyectoCheck.objects.filter(fecha_limite__isnull=False, **bounds)
            .select_related('proyecto')
            .order_by('fecha_limite', 'proyecto_id', 'orden')
        )
        return Response([{
            'id': row.id,
            'proyecto': row.proyecto_id,
            'proyecto_nombre': row.proyecto.nombre,
            'titulo': row.titulo,
            'fecha_limite': row.fecha_limite.isoformat(),
            'completado': row.completado,
        } for row in rows])

    @action(detail=True, methods=['post'], url_path='checks')
    def add_check(self, request, pk=None):
        project = self.get_object()
        data = ProjectCheckSerializer(data={
            'titulo': request.data.get('titulo', ''),
            'requiere_fecha': request.data.get('requiere_fecha', False),
            'requiere_documento': request.data.get('requiere_documento', False),
            'fecha_limite': request.data.get('fecha_limite') or None,
        })
        data.is_valid(raise_exception=True)
        if _clave_titulo(data.validated_data['titulo']) in {
            _clave_titulo(t) for t in project.checks.values_list('titulo', flat=True)
        }:
            raise ValidationError({'titulo': 'Este proyecto ya tiene un paso con ese titulo.'})
        siguiente = (project.checks.aggregate(m=Max('orden'))['m'] or 0) + 1
        ProyectoCheck.objects.create(
            proyecto=project, orden=siguiente, origen=ProyectoCheck.Origen.MANUAL,
            **data.validated_data,
        )
        return Response(self._rows(project), status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['patch', 'delete'], url_path=r'checks/(?P<check_id>\d+)')
    @transaction.atomic
    def check(self, request, pk=None, check_id=None):
        project = self.get_object()
        check = self._check_or_400(project, check_id)

        if request.method == 'DELETE':
            for adjunto in check.adjuntos.all():
                adjunto.archivo.delete(save=False)
            check.delete()
            return Response(self._rows(project))

        data = ProjectCheckSerializer(check, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        if 'completado' in data.validated_data and data.validated_data['completado'] != check.completado:
            if data.validated_data['completado']:
                pendientes = [r.titulo for r in check.requisitos.all() if not r.completado]
                if pendientes:
                    raise ValidationError({'completado': 'Antes hay que completar: ' + ', '.join(pendientes) + '.'})
                check.completado_at = timezone.now()
                check.completado_por = request.user
            else:
                check.completado_at = None
                check.completado_por = None
        data.save()
        return Response(self._rows(project))

    @action(detail=True, methods=['post'], url_path=r'checks/(?P<check_id>\d+)/adjuntos')
    def add_attachment(self, request, pk=None, check_id=None):
        project = self.get_object()
        check = self._check_or_400(project, check_id)
        archivo = request.FILES.get('archivo')
        if archivo is None:
            raise ValidationError({'archivo': 'Adjunta un fichero.'})
        if archivo.size > CHECK_ATTACHMENT_MAX_BYTES:
            raise ValidationError({'archivo': 'El fichero supera los 20 MB.'})
        ProyectoCheckAdjunto.objects.create(
            paso=check, archivo=archivo, nombre_original=archivo.name[:255],
            tamano=archivo.size, subido_por=request.user,
        )
        return Response(self._rows(project), status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'checks/(?P<check_id>\d+)/adjuntos/(?P<attachment_id>\d+)')
    def delete_attachment(self, request, pk=None, check_id=None, attachment_id=None):
        project = self.get_object()
        check = self._check_or_400(project, check_id)
        adjunto = check.adjuntos.filter(pk=attachment_id).first()
        if adjunto is None:
            raise ValidationError('Este documento ya no existe.')
        adjunto.archivo.delete(save=False)
        adjunto.delete()
        return Response(self._rows(project))


class WorkerSerializer(serializers.ModelSerializer):
    class Meta:
        model = TrabajadorOficina
        fields = ['id', 'nombre', 'activo', 'color']

    def validate_color(self, value):
        return value.lower()

    def create(self, validated_data):
        if 'color' not in validated_data:
            palette = ('#2563eb', '#b45309', '#0f766e', '#be185d', '#7c3aed', '#4d7c0f', '#0369a1', '#b91c1c')
            used = list(TrabajadorOficina.objects.values_list('color', flat=True))
            validated_data['color'] = min(palette, key=used.count)
        return super().create(validated_data)


class WorkerViewSet(viewsets.ModelViewSet):
    queryset = TrabajadorOficina.objects.all()
    serializer_class = WorkerSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'head', 'options']


class EventSerializer(serializers.ModelSerializer):
    titulo = serializers.CharField(required=False, allow_blank=True, max_length=200)

    class Meta:
        model = EventoCalendario
        fields = ['id', 'titulo', 'tipo', 'inicio', 'fin', 'proyecto', 'trabajadores', 'notas']

    def validate(self, attrs):
        def value(key):
            return attrs.get(key, getattr(self.instance, key, None))
        if value('fin') < value('inicio'):
            raise serializers.ValidationError({'fin': 'La fecha final debe ser igual o posterior al inicio.'})
        workers = attrs.get('trabajadores')
        if workers is None:
            workers = list(self.instance.trabajadores.all()) if self.instance else []
        if value('tipo') == EventoCalendario.Tipo.VACACIONES and not workers:
            raise serializers.ValidationError({'trabajadores': 'Selecciona al menos una persona.'})
        if value('tipo') == EventoCalendario.Tipo.VACACIONES:
            attrs['titulo'] = self.vacation_title(workers)
            attrs['proyecto'] = None
        elif not (value('titulo') or '').strip():
            raise serializers.ValidationError({'titulo': 'Indica un titulo para el evento.'})
        if any(not w.activo for w in workers):
            existing = set(self.instance.trabajadores.values_list('id', flat=True)) if self.instance else set()
            if any(not w.activo and w.id not in existing for w in workers):
                raise serializers.ValidationError({'trabajadores': 'No se pueden asignar personas inactivas.'})
        return attrs

    @staticmethod
    def vacation_title(workers):
        names = ', '.join(worker.nombre for worker in sorted(workers, key=lambda w: (w.nombre, w.pk)))
        return f'Vacaciones de {names}'[:200]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if instance.tipo == EventoCalendario.Tipo.VACACIONES:
            data['titulo'] = self.vacation_title(instance.trabajadores.all())
        return data


class EventViewSet(viewsets.ModelViewSet):
    queryset = EventoCalendario.objects.prefetch_related('trabajadores')
    serializer_class = EventSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None

    def get_queryset(self):
        queryset = super().get_queryset()
        for param, lookup in [('desde', 'fin__gte'), ('hasta', 'inicio__lte')]:
            raw = self.request.query_params.get(param)
            if raw:
                try:
                    parsed = date.fromisoformat(raw)
                except ValueError:
                    raise ValidationError({param: 'Usa una fecha AAAA-MM-DD.'})
                queryset = queryset.filter(**{lookup: parsed})
        return queryset

    def perform_create(self, serializer):
        serializer.save(creado_por=self.request.user)
