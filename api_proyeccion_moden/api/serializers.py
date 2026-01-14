from django.contrib.auth.models import User
from rest_framework import serializers

from api.models import Proyecto, Modulo


class UserSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = User
        fields = ["url", "username", "email", "groups"]

class ProyectoSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = Proyecto
        fields = ["id", "url", "nombre", "usuario_id"]

class ModuloSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = Modulo
        fields = ["id", "url", "nombre", "planta", "proyecto_id"]
