from django.contrib.auth.models import User
from rest_framework import permissions, viewsets

from api.serializers import ProyectoSerializer, UserSerializer, ModuloSerializer
from api.models import Modulo, Proyecto



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

class ModuloViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar módulos.
    """
    queryset = Modulo.objects.all().order_by("id")
    serializer_class = ModuloSerializer
    permission_classes = [permissions.IsAuthenticated]