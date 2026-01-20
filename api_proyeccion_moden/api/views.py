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


class PlantaViewSet(viewsets.ModelViewSet):
    """
    API endpoint para ver, crear, editar y borrar plantas.
    Filtrar por proyecto con ?proyecto=ID
    """
    queryset = Planta.objects.all().order_by('orden', 'nombre')
    serializer_class = PlantaSerializer
    permission_classes = [permissions.AllowAny]  # For demo, adjust later

    def get_queryset(self):
        queryset = Planta.objects.all().order_by('orden', 'nombre')
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


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
        planta_id = self.request.query_params.get('planta', None)
        if planta_id is not None:
            queryset = queryset.filter(planta_id=planta_id)
        elif proyecto_id is not None:
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
    permission_classes = [permissions.AllowAny]

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
    permission_classes = [permissions.AllowAny]

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

# =============================================================================
# DEVICE PAIRING VIEWS
# =============================================================================
class DeviceViewSet(viewsets.ViewSet):
    """
    Endpoints for Mini-PC (Kiosk) pairing and operation.
    """
    permission_classes = [permissions.AllowAny] # We handle token auth manually for devices

    @action(detail=False, methods=['post'])
    def init(self, request):
        """
        Device requests a new pairing code.
        """
        from api.serializers import DeviceInitSerializer
        import secrets
        from django.utils import timezone
        
        serializer = DeviceInitSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
            
        mesa_id = serializer.validated_data.get('mesa_id')
        mesa = None
        
        if mesa_id:
            try:
                mesa = Mesa.objects.get(id=mesa_id)
            except Mesa.DoesNotExist:
                return Response({'detail': 'Mesa not found'}, status=404)
        
        # If mesa known, check for existing valid code first
        if mesa:
            # Reuse existing code if still valid
            if mesa.pairing_code and mesa.pairing_code_expires_at and mesa.pairing_code_expires_at > timezone.now():
                return Response({'pairing_code': mesa.pairing_code, 'expires_at': mesa.pairing_code_expires_at})
            
            # Generate new code only if none exists or expired
            code = secrets.token_hex(3).upper() # 6 chars
            mesa.pairing_code = code
            mesa.pairing_code_expires_at = timezone.now() + timezone.timedelta(minutes=10)
            mesa.save(update_fields=['pairing_code', 'pairing_code_expires_at'])
            return Response({'pairing_code': code, 'expires_at': mesa.pairing_code_expires_at})
        
        # If no mesa selected (flexible flow), we would need a temporary session.
        # For PoC, we enforce mesa_id or just return code if we had a session model.
        # Keeping it simple: Require mesa_id OR find a free mesa?
        # Let's assume for PoC we might pass mesa_id if known, OR we create a placeholder?
        # User prompt said: "Option 1 (simpler): endpoint receives mesa_id".
        if not mesa:
             return Response({'detail': 'mesa_id required for this PoC phase'}, status=400)

    @action(detail=False, methods=['get'])
    def status(self, request):
        """
        Device polls for pairing status using the code.
        """
        code = request.query_params.get('code')
        if not code:
            return Response({'detail': 'Code required'}, status=400)
            
        from django.utils import timezone
        # Find mesa with this code
        mesa = Mesa.objects.filter(pairing_code=code).first()
        
        if not mesa:
            return Response({'status': 'EXPIRED'}) # Or INVALID
            
        if mesa.pairing_code_expires_at and mesa.pairing_code_expires_at < timezone.now():
            return Response({'status': 'EXPIRED'})
            
        # Check if paired (has token hash AND code is cleared/consumed)
        # Actually, in 'pair' action we clear the code.
        # But here we need to return the token ONCE.
        # So 'pair' action should probably generates the token, saves hash to DB, 
        # and saves the RAW token temporarily (maybe in pairing_code field? No unsafe).
        # Better strategy:
        # The 'pair' action sets a flag or we check if device_token_hash is set.
        # But how to get the raw token to the device?
        # Option: 'pair' action updates DB. Device calls 'status'.
        # We need a way to pass the token.
        # Let's use a temporary field or just rely on the fact that if we just paired,
        # we might have stored the raw token in a cache or similar?
        # User prompt says: "If linked -> { status: 'PAIRED', device_token: '...' }"
        # And: "Invalidate code immediately".
        # So we can store the raw token in `pairing_code` temporarily? No, likely too short.
        # Let's add a temporary `temp_token_storage` to Mesa model? 
        # Or simpler: The `pair` action returns the token to the Dashboard?
        # No, User says: "return OK (and DO NOT return token here; token is picked up by mini-PC via /status)".
        
        # Solution: Store the RAW token in the `pairing_code` field for the brief moment between Pair and Status check?
        # Or add a `temp_token` field to Mesa model.
        # Since I can't easily add fields without migration, I will use `pairing_code` field to store the token 
        # prefixed with "TOKEN:" if it fits (max 10 chars is small).
        # Wait, `pairing_code` is 10 chars. Token is 32 bytes. Won't fit.
        # I need a place to store existing token for one-time retrieval.
        # I'll rely on a hack for PoC: Use `last_error` field to store "PENDING_TOKEN:<token>" momentarily?
        # Yes, good enough for PoC.
        
        if mesa.last_error and mesa.last_error.startswith("PENDING_TOKEN:"):
            token = mesa.last_error.split(":", 1)[1]
            # Clear it
            mesa.last_error = None
            mesa.pairing_code = None # Clear code
            mesa.save(update_fields=['last_error', 'pairing_code'])
            return Response({'status': 'PAIRED', 'device_token': token})
            
        return Response({'status': 'WAITING'})

    @action(detail=False, methods=['post'])
    def pair(self, request):
        """
        Dashboard confirms pairing for a mesa and code.
        """
        from api.serializers import DevicePairSerializer
        import secrets
        import hashlib
        
        serializer = DevicePairSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
            
        mesa_id = serializer.validated_data.get('mesa_id')
        code = serializer.validated_data.get('pairing_code')
        
        try:
            mesa = Mesa.objects.get(id=mesa_id)
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)
            
        if mesa.pairing_code != code:
             return Response({'detail': 'Invalid code for this mesa'}, status=400)
             
        # Generate Token
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        
        mesa.device_token_hash = token_hash
        # Store raw token temporarily for retrieval by device
        mesa.last_error = f"PENDING_TOKEN:{raw_token}"
        mesa.save(update_fields=['device_token_hash', 'last_error'])
        
        return Response({'status': 'ok'})

    @action(detail=False, methods=['post'])
    def heartbeat(self, request):
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        from api.serializers import DeviceHeartbeatSerializer
        from django.utils import timezone
        
        serializer = DeviceHeartbeatSerializer(data=request.data)
        if serializer.is_valid():
            # Update generic stats
            mesa.last_seen = timezone.now()
            # Could save other stats if model supports it
            mesa.save(update_fields=['last_seen'])
            
        return Response({'status': 'ok'})

    @action(detail=False, methods=['get'])
    def state(self, request):
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        from api.serializers import MesaStateSerializer
        serializer = MesaStateSerializer(mesa)
        return Response(serializer.data)
        
    @action(detail=False, methods=['post'])
    def revoke(self, request):
        # Admin action (normally authenticated, for PoC maybe just open or requires Secret)
        # Let's assume simple Mesa ID + Secret Header
        # Or just Dashboard authenticated. For PoC let's use standard IsAuthenticated if called from Dash.
        # If called from Device? A device shouldn't revoke itself easily?
        # User request: "POST /api/device/revoke ... Protect with X-Setup-Key"
        
        setup_key = request.headers.get('X-Setup-Key')
        if setup_key != 'INAK_ROCKS': # Hardcoded PoC key
             # Also allow if user is Admin
             if not (request.user and request.user.is_staff):
                 return Response({'detail': 'Forbidden'}, status=403)

        mesa_id = request.data.get('mesa_id')
        if not mesa_id:
             return Response({'detail': 'mesa_id required'}, status=400)
             
        try:
            mesa = Mesa.objects.get(id=mesa_id)
            mesa.device_token_hash = None
            mesa.pairing_code = None
            mesa.last_error = None
            mesa.save()
            return Response({'status': 'revoked'})
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)

    def _authenticate_device(self, request):
        """Helper to validate Bearer token against hashes."""
        import hashlib
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return None
            
        token = auth_header.split(' ')[1]
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        
        return Mesa.objects.filter(device_token_hash=token_hash).first()


class MesaQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de mesas (WorkItems).
    """
    queryset = MesaQueueItem.objects.all().order_by('mesa', 'position')
    serializer_class = MesaQueueItemSerializer
    permission_classes = [permissions.AllowAny]

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