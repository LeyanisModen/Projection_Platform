from django.contrib.auth.models import User
from rest_framework import permissions, viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response

from api.serializers import (
    ProyectoSerializer, PlantaSerializer, UserSerializer, ModuloSerializer,
    ImagenSerializer, MesaSerializer,
    ModuloQueueSerializer, ModuloQueueItemSerializer, MesaQueueItemSerializer
)
from api.models import (
    Modulo, Proyecto, Planta, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem
)
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.authtoken.models import Token

from rest_framework import renderers

class ServerSentEventRenderer(renderers.BaseRenderer):
    media_type = 'text/event-stream'
    format = 'txt'
    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data


class CustomAuthToken(ObtainAuthToken):
    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data,
                                           context={'request': request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        token, created = Token.objects.get_or_create(user=user)
        return Response({
            'token': token.key,
            'user_id': user.pk,
            'username': user.username,
            'is_staff': user.is_staff,
            'is_superuser': user.is_superuser
        })


class UserViewSet(viewsets.ModelViewSet):
    """
    API endpoint that allows users to be viewed or edited.
    """
    # queryset = User.objects.all().order_by("-date_joined")
    serializer_class = UserSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        queryset = User.objects.all().order_by("-date_joined")
        if self.action == 'list':
            return queryset.filter(is_superuser=False)
        return queryset


from django.db.models import Count

class ProyectoViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar proyectos.
    """
    # Optimize: select_related user to avoid N+1 on 'usuario.username'
    queryset = Proyecto.objects.select_related('usuario').all().order_by("nombre")
    serializer_class = ProyectoSerializer
    permission_classes = [permissions.AllowAny] 

# ... (rest of ProyectoViewSet unchanged until modulos action) ...

class PlantaViewSet(viewsets.ModelViewSet):
    """
    API endpoint para ver, crear, editar y borrar plantas.
    Filtrar por proyecto con ?proyecto=ID
    """
    # Optimize: Annotate count to avoid per-row query
    queryset = Planta.objects.annotate(modulos_count=Count('modulos')).order_by('orden', 'nombre')
    serializer_class = PlantaSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        # Must re-apply annotation in get_queryset overrides
        queryset = Planta.objects.annotate(modulos_count=Count('modulos')).order_by('orden', 'nombre')
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


class ModuloViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar módulos.
    """
    # Assuming basic serializer only needs IDs, but if it needs names... 
    # ModuloSerializer has simple fields. Keep as is for now unless 'planta' detail is needed.
    queryset = Modulo.objects.all().order_by("id")
    serializer_class = ModuloSerializer
    permission_classes = [permissions.AllowAny]

# ...

class ImagenViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar imágenes.
    """
    # Optimize: select_related modulo because serializer accesses 'modulo.nombre'
    queryset = Imagen.objects.select_related('modulo').all().order_by("id")
    serializer_class = ImagenSerializer
    permission_classes = [permissions.AllowAny]
    pagination_class = None

    def get_queryset(self):
        # Re-apply optimization
        queryset = Imagen.objects.select_related('modulo').filter(activo=True).order_by("modulo", "fase", "orden")
        modulo_id = self.request.query_params.get('modulo', None)
        fase = self.request.query_params.get('fase', None)
        if modulo_id is not None:
            queryset = queryset.filter(modulo_id=modulo_id)
        if fase is not None:
            queryset = queryset.filter(fase=fase)
        return queryset

# ...

class ModuloQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de módulos.
    """
    # Optimize: fetch related modulo and planta
    queryset = ModuloQueueItem.objects.select_related('modulo', 'modulo__planta').all().order_by('queue', 'position')
    serializer_class = ModuloQueueItemSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        queryset = ModuloQueueItem.objects.select_related('modulo', 'modulo__planta').all().order_by('position')
        # ... rest of filters ...
        queue_id = self.request.query_params.get('queue', None)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if queue_id is not None:
            queryset = queryset.filter(queue_id=queue_id)
        if proyecto_id is not None:
            queryset = queryset.filter(queue__proyecto_id=proyecto_id)
        return queryset
    
    # ...

class MesaQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de mesas (WorkItems).
    """
    # Optimize: fetch all related fields used in serializer
    queryset = MesaQueueItem.objects.select_related(
        'mesa', 
        'modulo', 
        'imagen', 
        'modulo__planta', 
        'modulo__planta__proyecto'
    ).all().order_by('mesa', 'position')
    
    serializer_class = MesaQueueItemSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        queryset = MesaQueueItem.objects.select_related(
             'mesa', 
             'modulo', 
             'imagen', 
             'modulo__planta', 
             'modulo__planta__proyecto'
        ).all().order_by('position')
        
        mesa_id = self.request.query_params.get('mesa', None)
        status_filter = self.request.query_params.get('status', None)
        if mesa_id is not None:
            queryset = queryset.filter(mesa_id=mesa_id)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset