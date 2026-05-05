from django.urls import include, path
from rest_framework import routers

from api import views


router = routers.DefaultRouter()
router.register(r"users", views.UserViewSet)
router.register(r"proyectos", views.ProyectoViewSet)
router.register(r"modulos", views.ModuloViewSet)
router.register(r"imagenes", views.ImagenViewSet)
router.register(r"mesas", views.MesaViewSet)
router.register(r"grupos-mesas", views.GrupoMesasViewSet)
router.register(r"detalle-modulo-fases", views.DetalleModuloFaseViewSet)
router.register(r"modulo-queues", views.ModuloQueueViewSet)
router.register(r"modulo-queue-items", views.ModuloQueueItemViewSet)
router.register(r"mesa-queue-items", views.MesaQueueItemViewSet)
router.register(r"device", views.DeviceViewSet, basename="device")

# Wire up our API using automatic URL routing.
# Additionally, we include login URLs for the browsable API.
urlpatterns = [
    path("", include(router.urls)),
    path(
        "lista-compra/general/",
        views.ListaCompraGeneralView.as_view(),
        name="lista-compra-general",
    ),
    path(
        "lista-compra/general/<str:clave>/",
        views.ListaCompraGeneralView.as_view(),
        name="lista-compra-general-toggle",
    ),
    path("api-auth/", include("rest_framework.urls", namespace="rest_framework")),
]
