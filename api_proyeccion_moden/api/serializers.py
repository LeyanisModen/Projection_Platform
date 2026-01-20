from django.contrib.auth.models import User
from rest_framework import serializers

from api.models import (
    Proyecto, Planta, Modulo, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem
)


class UserSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = User
        fields = ["url", "username", "email", "groups"]


# =============================================================================
# CORE SERIALIZERS
# =============================================================================
class ProyectoSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = Proyecto
        fields = ["id", "url", "nombre", "usuario"]


class PlantaSerializer(serializers.ModelSerializer):
    modulos_count = serializers.SerializerMethodField()

    class Meta:
        model = Planta
        fields = ["id", "nombre", "proyecto", "orden", "modulos_count"]

    def get_modulos_count(self, obj):
        return obj.modulos.count()


class ModuloSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = Modulo
        fields = [
            "id", "url", "nombre", "planta", "proyecto",
            "inferior_hecho", "superior_hecho", "estado",
            "cerrado", "cerrado_at", "cerrado_by"
        ]
        read_only_fields = ["estado", "cerrado_at"]


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
    imagen = ImagenSerializer(source='imagen_actual', read_only=True)
    
    class Meta:
        model = Mesa
        fields = [
            "id", "url", "nombre", "usuario",
            "imagen_actual", "ultima_actualizacion", "imagen",
            "locked", "blackout", "last_seen"
        ]


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
    
    class Meta:
        model = MesaQueueItem
        fields = [
            "id", "mesa", "mesa_nombre",
            "modulo", "modulo_nombre", "fase", "imagen", "imagen_url",
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
