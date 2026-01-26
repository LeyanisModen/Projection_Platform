from django.db import models
from django.contrib.auth.models import User


# =============================================================================
# FASE CHOICES
# =============================================================================
class Fase(models.TextChoices):
    INFERIOR = 'INFERIOR', 'Inferior'
    SUPERIOR = 'SUPERIOR', 'Superior'


class MesaQueueStatus(models.TextChoices):
    EN_COLA = 'EN_COLA', 'En Cola'
    MOSTRANDO = 'MOSTRANDO', 'Mostrando'
    HECHO = 'HECHO', 'Hecho'


class ModuloEstado(models.TextChoices):
    PENDIENTE = 'PENDIENTE', 'Pendiente'
    EN_PROGRESO = 'EN_PROGRESO', 'En Progreso'
    COMPLETADO = 'COMPLETADO', 'Completado'
    CERRADO = 'CERRADO', 'Cerrado'


# =============================================================================
# CORE MODELS
# =============================================================================
class Proyecto(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='proyectos')

    def __str__(self):
        return self.nombre

    class Meta:
        db_table = 'api_proyecto'



class Planta(models.Model):
    """
    Planta/Nivel dentro de un proyecto.
    Jerarquía: Proyecto -> Planta -> Modulo
    """
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='plantas')
    orden = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"{self.proyecto.nombre} - {self.nombre}"

    class Meta:
        db_table = 'api_planta'
        ordering = ['orden', 'nombre']
        constraints = [
            models.UniqueConstraint(
                fields=['proyecto', 'nombre'],
                name='unique_planta_nombre_per_proyecto'
            ),
        ]


class Modulo(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    planta = models.ForeignKey(
        Planta,
        on_delete=models.CASCADE,
        related_name='modulos',
        null=True,  # Temporarily nullable for migration
        blank=True
    )
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='modulos')
    
    # Estado por fase
    inferior_hecho = models.BooleanField(default=False)
    superior_hecho = models.BooleanField(default=False)
    estado = models.CharField(
        max_length=20,
        choices=ModuloEstado.choices,
        default=ModuloEstado.PENDIENTE
    )
    
    # Cierre por supervisor
    cerrado = models.BooleanField(default=False)
    cerrado_at = models.DateTimeField(null=True, blank=True)
    cerrado_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='modulos_cerrados'
    )

    def __str__(self):
        planta_nombre = self.planta.nombre if self.planta else "Sin planta"
        return f"{self.nombre} ({planta_nombre})"

    def actualizar_estado(self):
        """Update estado based on phase completion."""
        if self.cerrado:
            self.estado = ModuloEstado.CERRADO
        elif self.inferior_hecho and self.superior_hecho:
            self.estado = ModuloEstado.COMPLETADO
        elif self.inferior_hecho or self.superior_hecho:
            self.estado = ModuloEstado.EN_PROGRESO
        else:
            self.estado = ModuloEstado.PENDIENTE
        self.save(update_fields=['estado'])

    def save(self, *args, **kwargs):
        # Sync booleans if estado is changed manually (e.g. from Admin)
        if self.estado == ModuloEstado.COMPLETADO or self.estado == ModuloEstado.CERRADO:
            self.inferior_hecho = True
            self.superior_hecho = True
        elif self.estado == ModuloEstado.PENDIENTE:
            self.inferior_hecho = False
            self.superior_hecho = False
            
        super().save(*args, **kwargs)

    class Meta:
        db_table = 'api_modulo'


class ImagenStatus(models.TextChoices):
    DRAFT = 'DRAFT', 'Borrador'
    PUBLISHED = 'PUBLISHED', 'Publicado'
    ARCHIVED = 'ARCHIVED', 'Archivado'


class Imagen(models.Model):
    id = models.AutoField(primary_key=True)
    url = models.CharField(max_length=500, blank=True, null=True)
    archivo = models.FileField(upload_to='imagenes/', blank=True, null=True)
    uploaded_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    tipo = models.CharField(max_length=200, blank=True, null=True)  # Legacy field
    modulo = models.ForeignKey(Modulo, on_delete=models.CASCADE, related_name='imagenes')
    
    # New fields for phase/sequence management
    fase = models.CharField(
        max_length=20,
        choices=Fase.choices,
        default=Fase.INFERIOR
    )
    orden = models.PositiveIntegerField(default=1)
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(
        max_length=20,
        choices=ImagenStatus.choices,
        default=ImagenStatus.DRAFT
    )
    activo = models.BooleanField(default=True)
    checksum = models.CharField(max_length=64, blank=True, null=True)

    def __str__(self):
        return f"{self.fase} - {self.orden} - {self.url}"

    class Meta:
        db_table = 'api_imagen'
        constraints = [
            models.UniqueConstraint(
                fields=['modulo', 'fase', 'orden', 'version'],
                name='unique_imagen_modulo_fase_orden_version'
            ),
            models.CheckConstraint(
                check=models.Q(fase__in=[Fase.INFERIOR, Fase.SUPERIOR]),
                name='check_imagen_fase_valid'
            ),
        ]
        indexes = [
            models.Index(fields=['modulo']),
            models.Index(fields=['modulo', 'fase']),
            models.Index(fields=['modulo', 'fase', 'orden']),
        ]


class Mesa(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name='mesas')
    
    # Cache visual (source of truth is MesaQueueItem with status MOSTRANDO)
    imagen_actual = models.ForeignKey(
        Imagen,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mesas_asignadas'
    )
    ultima_actualizacion = models.DateTimeField(auto_now=True)
    
    # Operational state
    # Operational state
    locked = models.BooleanField(default=False)
    blackout = models.BooleanField(default=False)
    last_seen = models.DateTimeField(null=True, blank=True)
    
    # Device Pairing (PoC)
    device_token_hash = models.CharField(max_length=128, null=True, blank=True, unique=True)
    pairing_code = models.CharField(max_length=10, null=True, blank=True)
    pairing_code_expires_at = models.DateTimeField(null=True, blank=True)
    mapper_enabled = models.BooleanField(default=False)
    calibration_json = models.JSONField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)

    def __str__(self):
        return self.nombre

    class Meta:
        db_table = 'api_mesa'


# =============================================================================
# DEVICE PAIRING SESSION (Option B - Generic Pairing)
# =============================================================================
class PairingSession(models.Model):
    """
    Temporary session for device pairing when mesa is not yet known.
    Allows device to show code, then admin chooses which mesa to link.
    """
    id = models.AutoField(primary_key=True)
    pairing_code = models.CharField(max_length=10, unique=True)
    expires_at = models.DateTimeField()
    
    # Once paired, store the token hash and linked mesa
    device_token_hash = models.CharField(max_length=128, null=True, blank=True)
    mesa = models.ForeignKey(Mesa, on_delete=models.CASCADE, null=True, blank=True)
    
    # Session metadata
    created_at = models.DateTimeField(auto_now_add=True)
    device_info = models.JSONField(null=True, blank=True)  # User-agent, IP, etc.
    
    class Meta:
        db_table = 'api_pairing_session'
    
    def __str__(self):
        return f"Pairing {self.pairing_code} -> {self.mesa.nombre if self.mesa else 'unlinked'}"




class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    telefono = models.CharField(max_length=20, blank=True, null=True)
    direccion = models.CharField(max_length=300, blank=True, null=True)
    coordinador = models.CharField(max_length=100, blank=True, null=True)
    password_texto_plano = models.CharField(max_length=128, blank=True, null=True)

    def __str__(self):
        return f"Perfil de {self.user.username}"

    class Meta:
        db_table = 'api_userprofile'


# =============================================================================
# QUEUE MODELS
# =============================================================================
class ModuloQueue(models.Model):
    """
    Cola de planificación de módulos por proyecto.
    Una cola por proyecto.
    """
    id = models.AutoField(primary_key=True)
    proyecto = models.OneToOneField(
        Proyecto,
        on_delete=models.CASCADE,
        related_name='modulo_queue'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='modulo_queues_creadas'
    )
    activa = models.BooleanField(default=True)

    def __str__(self):
        return f"Cola: {self.proyecto.nombre}"

    class Meta:
        db_table = 'api_modulo_queue'


class ModuloQueueItem(models.Model):
    """
    Item en la cola de módulos (ordenable).
    """
    id = models.AutoField(primary_key=True)
    queue = models.ForeignKey(
        ModuloQueue,
        on_delete=models.CASCADE,
        related_name='items'
    )
    modulo = models.ForeignKey(
        Modulo,
        on_delete=models.CASCADE,
        related_name='queue_items'
    )
    position = models.PositiveIntegerField(default=0)
    added_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='modulo_queue_items_added'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.queue.proyecto.nombre} - {self.modulo.nombre} (pos: {self.position})"

    class Meta:
        db_table = 'api_modulo_queue_item'
        ordering = ['position']
        constraints = [
            models.UniqueConstraint(
                fields=['queue', 'modulo'],
                name='unique_modulo_in_queue'
            ),
        ]
        indexes = [
            models.Index(fields=['queue', 'position']),
            models.Index(fields=['modulo']),
        ]


class MesaQueueItem(models.Model):
    """
    WorkItem: trabajo asignado a una mesa (cola ejecutable).
    Cada item es una fase de un módulo con su imagen concreta.
    """
    id = models.AutoField(primary_key=True)
    mesa = models.ForeignKey(
        Mesa,
        on_delete=models.CASCADE,
        related_name='queue_items'
    )
    modulo = models.ForeignKey(
        Modulo,
        on_delete=models.CASCADE,
        related_name='mesa_queue_items'
    )
    fase = models.CharField(
        max_length=20,
        choices=Fase.choices
    )
    imagen = models.ForeignKey(
        Imagen,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mesa_queue_items'
    )
    position = models.PositiveIntegerField(default=0)
    status = models.CharField(
        max_length=20,
        choices=MesaQueueStatus.choices,
        default=MesaQueueStatus.EN_COLA
    )
    
    # Assignment tracking
    assigned_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mesa_queue_items_assigned'
    )
    assigned_at = models.DateTimeField(auto_now_add=True)
    
    # Completion tracking
    done_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mesa_queue_items_done'
    )
    done_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Mesa {self.mesa.nombre} - {self.modulo.nombre} ({self.fase}) - {self.status}"

    def save(self, *args, **kwargs):
        # Validate that imagen belongs to the same modulo and fase
        # Validate that imagen belongs to the same modulo and fase if imagen is present
        if self.imagen:
            if self.imagen.modulo_id != self.modulo_id:
                raise ValueError(
                    f"Imagen {self.imagen_id} no pertenece al módulo {self.modulo_id}"
                )
            if self.imagen.fase != self.fase:
                raise ValueError(
                    f"Imagen {self.imagen_id} es fase {self.imagen.fase}, no {self.fase}"
                )
        super().save(*args, **kwargs)

    def marcar_hecho(self, user=None):
        """Mark this item as done and update module phase status."""
        from django.utils import timezone
        
        self.status = MesaQueueStatus.HECHO
        # Handle AnonymousUser (if coming from unrestrained API)
        if user and not user.is_authenticated:
            user = None
        self.done_by = user
        self.done_at = timezone.now()
        self.save()  # Ensure HECHO status is persisted

        # Update module phase status
        if self.fase == Fase.INFERIOR:
            self.modulo.inferior_hecho = True
            self.modulo.save(update_fields=['inferior_hecho'])
        elif self.fase == Fase.SUPERIOR:
            self.modulo.superior_hecho = True
            self.modulo.save(update_fields=['superior_hecho'])
        
        self.modulo.actualizar_estado()

        # Auto-promote next 'EN_COLA' item
        # If there is another item in queue, set it to MOSTRANDO immediately
        next_item = MesaQueueItem.objects.filter(
            mesa=self.mesa,
            status=MesaQueueStatus.EN_COLA
        ).order_by('position').first()

        if next_item:
            next_item.status = MesaQueueStatus.MOSTRANDO
            next_item.save(update_fields=['status'])
            self.mesa.imagen_actual = next_item.imagen
            self.mesa.save(update_fields=['imagen_actual'])

    class Meta:
        db_table = 'api_mesa_queue_item'
        ordering = ['position']
        constraints = [
            models.CheckConstraint(
                check=models.Q(fase__in=[Fase.INFERIOR, Fase.SUPERIOR]),
                name='check_mesa_queue_item_fase_valid'
            ),
            models.CheckConstraint(
                check=models.Q(status__in=[
                    MesaQueueStatus.EN_COLA,
                    MesaQueueStatus.MOSTRANDO,
                    MesaQueueStatus.HECHO
                ]),
                name='check_mesa_queue_item_status_valid'
            ),
        ]
        indexes = [
            models.Index(fields=['mesa', 'position']),
            models.Index(fields=['mesa', 'status']),
            models.Index(fields=['modulo', 'fase']),
        ]