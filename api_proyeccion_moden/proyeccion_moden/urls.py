from django.urls import include, path
from django.conf import settings
from django.conf.urls.static import static
from rest_framework import routers

from api import views

from django.contrib import admin

router = routers.DefaultRouter()
router.register(r"users", views.UserViewSet, basename="user")
router.register(r"proyectos", views.ProyectoViewSet)
router.register(r"plantas", views.PlantaViewSet)
router.register(r"modulos", views.ModuloViewSet)
router.register(r"imagenes", views.ImagenViewSet)
router.register(r"mesas", views.MesaViewSet)
router.register(r"modulo-queues", views.ModuloQueueViewSet)
router.register(r"modulo-queue-items", views.ModuloQueueItemViewSet)
router.register(r"mesa-queue-items", views.MesaQueueItemViewSet)
router.register(r"device", views.DeviceViewSet, basename="device")

from rest_framework.authtoken import views as drf_views

# Wire up our API using automatic URL routing.
# Additionally, we include login URLs for the browsable API.
urlpatterns = [
    path("api/", include(router.urls)),
    path("api-auth/", include("rest_framework.urls", namespace="rest_framework")),
    path("api/token-auth/", views.CustomAuthToken.as_view()),
    path("admin/", admin.site.urls),
]

# Serve media files in development
from django.urls import re_path
from django.views.static import serve

# Serve media files in development AND production (since we don't have separate media server)
urlpatterns += [
    re_path(r'^media/(?P<path>.*)$', serve, {
        'document_root': settings.MEDIA_ROOT,
    }),
]

if settings.DEBUG:
    # Static is handled by WhiteNoise in prod, but media needs manual serving here
    pass

