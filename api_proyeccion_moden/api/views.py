from django.contrib.auth.models import User
from rest_framework import permissions, viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response

from api.serializers import (
    ProyectoSerializer, UserSerializer, ModuloSerializer,
    ImagenSerializer, MesaSerializer,
    ModuloQueueSerializer, ModuloQueueItemSerializer, MesaQueueItemSerializer
)
from api.models import (
    Modulo, Proyecto, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem
)


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint that allows users to be viewed or edited.
    """
    queryset = User.objects.all().order_by("-date_joined")
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]


class ProyectoViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar proyectos.
    """
    queryset = Proyecto.objects.all().order_by("nombre")
    serializer_class = ProyectoSerializer
    permission_classes = [permissions.IsAuthenticated]

    @action(detail=True, methods=['get'])
    def modulos(self, request, pk=None):
        """Get all modules for a project."""
        proyecto = self.get_object()
        modulos = proyecto.modulos.all().order_by('id')
        serializer = ModuloSerializer(modulos, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def queue(self, request, pk=None):
        """Get the module queue for a project."""
        proyecto = self.get_object()
        try:
            queue = proyecto.modulo_queue
            serializer = ModuloQueueSerializer(queue, context={'request': request})
            return Response(serializer.data)
        except ModuloQueue.DoesNotExist:
            return Response({'detail': 'No queue exists for this project'}, status=404)

    @action(detail=True, methods=['get'])
    def queue_items(self, request, pk=None):
        """Get the ordered queue items for a project."""
        proyecto = self.get_object()
        try:
            queue = proyecto.modulo_queue
            items = queue.items.all().order_by('position')
            serializer = ModuloQueueItemSerializer(items, many=True, context={'request': request})
            return Response(serializer.data)
        except ModuloQueue.DoesNotExist:
            return Response([])


class ModuloViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar módulos.
    """
    queryset = Modulo.objects.all().order_by("id")
    serializer_class = ModuloSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = Modulo.objects.all().order_by("id")
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset

    @action(detail=True, methods=['get'])
    def imagenes(self, request, pk=None):
        """Get all images for a module."""
        modulo = self.get_object()
        imagenes = modulo.imagenes.filter(activo=True).order_by('fase', 'orden')
        serializer = ImagenSerializer(imagenes, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def cerrar(self, request, pk=None):
        """Close a module (supervisor action)."""
        from django.utils import timezone
        modulo = self.get_object()
        if not (modulo.inferior_hecho and modulo.superior_hecho):
            return Response(
                {'detail': 'No se puede cerrar: faltan fases por completar'},
                status=status.HTTP_400_BAD_REQUEST
            )
        modulo.cerrado = True
        modulo.cerrado_at = timezone.now()
        modulo.cerrado_by = request.user
        modulo.actualizar_estado()
        serializer = self.get_serializer(modulo)
        return Response(serializer.data)


class ImagenViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar imágenes.
    """
    queryset = Imagen.objects.all().order_by("id")
    serializer_class = ImagenSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = Imagen.objects.filter(activo=True).order_by("modulo", "fase", "orden")
        modulo_id = self.request.query_params.get('modulo', None)
        fase = self.request.query_params.get('fase', None)
        if modulo_id is not None:
            queryset = queryset.filter(modulo_id=modulo_id)
        if fase is not None:
            queryset = queryset.filter(fase=fase)
        return queryset


class MesaViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar mesas y asignación de imágenes.
    """
    queryset = Mesa.objects.all().order_by("nombre")
    serializer_class = MesaSerializer
    permission_classes = [permissions.IsAuthenticated]

    @action(detail=True, methods=['get'])
    def queue_items(self, request, pk=None):
        """Get the work queue for a desk."""
        mesa = self.get_object()
        items = mesa.queue_items.all().order_by('position')
        serializer = MesaQueueItemSerializer(items, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def current_item(self, request, pk=None):
        """Get the current item being shown on a desk."""
        mesa = self.get_object()
        from api.models import MesaQueueStatus
        item = mesa.queue_items.filter(status=MesaQueueStatus.MOSTRANDO).first()
        if item:
            serializer = MesaQueueItemSerializer(item, context={'request': request})
            return Response(serializer.data)
        return Response({'detail': 'No item currently showing'}, status=404)


class ModuloQueueViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar colas de módulos por proyecto.
    """
    queryset = ModuloQueue.objects.all()
    serializer_class = ModuloQueueSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = ModuloQueue.objects.all()
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


class ModuloQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de módulos.
    """
    queryset = ModuloQueueItem.objects.all().order_by('queue', 'position')
    serializer_class = ModuloQueueItemSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = ModuloQueueItem.objects.all().order_by('position')
        queue_id = self.request.query_params.get('queue', None)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if queue_id is not None:
            queryset = queryset.filter(queue_id=queue_id)
        if proyecto_id is not None:
            queryset = queryset.filter(queue__proyecto_id=proyecto_id)
        return queryset

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        """Reorder items in the queue. Expects: {items: [{id: X, position: Y}, ...]}"""
        items_data = request.data.get('items', [])
        for item_data in items_data:
            try:
                item = ModuloQueueItem.objects.get(id=item_data['id'])
                item.position = item_data['position']
                item.save(update_fields=['position'])
            except ModuloQueueItem.DoesNotExist:
                pass
        return Response({'status': 'ok'})


class MesaQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de mesas (WorkItems).
    """
    queryset = MesaQueueItem.objects.all().order_by('mesa', 'position')
    serializer_class = MesaQueueItemSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = MesaQueueItem.objects.all().order_by('position')
        mesa_id = self.request.query_params.get('mesa', None)
        status_filter = self.request.query_params.get('status', None)
        if mesa_id is not None:
            queryset = queryset.filter(mesa_id=mesa_id)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset

    @action(detail=True, methods=['post'])
    def marcar_hecho(self, request, pk=None):
        """Mark a work item as done."""
        item = self.get_object()
        item.marcar_hecho(user=request.user)
        serializer = self.get_serializer(item)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def mostrar(self, request, pk=None):
        """Set this item as the one currently showing."""
        from api.models import MesaQueueStatus
        item = self.get_object()
        # Unset any other MOSTRANDO items for this desk
        MesaQueueItem.objects.filter(
            mesa=item.mesa,
            status=MesaQueueStatus.MOSTRANDO
        ).update(status=MesaQueueStatus.EN_COLA)
        # Set this one as MOSTRANDO
        item.status = MesaQueueStatus.MOSTRANDO
        item.save(update_fields=['status'])
        # Update mesa cache
        item.mesa.imagen_actual = item.imagen
        item.mesa.save(update_fields=['imagen_actual'])
        serializer = self.get_serializer(item)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        """Reorder items in the mesa queue. Expects: {items: [{id: X, position: Y}, ...]}"""
        items_data = request.data.get('items', [])
        for item_data in items_data:
            try:
                item = MesaQueueItem.objects.get(id=item_data['id'])
                item.position = item_data['position']
                item.save(update_fields=['position'])
            except MesaQueueItem.DoesNotExist:
                pass
        return Response({'status': 'ok'})