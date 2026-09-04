"""Internal project checklists, staff and calendar endpoints."""
from datetime import date

from django.db import transaction
from rest_framework import serializers, viewsets, permissions
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .models import (Proyecto, ProyectoCheckDefinicion, ProyectoCheckEstado,
                     TrabajadorOficina, EventoCalendario)


class CheckDefinitionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProyectoCheckDefinicion
        fields = ['id', 'titulo', 'activo', 'orden']


class CheckDefinitionViewSet(viewsets.ModelViewSet):
    queryset = ProyectoCheckDefinicion.objects.all()
    serializer_class = CheckDefinitionSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'head', 'options']


class CheckStateInput(serializers.Serializer):
    completado = serializers.BooleanField()


class ProjectChecklistViewSet(viewsets.GenericViewSet):
    queryset = Proyecto.objects.all()
    permission_classes = [permissions.IsAdminUser]

    def retrieve(self, request, pk=None):
        project = self.get_object()
        states = {s.definicion_id: s for s in project.check_estados.select_related('actualizado_por')}
        rows = []
        for definition in ProyectoCheckDefinicion.objects.filter(activo=True):
            state = states.get(definition.id)
            rows.append({
                'id': definition.id, 'titulo': definition.titulo,
                'completado': bool(state and state.completado),
                'actualizado_at': state.actualizado_at if state else None,
                'actualizado_por': state.actualizado_por.get_username() if state and state.actualizado_por else None,
            })
        return Response(rows)

    @action(detail=True, methods=['patch'], url_path=r'checks/(?P<check_id>\d+)')
    @transaction.atomic
    def check(self, request, pk=None, check_id=None):
        project = self.get_object()
        definition = ProyectoCheckDefinicion.objects.filter(pk=check_id, activo=True).first()
        if definition is None:
            raise ValidationError('Este paso ya no esta disponible.')
        data = CheckStateInput(data=request.data)
        data.is_valid(raise_exception=True)
        ProyectoCheckEstado.objects.update_or_create(
            proyecto=project, definicion=definition,
            defaults={**data.validated_data, 'actualizado_por': request.user},
        )
        return self.retrieve(request, pk)


class WorkerSerializer(serializers.ModelSerializer):
    class Meta:
        model = TrabajadorOficina
        fields = ['id', 'nombre', 'activo']


class WorkerViewSet(viewsets.ModelViewSet):
    queryset = TrabajadorOficina.objects.all()
    serializer_class = WorkerSerializer
    permission_classes = [permissions.IsAdminUser]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'head', 'options']


class EventSerializer(serializers.ModelSerializer):
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
        if any(not w.activo for w in workers):
            existing = set(self.instance.trabajadores.values_list('id', flat=True)) if self.instance else set()
            if any(not w.activo and w.id not in existing for w in workers):
                raise serializers.ValidationError({'trabajadores': 'No se pueden asignar personas inactivas.'})
        return attrs


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
