from django.contrib.auth.models import User
from rest_framework import serializers

from api.models import (
    Proyecto, Planta, Modulo, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem, UserProfile
)


class UserSerializer(serializers.HyperlinkedModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    first_name = serializers.CharField(required=False, allow_blank=True)
    last_name = serializers.CharField(required=False, allow_blank=True)
    telefono = serializers.CharField(source='profile.telefono', required=False, allow_blank=True, allow_null=True)
    direccion = serializers.CharField(source='profile.direccion', required=False, allow_blank=True, allow_null=True)
    coordinador = serializers.CharField(source='profile.coordinador', required=False, allow_blank=True, allow_null=True)
    password_texto_plano = serializers.CharField(source='profile.password_texto_plano', read_only=True, allow_null=True)

    class Meta:
        model = User
        fields = ["id", "url", "username", "email", "password", "groups", "first_name", "last_name", "telefono", "direccion", "coordinador", "password_texto_plano"]


    def create(self, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')

        user = super().create(validated_data)
        
        # Save password in plain text if provided
        plain_password_to_save = password if password else ''

        if password:
            user.set_password(password)
            user.save()
            
        # Create profile with all fields
        UserProfile.objects.create(
            user=user, 
            telefono=telefono or '',
            direccion=direccion or '',
            coordinador=coordinador or '',
            password_texto_plano=plain_password_to_save
        )

        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        profile_data = validated_data.pop('profile', {})
        telefono = profile_data.get('telefono')
        direccion = profile_data.get('direccion')
        coordinador = profile_data.get('coordinador')

        user = super().update(instance, validated_data)
        
        # Profile updates
        profile_defaults = {}
        if telefono is not None:
            profile_defaults['telefono'] = telefono
        if direccion is not None:
            profile_defaults['direccion'] = direccion
        if coordinador is not None:
            profile_defaults['coordinador'] = coordinador

        # Password handling
        if password:
            user.set_password(password)
            user.save()
            profile_defaults['password_texto_plano'] = password
            
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
    
    class Meta:
        model = Proyecto
        fields = ["id", "url", "nombre", "usuario", "usuario_nombre", "num_plantas"]
        extra_kwargs = {
            'usuario': {'required': False, 'allow_null': True}
        }


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
        return obj.modulos.count()


class ModuloSerializer(serializers.ModelSerializer):
    class Meta:
        model = Modulo
        fields = [
            "id", "url", "nombre", "planta", "proyecto",
            "inferior_hecho", "superior_hecho", "estado",
            "cerrado", "cerrado_at", "cerrado_by"
        ]
        read_only_fields = ["cerrado_at"]


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


class MesaSerializer(serializers.HyperlinkedModelSerializer):
    usuario = serializers.PrimaryKeyRelatedField(queryset=User.objects.all())
    imagen = ImagenSerializer(source='imagen_actual', read_only=True)
    is_linked = serializers.SerializerMethodField()
    
    class Meta:
        model = Mesa
        fields = [
            "id", "url", "nombre", "usuario",
            "imagen_actual", "ultima_actualizacion", "imagen",
            "locked", "blackout", "last_seen", "is_linked"
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
    modulo_planta_id = serializers.IntegerField(source='modulo.planta.id', read_only=True)
    modulo_proyecto_id = serializers.IntegerField(source='modulo.planta.proyecto.id', read_only=True)
    
    class Meta:
        model = MesaQueueItem
        fields = [
            "id", "mesa", "mesa_nombre",
            "modulo", "modulo_nombre", "modulo_planta_id", "modulo_proyecto_id",
            "fase", "imagen", "imagen_url",
            "position", "status",
            "assigned_by", "assigned_at",
            "done_by", "done_at"
        ]
        read_only_fields = ["assigned_at", "done_at"]

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
            
        return data

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

class MesaStateSerializer(serializers.ModelSerializer):
    image_url = serializers.CharField(source='imagen_actual.url', read_only=True)
    
    class Meta:
        model = Mesa
        fields = [
            'id', 'nombre', 
            'imagen_actual', 'image_url',
            'mapper_enabled', 'calibration_json',
            'blackout', 'locked', 'last_seen'
        ]
