import hashlib
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.models import Mesa, Proyecto


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
        "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
        "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    }
)
class PermissionAndDeviceAuthTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="admin123", is_staff=True)
        self.user_a = User.objects.create_user(username="user_a", password="pass123")
        self.user_b = User.objects.create_user(username="user_b", password="pass123")
        self.admin_token = Token.objects.create(user=self.admin)
        self.user_a_token = Token.objects.create(user=self.user_a)

        self.project_a = Proyecto.objects.create(nombre="Proyecto A", usuario=self.user_a)
        self.project_b = Proyecto.objects.create(nombre="Proyecto B", usuario=self.user_b)

        self.mesa_a = Mesa.objects.create(nombre="Mesa A", usuario=self.user_a)
        raw_device_token = "device-secret-token"
        self.device_token = raw_device_token
        self.mesa_a.device_token_hash = hashlib.sha256(raw_device_token.encode()).hexdigest()
        self.mesa_a.save(update_fields=["device_token_hash"])

    def test_projects_requires_authentication(self):
        response = self.client.get("/api/proyectos/")
        self.assertEqual(response.status_code, 401)

    def test_regular_user_sees_only_own_projects(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.user_a_token.key}")
        response = self.client.get("/api/proyectos/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.project_a.id)

    def test_admin_sees_all_projects(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")
        response = self.client.get("/api/proyectos/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 2)

    def test_device_heartbeat_requires_valid_device_token(self):
        response = self.client.post("/api/device/heartbeat/", {}, format="json")
        self.assertEqual(response.status_code, 401)

        response = self.client.post(
            "/api/device/heartbeat/",
            {},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {self.device_token}",
        )
        self.assertEqual(response.status_code, 200)

    def test_pair_rejects_expired_mesa_code(self):
        self.mesa_a.pairing_code = "ABC123"
        self.mesa_a.pairing_code_expires_at = timezone.now() - timedelta(minutes=1)
        self.mesa_a.save(update_fields=["pairing_code", "pairing_code_expires_at"])

        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.user_a_token.key}")
        response = self.client.post(
            "/api/device/pair/",
            {"mesa_id": self.mesa_a.id, "pairing_code": "ABC123"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["detail"], "Pairing code expired")
