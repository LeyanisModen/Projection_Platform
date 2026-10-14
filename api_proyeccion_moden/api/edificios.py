"""Edificios: agrupan los forjados (proyectos) de un mismo bloque de obra.

Cada forjado sigue siendo un proyecto para todo lo de fabrica (bastidores,
colas, mesas, lista de control...). El edificio solo agrupa, ordena de
abajo arriba y suma sus estadisticas. Un edificio es de una sola ferralla.

Los nombres de los proyectos siguen la convencion de la oficina:
``OBRA[_B<bloque>]_P<planta>``, con planta ``S1``/``S2`` (sotano), ``SS``
(semisotano), ``B`` (baja), ``M`` (entreplanta), ``C`` (cubierta) o un
numero. Cada bloque es un edificio distinto: ``RIPAGAINA108_BH_P02`` va al
edificio ``RIPAGAINA108_BH``, planta 2.
"""
import re

from rest_framework import permissions, serializers, viewsets
from rest_framework.exceptions import PermissionDenied

from .models import Edificio, PlantaTipo

_NOMBRE = re.compile(
    r'^(?P<obra>.+?)(?:_B(?P<bloque>[A-Za-z0-9]{1,4}))?_P(?P<planta>SS|S\d{1,2}|B|M\d{0,2}|C\d{0,2}|\d{1,3})$',
    re.IGNORECASE,
)


def leer_nombre(nombre):
    """(edificio, planta_tipo, planta_numero) a partir del nombre, o None."""
    m = _NOMBRE.match((nombre or '').strip())
    if not m:
        return None
    obra, bloque, planta = m.group('obra'), m.group('bloque'), m.group('planta').upper()
    edificio = f'{obra}_B{bloque.upper()}' if bloque else obra
    if planta == 'SS':
        return edificio, PlantaTipo.SEMISOTANO, None
    if planta.startswith('S'):
        return edificio, PlantaTipo.SOTANO, int(planta[1:])
    if planta == 'B':
        return edificio, PlantaTipo.BAJA, None
    if planta.startswith('M'):
        return edificio, PlantaTipo.ENTREPLANTA, int(planta[1:]) if planta[1:] else None
    if planta.startswith('C'):
        return edificio, PlantaTipo.CUBIERTA, int(planta[1:]) if planta[1:] else None
    return edificio, PlantaTipo.PLANTA, int(planta)


def asignar_por_nombre(proyecto):
    """Edificio y planta deducidos del nombre si aun no los tiene.

    Lo puesto a mano no se toca. Crea el edificio de su ferralla si no
    existe. Devuelve True si ha cambiado algo.
    """
    datos = leer_nombre(proyecto.nombre)
    if datos is None or proyecto.usuario_id is None:
        return False
    nombre_edificio, tipo, numero = datos
    cambios = []
    if proyecto.edificio_id is None:
        edificio, _ = Edificio.objects.get_or_create(usuario_id=proyecto.usuario_id, nombre=nombre_edificio)
        proyecto.edificio = edificio
        cambios.append('edificio')
    if not proyecto.planta_tipo:
        proyecto.planta_tipo = tipo
        proyecto.planta_numero = numero
        cambios += ['planta_tipo', 'planta_numero']
    if cambios:
        proyecto.save(update_fields=cambios)
    return bool(cambios)


def ajustar_a_ferralla(proyecto):
    """Si el proyecto cambia de ferralla, sale del edificio de la anterior
    (un edificio es de una sola ferralla) y se busca el suyo por el nombre."""
    if proyecto.edificio_id and proyecto.edificio.usuario_id != proyecto.usuario_id:
        proyecto.edificio = None
        proyecto.save(update_fields=['edificio'])
    asignar_por_nombre(proyecto)


class EdificioSerializer(serializers.ModelSerializer):
    forjados = serializers.SerializerMethodField()

    class Meta:
        model = Edificio
        fields = ['id', 'nombre', 'usuario', 'forjados', 'created_at']
        read_only_fields = ['created_at']

    def get_forjados(self, obj):
        return obj.forjados.count()

    def validate_nombre(self, value):
        value = (value or '').strip()
        if not value:
            raise serializers.ValidationError('Indica el nombre del edificio.')
        return value


class EdificioViewSet(viewsets.ModelViewSet):
    """Edificios. La oficina los crea y renombra; cada ferralla ve los suyos."""
    queryset = Edificio.objects.select_related('usuario').all()
    serializer_class = EdificioSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    @staticmethod
    def _es_oficina(user):
        return bool(user and (user.is_staff or user.is_superuser))

    def get_queryset(self):
        queryset = super().get_queryset()
        if not self._es_oficina(self.request.user):
            queryset = queryset.filter(usuario=self.request.user)
        usuario = self.request.query_params.get('usuario')
        if usuario and str(usuario).isdigit():
            queryset = queryset.filter(usuario_id=int(usuario))
        return queryset

    def _solo_oficina(self):
        if not self._es_oficina(self.request.user):
            raise PermissionDenied('Solo la oficina gestiona los edificios.')

    def perform_create(self, serializer):
        self._solo_oficina()
        serializer.save()

    def perform_update(self, serializer):
        self._solo_oficina()
        edificio = serializer.save()
        # Un edificio es de una sola ferralla: sus forjados de otra salen.
        edificio.forjados.exclude(usuario_id=edificio.usuario_id).update(edificio=None)

    def perform_destroy(self, instance):
        self._solo_oficina()
        instance.delete()
