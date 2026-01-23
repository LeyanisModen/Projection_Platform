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

from rest_framework import renderers

class ServerSentEventRenderer(renderers.BaseRenderer):
    media_type = 'text/event-stream'
    format = 'txt'
    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data


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
    permission_classes = [permissions.AllowAny]  # Allow visor access without auth

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

    @action(detail=True, methods=['post', 'get'], permission_classes=[permissions.AllowAny])
    def calibration(self, request, pk=None):
        """
        GET: Retrieve current calibration JSON for a mesa.
        POST: Save calibration JSON (corner positions) for a mesa.
        """
        mesa = self.get_object()
        
        if request.method == 'GET':
            return Response({
                'id': mesa.id,
                'nombre': mesa.nombre,
                'calibration_json': mesa.calibration_json
            })
        
        # POST: Save calibration
        calibration_data = request.data.get('calibration_json')
        if calibration_data is None:
            return Response(
                {'detail': 'calibration_json is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        mesa.calibration_json = calibration_data
        # Update calibration_json AND trigger auto_now for ultima_actualizacion
        mesa.save()
        
        return Response({
            'id': mesa.id,
            'nombre': mesa.nombre,
            'calibration_json': mesa.calibration_json,
            'message': 'Calibration saved successfully'
        })


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
        Option A: mesa_id provided → code saved to Mesa directly
        Option B: no mesa_id → code saved to PairingSession (flexible linking later)
        """
        from api.serializers import DeviceInitSerializer
        from api.models import PairingSession
        import secrets
        from django.utils import timezone
        
        serializer = DeviceInitSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
            
        mesa_id = serializer.validated_data.get('mesa_id')
        
        # Option A: Mesa ID known
        if mesa_id:
            try:
                mesa = Mesa.objects.get(id=mesa_id)
            except Mesa.DoesNotExist:
                return Response({'detail': 'Mesa not found'}, status=404)
            
            # Reuse existing code if still valid
            if mesa.pairing_code and mesa.pairing_code_expires_at and mesa.pairing_code_expires_at > timezone.now():
                return Response({'pairing_code': mesa.pairing_code, 'expires_at': mesa.pairing_code_expires_at, 'mode': 'mesa'})
            
            # Generate new code
            code = secrets.token_hex(3).upper()
            mesa.pairing_code = code
            mesa.pairing_code_expires_at = timezone.now() + timezone.timedelta(minutes=10)
            mesa.save(update_fields=['pairing_code', 'pairing_code_expires_at'])
            return Response({'pairing_code': code, 'expires_at': mesa.pairing_code_expires_at, 'mode': 'mesa'})
        
        # Option B: No mesa_id - create a PairingSession
        # Check for existing valid session from this device (by code in request if refreshing)
        existing_code = request.data.get('existing_code')
        if existing_code:
            try:
                session = PairingSession.objects.get(pairing_code=existing_code)
                if session.expires_at > timezone.now():
                    return Response({
                        'pairing_code': session.pairing_code, 
                        'expires_at': session.expires_at,
                        'mode': 'session',
                        'mesa': session.mesa.id if session.mesa else None
                    })
            except PairingSession.DoesNotExist:
                pass
        
        # Generate new session
        code = secrets.token_hex(3).upper()
        expires_at = timezone.now() + timezone.timedelta(minutes=10)
        session = PairingSession.objects.create(
            pairing_code=code,
            expires_at=expires_at,
            device_info={'user_agent': request.META.get('HTTP_USER_AGENT', 'unknown')}
        )
        return Response({
            'pairing_code': code, 
            'expires_at': expires_at,
            'mode': 'session'
        })

    @action(detail=False, methods=['get'])
    def status(self, request):
        """
        Device polls for pairing status using the code.
        Checks both Mesa (Option A) and PairingSession (Option B).
        """
        code = request.query_params.get('code')
        if not code:
            return Response({'detail': 'Code required'}, status=400)
            
        from django.utils import timezone
        from api.models import PairingSession
        
        # Option A: Check Mesa with this code
        mesa = Mesa.objects.filter(pairing_code=code).first()
        if mesa:
            if mesa.pairing_code_expires_at and mesa.pairing_code_expires_at < timezone.now():
                return Response({'status': 'EXPIRED'})
            
            # Check if paired (pending token in last_error)
            if mesa.last_error and mesa.last_error.startswith("PENDING_TOKEN:"):
                token = mesa.last_error.split(":", 1)[1]
                mesa.last_error = None
                mesa.pairing_code = None
                mesa.save(update_fields=['last_error', 'pairing_code'])
                return Response({'status': 'PAIRED', 'device_token': token, 'mesa_id': mesa.id})
                
            return Response({'status': 'WAITING', 'mode': 'mesa'})
        
        # Option B: Check PairingSession
        try:
            session = PairingSession.objects.get(pairing_code=code)
        except PairingSession.DoesNotExist:
            return Response({'status': 'EXPIRED'})
        
        if session.expires_at < timezone.now():
            return Response({'status': 'EXPIRED'})
        
        # Check if session has been linked to a mesa and has a token
        if session.device_token_hash and session.mesa:
            # Token was generated - return it once
            # We need to store it temporarily somewhere. Use mesa.last_error for consistency.
            if session.mesa.last_error and session.mesa.last_error.startswith("PENDING_TOKEN:"):
                token = session.mesa.last_error.split(":", 1)[1]
                session.mesa.last_error = None
                session.mesa.save(update_fields=['last_error'])
                # Also copy the token hash to mesa for future auth
                session.mesa.device_token_hash = session.device_token_hash
                session.mesa.save(update_fields=['device_token_hash'])
                return Response({'status': 'PAIRED', 'device_token': token, 'mesa_id': session.mesa.id})
            
            return Response({'status': 'PAIRED', 'mesa_id': session.mesa.id})  # Token already retrieved
        
        return Response({'status': 'WAITING', 'mode': 'session'})

    @action(detail=False, methods=['post'])
    def pair(self, request):
        """
        Dashboard confirms pairing for a mesa and code.
        Supports linking via Mesa directly (Option A) or via Session (Option B).
        """
        from api.serializers import DevicePairSerializer
        from api.models import PairingSession
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
        
        # Check if code matches Mesa (Option A)
        if mesa.pairing_code == code:
            # Proceed with direct pairing
            pass
        else:
            # Check if code matches a Session (Option B)
            try:
                session = PairingSession.objects.get(pairing_code=code)
                # Link session to this mesa
                session.mesa = mesa
            except PairingSession.DoesNotExist:
                return Response({'detail': 'Invalid pairing code'}, status=400)
        
        # Generate Token
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        
        # Save token to Mesa
        mesa.device_token_hash = token_hash
        # Store raw token temporarily for retrieval by device (via status endpoint)
        mesa.last_error = f"PENDING_TOKEN:{raw_token}"
        mesa.save(update_fields=['device_token_hash', 'last_error'])
        
        # If using session, save token hash there too so status check knows it's done
        if 'session' in locals() and session:
            session.device_token_hash = token_hash
            session.save(update_fields=['mesa', 'device_token_hash'])
        
        return Response({'status': 'ok'})

    @action(detail=False, methods=['post'])
    def unbind(self, request):
        """
        Unbind a device from a Mesa. Called from Dashboard.
        Requires: mesa_id
        """
        mesa_id = request.data.get('mesa_id')
        if not mesa_id:
            return Response({'detail': 'mesa_id required'}, status=400)
        
        try:
            mesa = Mesa.objects.get(id=mesa_id)
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)
        
        if not mesa.device_token_hash:
            return Response({'detail': 'Mesa has no linked device'}, status=400)
        
        # Clear device link
        mesa.device_token_hash = None
        mesa.pairing_code = None
        mesa.last_error = None
        mesa.save(update_fields=['device_token_hash', 'pairing_code', 'last_error'])
        
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


    @action(detail=False, methods=['get'], renderer_classes=[ServerSentEventRenderer])
    def stream(self, request):
        """
        Server-Sent Events (SSE) stream for real-time updates.
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        import time
        import json
        from django.http import StreamingHttpResponse
        
        def event_stream():
            last_check = mesa.ultima_actualizacion
            
            # Send initial state immediately
            initial_data = {
                'type': 'calibration',
                'data': {'corners': mesa.calibration_json.get('corners')} if mesa.calibration_json else {}
            }
            yield f"data: {json.dumps(initial_data)}\n\n"
            
            while True:
                # Refresh from DB to check for updates
                mesa.refresh_from_db()
                
                if mesa.ultima_actualizacion > last_check:
                    last_check = mesa.ultima_actualizacion
                    payload = {
                        'type': 'calibration',
                        'data': {'corners': mesa.calibration_json.get('corners')} if mesa.calibration_json else {}
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                
                # Check every 100ms
                time.sleep(0.1)

        response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'  # Disable Nginx buffering
        return response

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
        token = None
        
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]
        elif request.query_params.get('token'):
            token = request.query_params.get('token')
            
        if not token:
            return None
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
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset

    def perform_create(self, serializer):
        item = serializer.save()
        from api.models import MesaQueueStatus
        
        # Check if there are any active items (MOSTRANDO)
        # If not, auto-promote this new item
        active_exists = MesaQueueItem.objects.filter(
            mesa=item.mesa,
            status=MesaQueueStatus.MOSTRANDO
        ).exists()
        
        if not active_exists:
            item.status = MesaQueueStatus.MOSTRANDO
            item.save(update_fields=['status'])
            item.mesa.imagen_actual = item.imagen
            item.mesa.save(update_fields=['imagen_actual'])

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