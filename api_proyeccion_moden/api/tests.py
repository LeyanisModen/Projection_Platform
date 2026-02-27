import hashlib
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.models import Imagen, Mesa, MesaQueueItem, Modulo, Planta, Proyecto


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


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
        "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
        "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    }
)
class MesaQueueItemBehaviorTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="queue_user", password="pass123")
        self.token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")

        self.project = Proyecto.objects.create(nombre="Proyecto Cola", usuario=self.user)
        self.planta = Planta.objects.create(nombre="P1", proyecto=self.project, orden=1)
        self.mesa_a = Mesa.objects.create(nombre="Mesa A", usuario=self.user)
        self.mesa_b = Mesa.objects.create(nombre="Mesa B", usuario=self.user)

        self.modulo_a = Modulo.objects.create(nombre="M-A", proyecto=self.project, planta=self.planta)
        self.modulo_b = Modulo.objects.create(nombre="M-B", proyecto=self.project, planta=self.planta)
        self.modulo_c = Modulo.objects.create(nombre="M-C", proyecto=self.project, planta=self.planta)

    def _create_item(self, mesa_id, modulo_id, fase="INFERIOR", position=0):
        return self.client.post(
            "/api/mesa-queue-items/",
            {
                "mesa": mesa_id,
                "modulo": modulo_id,
                "fase": fase,
                "imagen": None,
                "position": position,
            },
            format="json",
        )

    def test_en_cola_item_can_move_between_mesas(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(second_response.status_code, 201)

        item_id = second_response.data["id"]
        move_response = self.client.patch(
            f"/api/mesa-queue-items/{item_id}/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )

        self.assertEqual(move_response.status_code, 200)
        self.assertEqual(move_response.data["mesa"], self.mesa_b.id)

    def test_mostrando_item_cannot_move_between_mesas(self):
        create_response = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        self.assertEqual(create_response.status_code, 201)

        item_id = create_response.data["id"]
        move_response = self.client.patch(
            f"/api/mesa-queue-items/{item_id}/",
            {"mesa": self.mesa_b.id},
            format="json",
        )

        self.assertEqual(move_response.status_code, 400)
        self.assertIn("MOSTRANDO", str(move_response.data))

    def test_mostrando_item_can_be_deleted(self):
        create_response = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        self.assertEqual(create_response.status_code, 201)

        item_id = create_response.data["id"]
        delete_response = self.client.delete(f"/api/mesa-queue-items/{item_id}/")

        self.assertEqual(delete_response.status_code, 204)
        self.assertFalse(MesaQueueItem.objects.filter(id=item_id).exists())

    def test_queue_can_be_reordered(self):
        first = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        third = self._create_item(self.mesa_a.id, self.modulo_c.id, position=2)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(third.status_code, 201)

        reorder_response = self.client.post(
            "/api/mesa-queue-items/reorder/",
            {
                "items": [
                    {"id": first.data["id"], "position": 0},
                    {"id": third.data["id"], "position": 1},
                    {"id": second.data["id"], "position": 2},
                ]
            },
            format="json",
        )

        self.assertEqual(reorder_response.status_code, 200)
        self.assertEqual(MesaQueueItem.objects.get(id=third.data["id"]).position, 1)
        self.assertEqual(MesaQueueItem.objects.get(id=second.data["id"]).position, 2)

    def test_create_allows_new_active_item_when_previous_is_hecho(self):
        MesaQueueItem.objects.create(
            mesa=self.mesa_a,
            modulo=self.modulo_a,
            fase="INFERIOR",
            status="HECHO",
            position=0,
        )

        create_response = self._create_item(self.mesa_b.id, self.modulo_a.id, fase="INFERIOR", position=0)
        self.assertEqual(create_response.status_code, 201)

    def test_move_still_works_with_legacy_inconsistent_imagen_data(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(second_response.status_code, 201)

        legacy_image = Imagen.objects.create(
            modulo=self.modulo_c,
            fase="INFERIOR",
            orden=1,
            version=1,
            url="legacy://img",
        )
        MesaQueueItem.objects.filter(id=second_response.data["id"]).update(imagen_id=legacy_image.id)

        move_response = self.client.patch(
            f"/api/mesa-queue-items/{second_response.data['id']}/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )
        self.assertEqual(move_response.status_code, 200)

    def test_move_action_moves_item_between_mesas(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(second_response.status_code, 201)

        move_response = self.client.post(
            f"/api/mesa-queue-items/{second_response.data['id']}/move/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )
        self.assertEqual(move_response.status_code, 200)
        self.assertEqual(move_response.data["mesa"], self.mesa_b.id)
