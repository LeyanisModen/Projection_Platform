"""Internal project checklists, staff and calendar endpoints."""
from datetime import date

from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from rest_framework import serializers, viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .models import (Proyecto, ProyectoCheck, ProyectoCheckDefinicion,
                     TrabajadorOficina, EventoCalendario)


# ---------------------------------------------------------------------------
# Lista de control maestra (plantilla)
# ---------------------------------------------------------------------------
class CheckDefinitionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProyectoCheckDefinicion
        fields = ['id', 'titulo', 'orden']
        extra_kwargs = {'orden': {'required': False}}

    def validate_titulo(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Indica un titulo para el paso.')
        return value


class CheckDefinitionViewSet(viewsets.ModelViewSet):
    """CRUD de la lista maestra. Borrar aqui no afecta a proyectos ya sembrados."""
    queryset = ProyectoCheckDefinicion.objects.all()
    serializer_class = CheckDefinitionSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def perform_create(self, serializer):
        if 'orden' in serializer.validated_data:
            serializer.save()
            return
        siguiente = (ProyectoCheckDefinicion.objects.aggregate(m=Max('orden'))['m'] or 0) + 1
        serializer.save(orden=siguiente)

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
        return Response(CheckDefinitionSerializer(ProyectoCheckDefinicion.objects.all(), many=True).data)


# ---------------------------------------------------------------------------
# Lista de control de cada proyecto
# ---------------------------------------------------------------------------
def _clave_titulo(titulo):
    return (titulo or '').strip().casefold()


def sembrar_checklist(proyecto):
    """Copia al proyecto los pasos de la plantilla que aun no tiene (por titulo).

    Se llama al crear el proyecto y desde el boton «Anadir pasos de la
    plantilla». Los pasos nuevos se anaden al final para no reordenar los que
    ya existen. Devuelve cuantos se han creado.
    """
    existentes = {_clave_titulo(t) for t in proyecto.checks.values_list('titulo', flat=True)}
    siguiente = (proyecto.checks.aggregate(m=Max('orden'))['m'] or 0) + 1
    nuevos = []
    for definicion in ProyectoCheckDefinicion.objects.all():
        if _clave_titulo(definicion.titulo) in existentes:
            continue
        existentes.add(_clave_titulo(definicion.titulo))
        nuevos.append(ProyectoCheck(
            proyecto=proyecto, titulo=definicion.titulo, orden=siguiente,
            origen=ProyectoCheck.Origen.PLANTILLA,
        ))
        siguiente += 1
    if nuevos:
        ProyectoCheck.objects.bulk_create(nuevos)
    return len(nuevos)


class ProjectCheckSerializer(serializers.ModelSerializer):
    completado_por = serializers.SerializerMethodField()

    class Meta:
        model = ProyectoCheck
        fields = ['id', 'titulo', 'orden', 'origen', 'completado', 'completado_at', 'completado_por', 'creado_at']
        read_only_fields = ['orden', 'origen', 'completado_at', 'completado_por', 'creado_at']

    def get_completado_por(self, obj):
        return obj.completado_por.get_username() if obj.completado_por else None

    def validate_titulo(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Indica un titulo para el paso.')
        return value


class ProjectChecklistViewSet(viewsets.GenericViewSet):
    """GET lista, POST checks/ (manual), PATCH/DELETE checks/<id>/, POST sembrar/.

    Todas las mutaciones devuelven la lista completa para que el front la
    sustituya sin recomponer estado.
    """
    queryset = Proyecto.objects.all()
    permission_classes = [permissions.IsAdminUser]

    def _rows(self, project):
        return ProjectCheckSerializer(
            project.checks.select_related('completado_por'), many=True,
        ).data

    def retrieve(self, request, pk=None):
        return Response(self._rows(self.get_object()))

    @action(detail=True, methods=['post'], url_path='checks')
    def add_check(self, request, pk=None):
        project = self.get_object()
        data = ProjectCheckSerializer(data={'titulo': request.data.get('titulo', '')})
        data.is_valid(raise_exception=True)
        if _clave_titulo(data.validated_data['titulo']) in {
            _clave_titulo(t) for t in project.checks.values_list('titulo', flat=True)
        }:
            raise ValidationError({'titulo': 'Este proyecto ya tiene un paso con ese titulo.'})
        siguiente = (project.checks.aggregate(m=Max('orden'))['m'] or 0) + 1
        ProyectoCheck.objects.create(
            proyecto=project, titulo=data.validated_data['titulo'], orden=siguiente,
            origen=ProyectoCheck.Origen.MANUAL,
        )
        return Response(self._rows(project), status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['patch', 'delete'], url_path=r'checks/(?P<check_id>\d+)')
    @transaction.atomic
    def check(self, request, pk=None, check_id=None):
        project = self.get_object()
        check = project.checks.filter(pk=check_id).first()
        if check is None:
            raise ValidationError('Este paso ya no existe en el proyecto.')

        if request.method == 'DELETE':
            check.delete()
            return Response(self._rows(project))

        data = ProjectCheckSerializer(check, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        if 'completado' in data.validated_data and data.validated_data['completado'] != check.completado:
            if data.validated_data['completado']:
                check.completado_at = timezone.now()
                check.completado_por = request.user
            else:
                check.completado_at = None
                check.completado_por = None
        data.save()
        return Response(self._rows(project))

    @action(detail=True, methods=['post'])
    def sembrar(self, request, pk=None):
        project = self.get_object()
        creados = sembrar_checklist(project)
        return Response({'creados': creados, 'checks': self._rows(project)})


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
