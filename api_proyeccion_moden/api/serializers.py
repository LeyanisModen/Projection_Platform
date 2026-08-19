import os

from django.contrib.auth.models import User
from rest_framework import serializers

from api.models import (
    Proyecto, Modulo, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem, UserProfile, MesaQueueStatus,
    FotoFabricacion, GrupoMesas, GrupoMesasProyecto,
    DetalleModuloFase, GrupoBastidor, FerrallaContacto, FerrallaDireccion, Fase
)
from api.queue_sync import module_reorderability
from api.module_features import module_has_sd


class FerrallaContactoSerializer(serializers.ModelSerializer):
    class Meta:
        model = FerrallaContacto
        fields = ["id", "nombre", "cargo", "telefono", "email", "orden"]
        read_only_fields = ["id"]
        extra_kwargs = {
            "nombre": {"required": False, "allow_blank": True},
            "cargo": {"required": False, "allow_blank": True},
            "telefono": {"required": False, "allow_blank": True},
            "email": {"required": False, "allow_blank": True},
            "orden": {"required": False},
        }


class FerrallaDireccionSerializer(serializers.ModelSerializer):
    class Meta:
        model = FerrallaDireccion
        fields = ["id", "nombre", "direccion", "orden"]
        read_only_fields = ["id"]
        extra_kwargs = {
            "nombre": {"required": False, "allow_blank": True},
            "direccion": {"required": False, "allow_blank": True},
            "orden": {"required": False},
        }


class UserSerializer(serializers.HyperlinkedModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    first_name = serializers.CharField(required=False, allow_blank=True)
    last_name = serializers.CharField(required=False, allow_blank=True)
    telefono = serializers.CharField(source='profile.telefono', required=False, allow_blank=True, allow_null=True)
    direccion = serializers.CharField(source='profile.direccion', required=False, allow_blank=True, allow_null=True)
    coordinador = serializers.CharField(source='profile.coordinador', required=False, allow_blank=True, allow_null=True)
    password_texto_plano = serializers.CharField(
        source='profile.password_texto_plano',
        required=False,
        allow_blank=True,
        allow_null=True,
    )
    capacidad_diaria_modulos = serializers.IntegerField(
        source='profile.capacidad_diaria_modulos', required=False, min_value=1
    )
    contactos = FerrallaContactoSerializer(many=True, required=False)
    direcciones = FerrallaDireccionSerializer(many=True, required=False)

    class Meta:
        model = User
        fields = [
            "id", "url", "username", "email", "password", "groups",
            "first_name", "last_name", "telefono", "direccion", "coordinador",
            "password_texto_plano", "capacidad_diaria_modulos", "contactos", "direcciones",
        ]

    def _request_user_is_admin(self):
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if not self._request_user_is_admin():
            data['password_texto_plano'] = None
        return data

    def _save_contactos(self, user, contactos_data):
        FerrallaContacto.objects.filter(user=user).delete()
        contactos = []
        for index, contacto in enumerate(contactos_data):
            contacto = dict(contacto)
            if not any((contacto.get(field) or '').strip() for field in ('nombre', 'cargo', 'telefono', 'email')):
                continue
            contacto['orden'] = contacto.get('orden', index)
            contactos.append(FerrallaContacto(user=user, **contacto))
        FerrallaContacto.objects.bulk_create(contactos)

    def _save_direcciones(self, user, direcciones_data):
        FerrallaDireccion.objects.filter(user=user).delete()
        direcciones = []
        for index, direccion in enumerate(direcciones_data):
            direccion = dict(direccion)
            if not any((direccion.get(field) or '').strip() for field in ('nombre', 'direccion')):
                continue
            direccion['orden'] = direccion.get('orden', index)
            direcciones.append(FerrallaDireccion(user=user, **direccion))
        FerrallaDireccion.objects.bulk_create(direcciones)

    def _sync_legacy_fields_from_lists(self, user):
        first_contacto = user.contactos.order_by('orden', 'id').first()
        first_direccion = user.direcciones.order_by('orden', 'id').first()

        profile_defaults = {
            'coordinador': first_contacto.nombre if first_contacto else '',
            'telefono': first_contacto.telefono if first_contacto else '',
            'direccion': first_direccion.direccion if first_direccion else '',
        }
        UserProfile.objects.update_or_create(user=user, defaults=profile_defaults)

        first_email = first_contacto.email if first_contacto else ''
        if user.email != first_email:
            user.email = first_email
            user.save(update_fields=['email'])

    def create(self, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        contactos_data = validated_data.pop('contactos', None)
        direcciones_data = validated_data.pop('direcciones', None)
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')
        capacidad = profile_data.get('capacidad_diaria_modulos')
        password_texto_plano = profile_data.get('password_texto_plano')

        user = super().create(validated_data)

        if password:
            user.set_password(password)
            user.save()

        profile_kwargs = {
            'telefono': telefono or '',
            'direccion': direccion or '',
            'coordinador': coordinador or '',
        }
        if self._request_user_is_admin():
            profile_kwargs['password_texto_plano'] = (
                password_texto_plano if password_texto_plano is not None else (password or '')
            )
        if capacidad is not None:
            profile_kwargs['capacidad_diaria_modulos'] = capacidad
        UserProfile.objects.create(user=user, **profile_kwargs)

        if contactos_data is not None:
            self._save_contactos(user, contactos_data)
        if direcciones_data is not None:
            self._save_direcciones(user, direcciones_data)
        if contactos_data is not None or direcciones_data is not None:
            self._sync_legacy_fields_from_lists(user)

        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        contactos_data = validated_data.pop('contactos', None)
        direcciones_data = validated_data.pop('direcciones', None)
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')
        capacidad = profile_data.get('capacidad_diaria_modulos')
        password_texto_plano_provided = 'password_texto_plano' in profile_data
        password_texto_plano = profile_data.get('password_texto_plano')

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

        if self._request_user_is_admin():
            if password_texto_plano_provided:
                profile_defaults['password_texto_plano'] = password_texto_plano or ''
            elif password:
                profile_defaults['password_texto_plano'] = password
            
        if profile_defaults:
            UserProfile.objects.update_or_create(
                user=user,
                defaults=profile_defaults
            )

        if contactos_data is not None:
            self._save_contactos(user, contactos_data)
        if direcciones_data is not None:
            self._save_direcciones(user, direcciones_data)
        if contactos_data is not None or direcciones_data is not None:
            self._sync_legacy_fields_from_lists(user)

        return user


# =============================================================================
# CORE SERIALIZERS
# =============================================================================
class ProyectoSerializer(serializers.HyperlinkedModelSerializer):
    usuario_nombre = serializers.ReadOnlyField(source='usuario.username')
    capacidad_diaria_usuario = serializers.SerializerMethodField()
    grupos_count = serializers.SerializerMethodField()
    modulos_count = serializers.SerializerMethodField()
    modulos_completados = serializers.SerializerMethodField()
    modulos_completados_hoy = serializers.SerializerMethodField()
    datos_tecnicos_archivo = serializers.SerializerMethodField()

    class Meta:
        model = Proyecto
        fields = [
            "id", "url", "nombre", "usuario", "usuario_nombre",
            "bastidor_longitud_cm", "datos_tecnicos_importados",
            "datos_tecnicos_archivo", "datos_tecnicos_actualizados_at",
            "plano_archivo", "planilla_archivo",
            "estrategia_bastidor",
            "capacidad_diaria_usuario",
            "grupos_count", "modulos_count", "modulos_completados",
            "modulos_completados_hoy",
        ]
        extra_kwargs = {
            'usuario': {'required': False, 'allow_null': True},
            'datos_tecnicos_importados': {'read_only': True},
        }

    def get_datos_tecnicos_archivo(self, obj):
        if not obj.fichero_datos_tecnicos:
            return None
        return os.path.basename(obj.fichero_datos_tecnicos.name)

    @staticmethod
    def _validate_pdf(value, label):
        if value and os.path.splitext(value.name)[1].lower() != '.pdf':
            raise serializers.ValidationError(f'El {label} debe ser un archivo PDF.')
        return value

    def validate_plano_archivo(self, value):
        return self._validate_pdf(value, 'plano')

    def validate_planilla_archivo(self, value):
        return self._validate_pdf(value, 'planilla')

    def get_capacidad_diaria_usuario(self, obj):
        if obj.usuario and hasattr(obj.usuario, 'profile'):
            return obj.usuario.profile.capacidad_diaria_modulos
        return 12

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


class ModuloSerializer(serializers.ModelSerializer):
    fotos_count = serializers.SerializerMethodField()
    detalles_fase = serializers.SerializerMethodField()

    class Meta:
        model = Modulo
        fields = [
            "id", "nombre", "ancho_cm", "tipo_modulo", "proyecto", "grupo_bastidor",
            "inferior_hecho", "superior_hecho", "estado",
            "completado_at", "cerrado", "cerrado_at", "cerrado_by",
            "codigos_color", "fotos_count", "detalles_fase"
        ]
        read_only_fields = ["completado_at", "cerrado_at", "grupo_bastidor"]

    def get_fotos_count(self, obj):
        if hasattr(obj, '_fotos_count'):
            return obj._fotos_count
        return obj.fotos_fabricacion.count()

    def get_detalles_fase(self, obj):
        detalles = getattr(obj, '_prefetched_objects_cache', {}).get('detalles_fase')
        if detalles is None:
            detalles = obj.detalles_fase.all()
        return DetalleModuloFaseSerializer(detalles, many=True).data


class FaseModuloSerializer(serializers.Serializer):
    fase = serializers.ChoiceField(choices=Fase.choices)


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
        # Orden manual (orden_intra) con nombre natural como desempate.
        # Modulos sin orden_intra asignado (=0) caen al inicio en orden
        # natural — solo deberian existir en bastidores antiguos previos
        # al backfill o si la migracion fallo.
        modulos = sorted(
            obj.modulos.all(),
            key=lambda m: (m.orden_intra or 0, self._natural_key(m.nombre)),
        )
        serialized = []
        for m in modulos:
            movible, motivo_bloqueo = module_reorderability(m)
            fases_en_curso = {
                item.fase
                for item in getattr(m, "reorder_showing_items", [])
            }
            serialized.append({
                "id": m.id,
                "nombre": m.nombre,
                "ancho_cm": m.ancho_cm,
                "tipo_modulo": m.tipo_modulo,
                "estado": m.estado,
                "inferior_hecho": m.inferior_hecho,
                "superior_hecho": m.superior_hecho,
                "inferior_en_curso": Fase.INFERIOR in fases_en_curso,
                "superior_en_curso": Fase.SUPERIOR in fases_en_curso,
                "cerrado": m.cerrado,
                "fotos_count": m.fotos_fabricacion.count(),
                "tiene_sd": module_has_sd(m),
                "movible": movible,
                "motivo_bloqueo": motivo_bloqueo,
            })
        return serialized

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
    archivo_nombre = serializers.SerializerMethodField()
    
    class Meta:
        model = Imagen
        fields = [
            "id", "url", "src", "nombre", "archivo_nombre", "modulo",
            "fase", "orden", "version", "status", "activo", "checksum"
        ]

    def get_nombre(self, obj):
        # Format: INF-001-MOD-A1
        fase_pref = "INF" if obj.fase == "INFERIOR" else "SUP"
        modulo_nombre = obj.modulo.nombre if obj.modulo else "UNKNOWN"
        return f"{fase_pref}-{obj.orden:03d}-{modulo_nombre}"

    def get_archivo_nombre(self, obj):
        return os.path.basename(obj.url or '')


class FotoFabricacionSerializer(serializers.ModelSerializer):
    modulo_nombre = serializers.CharField(source='modulo.nombre', read_only=True)
    proyecto_id = serializers.SerializerMethodField()
    mesa_nombre = serializers.CharField(source='mesa.nombre', read_only=True, allow_null=True)
    fase_label = serializers.SerializerMethodField()

    class Meta:
        model = FotoFabricacion
        fields = [
            "id", "modulo", "modulo_nombre", "proyecto_id",
            "mesa", "mesa_nombre",
            "fase", "fase_label", "paso", "imagen_referencia",
            "url", "capturada_at", "updated_at",
            "filename_original", "file_size",
            "check_result", "check_detail",
        ]
        read_only_fields = ["capturada_at", "updated_at", "url", "file_size"]

    def get_fase_label(self, obj):
        return "INF" if obj.fase == "INFERIOR" else "SUP"

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
            "last_seen", "capture_service_online", "camera_sharpness",
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
    
    class Meta:
        model = ModuloQueueItem
        fields = [
            "id", "queue", "modulo", "modulo_nombre",
            "position", "added_by", "created_at"
        ]
        read_only_fields = ["created_at"]


class MesaQueueItemSerializer(serializers.ModelSerializer):
    modulo_nombre = serializers.CharField(source='modulo.nombre', read_only=True)
    imagen_url = serializers.CharField(source='imagen.url', read_only=True)
    mesa_nombre = serializers.CharField(source='mesa.nombre', read_only=True)
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
    current_image_index = serializers.IntegerField(
        source='mesa.current_image_index', read_only=True
    )
    imagenes_total = serializers.SerializerMethodField()

    class Meta:
        model = MesaQueueItem
        fields = [
            "id", "mesa", "mesa_nombre",
            "modulo", "modulo_nombre",
            "modulo_proyecto_id", "modulo_proyecto_nombre",
            "fase", "imagen", "imagen_url",
            "position", "plan_group_index",
            "grupo_bastidor_indice", "grupo_bastidor_nombre",
            "status", "dificultad", "current_image_index", "imagenes_total",
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

    def get_imagenes_total(self, obj):
        cached = getattr(obj.modulo, 'queue_active_images', None)
        if cached is not None:
            return sum(1 for imagen in cached if imagen.fase == obj.fase)
        return obj.modulo.imagenes.filter(fase=obj.fase, activo=True).count()

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

    def get_modulo_proyecto_id(self, obj):
        return obj.modulo.proyecto_id if obj.modulo_id else None

# =============================================================================
# DEVICE PAIRING SERIALIZERS
# =============================================================================
class DeviceInitSerializer(serializers.Serializer):
    mesa_id = serializers.IntegerField(required=False)

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


CAPTURE_DAY_CHOICES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']


class MesaCaptureRotationSerializer(serializers.Serializer):
    mesa_id = serializers.IntegerField(min_value=1)
    image_rotation = serializers.ChoiceField(choices=[0, 90, 180, 270])


class FerrallaCaptureConfigSerializer(serializers.Serializer):
    active_days = serializers.ListField(
        child=serializers.ChoiceField(choices=CAPTURE_DAY_CHOICES),
        allow_empty=False,
    )
    start_time = serializers.TimeField(
        input_formats=['%H:%M', '%H:%M:%S'],
        format='%H:%M',
    )
    end_time = serializers.TimeField(
        input_formats=['%H:%M', '%H:%M:%S'],
        format='%H:%M',
    )
    interval_seconds = serializers.IntegerField(min_value=10, max_value=3600)
    rotations = MesaCaptureRotationSerializer(many=True, required=False)

    def validate_active_days(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError('No se pueden repetir dias.')
        return value

    def validate_rotations(self, value):
        mesa_ids = [item['mesa_id'] for item in value]
        if len(mesa_ids) != len(set(mesa_ids)):
            raise serializers.ValidationError('No se puede repetir una mesa.')
        return value

    def validate(self, attrs):
        if attrs['start_time'] >= attrs['end_time']:
            raise serializers.ValidationError(
                {'end_time': 'La hora final debe ser posterior a la inicial.'}
            )
        return attrs


class DeviceCaptureConfigAckSerializer(serializers.Serializer):
    revision = serializers.IntegerField(min_value=1)
    status = serializers.ChoiceField(choices=['applied', 'error'])
    error = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=2000,
    )

    def validate(self, attrs):
        if attrs['status'] == 'error' and not attrs.get('error', '').strip():
            raise serializers.ValidationError(
                {'error': 'Indica el error que impidio aplicar la configuracion.'}
            )
        return attrs

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
