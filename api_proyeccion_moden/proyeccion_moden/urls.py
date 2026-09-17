from django.urls import include, path
from django.conf import settings
from django.conf.urls.static import static
from rest_framework import routers

from api import views
from api.health import HealthView
from api.office import CheckDefinitionViewSet, ProjectChecklistViewSet, WorkerViewSet, EventViewSet

from django.contrib import admin

router = routers.DefaultRouter()
router.register(r"users", views.UserViewSet, basename="user")
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
router.register(r"fotos", views.FotoFabricacionViewSet)
router.register(r"grupos-bastidor", views.GrupoBastidorViewSet)
router.register(r"check-definiciones", CheckDefinitionViewSet)
router.register(r"proyecto-checklist", ProjectChecklistViewSet, basename='proyecto-checklist')
router.register(r"trabajadores", WorkerViewSet)
router.register(r"eventos", EventViewSet)

from rest_framework.authtoken import views as drf_views

# Wire up our API using automatic URL routing.
# Additionally, we include login URLs for the browsable API.
urlpatterns = [
    path("api/health/", HealthView.as_view(), name="health"),
    path("api/", include(router.urls)),
    path("api-auth/", include("rest_framework.urls", namespace="rest_framework")),
    path("api/token-auth/", views.CustomAuthToken.as_view()),
    path("api/stats/production/", views.ProductionStatsView.as_view(), name="production-stats"),
    path(
        "api/lista-materiales/general/",
        views.ListaMaterialesGeneralView.as_view(),
        name="lista-materiales-general",
    ),
    path(
        "api/lista-materiales/general/<str:clave>/",
        views.ListaMaterialesGeneralView.as_view(),
        name="lista-materiales-general-toggle",
    ),
    path("admin/", admin.site.urls),
]

# Media is served by Django in every environment (Railway volume mounted at
# MEDIA_ROOT, proxied by the frontend's nginx). api.media_access checks the
# user/device credential before handing the file to django.views.static.serve.
from django.urls import re_path
from api.media_access import protected_media

urlpatterns += [
    re_path(r'^media/(?P<path>.*)$', protected_media, name='media'),
]

