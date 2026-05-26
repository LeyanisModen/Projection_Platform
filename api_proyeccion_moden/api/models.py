from decimal import Decimal, InvalidOperation

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


class MesaTipo(models.TextChoices):
    INFERIOR = 'INFERIOR', 'Inferior'
    SUPERIOR = 'SUPERIOR', 'Superior'


class MaterialTipo(models.TextChoices):
    REFUERZO = 'REFUERZO', 'Refuerzo'
    BARRA_SOLAPE = 'BARRA_SOLAPE', 'Barra de solape de zuncho'
    ZUNCHO = 'ZUNCHO', 'Zuncho'
    SEPARADOR = 'SEPARADOR', 'Separador'
    PUNZO = 'PUNZO', 'Punzonamiento'


class MaterialOrigenCheck(models.TextChoices):
    PROYECTO = 'PROYECTO', 'Proyecto'
    GENERAL = 'GENERAL', 'General'


# =============================================================================
# CORE MODELS
# =============================================================================
class EstrategiaBastidor(models.TextChoices):
    SECUENCIAL = 'SECUENCIAL', 'Secuencial'
    AISLAR_CENTRAL_GIRADO = 'AISLAR_CENTRAL_GIRADO', 'Aislar central girado'


class Proyecto(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='proyectos')
    bastidor_longitud_cm = models.DecimalField(
        max_digits=6,
        decimal_places=2,
        default=114,
        help_text='Longitud util del bastidor para calcular capacidad por espesor.'
    )
    datos_tecnicos_importados = models.BooleanField(
        default=False,
        help_text='Indica si ya se importo el fichero de datos tecnicos y se calcularon los grupos.'
    )
    estrategia_bastidor = models.CharField(
        max_length=32,
        choices=EstrategiaBastidor.choices,
        default=EstrategiaBastidor.SECUENCIAL,
        help_text='Estrategia de agrupacion: SECUENCIAL = corte solo por longitud; '
                  'AISLAR_CENTRAL_GIRADO = separa modulos central_girado del resto.'
    )

    def __str__(self):
        return self.nombre

    class Meta:
        db_table = 'api_proyecto'


class GrupoBastidor(models.Model):
    """
    Agrupacion fisica de modulos que comparten un bastidor de acopio.
    Una vez calculados son inmutables: un modulo reiniciado permanece en su grupo.
    """
    id = models.AutoField(primary_key=True)
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='grupos_bastidor')
    indice = models.PositiveIntegerField(help_text='Numero de grupo dentro del proyecto (1, 2, 3...).')
    nombre = models.CharField(
        max_length=120,
        blank=True,
        default='',
        help_text='Alias opcional del grupo (p.ej. "Fachada norte"). Vacio => se usa el indice.'
    )
    asignado_a = models.ForeignKey(
        'GrupoMesas',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='grupos_bastidor_reservados',
        help_text='Grupo operativo al que se ha reservado este bastidor. Null => disponible.',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        if self.nombre:
            return f"{self.proyecto.nombre} - {self.nombre}"
        return f"{self.proyecto.nombre} - Grupo {self.indice}"

    class Meta:
        db_table = 'api_grupo_bastidor'
        ordering = ['proyecto', 'indice']
        constraints = [
            models.UniqueConstraint(
                fields=['proyecto', 'indice'],
                name='unique_grupo_indice_per_proyecto'
            ),
        ]



class Planta(models.Model):
    """
    Planta/Nivel dentro de un proyecto.
    Jerarquía: Proyecto -> Planta -> Modulo
    """
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='plantas')
    orden = models.PositiveIntegerField(default=0)
    
    # New fields for Dashboard
    plano_imagen = models.ImageField(upload_to='planos/', blank=True, null=True)
    fichero_corte = models.FileField(upload_to='cortes/', blank=True, null=True)

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


class TipoModulo(models.TextChoices):
    CENTRAL = 'CENTRAL', 'Central'
    CENTRAL_GIRADO = 'CENTRAL_GIRADO', 'Central girado'
    LADO_LARGO = 'LADO_LARGO', 'Lado largo'
    LADO_CORTO = 'LADO_CORTO', 'Lado corto'
    ESQUINA = 'ESQUINA', 'Esquina'


class Modulo(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    tipo_modulo = models.CharField(
        max_length=32,
        choices=TipoModulo.choices,
        blank=True,
        default='',
        help_text='Tipologia del modulo para agrupacion: CENTRAL, CENTRAL_GIRADO, LADO_LARGO, LADO_CORTO, ESQUINA.'
    )
    ancho_cm = models.DecimalField(
        max_digits=6,
        decimal_places=2,
        null=True,
        blank=True,
        help_text='Ancho util del modulo para agrupacion en bastidor.'
    )
    planta = models.ForeignKey(
        Planta,
        on_delete=models.CASCADE,
        related_name='modulos',
        null=True,  # Temporarily nullable for migration
        blank=True
    )
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='modulos')
    grupo_bastidor = models.ForeignKey(
        'GrupoBastidor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='modulos',
        help_text='Grupo de bastidor al que pertenece el modulo. Se asigna al calcular los grupos.'
    )
    
    # Estado por fase
    inferior_hecho = models.BooleanField(default=False)
    superior_hecho = models.BooleanField(default=False)
    estado = models.CharField(
        max_length=20,
        choices=ModuloEstado.choices,
        default=ModuloEstado.PENDIENTE
    )
    
    # Timestamp cuando ambas fases quedaron hechas
    completado_at = models.DateTimeField(null=True, blank=True)

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

    # Codigo de color de 4 posiciones para validacion de fotos
    codigos_color = models.CharField(
        max_length=8,
        default='xxxxxxxx',
        blank=True,
        help_text='Up to 8 chars: y=yellow, g=green, c=cyan, v=violet, m=magenta, o=orange, x=skip'
    )

    def __str__(self):
        planta_nombre = self.planta.nombre if self.planta else "Sin planta"
        return f"{self.nombre} ({planta_nombre})"

    def actualizar_estado(self):
        """Update estado based on phase completion."""
        from django.utils import timezone
        if self.cerrado:
            self.estado = ModuloEstado.CERRADO
        elif self.inferior_hecho and self.superior_hecho:
            self.estado = ModuloEstado.COMPLETADO
        elif self.inferior_hecho or self.superior_hecho:
            self.estado = ModuloEstado.EN_PROGRESO
        else:
            self.estado = ModuloEstado.PENDIENTE

        # Stamp / clear completado_at based on final estado
        if self.estado in (ModuloEstado.COMPLETADO, ModuloEstado.CERRADO):
            if self.completado_at is None:
                self.completado_at = timezone.now()
        else:
            self.completado_at = None

        self.save(update_fields=[
            'estado', 'inferior_hecho', 'superior_hecho', 'completado_at'
        ])

    def save(self, *args, **kwargs):
        from django.utils import timezone
        # Sync booleans if estado is changed manually (e.g. from Admin)
        if self.estado == ModuloEstado.COMPLETADO or self.estado == ModuloEstado.CERRADO:
            self.inferior_hecho = True
            self.superior_hecho = True
            if self.completado_at is None:
                self.completado_at = timezone.now()
        elif self.estado == ModuloEstado.PENDIENTE:
            self.inferior_hecho = False
            self.superior_hecho = False
            self.completado_at = None
        # EN_PROGRESO: clear completado_at if it was set
        elif self.estado == ModuloEstado.EN_PROGRESO and self.completado_at is not None:
            self.completado_at = None

        super().save(*args, **kwargs)

    class Meta:
        db_table = 'api_modulo'


class DetalleModuloFase(models.Model):
    """
    Datos tecnicos y metricas importadas para cada modulo y fase.
    La fase INFERIOR representa la fabricacion inferior + montaje.
    """
    id = models.AutoField(primary_key=True)
    modulo = models.ForeignKey(
        Modulo,
        on_delete=models.CASCADE,
        related_name='detalles_fase'
    )
    fase = models.CharField(
        max_length=20,
        choices=Fase.choices
    )

    espesor_cm = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    peso_malla_inicial_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    peso_malla_final_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    desperdicio_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    cantidad_cortes = models.PositiveIntegerField(null=True, blank=True)
    cantidad_refuerzos = models.PositiveIntegerField(null=True, blank=True)
    peso_refuerzos_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)

    # Metricas especificas de la fase inferior + montaje.
    cantidad_zunchos = models.PositiveIntegerField(null=True, blank=True)
    peso_zunchos_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    cantidad_separadores = models.PositiveIntegerField(null=True, blank=True)
    peso_separadores_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    cantidad_punzos = models.PositiveIntegerField(null=True, blank=True)
    peso_punzos_kg = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)

    # Linear meters of each element kind (per phase totals).
    metros_refuerzos = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    metros_zunchos = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    metros_separadores = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    metros_punzos = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)

    dificultad_fabricacion = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    observaciones = models.TextField(blank=True, null=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.modulo.nombre} - {self.fase}"

    @property
    def capacidad_bastidor(self):
        try:
            longitud_bastidor = Decimal(self.modulo.proyecto.bastidor_longitud_cm)
            ancho_modulo = Decimal(self.modulo.ancho_cm or self.espesor_cm)
        except (TypeError, InvalidOperation):
            return None
        if ancho_modulo <= 0:
            return None
        return max(int(longitud_bastidor / ancho_modulo), 0)

    @property
    def peso_total_kg(self):
        values = [
            self.peso_malla_final_kg,
            self.peso_refuerzos_kg,
            self.peso_zunchos_kg,
            self.peso_separadores_kg,
            self.peso_punzos_kg,
        ]
        if not any(value is not None for value in values):
            return None
        return sum(value for value in values if value is not None)

    @property
    def dificultad_calculada(self):
        """
        Heuristic difficulty score per phase.

        Time units: cut=1, weld=2, color ribbon=1.5.

        Each element contributes (cantidad*2 + metros_lineales) welds at
        its extremes plus one weld every linear meter. Separators count
        x3 (2 bottom bars + 1 top), zunchos and punzos x4. Color ribbons
        only apply on SUPERIOR phase and come from modulo.codigos_color
        (any char != 'x' counts as one ribbon). Weight is normalized /100.
        """
        def _num(value):
            if value is None or value == '':
                return Decimal('0')
            try:
                return Decimal(value)
            except (TypeError, InvalidOperation):
                return Decimal('0')

        cortes = _num(self.cantidad_cortes)
        is_sup = self.fase == Fase.SUPERIOR

        # Soldaduras por elemento
        def _welds(count, meters, multiplier):
            return (count * Decimal('2') + meters) * multiplier

        welds = Decimal('0')
        welds += _welds(_num(self.cantidad_refuerzos), _num(self.metros_refuerzos), Decimal('1'))
        if not is_sup:
            # Separadores: la DB actual aún no trae longitud; asumir 2m por unidad
            sep_count = _num(self.cantidad_separadores)
            sep_meters = _num(self.metros_separadores)
            if sep_meters <= 0 and sep_count > 0:
                sep_meters = sep_count * Decimal('2')
            welds += _welds(sep_count, sep_meters, Decimal('3'))
            welds += _welds(_num(self.cantidad_zunchos), _num(self.metros_zunchos), Decimal('4'))
            welds += _welds(_num(self.cantidad_punzos), _num(self.metros_punzos), Decimal('4'))

        time_units = cortes * Decimal('1') + welds * Decimal('2')

        # Color ribbons: only SUPERIOR, count non-'x' chars in modulo code.
        if is_sup and self.modulo and self.modulo.codigos_color:
            ribbons = sum(1 for c in self.modulo.codigos_color if c and c.lower() != 'x')
            time_units += Decimal(ribbons) * Decimal('1.5')

        # Weight component (normalized /100 as modules are heavy).
        weight_component = Decimal('0')
        total_weight = self.peso_total_kg
        if total_weight is not None:
            try:
                weight_component = Decimal(total_weight) / Decimal('100')
            except (TypeError, InvalidOperation):
                weight_component = Decimal('0')

        return float(time_units + weight_component)

    class Meta:
        db_table = 'api_detalle_modulo_fase'
        ordering = ['modulo', 'fase']
        constraints = [
            models.UniqueConstraint(
                fields=['modulo', 'fase'],
                name='unique_detalle_modulo_por_fase'
            ),
            models.CheckConstraint(
                check=models.Q(fase__in=[Fase.INFERIOR, Fase.SUPERIOR]),
                name='check_detalle_modulo_fase_valid'
            ),
        ]
        indexes = [
            models.Index(fields=['modulo', 'fase']),
            models.Index(fields=['fase']),
        ]


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


class FotoFabricacion(models.Model):
    """
    Foto de evidencia capturada durante la fabricacion.
    Separada de Imagen (planos) -- estas son capturas de camara
    tomadas en cada paso de proyeccion como evidencia de calidad.
    """
    id = models.AutoField(primary_key=True)
    modulo = models.ForeignKey(
        Modulo,
        on_delete=models.CASCADE,
        related_name='fotos_fabricacion'
    )
    mesa = models.ForeignKey(
        'Mesa',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='fotos_capturadas'
    )
    fase = models.CharField(
        max_length=20,
        choices=Fase.choices
    )
    paso = models.PositiveIntegerField(
        help_text="Indice de imagen (0-based) en el que se capturo la foto"
    )
    imagen_referencia = models.ForeignKey(
        Imagen,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='fotos_evidencia',
        help_text="Imagen de plano que se estaba proyectando al capturar esta foto"
    )
    url = models.CharField(
        max_length=500,
        help_text="Ruta URL relativa al archivo de foto almacenado"
    )
    capturada_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    filename_original = models.CharField(max_length=255, blank=True, null=True)
    file_size = models.PositiveIntegerField(null=True, blank=True, help_text="Tamano del archivo en bytes")
    check_result = models.BooleanField(
        null=True,
        blank=True,
        help_text="Resultado de la validacion de colores. null = foto no pasada por check."
    )
    check_detail = models.JSONField(
        null=True,
        blank=True,
        help_text="Detalle del algoritmo: expected, detected, pixel_ratios, min_ratio."
    )

    def __str__(self):
        fase_pref = "INF" if self.fase == "INFERIOR" else "SUP"
        return f"Foto {self.modulo.nombre} {fase_pref}-paso{self.paso} ({self.capturada_at})"

    class Meta:
        db_table = 'api_foto_fabricacion'
        ordering = ['-capturada_at']
        unique_together = [('modulo', 'fase', 'paso')]
        indexes = [
            models.Index(fields=['modulo', 'fase']),
            models.Index(fields=['modulo', 'fase', 'paso']),
            models.Index(fields=['mesa']),
        ]


class GrupoMesas(models.Model):
    """
    Grupo operativo de 3 mesas para una ferralla:
    INFERIOR_1, INFERIOR_2 y SUPERIORES.
    """
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='grupos_mesas'
    )
    proyecto_actual = models.ForeignKey(
        Proyecto,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='grupos_mesas_activos',
    )
    activa = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.usuario.username} - {self.nombre}"

    def ensure_default_mesas(self):
        """Crea las mesas por defecto del grupo solo si nace vacio.

        Default: tres mesas con indice global 1..3 nombradas 'Mesa N',
        con tipos (INF, INF, SUP). Despues del primer alta no recrea
        nada para no revertir modificaciones del cliente.
        """
        if self.mesas.exists():
            return
        defaults = [
            (1, MesaTipo.INFERIOR),
            (2, MesaTipo.INFERIOR),
            (3, MesaTipo.SUPERIOR),
        ]
        for indice, tipo in defaults:
            Mesa.objects.create(
                nombre=f"Mesa {indice}",
                usuario=self.usuario,
                grupo=self,
                tipo=tipo,
                indice=indice,
            )

    class Meta:
        db_table = 'api_grupo_mesas'
        ordering = ['usuario__username', 'nombre']
        constraints = [
            models.UniqueConstraint(
                fields=['usuario', 'nombre'],
                name='unique_grupo_mesas_nombre_por_usuario'
            ),
        ]


class GrupoMesasProyecto(models.Model):
    """
    Cola ordenada de proyectos asignados a un grupo operativo de mesas.
    El primero (orden mas bajo) es el que se esta fabricando ahora mismo;
    los siguientes entraran cuando el actual se agote. Un mismo proyecto
    puede estar en la cola de varios grupos operativos a la vez (fabricacion
    en paralelo).
    """
    id = models.AutoField(primary_key=True)
    grupo_mesas = models.ForeignKey(
        'GrupoMesas',
        on_delete=models.CASCADE,
        related_name='proyectos_cola',
    )
    proyecto = models.ForeignKey(
        Proyecto,
        on_delete=models.CASCADE,
        related_name='colas_grupos_mesas',
    )
    orden = models.PositiveIntegerField(
        default=0,
        help_text='Posicion en la cola. Menor => antes se fabrica.'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.grupo_mesas.nombre} #{self.orden}: {self.proyecto.nombre}"

    class Meta:
        db_table = 'api_grupo_mesas_proyecto'
        ordering = ['grupo_mesas', 'orden']
        constraints = [
            models.UniqueConstraint(
                fields=['grupo_mesas', 'proyecto'],
                name='unique_proyecto_por_grupo_mesas'
            ),
        ]


class Mesa(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario = models.ForeignKey(User, on_delete=models.CASCADE, related_name='mesas')
    grupo = models.ForeignKey(
        'GrupoMesas',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mesas'
    )
    tipo = models.CharField(
        max_length=20,
        choices=MesaTipo.choices,
        default=MesaTipo.INFERIOR,
    )
    indice = models.PositiveIntegerField(default=1)
    activa = models.BooleanField(
        default=True,
        help_text='Si False, el planificador la ignora pero se conserva (mesa en mantenimiento o proyector roto).',
    )

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

    # Reported by the visor's heartbeat so the dashboard can flag a
    # mini-PC whose local capture service is down or whose lens looks
    # dirty. null => nothing reported yet.
    capture_service_online = models.BooleanField(null=True, blank=True)
    camera_sharpness = models.CharField(
        max_length=16,
        null=True,
        blank=True,
        help_text="Reported by the mini-PC: 'ok' | 'warning' | 'blurry' | 'unknown'.",
    )
    # Latest result of a _check slide. Source of truth for both the
    # player (mini-PC) and the visor (dashboard) so they show the same
    # success/error/no_camera overlay and apply the same SPACE-to-clear
    # block. Cleared by an explicit POST to clear_check_overlay/.
    check_overlay = models.CharField(
        max_length=16,
        null=True,
        blank=True,
        help_text="Latest _check result for this mesa: 'success' | 'error' | 'no_camera' | null.",
    )

    # Device Pairing (PoC)
    device_token_hash = models.CharField(max_length=128, null=True, blank=True, unique=True)
    pairing_code = models.CharField(max_length=10, null=True, blank=True)
    pairing_code_expires_at = models.DateTimeField(null=True, blank=True)
    mapper_enabled = models.BooleanField(default=False)
    current_image_index = models.IntegerField(default=0)
    calibration_json = models.JSONField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)

    def __str__(self):
        return self.nombre

    class Meta:
        db_table = 'api_mesa'
        constraints = [
            models.UniqueConstraint(
                fields=['grupo', 'indice'],
                condition=models.Q(grupo__isnull=False),
                name='unique_indice_por_grupo_mesas'
            ),
        ]


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
    capacidad_diaria_modulos = models.PositiveIntegerField(
        default=12,
        help_text='Modulos que la ferralla produce por dia (se reparten entre sus mesas INF).'
    )

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
    plan_group_index = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text='Indice de grupo de bastidor dentro de la planificacion automatica.'
    )
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
        # When only moving/reordering (mesa/position), skip image-module consistency checks.
        update_fields = kwargs.get('update_fields')
        should_validate_image_link = (
            update_fields is None
            or any(field in update_fields for field in ['imagen', 'imagen_id', 'modulo', 'modulo_id', 'fase'])
        )

        # Validate that imagen belongs to the same modulo and fase if imagen is present.
        if should_validate_image_link and self.imagen:
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
        
        # Also update the module phase status
        if self.fase == Fase.INFERIOR:
            self.modulo.inferior_hecho = True
        else:
            self.modulo.superior_hecho = True
        self.modulo.actualizar_estado()

    class Meta:
        db_table = 'api_mesa_queue_item'
        ordering = ['position']
        constraints = [
            # Allow historical HECHO rows, but keep at most one active assignment.
            models.UniqueConstraint(
                fields=['modulo', 'fase'],
                condition=models.Q(
                    status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO]
                ),
                name='unique_active_modulo_fase_assignment'
            ),
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
            models.Index(fields=['mesa', 'plan_group_index']),
        ]


# =============================================================================
# SHOPPING LIST (lista de compra de materiales)
# =============================================================================
class MaterialPieza(models.Model):
    """One row per individual piece imported from the per-project materials .db.

    Refuerzos and barras_solape carry an explicit `capa` column in the source
    .db. Zunchos, separadores and punzos do not — by domain rule they always
    belong to the inferior phase, so the importer stores them as INFERIOR.
    `subtipo` is the canonical identifier within a tipo: '10' for Ø10,
    'Z1' for zuncho Z1, '20' for separador altura 20cm, etc.
    """
    proyecto = models.ForeignKey(
        Proyecto,
        on_delete=models.CASCADE,
        related_name='materiales',
    )
    modulo = models.ForeignKey(
        Modulo,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='materiales',
    )
    tipo = models.CharField(max_length=20, choices=MaterialTipo.choices)
    capa = models.CharField(max_length=20, choices=Fase.choices)
    subtipo = models.CharField(max_length=40)
    longitud = models.DecimalField(max_digits=10, decimal_places=4)

    class Meta:
        db_table = 'api_material_pieza'
        indexes = [
            models.Index(fields=['proyecto', 'tipo', 'subtipo']),
            models.Index(fields=['modulo', 'capa']),
        ]

    def __str__(self):
        return f"{self.tipo} {self.subtipo} · {self.longitud}m"


class MaterialInformado(models.Model):
    """Per-project, per-material-key state of the shopping-list checkbox.

    `origen` differentiates whether a row was marked from the per-project
    modal ('PROYECTO') or propagated from the general aggregated view
    ('GENERAL'), so unchecking from the general view only affects rows
    it itself marked, leaving manual per-project marks alone.
    """
    proyecto = models.ForeignKey(
        Proyecto,
        on_delete=models.CASCADE,
        related_name='materiales_informados',
    )
    clave_material = models.CharField(max_length=80)
    informado = models.BooleanField(default=False)
    origen = models.CharField(
        max_length=20,
        choices=MaterialOrigenCheck.choices,
        null=True,
        blank=True,
    )
    fecha_marcado = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'api_material_informado'
        constraints = [
            models.UniqueConstraint(
                fields=['proyecto', 'clave_material'],
                name='unique_material_informado_proyecto_clave',
            ),
        ]
        indexes = [
            models.Index(fields=['proyecto', 'informado']),
            models.Index(fields=['clave_material']),
        ]

    def __str__(self):
        return f"{self.proyecto_id} · {self.clave_material} = {self.informado}"

