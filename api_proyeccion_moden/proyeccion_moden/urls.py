"""
URL configuration for proyeccion_moden project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.urls import include, path
from rest_framework import routers

from api import views

from django.contrib import admin

router = routers.DefaultRouter()
router.register(r"users", views.UserViewSet)
router.register(r"proyectos", views.ProyectoViewSet)
router.register(r"plantas", views.PlantaViewSet)
router.register(r"modulos", views.ModuloViewSet)
router.register(r"imagenes", views.ImagenViewSet)
router.register(r"mesas", views.MesaViewSet)
router.register(r"modulo-queues", views.ModuloQueueViewSet)
router.register(r"modulo-queue-items", views.ModuloQueueItemViewSet)
router.register(r"mesa-queue-items", views.MesaQueueItemViewSet)
router.register(r"device", views.DeviceViewSet, basename="device")

# Wire up our API using automatic URL routing.
# Additionally, we include login URLs for the browsable API.
urlpatterns = [
    path("", include(router.urls)),
    path("api-auth/", include("rest_framework.urls", namespace="rest_framework")),
    path("admin/", admin.site.urls),
]
