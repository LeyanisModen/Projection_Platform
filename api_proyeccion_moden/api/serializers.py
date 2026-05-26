from django.contrib.auth.models import User
from rest_framework import serializers

from api.models import (
    Proyecto, Planta, Modulo, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem, UserProfile, MesaQueueStatus,
    FotoFabricacion, GrupoMesas, GrupoMesasProyecto,
    DetalleModuloFase, GrupoBastidor
)


class UserSerializer(serializers.HyperlinkedModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    first_name = serializers.CharField(required=False, allow_blank=True)
    last_name = serializers.CharField(required=False, allow_blank=True)
    telefono = serializers.CharField(source='profile.telefono', required=False, allow_blank=True, allow_null=True)
    direccion = serializers.CharField(source='profile.direccion', required=False, allow_blank=True, allow_null=True)
    coordinador = serializers.CharField(source='profile.coordinador', required=False, allow_blank=True, allow_null=True)
    capacidad_diaria_modulos = serializers.IntegerField(
        source='profile.capacidad_diaria_modulos', required=False, min_value=1
    )

    class Meta:
        model = User
        fields = [
            "id", "url", "username", "email", "password", "groups",
            "first_name", "last_name", "telefono", "direccion", "coordinador",
            "capacidad_diaria_modulos",
        ]


    def create(self, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')
        capacidad = profile_data.get('capacidad_diaria_modulos')

        user = super().create(validated_data)

        if password:
            user.set_password(password)
            user.save()

        profile_kwargs = {
            'telefono': telefono or '',
            'direccion': direccion or '',
            'coordinador': coordinador or '',
        }
        if capacidad is not None:
            profile_kwargs['capacidad_diaria_modulos'] = capacidad
        UserProfile.objects.create(user=user, **profile_kwargs)

        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')
        capacidad = profile_data.get('capacidad_diaria_modulos')

        user = super().update(instance, validated_data)
        
        # Profile updates
        profile_defaults = {}
        if telefono is not None:
            profile_defaults['telefono'] = telefono
        if direccion is not None:
            profile_defaults['direccion'] = direccion
        if coordinador is not None:
            profile_defaults['coordinador'] = coordinador
        if capacidad is not None:
            profile_defaults['capacidad_diaria_modulos'] = capacidad

        # Password handling
        if password:
            user.set_password(password)
            user.save()
            
        if profile_defaults:
            UserProfile.objects.update_or_create(
                user=user,
                defaults=profile_defaults
            )

        return user


# =============================================================================
# CORE SERIALIZERS
# =============================================================================
class ProyectoSerializer(serializers.HyperlinkedModelSerializer):
    num_plantas = serializers.IntegerField(write_only=True, required=False, min_value=0, default=0)
    usuario_nombre = serializers.ReadOnlyField(source='usuario.username')
    capacidad_diaria_usuario = serializers.SerializerMethodField()
    grupos_count = serializers.SerializerMethodField()
    modulos_count = serializers.SerializerMethodField()
    modulos_completados = serializers.SerializerMethodField()
    modulos_completados_hoy = serializers.SerializerMethodField()

    class Meta:
        model = Proyecto
        fields = [
            "id", "url", "nombre", "usuario", "usuario_nombre", "num_plantas",
            "bastidor_longitud_cm", "datos_tecnicos_importados",
            "estrategia_bastidor",
            "capacidad_diaria_usuario",
            "grupos_count", "modulos_count", "modulos_completados",
            "modulos_completados_hoy",
        ]

    def get_capacidad_diaria_usuario(self, obj):
        if obj.usuario and hasattr(obj.usuario, 'profile'):
            return obj.usuario.profile.capacidad_diaria_modulos
        return 12
        extra_kwargs = {
            'usuario': {'required': False, 'allow_null': True},
            'datos_tecnicos_importados': {'read_only': True},
        }

    def get_grupos_count(self, obj):
        return getattr(obj, '_grupos_count', None) or obj.grupos_bastidor.count()

    def get_modulos_count(self, obj):
        return getattr(obj, '_modulos_count', None) or obj.modulos.count()

    def get_modulos_completados(self, obj):
        cached = getattr(obj, '_modulos_completados', None)
        if cached is not None:
            return cached
        return obj.modulos.filter(estado__in=['COMPLETADO', 'CERRADO']).count()

    def get_modulos_completados_hoy(self, obj):
        from django.utils import timezone
        today = timezone.localdate()
        current_tz = timezone.get_current_timezone()
        from datetime import timedelta, datetime
        start = timezone.make_aware(datetime.combine(today, datetime.min.time()), current_tz)
        end = timezone.make_aware(datetime.combine(today + timedelta(days=1), datetime.min.time()), current_tz)
        return obj.modulos.filter(
            completado_at__isnull=False,
            completado_at__gte=start,
            completado_at__lt=end,
        ).count()


    def create(self, validated_data):
        num_plantas = validated_data.pop('num_plantas', 0)
        proyecto = super().create(validated_data)

        if num_plantas > 0:
            # Create plants
            # Avoid circular import by importing inside method if needed, 
            # though Planta is already imported at top level
            
            # Batch create for efficiency? Or simple loop. 
            # Loop is fine for small numbers.
            planta_objects = []
            for i in range(1, num_plantas + 1):
                planta_objects.append(
                    Planta(
                        nombre=f"Planta {i}",
                        proyecto=proyecto,
                        orden=i
                    )
                )
            if planta_objects:
                Planta.objects.bulk_create(planta_objects)
                
        return proyecto


class PlantaSerializer(serializers.ModelSerializer):
    modulos_count = serializers.SerializerMethodField()

    class Meta:
        model = Planta
        fields = ["id", "nombre", "proyecto", "orden", "modulos_count", "plano_imagen", "fichero_corte"]

    def get_modulos_count(self, obj):
        if hasattr(obj, 'modulos_count'):
            return obj.modulos_count
        return obj.modulos.count()


class ModuloSerializer(serializers.ModelSerializer):
    fotos_count = serializers.SerializerMethodField()
    detalles_fase = serializers.SerializerMethodField()

    class Meta:
        model = Modulo
        fields = [
            "id", "nombre", "ancho_cm", "tipo_modulo", "planta", "proyecto", "grupo_bastidor",
            "inferior_hecho", "superior_hecho", "estado",
            "cerrado", "cerrado_at", "cerrado_by",
            "codigos_color", "fotos_count", "detalles_fase"
        ]
        read_only_fields = ["cerrado_at", "grupo_bastidor"]

    def get_fotos_count(self, obj):
        if hasattr(obj, '_fotos_count'):
            return obj._fotos_count
        return obj.fotos_fabricacion.count()

    def get_detalles_fase(self, obj):
        detalles = getattr(obj, '_prefetched_objects_cache', {}).get('detalles_fase')
        if detalles is None:
            detalles = obj.detalles_fase.all()
        return DetalleModuloFaseSerializer(detalles, many=True).data


class GrupoBastidorSerializer(serializers.ModelSerializer):
    modulos = serializers.SerializerMethodField()
    longitud_total_cm = serializers.SerializerMethodField()
    capacidad_cm = serializers.SerializerMethodField()
    overflow = serializers.SerializerMethodField()

    class Meta:
        model = GrupoBastidor
        fields = [
            "id", "proyecto", "indice", "nombre", "created_at",
            "modulos", "longitud_total_cm", "capacidad_cm", "overflow",
        ]
        read_only_fields = ["created_at", "proyecto"]

    def _natural_key(self, nombre):
        import re as _re
        parts = _re.split(r'(\d+)', nombre or '')
        return [int(p) if p.isdigit() else p for p in parts]

    def get_modulos(self, obj):
        modulos = sorted(obj.modulos.all(), key=lambda m: self._natural_key(m.nombre))
        return [
            {
                "id": m.id,
                "nombre": m.nombre,
                "ancho_cm": m.ancho_cm,
                "tipo_modulo": m.tipo_modulo,
                "estado": m.estado,
                "inferior_hecho": m.inferior_hecho,
                "superior_hecho": m.superior_hecho,
                "cerrado": m.cerrado,
                "fotos_count": m.fotos_fabricacion.count(),
            }
            for m in modulos
        ]

    def get_longitud_total_cm(self, obj):
        from decimal import Decimal, InvalidOperation
        total = Decimal('0')
        for m in obj.modulos.all():
            if m.ancho_cm in [None, '']:
                continue
            try:
                total += Decimal(m.ancho_cm)
            except (TypeError, InvalidOperation):
                continue
        return float(total)

    def get_capacidad_cm(self, obj):
        from decimal import Decimal, InvalidOperation
        try:
            return float(Decimal(obj.proyecto.bastidor_longitud_cm))
        except (TypeError, InvalidOperation, AttributeError):
            return 114.0

    def get_overflow(self, obj):
        return self.get_longitud_total_cm(obj) > self.get_capacidad_cm(obj)


class DetalleModuloFaseSerializer(serializers.ModelSerializer):
    capacidad_bastidor = serializers.IntegerField(read_only=True)
    peso_total_kg = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)

    class Meta:
        model = DetalleModuloFase
        fields = [
            "id", "modulo", "fase",
            "espesor_cm",
            "peso_malla_inicial_kg", "peso_malla_final_kg", "desperdicio_kg",
            "cantidad_cortes",
            "cantidad_refuerzos", "peso_refuerzos_kg", "metros_refuerzos",
            "cantidad_zunchos", "peso_zunchos_kg", "metros_zunchos",
            "cantidad_separadores", "peso_separadores_kg", "metros_separadores",
            "cantidad_punzos", "peso_punzos_kg", "metros_punzos",
            "dificultad_fabricacion",
            "observaciones",
            "capacidad_bastidor", "peso_total_kg",
            "created_at", "updated_at"
        ]
        read_only_fields = ["created_at", "updated_at", "capacidad_bastidor", "peso_total_kg"]


class ImagenSerializer(serializers.HyperlinkedModelSerializer):
    src = serializers.CharField(source='url', read_only=True)
    nombre = serializers.SerializerMethodField()
    
    class Meta:
        model = Imagen
        fields = [
            "id", "url", "src", "nombre", "modulo",
            "fase", "orden", "version", "activo", "checksum"
        ]

    def get_nombre(self, obj):
        # Format: INF-001-MOD-A1
        fase_pref = "INF" if obj.fase == "INFERIOR" else "SUP"
        modulo_nombre = obj.modulo.nombre if obj.modulo else "UNKNOWN"
        return f"{fase_pref}-{obj.orden:03d}-{modulo_nombre}"


class FotoFabricacionSerializer(serializers.ModelSerializer):
    modulo_nombre = serializers.CharField(source='modulo.nombre', read_only=True)
    planta_nombre = serializers.SerializerMethodField()
    proyecto_id = serializers.SerializerMethodField()
    mesa_nombre = serializers.CharField(source='mesa.nombre', read_only=True, allow_null=True)
    fase_label = serializers.SerializerMethodField()

    class Meta:
        model = FotoFabricacion
        fields = [
            "id", "modulo", "modulo_nombre", "planta_nombre", "proyecto_id",
            "mesa", "mesa_nombre",
            "fase", "fase_label", "paso", "imagen_referencia",
            "url", "capturada_at", "updated_at",
            "filename_original", "file_size",
            "check_result", "check_detail",
        ]
        read_only_fields = ["capturada_at", "updated_at", "url", "file_size"]

    def get_fase_label(self, obj):
        return "INF" if obj.fase == "INFERIOR" else "SUP"

    def get_planta_nombre(self, obj):
        if obj.modulo and obj.modulo.planta:
            return obj.modulo.planta.nombre
        return None

    def get_proyecto_id(self, obj):
        if obj.modulo:
            return obj.modulo.proyecto_id
        return None


class MesaSerializer(serializers.HyperlinkedModelSerializer):
    usuario = serializers.PrimaryKeyRelatedField(queryset=User.objects.all())
    grupo = serializers.PrimaryKeyRelatedField(queryset=GrupoMesas.objects.all(), allow_null=True, required=False)
    imagen = ImagenSerializer(source='imagen_actual', read_only=True)
    is_linked = serializers.SerializerMethodField()
    
    class Meta:
        model = Mesa
        fields = [
            "id", "url", "nombre", "usuario",
            "grupo", "tipo", "indice", "activa",
            "imagen_actual", "ultima_actualizacion", "imagen",
            "locked", "blackout", "last_seen", "is_linked",
            "capture_service_online", "camera_sharpness", "check_overlay",
            "mapper_enabled", "current_image_index", "calibration_json"
        ]

    def get_is_linked(self, obj):
        """Returns True if a device is linked to this Mesa."""
        return bool(obj.device_token_hash)


# =============================================================================
# QUEUE SERIALIZERS
# =============================================================================
class ModuloQueueSerializer(serializers.ModelSerializer):
    class Meta:
        model = ModuloQueue
        fields = ["id", "proyecto", "created_at", "created_by", "activa"]
        read_only_fields = ["created_at"]


class MesaResumenGrupoSerializer(serializers.ModelSerializer):
    is_linked = serializers.SerializerMethodField()

    class Meta:
        model = Mesa
        fields = [
            "id", "nombre", "tipo", "indice", "activa", "is_linked",
            "capture_service_online", "camera_sharpness",
        ]

    def get_is_linked(self, obj):
        return bool(obj.device_token_hash)


class GrupoMesasProyectoSerializer(serializers.ModelSerializer):
    proyecto_nombre = serializers.CharField(source='proyecto.nombre', read_only=True)

    class Meta:
        model = GrupoMesasProyecto
        fields = ["id", "proyecto", "proyecto_nombre", "orden"]
        read_only_fields = ["id", "proyecto_nombre"]


class GrupoMesasSerializer(serializers.ModelSerializer):
    mesas = MesaResumenGrupoSerializer(many=True, read_only=True)
    proyectos_cola = serializers.SerializerMethodField()

    class Meta:
        model = GrupoMesas
        fields = [
            "id", "nombre", "usuario",
            "proyecto_actual", "proyectos_cola",
            "activa", "created_at", "mesas",
        ]
        read_only_fields = ["created_at", "mesas", "proyectos_cola"]
        extra_kwargs = {
            "usuario": {"required": False},
            "proyecto_actual": {"required": False, "allow_null": True},
        }

    def get_proyectos_cola(self, obj):
        entries = getattr(obj, '_prefetched_objects_cache', {}).get('proyectos_cola')
        if entries is None:
            entries = obj.proyectos_cola.select_related('proyecto').order_by('orden', 'id')
        return GrupoMesasProyectoSerializer(entries, many=True).data


class ModuloQueueItemSerializer(serializers.ModelSerializer):
    modulo_nombre = serializers.CharField(source='modulo.nombre', read_only=True)
    modulo_planta = serializers.CharField(source='modulo.planta.nombre', read_only=True)
    
    class Meta:
        model = ModuloQueueItem
        fields = [
            "id", "queue", "modulo", "modulo_nombre", "modulo_planta",
            "position", "added_by", "created_at"
        ]
        read_only_fields = ["created_at"]


class MesaQueueItemSerializer(serializers.ModelSerializer):
    modulo_nombre = serializers.CharField(source='modulo.nombre', read_only=True)
    imagen_url = serializers.CharField(source='imagen.url', read_only=True)
    mesa_nombre = serializers.CharField(source='mesa.nombre', read_only=True)
    modulo_planta_id = serializers.SerializerMethodField()
    modulo_proyecto_id = serializers.SerializerMethodField()
    modulo_proyecto_nombre = serializers.CharField(
        source='modulo.proyecto.nombre', read_only=True, default=''
    )
    grupo_bastidor_indice = serializers.IntegerField(
        source='modulo.grupo_bastidor.indice', read_only=True, default=None
    )
    grupo_bastidor_nombre = serializers.CharField(
        source='modulo.grupo_bastidor.nombre', read_only=True, default=''
    )
    dificultad = serializers.SerializerMethodField()

    class Meta:
        model = MesaQueueItem
        fields = [
            "id", "mesa", "mesa_nombre",
            "modulo", "modulo_nombre", "modulo_planta_id",
            "modulo_proyecto_id", "modulo_proyecto_nombre",
            "fase", "imagen", "imagen_url",
            "position", "plan_group_index",
            "grupo_bastidor_indice", "grupo_bastidor_nombre",
            "status", "dificultad",
            "assigned_by", "assigned_at",
            "done_by", "done_at"
        ]
        read_only_fields = ["assigned_at", "done_at"]
        validators = []

    def get_dificultad(self, obj):
        """Normalized dificultad (100 = ferralla average) of the DetalleModuloFase
        matching this queue item's modulo+fase, or None if not available."""
        if obj.modulo is None:
            return None
        detalle = None
        cached = getattr(obj.modulo, '_prefetched_objects_cache', {}).get('detalles_fase')
        candidates = cached if cached is not None else obj.modulo.detalles_fase.all()
        for d in candidates:
            if d.fase == obj.fase:
                detalle = d
                break
        if detalle is None:
            return None
        from api.views import _compute_dificultad
        raw = _compute_dificultad(detalle)
        scale = self.context.get('dificultad_scale', 1.0)
        return round(raw * scale, 1)

    def validate(self, data):
        """
        Validate that imagen belongs to the same modulo and fase.
        """
        imagen = data.get('imagen')
        modulo = data.get('modulo')
        fase = data.get('fase')
        
        if imagen and modulo and imagen.modulo_id != modulo.id:
            raise serializers.ValidationError({
                'imagen': f"Imagen no pertenece al módulo {modulo.nombre}"
            })
        
        if imagen and fase and imagen.fase != fase:
            raise serializers.ValidationError({
                'imagen': f"Imagen es fase {imagen.fase}, no {fase}"
            })

        # Resolve effective values for create and partial update.
        instance = getattr(self, 'instance', None)
        effective_modulo = modulo or (instance.modulo if instance else None)
        effective_fase = fase or (instance.fase if instance else None)
        effective_status = data.get('status') or (instance.status if instance else MesaQueueStatus.EN_COLA)
        new_mesa = data.get('mesa')

        # Business rule: the item currently showing cannot be moved to another mesa.
        if (
            instance
            and instance.status == MesaQueueStatus.MOSTRANDO
            and new_mesa
            and new_mesa.id != instance.mesa_id
        ):
            raise serializers.ValidationError(
                "No se puede mover entre mesas un item con estado MOSTRANDO"
            )

        # Keep only one active assignment for the same module phase.
        if (
            effective_modulo
            and effective_fase
            and effective_status in [MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO]
        ):
            conflict_qs = MesaQueueItem.objects.select_related('mesa').filter(
                modulo=effective_modulo,
                fase=effective_fase,
                status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
            )
            if instance:
                conflict_qs = conflict_qs.exclude(pk=instance.pk)
            conflict = conflict_qs.first()
            if conflict:
                raise serializers.ValidationError(
                    f"Esta fase ya esta asignada a {conflict.mesa.nombre}"
                )
            
        return data

    def update(self, instance, validated_data):
        """Persist partial updates using update_fields to avoid unrelated full-save side effects."""
        for attr, value in validated_data.items():
            setattr(instance, attr, value)

        if validated_data:
            instance.save(update_fields=list(validated_data.keys()))
        else:
            instance.save()
        return instance

    def get_modulo_planta_id(self, obj):
        if obj.modulo_id and obj.modulo.planta_id:
            return obj.modulo.planta_id
        return None

    def get_modulo_proyecto_id(self, obj):
        if obj.modulo_id and obj.modulo.planta_id and obj.modulo.planta and obj.modulo.planta.proyecto_id:
            return obj.modulo.planta.proyecto_id
        return None

# =============================================================================
# DEVICE PAIRING SERIALIZERS
# =============================================================================
class DeviceInitSerializer(serializers.Serializer):
    mesa_id = serializers.IntegerField(required=False)

class DeviceStatusSerializer(serializers.Serializer):
    code = serializers.CharField(required=True)

class DevicePairSerializer(serializers.Serializer):
    mesa_id = serializers.IntegerField(required=True)
    pairing_code = serializers.CharField(required=True)

class DeviceHeartbeatSerializer(serializers.Serializer):
    current_item_id = serializers.IntegerField(required=False, allow_null=True)
    mode = serializers.CharField(required=False, allow_blank=True)
    player_version = serializers.CharField(required=False, allow_blank=True)
    last_error = serializers.CharField(required=False, allow_blank=True)
    capture_service_online = serializers.BooleanField(required=False, allow_null=True)
    camera_sharpness = serializers.ChoiceField(
        required=False, allow_blank=True, allow_null=True,
        choices=['ok', 'warning', 'blurry', 'unknown'],
    )

class MesaStateSerializer(serializers.ModelSerializer):
    image_url = serializers.CharField(source='imagen_actual.url', read_only=True)

    class Meta:
        model = Mesa
        fields = [
            'id', 'nombre',
            'imagen_actual', 'image_url',
            'mapper_enabled', 'current_image_index', 'calibration_json',
            'blackout', 'locked', 'last_seen', 'check_overlay'
        ]
