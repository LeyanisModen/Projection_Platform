import hashlib
import io
import json
import os
import sqlite3
import tempfile
import zipfile
from datetime import timedelta
from pathlib import Path

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.models import (
    Imagen, Mesa, MesaQueueItem, Modulo, Planta, Proyecto,
    DetalleModuloFase, GrupoMesas, FotoFabricacion,
    FerrallaContacto, FerrallaDireccion, PairingSession,
    MesaQueueStatus, ModuloEstado, GrupoBastidor, GrupoMesasProyecto
)


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
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(len(response.data["results"]), 1)
        self.assertEqual(response.data["results"][0]["id"], self.project_a.id)

    def test_admin_sees_all_projects(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")
        response = self.client.get("/api/proyectos/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["count"], 2)
        self.assertEqual(len(response.data["results"]), 2)

    def test_module_image_preview_is_read_only_and_scoped_to_project_owner(self):
        module_a = Modulo.objects.create(nombre="A01", proyecto=self.project_a)
        image = Imagen.objects.create(
            modulo=module_a,
            fase="SUPERIOR",
            orden=3,
            version=2,
            status="PUBLISHED",
            activo=True,
            url="/media/imagenes/1/2/3/13_CHECK_VISUAL.png",
        )
        module_b = Modulo.objects.create(nombre="B01", proyecto=self.project_b)

        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.user_a_token.key}")
        before_count = Imagen.objects.count()
        response = self.client.get(f"/api/modulos/{module_a.id}/imagenes/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Imagen.objects.count(), before_count)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], image.id)
        self.assertEqual(response.data[0]["archivo_nombre"], "13_CHECK_VISUAL.png")
        self.assertEqual(response.data[0]["status"], "PUBLISHED")

        forbidden_response = self.client.get(f"/api/modulos/{module_b.id}/imagenes/")
        self.assertEqual(forbidden_response.status_code, 404)

    def test_delete_project_removes_its_media_without_touching_other_projects(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")

        with tempfile.TemporaryDirectory() as media_root:
            with override_settings(MEDIA_ROOT=media_root):
                planta = Planta.objects.create(
                    nombre="Planta a borrar", proyecto=self.project_a, orden=1
                )
                modulo = Modulo.objects.create(
                    nombre="A01", planta=planta, proyecto=self.project_a
                )
                planta.plano_imagen.save(
                    "plano-a.pdf", SimpleUploadedFile("plano-a.pdf", b"plano")
                )
                planta.fichero_corte.save(
                    "corte-a.zip", SimpleUploadedFile("corte-a.zip", b"corte")
                )
                self.project_a.fichero_datos_tecnicos.save(
                    "datos-a.db",
                    SimpleUploadedFile("datos-a.db", b"datos-tecnicos"),
                )

                project_image = (
                    Path(media_root)
                    / "imagenes"
                    / str(self.project_a.id)
                    / str(planta.id)
                    / str(modulo.id)
                    / "paso.png"
                )
                project_image.parent.mkdir(parents=True)
                project_image.write_bytes(b"imagen")
                Imagen.objects.create(
                    modulo=modulo,
                    fase="INFERIOR",
                    orden=1,
                    activo=True,
                    url=(
                        f"/media/imagenes/{self.project_a.id}/"
                        f"{planta.id}/{modulo.id}/paso.png"
                    ),
                )
                legacy_image = Imagen.objects.create(
                    modulo=modulo,
                    fase="INFERIOR",
                    orden=2,
                    activo=True,
                    archivo=SimpleUploadedFile("legacy.png", b"legacy"),
                )

                project_photo = (
                    Path(media_root)
                    / "fotos"
                    / str(self.project_a.id)
                    / str(planta.id)
                    / str(modulo.id)
                    / "captura.jpg"
                )
                project_photo.parent.mkdir(parents=True)
                project_photo.write_bytes(b"foto")
                FotoFabricacion.objects.create(
                    modulo=modulo,
                    fase="INFERIOR",
                    paso=0,
                    url=(
                        f"/media/fotos/{self.project_a.id}/"
                        f"{planta.id}/{modulo.id}/captura.jpg"
                    ),
                )

                other_project_file = (
                    Path(media_root)
                    / "imagenes"
                    / str(self.project_b.id)
                    / "keep.png"
                )
                other_project_file.parent.mkdir(parents=True)
                other_project_file.write_bytes(b"keep")

                plano_path = Path(planta.plano_imagen.path)
                corte_path = Path(planta.fichero_corte.path)
                technical_path = Path(
                    self.project_a.fichero_datos_tecnicos.path
                )
                legacy_image_path = Path(legacy_image.archivo.path)
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.client.delete(
                        f"/api/proyectos/{self.project_a.id}/"
                    )

                self.assertEqual(response.status_code, 204)
                self.assertFalse(Proyecto.objects.filter(id=self.project_a.id).exists())
                self.assertFalse(project_image.exists())
                self.assertFalse(project_photo.exists())
                self.assertFalse(plano_path.exists())
                self.assertFalse(corte_path.exists())
                self.assertFalse(technical_path.exists())
                self.assertFalse(legacy_image_path.exists())
                self.assertTrue(other_project_file.exists())

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

    def test_paired_session_token_survives_expired_code_until_device_authenticates(self):
        session = PairingSession.objects.create(
            pairing_code="BADNET",
            expires_at=timezone.now() + timedelta(minutes=1),
        )

        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.user_a_token.key}")
        pair_response = self.client.post(
            "/api/device/pair/",
            {"mesa_id": self.mesa_a.id, "pairing_code": "BADNET"},
            format="json",
        )
        self.assertEqual(pair_response.status_code, 200)

        session.expires_at = timezone.now() - timedelta(minutes=1)
        session.save(update_fields=["expires_at"])
        self.client.credentials()

        first_status = self.client.get("/api/device/status/?code=BADNET")
        self.assertEqual(first_status.status_code, 200)
        self.assertEqual(first_status.data["status"], "PAIRED")
        token = first_status.data["device_token"]
        self.assertTrue(token)

        second_status = self.client.get("/api/device/status/?code=BADNET")
        self.assertEqual(second_status.status_code, 200)
        self.assertEqual(second_status.data["device_token"], token)

        self.mesa_a.refresh_from_db()
        self.assertTrue(self.mesa_a.last_error.startswith("PENDING_TOKEN:"))

        heartbeat = self.client.post(
            "/api/device/heartbeat/",
            {},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(heartbeat.status_code, 200)

        self.mesa_a.refresh_from_db()
        self.assertIsNone(self.mesa_a.last_error)

    def test_direct_mesa_pairing_keeps_token_retrievable_until_device_authenticates(self):
        self.mesa_a.pairing_code = "MESA03"
        self.mesa_a.pairing_code_expires_at = timezone.now() + timedelta(minutes=1)
        self.mesa_a.save(update_fields=["pairing_code", "pairing_code_expires_at"])

        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.user_a_token.key}")
        pair_response = self.client.post(
            "/api/device/pair/",
            {"mesa_id": self.mesa_a.id, "pairing_code": "MESA03"},
            format="json",
        )
        self.assertEqual(pair_response.status_code, 200)

        self.mesa_a.pairing_code_expires_at = timezone.now() - timedelta(minutes=1)
        self.mesa_a.save(update_fields=["pairing_code_expires_at"])
        self.client.credentials()

        status_response = self.client.get("/api/device/status/?code=MESA03")
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.data["status"], "PAIRED")
        token = status_response.data["device_token"]
        self.assertTrue(token)

        heartbeat = self.client.post(
            "/api/device/heartbeat/",
            {},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(heartbeat.status_code, 200)

        self.mesa_a.refresh_from_db()
        self.assertIsNone(self.mesa_a.last_error)
        self.assertIsNone(self.mesa_a.pairing_code)


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
        "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
        "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    }
)
class FotoFabricacionDownloadTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin_fotos", password="admin123", is_staff=True)
        self.token = Token.objects.create(user=self.admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")

        self.user = User.objects.create_user(username="ferralla_fotos", password="pass123")
        self.proyecto = Proyecto.objects.create(nombre="Proyecto Fotos", usuario=self.user)
        self.planta = Planta.objects.create(nombre="P1", proyecto=self.proyecto, orden=1)
        self.grupo_1 = GrupoBastidor.objects.create(proyecto=self.proyecto, indice=1)
        self.grupo_2 = GrupoBastidor.objects.create(proyecto=self.proyecto, indice=2)
        self.modulo_1 = Modulo.objects.create(
            nombre="M-01",
            planta=self.planta,
            proyecto=self.proyecto,
            grupo_bastidor=self.grupo_1,
            orden_intra=1,
        )
        self.modulo_2 = Modulo.objects.create(
            nombre="M-02",
            planta=self.planta,
            proyecto=self.proyecto,
            grupo_bastidor=self.grupo_2,
            orden_intra=1,
        )

    def _crear_foto(self, modulo, relative_path):
        os.makedirs(os.path.dirname(relative_path), exist_ok=True)
        with open(relative_path, "wb") as fh:
            fh.write(b"fake-jpeg")

        media_relative = os.path.relpath(relative_path, start=self.media_root).replace("\\", "/")
        return FotoFabricacion.objects.create(
            modulo=modulo,
            fase="INFERIOR",
            paso=0,
            url=f"/media/{media_relative}",
            filename_original=os.path.basename(relative_path),
            file_size=8,
        )

    def test_fotos_y_zip_se_filtran_por_bastidor_sin_carpeta_de_bastidor(self):
        with tempfile.TemporaryDirectory() as media_root:
            self.media_root = media_root
            with override_settings(MEDIA_ROOT=media_root):
                self._crear_foto(self.modulo_1, os.path.join(media_root, "fotos", "m1.jpg"))
                self._crear_foto(self.modulo_2, os.path.join(media_root, "fotos", "m2.jpg"))

                list_response = self.client.get(
                    f"/api/fotos/?proyecto={self.proyecto.id}&grupo_bastidor={self.grupo_1.id}"
                )
                self.assertEqual(list_response.status_code, 200)
                self.assertEqual(len(list_response.data), 1)
                self.assertEqual(list_response.data[0]["modulo"], self.modulo_1.id)

                zip_response = self.client.get(
                    f"/api/fotos/download_zip/?proyecto={self.proyecto.id}&grupo_bastidor={self.grupo_1.id}"
                )
                self.assertEqual(zip_response.status_code, 200)

                archive = zipfile.ZipFile(io.BytesIO(zip_response.content))
                names = archive.namelist()
                self.assertIn("M-01/m1.jpg", names)
                self.assertNotIn("Bastidor 01/M-01/m1.jpg", names)
                self.assertNotIn("M-02/m2.jpg", names)

    def test_fotos_y_zip_se_filtran_por_modulos_concretos(self):
        with tempfile.TemporaryDirectory() as media_root:
            self.media_root = media_root
            with override_settings(MEDIA_ROOT=media_root):
                self._crear_foto(self.modulo_1, os.path.join(media_root, "fotos", "m1.jpg"))
                self._crear_foto(self.modulo_2, os.path.join(media_root, "fotos", "m2.jpg"))

                list_response = self.client.get(
                    f"/api/fotos/?proyecto={self.proyecto.id}&modulo={self.modulo_1.id}"
                )
                self.assertEqual(list_response.status_code, 200)
                self.assertEqual(len(list_response.data), 1)
                self.assertEqual(list_response.data[0]["modulo"], self.modulo_1.id)

                zip_response = self.client.get(
                    f"/api/fotos/download_zip/?proyecto={self.proyecto.id}&modulo={self.modulo_1.id}"
                )
                self.assertEqual(zip_response.status_code, 200)

                archive = zipfile.ZipFile(io.BytesIO(zip_response.content))
                names = archive.namelist()
                self.assertIn("m1.jpg", names)
                self.assertNotIn("M-02/m2.jpg", names)
                self.assertNotIn("m2.jpg", names)


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
        self.admin = User.objects.create_user(
            username="queue_admin", password="admin123", is_staff=True
        )
        self.admin_token = Token.objects.create(user=self.admin)
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

    def test_regular_user_cannot_move_item_between_mesas(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(second_response.status_code, 201)

        item_id = second_response.data["id"]
        move_response = self.client.patch(
            f"/api/mesa-queue-items/{item_id}/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )

        self.assertEqual(move_response.status_code, 403)
        item = MesaQueueItem.objects.get(id=item_id)
        self.assertEqual(item.mesa_id, self.mesa_a.id)
        self.assertEqual(item.position, 1)

    def test_mostrando_item_cannot_move_between_mesas(self):
        create_response = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        self.assertEqual(create_response.status_code, 201)

        item_id = create_response.data["id"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")
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

    def test_regular_user_cannot_reorder_queue(self):
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

        self.assertEqual(reorder_response.status_code, 403)
        self.assertEqual(MesaQueueItem.objects.get(id=third.data["id"]).position, 2)
        self.assertEqual(MesaQueueItem.objects.get(id=second.data["id"]).position, 1)

    def test_admin_can_reorder_queue(self):
        first = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        third = self._create_item(self.mesa_a.id, self.modulo_c.id, position=2)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")

        response = self.client.post(
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

        self.assertEqual(response.status_code, 200)
        self.assertEqual(MesaQueueItem.objects.get(id=third.data["id"]).position, 1)
        self.assertEqual(MesaQueueItem.objects.get(id=second.data["id"]).position, 2)

    def test_queue_item_incluye_progreso_de_imagenes_activas_de_su_fase(self):
        Imagen.objects.create(
            modulo=self.modulo_a,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-a-inf-1.png",
            activo=True,
        )
        Imagen.objects.create(
            modulo=self.modulo_a,
            fase="INFERIOR",
            orden=2,
            url="/imagenes/m-a-inf-2.png",
            activo=True,
        )
        Imagen.objects.create(
            modulo=self.modulo_a,
            fase="INFERIOR",
            orden=3,
            url="/imagenes/m-a-inf-inactiva.png",
            activo=False,
        )
        Imagen.objects.create(
            modulo=self.modulo_a,
            fase="SUPERIOR",
            orden=1,
            url="/imagenes/m-a-sup.png",
            activo=True,
        )
        create_response = self._create_item(
            self.mesa_a.id,
            self.modulo_a.id,
            fase="INFERIOR",
        )
        self.assertEqual(create_response.status_code, 201)
        self.mesa_a.current_image_index = 1
        self.mesa_a.save(update_fields=["current_image_index"])

        response = self.client.get(
            f"/api/mesa-queue-items/{create_response.data['id']}/"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["current_image_index"], 1)
        self.assertEqual(response.data["imagenes_total"], 2)

        grupo = GrupoMesas.objects.create(nombre="Grupo Progreso", usuario=self.user)
        self.mesa_a.grupo = grupo
        self.mesa_a.indice = 1
        self.mesa_a.save(update_fields=["grupo", "indice"])
        mesa_queue_response = self.client.get(
            f"/api/mesas/{self.mesa_a.id}/queue_items/"
        )
        self.assertEqual(mesa_queue_response.status_code, 200)
        self.assertEqual(mesa_queue_response.data[0]["current_image_index"], 1)
        self.assertEqual(mesa_queue_response.data[0]["imagenes_total"], 2)

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

        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")
        move_response = self.client.patch(
            f"/api/mesa-queue-items/{second_response.data['id']}/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )
        self.assertEqual(move_response.status_code, 200)

    def test_regular_user_cannot_use_move_action(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(second_response.status_code, 201)

        move_response = self.client.post(
            f"/api/mesa-queue-items/{second_response.data['id']}/move/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )
        self.assertEqual(move_response.status_code, 403)
        item = MesaQueueItem.objects.get(id=second_response.data["id"])
        self.assertEqual(item.mesa_id, self.mesa_a.id)

    def test_admin_move_action_moves_item_between_mesas(self):
        self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.admin_token.key}")

        move_response = self.client.post(
            f"/api/mesa-queue-items/{second_response.data['id']}/move/",
            {"mesa": self.mesa_b.id, "position": 0},
            format="json",
        )

        self.assertEqual(move_response.status_code, 200)
        self.assertEqual(move_response.data["mesa"], self.mesa_b.id)

    def test_marcar_hecho_resets_current_image_index_when_next_item_promoted(self):
        first_response = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(first_response.status_code, 201)
        self.assertEqual(second_response.status_code, 201)

        self.mesa_a.current_image_index = 4
        self.mesa_a.save(update_fields=["current_image_index"])

        response = self.client.post(
            f"/api/mesa-queue-items/{first_response.data['id']}/marcar_hecho/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)

        self.mesa_a.refresh_from_db()
        self.assertEqual(self.mesa_a.current_image_index, 0)
        self.assertEqual(MesaQueueItem.objects.get(id=second_response.data["id"]).status, "MOSTRANDO")

    def test_mostrar_resets_current_image_index(self):
        first_response = self._create_item(self.mesa_a.id, self.modulo_a.id, position=0)
        second_response = self._create_item(self.mesa_a.id, self.modulo_b.id, position=1)
        self.assertEqual(first_response.status_code, 201)
        self.assertEqual(second_response.status_code, 201)

        self.mesa_a.current_image_index = 3
        self.mesa_a.save(update_fields=["current_image_index"])

        response = self.client.post(
            f"/api/mesa-queue-items/{second_response.data['id']}/mostrar/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)

        self.mesa_a.refresh_from_db()
        self.assertEqual(self.mesa_a.current_image_index, 0)


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
        "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
        "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    }
)
class FerrallaContactosApiTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin_ferrallas", password="admin123", is_staff=True)
        self.token = Token.objects.create(user=self.admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")

    def test_admin_crea_ferralla_con_contactos_y_direcciones(self):
        response = self.client.post(
            "/api/users/",
            {
                "username": "ferralla_contactos",
                "first_name": "Ferralla Contactos",
                "password": "Moden1234",
                "password_texto_plano": "Moden1234",
                "contactos": [
                    {
                        "nombre": "Ana Oficina",
                        "cargo": "Oficina",
                        "telefono": "+34 600 000 001",
                        "email": "ana@example.com",
                    },
                    {
                        "nombre": "Luis Produccion",
                        "cargo": "Produccion",
                        "telefono": "+34 600 000 002",
                        "email": "luis@example.com",
                    },
                ],
                "direcciones": [
                    {"nombre": "Oficinas", "direccion": "Calle Oficina 1"},
                    {"nombre": "Mesas", "direccion": "Nave Produccion 2"},
                ],
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username="ferralla_contactos")
        self.assertEqual(FerrallaContacto.objects.filter(user=user).count(), 2)
        self.assertEqual(FerrallaDireccion.objects.filter(user=user).count(), 2)

        user.refresh_from_db()
        user.profile.refresh_from_db()
        self.assertEqual(user.email, "ana@example.com")
        self.assertEqual(user.profile.coordinador, "Ana Oficina")
        self.assertEqual(user.profile.telefono, "+34 600 000 001")
        self.assertEqual(user.profile.direccion, "Calle Oficina 1")
        self.assertEqual(response.data["contactos"][0]["nombre"], "Ana Oficina")
        self.assertEqual(response.data["direcciones"][1]["nombre"], "Mesas")

    def test_admin_actualiza_listas_reemplazando_valores_anteriores(self):
        create_response = self.client.post(
            "/api/users/",
            {
                "username": "ferralla_update",
                "first_name": "Ferralla Update",
                "password": "Moden1234",
                "contactos": [{"nombre": "Contacto Antiguo", "telefono": "111"}],
                "direcciones": [{"nombre": "Vieja", "direccion": "Direccion vieja"}],
            },
            format="json",
        )
        self.assertEqual(create_response.status_code, 201)
        user_id = create_response.data["id"]

        response = self.client.patch(
            f"/api/users/{user_id}/",
            {
                "contactos": [{"nombre": "Contacto Nuevo", "cargo": "Calidad", "email": "nuevo@example.com"}],
                "direcciones": [{"nombre": "Mallazos", "direccion": "Nave Mallazos"}],
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        user = User.objects.get(id=user_id)
        self.assertEqual(list(user.contactos.values_list("nombre", flat=True)), ["Contacto Nuevo"])
        self.assertEqual(list(user.direcciones.values_list("nombre", flat=True)), ["Mallazos"])
        user.profile.refresh_from_db()
        self.assertEqual(user.profile.coordinador, "Contacto Nuevo")
        self.assertEqual(user.profile.direccion, "Nave Mallazos")


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
        "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
        "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    }
)
class PlanningFoundationTests(APITestCase):
    def setUp(self):
        self._media_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._media_temp.cleanup)
        self._media_override = override_settings(
            MEDIA_ROOT=self._media_temp.name
        )
        self._media_override.enable()
        self.addCleanup(self._media_override.disable)

        self.user = User.objects.create_user(username="planning_user", password="pass123")
        self.token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")

        self.project = Proyecto.objects.create(nombre="Proyecto Plan", usuario=self.user)
        self.planta = Planta.objects.create(nombre="P1", proyecto=self.project, orden=1)
        self.modulo = Modulo.objects.create(nombre="M-01", proyecto=self.project, planta=self.planta)

    def _technical_db_file(self, filename, rows):
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as temp_file:
                temp_path = temp_file.name
            connection = sqlite3.connect(temp_path)
            connection.execute(
                """
                CREATE TABLE resumen (
                    id INTEGER PRIMARY KEY,
                    nombre_modulo TEXT,
                    ancho_cm REAL,
                    tipo_modulo TEXT,
                    numero_cortes_mallazo_inf INTEGER,
                    numero_cortes_mallazo_sup INTEGER,
                    cantidad_refuerzos_inf INTEGER,
                    cantidad_refuerzos_sup INTEGER,
                    peso_mallazo_recortado_inf REAL,
                    peso_mallazo_recortado_sup REAL
                )
                """
            )
            for index, row in enumerate(rows, start=1):
                connection.execute(
                    """
                    INSERT INTO resumen (
                        id, nombre_modulo, ancho_cm, tipo_modulo,
                        numero_cortes_mallazo_inf,
                        numero_cortes_mallazo_sup,
                        cantidad_refuerzos_inf,
                        cantidad_refuerzos_sup,
                        peso_mallazo_recortado_inf,
                        peso_mallazo_recortado_sup
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        index,
                        row["nombre"],
                        row.get("ancho", 17),
                        row.get("tipo", "CENTRAL"),
                        row.get("cortes_inf", 0),
                        row.get("cortes_sup", 0),
                        row.get("refuerzos_inf", 0),
                        row.get("refuerzos_sup", 0),
                        row.get("peso_inf", 10),
                        row.get("peso_sup", 10),
                    ),
                )
            connection.commit()
            connection.close()
            return SimpleUploadedFile(
                filename,
                Path(temp_path).read_bytes(),
                content_type="application/octet-stream",
            )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)

    def test_nombre_repetido_sigue_resolviendo_datos_tecnicos_originales(self):
        from api.views import _resolve_modulo_for_record

        self.modulo.nombre = "M-01-R"
        self.modulo.save(update_fields=["nombre"])

        modulo, error = _resolve_modulo_for_record(self.project, "M-01", "P1")

        self.assertIsNone(error)
        self.assertEqual(modulo, self.modulo)

    def test_detalle_modulo_fase_calcula_capacidad_bastidor(self):
        detalle = DetalleModuloFase.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            espesor_cm="12.00",
        )

        self.assertEqual(detalle.capacidad_bastidor, 9)

    def test_detalle_modulo_fase_prioriza_ancho_del_modulo_para_capacidad(self):
        self.modulo.ancho_cm = "19.00"
        self.modulo.save(update_fields=["ancho_cm"])

        detalle = DetalleModuloFase.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            espesor_cm="12.00",
        )

        self.assertEqual(detalle.capacidad_bastidor, 6)

    def test_crear_grupo_mesas_genera_tres_mesas_base(self):
        response = self.client.post(
            "/api/grupos-mesas/",
            {
                "nombre": "Grupo A",
                "usuario": self.user.id,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)

        grupo = GrupoMesas.objects.get(id=response.data["id"])
        combos = set(grupo.mesas.values_list("tipo", "indice"))

        self.assertEqual(grupo.mesas.count(), 3)
        # Indice global por grupo: Mesa 1 (INF), Mesa 2 (INF), Mesa 3 (SUP).
        self.assertSetEqual(
            combos,
            {("INFERIOR", 1), ("INFERIOR", 2), ("SUPERIOR", 3)},
        )

    def test_eliminar_grupo_mesas_elimina_sus_mesas_hijas(self):
        create_response = self.client.post(
            "/api/grupos-mesas/",
            {
                "nombre": "Grupo B",
                "usuario": self.user.id,
            },
            format="json",
        )

        self.assertEqual(create_response.status_code, 201)
        grupo_id = create_response.data["id"]
        self.assertEqual(Mesa.objects.filter(grupo_id=grupo_id).count(), 3)

        delete_response = self.client.delete(f"/api/grupos-mesas/{grupo_id}/")

        self.assertEqual(delete_response.status_code, 204)
        self.assertFalse(GrupoMesas.objects.filter(id=grupo_id).exists())
        self.assertEqual(Mesa.objects.filter(grupo_id=grupo_id).count(), 0)

    def _crear_grupo(self, nombre="Grupo CRUD"):
        response = self.client.post(
            "/api/grupos-mesas/",
            {"nombre": nombre, "usuario": self.user.id},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        return GrupoMesas.objects.get(id=response.data["id"])

    def test_reiniciar_modulo_limpia_colas_historicas_duplicadas(self):
        grupo = self._crear_grupo("Grupo Reinicio")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        imagen_inf = Imagen.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-01-inf.png",
        )
        imagen_sup = Imagen.objects.create(
            modulo=self.modulo,
            fase="SUPERIOR",
            orden=1,
            url="/imagenes/m-01-sup.png",
        )

        self.modulo.estado = ModuloEstado.COMPLETADO
        self.modulo.save()
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            imagen=imagen_inf,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            imagen=imagen_sup,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            imagen=imagen_sup,
            status=MesaQueueStatus.HECHO,
            position=1,
            done_at=timezone.now(),
        )
        mesa_sup.imagen_actual = imagen_sup
        mesa_sup.current_image_index = 2
        mesa_sup.save(update_fields=["imagen_actual", "current_image_index"])

        response = self.client.post(f"/api/modulos/{self.modulo.id}/reiniciar/")

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        mesa_sup.refresh_from_db()
        self.assertFalse(self.modulo.inferior_hecho)
        self.assertFalse(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.nombre, "M-01-R")
        self.assertFalse(self.modulo.cerrado)
        self.assertEqual(self.modulo.estado, ModuloEstado.PENDIENTE)
        self.assertIsNone(self.modulo.completado_at)
        active_items = MesaQueueItem.objects.filter(
            modulo=self.modulo,
            status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
        )
        self.assertEqual(active_items.count(), 2)
        self.assertEqual(
            active_items.get(fase="INFERIOR").mesa_id,
            mesa_inf.id,
        )
        self.assertEqual(
            active_items.get(fase="SUPERIOR").mesa_id,
            mesa_sup.id,
        )
        self.assertEqual(
            active_items.get(fase="SUPERIOR").status,
            MesaQueueStatus.MOSTRANDO,
        )
        self.assertTrue(
            GrupoMesasProyecto.objects.filter(
                grupo_mesas=grupo, proyecto=self.project
            ).exists()
        )
        self.assertIsNone(mesa_sup.imagen_actual)
        self.assertEqual(mesa_sup.current_image_index, 0)

        second_response = self.client.post(f"/api/modulos/{self.modulo.id}/reiniciar/")
        self.assertEqual(second_response.status_code, 200)
        self.modulo.refresh_from_db()
        self.assertEqual(self.modulo.nombre, "M-01-R")
        self.assertEqual(
            MesaQueueItem.objects.filter(
                modulo=self.modulo,
                status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
            ).count(),
            2,
        )

    def test_completar_fase_inferior_conserva_superior_pendiente(self):
        grupo = self._crear_grupo("Grupo Completar INF")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        imagen_inf = Imagen.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-01-inf.png",
        )
        imagen_sup = Imagen.objects.create(
            modulo=self.modulo,
            fase="SUPERIOR",
            orden=1,
            url="/imagenes/m-01-sup.png",
        )
        item_inf = MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            imagen=imagen_inf,
            status=MesaQueueStatus.EN_COLA,
            position=0,
        )
        item_sup = MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            imagen=imagen_sup,
            status=MesaQueueStatus.EN_COLA,
            position=0,
        )

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/completar-fase/",
            {"fase": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        item_inf.refresh_from_db()
        item_sup.refresh_from_db()
        self.assertTrue(self.modulo.inferior_hecho)
        self.assertFalse(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.estado, ModuloEstado.EN_PROGRESO)
        self.assertEqual(item_inf.status, MesaQueueStatus.HECHO)
        self.assertEqual(item_inf.done_by_id, self.user.id)
        self.assertEqual(item_sup.status, MesaQueueStatus.EN_COLA)

    def test_completar_fase_superior_finaliza_modulo_con_inferior_hecho(self):
        self.modulo.inferior_hecho = True
        self.modulo.estado = ModuloEstado.EN_PROGRESO
        self.modulo.save(update_fields=["inferior_hecho", "estado"])

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/completar-fase/",
            {"fase": "SUPERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        self.assertTrue(self.modulo.inferior_hecho)
        self.assertTrue(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.estado, ModuloEstado.COMPLETADO)
        self.assertIsNotNone(self.modulo.completado_at)

    def test_completar_fase_rechaza_fase_desconocida(self):
        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/completar-fase/",
            {"fase": "SD_D"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.modulo.refresh_from_db()
        self.assertFalse(self.modulo.inferior_hecho)
        self.assertFalse(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.estado, ModuloEstado.PENDIENTE)

    def test_reiniciar_fase_inferior_conserva_superior_y_su_cola(self):
        grupo = self._crear_grupo("Grupo Reinicio INF")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        imagen_inf = Imagen.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-01-inf.png",
        )
        imagen_sup = Imagen.objects.create(
            modulo=self.modulo,
            fase="SUPERIOR",
            orden=1,
            url="/imagenes/m-01-sup.png",
        )

        self.modulo.estado = ModuloEstado.COMPLETADO
        self.modulo.save()
        item_inf = MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            imagen=imagen_inf,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )
        item_sup = MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            imagen=imagen_sup,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )
        otro_modulo = Modulo.objects.create(
            nombre="M-02",
            proyecto=self.project,
            planta=self.planta,
        )
        otra_imagen_inf = Imagen.objects.create(
            modulo=otro_modulo,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-02-inf.png",
        )
        otro_item_inf = MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=otro_modulo,
            fase="INFERIOR",
            imagen=otra_imagen_inf,
            status=MesaQueueStatus.MOSTRANDO,
            position=1,
        )
        mesa_inf.imagen_actual = otra_imagen_inf
        mesa_inf.current_image_index = 4
        mesa_inf.save(update_fields=["imagen_actual", "current_image_index"])

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/reiniciar-fase/",
            {"fase": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        self.assertFalse(self.modulo.inferior_hecho)
        self.assertTrue(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.nombre, "M-01-R")
        self.assertEqual(self.modulo.estado, ModuloEstado.EN_PROGRESO)
        self.assertIsNone(self.modulo.completado_at)
        self.assertFalse(MesaQueueItem.objects.filter(id=item_inf.id).exists())
        self.assertTrue(MesaQueueItem.objects.filter(id=item_sup.id).exists())
        self.assertTrue(MesaQueueItem.objects.filter(id=otro_item_inf.id).exists())
        repeated_item = MesaQueueItem.objects.get(
            modulo=self.modulo,
            fase="INFERIOR",
            status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
        )
        self.assertEqual(repeated_item.mesa_id, mesa_inf.id)
        self.assertEqual(repeated_item.status, MesaQueueStatus.EN_COLA)
        self.assertEqual(repeated_item.position, 1)
        mesa_inf.refresh_from_db()
        self.assertEqual(mesa_inf.imagen_actual_id, otra_imagen_inf.id)
        self.assertEqual(mesa_inf.current_image_index, 4)

    def test_reiniciar_fase_superior_conserva_inferior_y_su_cola(self):
        grupo = self._crear_grupo("Grupo Reinicio SUP")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        imagen_inf = Imagen.objects.create(
            modulo=self.modulo,
            fase="INFERIOR",
            orden=1,
            url="/imagenes/m-01-inf.png",
        )
        imagen_sup = Imagen.objects.create(
            modulo=self.modulo,
            fase="SUPERIOR",
            orden=1,
            url="/imagenes/m-01-sup.png",
        )

        self.modulo.estado = ModuloEstado.COMPLETADO
        self.modulo.save()
        item_inf = MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            imagen=imagen_inf,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )
        item_sup = MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            imagen=imagen_sup,
            status=MesaQueueStatus.HECHO,
            position=0,
            done_at=timezone.now(),
        )

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/reiniciar-fase/",
            {"fase": "SUPERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        self.assertTrue(self.modulo.inferior_hecho)
        self.assertFalse(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.nombre, "M-01-R")
        self.assertEqual(self.modulo.estado, ModuloEstado.EN_PROGRESO)
        self.assertIsNone(self.modulo.completado_at)
        self.assertTrue(MesaQueueItem.objects.filter(id=item_inf.id).exists())
        self.assertFalse(MesaQueueItem.objects.filter(id=item_sup.id).exists())
        repeated_item = MesaQueueItem.objects.get(
            modulo=self.modulo,
            fase="SUPERIOR",
            status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
        )
        self.assertEqual(repeated_item.mesa_id, mesa_sup.id)
        self.assertEqual(repeated_item.status, MesaQueueStatus.MOSTRANDO)

    def test_reiniciar_fase_en_imagen_dos_pone_repeticion_primera(self):
        grupo = self._crear_grupo("Grupo Reinicio Prioritario")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        grupo_repetido = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=3,
            nombre="Grupo 3",
            asignado_a=grupo,
        )
        grupo_actual = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=5,
            nombre="Grupo 5",
            asignado_a=grupo,
        )
        self.modulo.grupo_bastidor = grupo_repetido
        self.modulo.orden_intra = 1
        self.modulo.inferior_hecho = True
        self.modulo.superior_hecho = True
        self.modulo.save()

        modulo_actual = Modulo.objects.create(
            nombre="M-05-A",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=grupo_actual,
            orden_intra=1,
        )
        modulo_siguiente = Modulo.objects.create(
            nombre="M-05-B",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=grupo_actual,
            orden_intra=2,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=modulo_actual,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=5,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=modulo_siguiente,
            fase="INFERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=1,
            plan_group_index=5,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.HECHO,
            position=2,
            plan_group_index=3,
        )
        mesa_inf.current_image_index = 1
        mesa_inf.save(update_fields=["current_image_index"])

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/reiniciar-fase/",
            {"fase": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        active = list(
            mesa_inf.queue_items.filter(status__in=["MOSTRANDO", "EN_COLA"])
            .select_related("modulo")
            .order_by("position")
        )
        self.assertEqual(
            [item.modulo.nombre for item in active],
            ["M-01-R", "M-05-A", "M-05-B"],
        )
        self.assertEqual(
            [item.plan_group_index for item in active],
            [3, 5, 5],
        )
        self.assertEqual(active[0].status, MesaQueueStatus.MOSTRANDO)
        self.assertEqual(active[1].status, MesaQueueStatus.EN_COLA)
        mesa_inf.refresh_from_db()
        self.assertEqual(mesa_inf.current_image_index, 0)

    def test_reiniciar_fase_avanzada_la_inserta_segunda_sin_perder_progreso(self):
        grupo = self._crear_grupo("Grupo Reinicio Tras Actual")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        grupo_repetido = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=3,
            nombre="Grupo 3",
            asignado_a=grupo,
        )
        grupo_actual = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=5,
            nombre="Grupo 5",
            asignado_a=grupo,
        )
        self.modulo.grupo_bastidor = grupo_repetido
        self.modulo.orden_intra = 1
        self.modulo.inferior_hecho = True
        self.modulo.superior_hecho = True
        self.modulo.save()

        modulo_actual = Modulo.objects.create(
            nombre="M-05-A",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=grupo_actual,
            orden_intra=1,
        )
        modulo_siguiente = Modulo.objects.create(
            nombre="M-05-B",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=grupo_actual,
            orden_intra=2,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=modulo_actual,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=5,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=modulo_siguiente,
            fase="INFERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=1,
            plan_group_index=5,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.HECHO,
            position=2,
            plan_group_index=3,
        )
        mesa_inf.current_image_index = 2
        mesa_inf.save(update_fields=["current_image_index"])

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/reiniciar-fase/",
            {"fase": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        active = list(
            mesa_inf.queue_items.filter(status__in=["MOSTRANDO", "EN_COLA"])
            .select_related("modulo")
            .order_by("position")
        )
        self.assertEqual(
            [item.modulo.nombre for item in active],
            ["M-05-A", "M-01-R", "M-05-B"],
        )
        self.assertEqual(
            [item.plan_group_index for item in active],
            [5, 3, 5],
        )
        self.assertEqual(active[0].status, MesaQueueStatus.MOSTRANDO)
        self.assertEqual(active[1].status, MesaQueueStatus.EN_COLA)
        mesa_inf.refresh_from_db()
        self.assertEqual(mesa_inf.current_image_index, 2)

    def test_importar_modulo_nuevo_lo_anade_a_colas_sin_replanificar(self):
        grupo = self._crear_grupo("Grupo Modulo Nuevo")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        GrupoMesasProyecto.objects.create(
            grupo_mesas=grupo,
            proyecto=self.project,
            orden=0,
        )
        self.project.datos_tecnicos_importados = True
        self.project.save(update_fields=["datos_tecnicos_importados"])
        bastidor = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=1,
            nombre="Grupo 1",
            asignado_a=grupo,
        )
        self.modulo.ancho_cm = "10.00"
        self.modulo.grupo_bastidor = bastidor
        self.modulo.orden_intra = 1
        self.modulo.save(update_fields=["ancho_cm", "grupo_bastidor", "orden_intra"])
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=1,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=1,
        )
        general = Planta.objects.create(
            nombre="General",
            proyecto=self.project,
            orden=2,
        )

        response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-structure/",
            {
                "plantas": json.dumps(
                    [{
                        "nombre": "General",
                        "orden": 2,
                        "modulos": [{
                            "nombre": "M-02",
                            "ancho_cm": "10.00",
                            "imagenes": [],
                        }],
                    }]
                )
            },
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            Planta.objects.filter(proyecto=self.project, nombre="General").count(),
            1,
        )
        nuevo = Modulo.objects.get(proyecto=self.project, nombre="M-02")
        self.assertEqual(nuevo.planta_id, general.id)
        self.assertEqual(nuevo.grupo_bastidor_id, bastidor.id)
        nuevo_items = MesaQueueItem.objects.filter(
            modulo=nuevo,
            status__in=[MesaQueueStatus.MOSTRANDO, MesaQueueStatus.EN_COLA],
        )
        self.assertEqual(nuevo_items.count(), 2)
        self.assertEqual(nuevo_items.get(fase="INFERIOR").mesa_id, mesa_inf.id)
        self.assertEqual(nuevo_items.get(fase="SUPERIOR").mesa_id, mesa_sup.id)
        self.assertEqual(nuevo_items.get(fase="INFERIOR").position, 0)
        self.assertEqual(
            nuevo_items.get(fase="INFERIOR").status,
            MesaQueueStatus.MOSTRANDO,
        )
        self.assertEqual(nuevo_items.get(fase="SUPERIOR").position, 1)

        duplicate_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-structure/",
            {
                "plantas": json.dumps(
                    [{
                        "nombre": "General",
                        "orden": 2,
                        "modulos": [{
                            "nombre": "M-02",
                            "ancho_cm": "10.00",
                            "imagenes": [],
                        }],
                    }]
                )
            },
            format="multipart",
        )
        self.assertEqual(duplicate_response.status_code, 200)
        self.assertEqual(duplicate_response.data["stats"]["modulos"], 0)
        self.assertEqual(
            Modulo.objects.filter(proyecto=self.project, nombre="M-02").count(),
            1,
        )

    def test_importar_imagenes_homonimas_conserva_archivo_de_cada_fase(self):
        inf_key = "MOD_M-02_INF_01_malla.jpg"
        sup_key = "MOD_M-02_SUP_01_malla.jpg"
        structure = [{
            "nombre": "General",
            "orden": 2,
            "modulos": [{
                "nombre": "M-02",
                "imagenes": [
                    {"filename": inf_key, "fase": "INFERIOR", "orden": 1},
                    {"filename": sup_key, "fase": "SUPERIOR", "orden": 1},
                ],
            }],
        }]

        with tempfile.TemporaryDirectory() as media_root:
            with override_settings(MEDIA_ROOT=media_root):
                response = self.client.post(
                    f"/api/proyectos/{self.project.id}/import-structure/",
                    {
                        "plantas": json.dumps(structure),
                        inf_key: SimpleUploadedFile(
                            "01_malla.jpg", b"imagen-inferior", "image/jpeg"
                        ),
                        sup_key: SimpleUploadedFile(
                            "01_malla.jpg", b"imagen-superior", "image/jpeg"
                        ),
                    },
                    format="multipart",
                )

                self.assertEqual(response.status_code, 200)
                modulo = Modulo.objects.get(
                    proyecto=self.project,
                    nombre="M-02",
                )
                inferior = modulo.imagenes.get(fase="INFERIOR", orden=1)
                superior = modulo.imagenes.get(fase="SUPERIOR", orden=1)

                self.assertNotEqual(inferior.url, superior.url)
                self.assertIn("_INF_", inferior.url)
                self.assertIn("_SUP_", superior.url)

                def uploaded_bytes(image):
                    relative = image.url.removeprefix("/media/")
                    return (Path(media_root) / Path(relative)).read_bytes()

                self.assertEqual(uploaded_bytes(inferior), b"imagen-inferior")
                self.assertEqual(uploaded_bytes(superior), b"imagen-superior")

    def test_mover_modulo_a_otro_bastidor_lo_traslada_a_su_mesa_inferior(self):
        admin = User.objects.create_user(
            username="move_module_admin",
            password="pass123",
            is_staff=True,
        )
        admin_token = Token.objects.create(user=admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {admin_token.key}")
        grupo = self._crear_grupo("Grupo Mover Modulo")
        mesa_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)
        origen = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=1,
            nombre="Grupo 1",
            asignado_a=grupo,
        )
        destino = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=2,
            nombre="Grupo 2",
            asignado_a=grupo,
        )
        self.modulo.grupo_bastidor = origen
        self.modulo.orden_intra = 1
        self.modulo.save(update_fields=["grupo_bastidor", "orden_intra"])
        modulo_actual = Modulo.objects.create(
            nombre="G1-ACTUAL",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=origen,
            orden_intra=2,
        )
        peer_1 = Modulo.objects.create(
            nombre="G2-01",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=destino,
            orden_intra=3,
        )
        peer_2 = Modulo.objects.create(
            nombre="G2-02",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=destino,
            orden_intra=2,
        )
        peer_3 = Modulo.objects.create(
            nombre="G2-03",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=destino,
            orden_intra=1,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_1,
            modulo=modulo_actual,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=1,
        )
        moved_item = MesaQueueItem.objects.create(
            mesa=mesa_1,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=1,
            plan_group_index=1,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=modulo_actual,
            fase="SUPERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=1,
        )
        moved_sup_item = MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=self.modulo,
            fase="SUPERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=4,
            plan_group_index=1,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=peer_1,
            fase="SUPERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=1,
            plan_group_index=2,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=peer_2,
            fase="SUPERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=2,
            plan_group_index=2,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_sup,
            modulo=peer_3,
            fase="SUPERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=3,
            plan_group_index=2,
        )
        current_peer_item = MesaQueueItem.objects.create(
            mesa=mesa_2,
            modulo=peer_1,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=2,
        )
        second_peer_item = MesaQueueItem.objects.create(
            mesa=mesa_2,
            modulo=peer_2,
            fase="INFERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=1,
            plan_group_index=2,
        )
        first_peer_item = MesaQueueItem.objects.create(
            mesa=mesa_2,
            modulo=peer_3,
            fase="INFERIOR",
            status=MesaQueueStatus.EN_COLA,
            position=2,
            plan_group_index=2,
        )
        mesa_1.current_image_index = 4
        mesa_1.save(update_fields=["current_image_index"])

        response = self.client.post(
            "/api/grupos-bastidor/move-modulo/",
            {
                "modulo_id": self.modulo.id,
                "grupo_destino_id": destino.id,
                "index_destino": 3,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.modulo.refresh_from_db()
        moved_item.refresh_from_db()
        mesa_1.refresh_from_db()
        self.assertEqual(self.modulo.grupo_bastidor_id, destino.id)
        self.assertEqual(moved_item.mesa_id, mesa_2.id)
        self.assertEqual(moved_item.status, MesaQueueStatus.MOSTRANDO)
        self.assertEqual(moved_item.plan_group_index, 2)
        moved_sup_item.refresh_from_db()
        self.assertEqual(moved_sup_item.mesa_id, mesa_sup.id)
        self.assertEqual(moved_sup_item.position, 1)
        self.assertEqual(moved_sup_item.status, MesaQueueStatus.EN_COLA)
        self.assertEqual(mesa_1.current_image_index, 4)
        self.assertEqual(
            list(
                mesa_2.queue_items.filter(status__in=["MOSTRANDO", "EN_COLA"])
                .order_by("position")
                .values_list("modulo__nombre", flat=True)
            ),
            ["M-01", "G2-01", "G2-02", "G2-03"],
        )

        # Tambien repara datos creados por la version anterior: el modulo
        # ya dice Grupo 2, pero su item todavia permanece en Mesa 1.
        moved_item.mesa = mesa_1
        moved_item.position = 1
        moved_item.status = MesaQueueStatus.EN_COLA
        moved_item.save(update_fields=["mesa", "position", "status"])
        first_peer_item.status = MesaQueueStatus.MOSTRANDO
        first_peer_item.save(update_fields=["status"])
        repair_response = self.client.post(
            "/api/grupos-bastidor/move-modulo/",
            {
                "modulo_id": self.modulo.id,
                "grupo_destino_id": destino.id,
                "index_destino": 3,
            },
            format="json",
        )
        self.assertEqual(repair_response.status_code, 200)
        moved_item.refresh_from_db()
        self.assertEqual(moved_item.mesa_id, mesa_2.id)
        self.assertEqual(moved_item.status, MesaQueueStatus.MOSTRANDO)

        # Y reordena la cola aunque el modulo ya estuviera en la mesa
        # correcta, que es el caso observado con A01 en staging.
        moved_item.position = 3
        moved_item.status = MesaQueueStatus.EN_COLA
        moved_item.save(update_fields=["position", "status"])
        current_peer_item.position = 0
        current_peer_item.status = MesaQueueStatus.MOSTRANDO
        current_peer_item.save(update_fields=["position", "status"])
        second_peer_item.position = 1
        second_peer_item.status = MesaQueueStatus.EN_COLA
        second_peer_item.save(update_fields=["position", "status"])
        first_peer_item.position = 2
        first_peer_item.status = MesaQueueStatus.EN_COLA
        first_peer_item.save(update_fields=["position", "status"])
        mesa_2.current_image_index = 0
        mesa_2.save(update_fields=["current_image_index"])

        same_mesa_response = self.client.post(
            "/api/grupos-bastidor/move-modulo/",
            {
                "modulo_id": self.modulo.id,
                "grupo_destino_id": destino.id,
                "index_destino": 3,
            },
            format="json",
        )
        self.assertEqual(same_mesa_response.status_code, 200)
        moved_item.refresh_from_db()
        self.assertEqual(moved_item.mesa_id, mesa_2.id)
        self.assertEqual(moved_item.position, 0)
        self.assertEqual(moved_item.status, MesaQueueStatus.MOSTRANDO)

        # Si el actual sigue en la primera imagen, moverlo dentro del card
        # aplica el nuevo orden inverso y da paso al nuevo primero.
        reorder_showing_response = self.client.post(
            "/api/grupos-bastidor/move-modulo/",
            {
                "modulo_id": self.modulo.id,
                "grupo_destino_id": destino.id,
                "index_destino": 1,
            },
            format="json",
        )
        self.assertEqual(reorder_showing_response.status_code, 200)
        moved_item.refresh_from_db()
        current_peer_item.refresh_from_db()
        self.assertEqual(moved_item.position, 2)
        self.assertEqual(moved_item.status, MesaQueueStatus.EN_COLA)
        self.assertEqual(current_peer_item.position, 0)
        self.assertEqual(current_peer_item.status, MesaQueueStatus.MOSTRANDO)
        self.assertEqual(
            list(
                mesa_2.queue_items.filter(status__in=["MOSTRANDO", "EN_COLA"])
                .order_by("position")
                .values_list("modulo__nombre", flat=True)
            ),
            ["G2-01", "G2-02", "M-01", "G2-03"],
        )
        moved_sup_item.refresh_from_db()
        self.assertEqual(moved_sup_item.position, 3)
        self.assertEqual(
            list(
                mesa_sup.queue_items.filter(status__in=["MOSTRANDO", "EN_COLA"])
                .order_by("position")
                .values_list("modulo__nombre", flat=True)
            ),
            ["G1-ACTUAL", "G2-01", "G2-02", "M-01", "G2-03"],
        )

    def test_no_mueve_de_mesa_un_modulo_que_ya_se_esta_mostrando(self):
        admin = User.objects.create_user(
            username="move_showing_module_admin",
            password="pass123",
            is_staff=True,
        )
        admin_token = Token.objects.create(user=admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {admin_token.key}")
        grupo = self._crear_grupo("Grupo Mover Mostrando")
        mesa_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        origen = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=1,
            nombre="Grupo 1",
            asignado_a=grupo,
        )
        destino = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=2,
            nombre="Grupo 2",
            asignado_a=grupo,
        )
        self.modulo.grupo_bastidor = origen
        self.modulo.orden_intra = 1
        self.modulo.save(update_fields=["grupo_bastidor", "orden_intra"])
        peer = Modulo.objects.create(
            nombre="G2-01",
            proyecto=self.project,
            planta=self.planta,
            grupo_bastidor=destino,
            orden_intra=1,
        )
        showing_item = MesaQueueItem.objects.create(
            mesa=mesa_1,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=1,
        )
        MesaQueueItem.objects.create(
            mesa=mesa_2,
            modulo=peer,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
            plan_group_index=2,
        )

        response = self.client.post(
            "/api/grupos-bastidor/move-modulo/",
            {
                "modulo_id": self.modulo.id,
                "grupo_destino_id": destino.id,
                "index_destino": 1,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.modulo.refresh_from_db()
        showing_item.refresh_from_db()
        self.assertEqual(self.modulo.grupo_bastidor_id, origen.id)
        self.assertEqual(showing_item.mesa_id, mesa_1.id)

    def test_solo_admin_puede_eliminar_modulo(self):
        response = self.client.delete(f"/api/modulos/{self.modulo.id}/")

        self.assertEqual(response.status_code, 403)
        self.assertTrue(Modulo.objects.filter(id=self.modulo.id).exists())

    def test_eliminar_modulo_pendiente_limpia_media_y_promueve_siguiente(self):
        admin = User.objects.create_user(
            username="module_delete_admin",
            password="pass123",
            is_staff=True,
        )
        admin_token = Token.objects.create(user=admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {admin_token.key}")
        grupo = self._crear_grupo("Grupo Eliminar Modulo")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        bastidor = GrupoBastidor.objects.create(
            proyecto=self.project,
            indice=1,
            nombre="Grupo 1",
            asignado_a=grupo,
        )
        self.modulo.grupo_bastidor = bastidor
        self.modulo.orden_intra = 1
        self.modulo.save(update_fields=["grupo_bastidor", "orden_intra"])
        siguiente = Modulo.objects.create(
            nombre="M-SIG",
            proyecto=self.project,
            planta=self.planta,
        )

        with tempfile.TemporaryDirectory() as media_root:
            with override_settings(MEDIA_ROOT=media_root):
                image_path = (
                    Path(media_root)
                    / "imagenes"
                    / str(self.project.id)
                    / str(self.planta.id)
                    / str(self.modulo.id)
                    / "paso.png"
                )
                image_path.parent.mkdir(parents=True)
                image_path.write_bytes(b"imagen")
                imagen = Imagen.objects.create(
                    modulo=self.modulo,
                    fase="INFERIOR",
                    orden=1,
                    activo=True,
                    url=(
                        f"/media/imagenes/{self.project.id}/"
                        f"{self.planta.id}/{self.modulo.id}/paso.png"
                    ),
                )
                MesaQueueItem.objects.create(
                    mesa=mesa_inf,
                    modulo=self.modulo,
                    fase="INFERIOR",
                    imagen=imagen,
                    status=MesaQueueStatus.MOSTRANDO,
                    position=0,
                )
                next_item = MesaQueueItem.objects.create(
                    mesa=mesa_inf,
                    modulo=siguiente,
                    fase="INFERIOR",
                    status=MesaQueueStatus.EN_COLA,
                    position=1,
                )
                mesa_inf.imagen_actual = imagen
                mesa_inf.current_image_index = 1
                mesa_inf.save(update_fields=["imagen_actual", "current_image_index"])

                with self.captureOnCommitCallbacks(execute=True):
                    response = self.client.delete(
                        f"/api/modulos/{self.modulo.id}/"
                    )

                self.assertEqual(response.status_code, 204)
                self.assertFalse(Modulo.objects.filter(id=self.modulo.id).exists())
                self.assertFalse(GrupoBastidor.objects.filter(id=bastidor.id).exists())
                self.assertFalse(image_path.exists())
                next_item.refresh_from_db()
                mesa_inf.refresh_from_db()
                self.assertEqual(next_item.status, MesaQueueStatus.MOSTRANDO)
                self.assertEqual(next_item.position, 0)
                self.assertEqual(mesa_inf.current_image_index, 0)

    def test_eliminar_modulo_pendiente_con_foto_exige_force_y_limpia_foto(self):
        admin = User.objects.create_user(
            username="module_delete_photo_admin",
            password="pass123",
            is_staff=True,
        )
        admin_token = Token.objects.create(user=admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {admin_token.key}")

        with tempfile.TemporaryDirectory() as media_root:
            with override_settings(MEDIA_ROOT=media_root):
                photo_path = (
                    Path(media_root)
                    / "fotos"
                    / str(self.project.id)
                    / str(self.planta.id)
                    / str(self.modulo.id)
                    / "prueba.jpg"
                )
                photo_path.parent.mkdir(parents=True)
                photo_path.write_bytes(b"foto-prueba")
                FotoFabricacion.objects.create(
                    modulo=self.modulo,
                    fase="INFERIOR",
                    paso=0,
                    url=(
                        f"/media/fotos/{self.project.id}/"
                        f"{self.planta.id}/{self.modulo.id}/prueba.jpg"
                    ),
                )

                response = self.client.delete(
                    f"/api/modulos/{self.modulo.id}/"
                )
                self.assertEqual(response.status_code, 409)
                self.assertTrue(
                    Modulo.objects.filter(id=self.modulo.id).exists()
                )

                with self.captureOnCommitCallbacks(execute=True):
                    response = self.client.delete(
                        f"/api/modulos/{self.modulo.id}/?force=true"
                    )

                self.assertEqual(response.status_code, 204)
                self.assertFalse(
                    Modulo.objects.filter(id=self.modulo.id).exists()
                )
                self.assertFalse(photo_path.exists())

    def test_no_elimina_modulo_que_ya_avanza_en_fabricacion(self):
        admin = User.objects.create_user(
            username="module_delete_guard_admin",
            password="pass123",
            is_staff=True,
        )
        admin_token = Token.objects.create(user=admin)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {admin_token.key}")
        grupo = self._crear_grupo("Grupo Eliminar Bloqueado")
        mesa_inf = grupo.mesas.get(tipo="INFERIOR", indice=1)
        MesaQueueItem.objects.create(
            mesa=mesa_inf,
            modulo=self.modulo,
            fase="INFERIOR",
            status=MesaQueueStatus.MOSTRANDO,
            position=0,
        )
        mesa_inf.current_image_index = 2
        mesa_inf.save(update_fields=["current_image_index"])

        response = self.client.delete(f"/api/modulos/{self.modulo.id}/")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(Modulo.objects.filter(id=self.modulo.id).exists())

    def test_reiniciar_fase_rechaza_fase_desconocida(self):
        self.modulo.estado = ModuloEstado.COMPLETADO
        self.modulo.save()

        response = self.client.post(
            f"/api/modulos/{self.modulo.id}/reiniciar-fase/",
            {"fase": "SD_S"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.modulo.refresh_from_db()
        self.assertTrue(self.modulo.inferior_hecho)
        self.assertTrue(self.modulo.superior_hecho)
        self.assertEqual(self.modulo.estado, ModuloEstado.COMPLETADO)

    def test_grupo_mesas_summary_includes_last_seen(self):
        grupo = self._crear_grupo("Grupo Last Seen")
        mesa = grupo.mesas.first()
        seen_at = timezone.now() - timedelta(minutes=3)
        mesa.last_seen = seen_at
        mesa.save(update_fields=["last_seen"])

        response = self.client.get(f"/api/grupos-mesas/{grupo.id}/")

        self.assertEqual(response.status_code, 200)
        mesa_payload = response.data["mesas"][0]
        self.assertIn("last_seen", mesa_payload)
        self.assertIsNotNone(mesa_payload["last_seen"])

    def test_add_mesa_inferior_asigna_siguiente_indice_libre(self):
        """El indice ahora es global por grupo: tras 3 mesas default, la
        nueva mesa recibe indice 4 independientemente del tipo."""
        grupo = self._crear_grupo("Grupo INF Extra")

        response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["tipo"], "INFERIOR")
        self.assertEqual(response.data["indice"], 4)
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 3)

    def test_add_mesa_superior_asigna_siguiente_indice_libre(self):
        grupo = self._crear_grupo("Grupo SUP Extra")

        response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "SUPERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["tipo"], "SUPERIOR")
        # Indice global: tras 3 mesas default, la siguiente recibe 4.
        self.assertEqual(response.data["indice"], 4)

    def test_add_mesa_rechaza_tipo_invalido(self):
        grupo = self._crear_grupo("Grupo Tipo Invalido")

        response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "XYZ"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_destroy_mesa_permite_borrar_la_unica_superior(self):
        """La regla 'no la unica del tipo' fue eliminada en Fase 8: el
        cliente puede dejar el grupo sin SUP (fabricar solo inferiores)."""
        grupo = self._crear_grupo("Grupo Unica SUP")
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR")

        response = self.client.delete(f"/api/mesas/{mesa_sup.id}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Mesa.objects.filter(id=mesa_sup.id).exists())
        self.assertEqual(grupo.mesas.filter(tipo="SUPERIOR").count(), 0)

    def test_destroy_mesa_permite_borrar_si_hay_otra_del_mismo_tipo(self):
        grupo = self._crear_grupo("Grupo Dos INF")
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Mesa.objects.filter(id=mesa_inf_2.id).exists())
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 1)

    def test_destroy_mesa_rechaza_si_tiene_device_sin_force(self):
        grupo = self._crear_grupo("Grupo Device")
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_inf_2.device_token_hash = "x" * 64
        mesa_inf_2.save(update_fields=["device_token_hash"])

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.data.get("device_vinculado"))
        self.assertTrue(Mesa.objects.filter(id=mesa_inf_2.id).exists())

    def test_destroy_mesa_con_force_borra_aunque_tenga_device(self):
        grupo = self._crear_grupo("Grupo Device Force")
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_inf_2.device_token_hash = "y" * 64
        mesa_inf_2.save(update_fields=["device_token_hash"])

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/?force=true")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Mesa.objects.filter(id=mesa_inf_2.id).exists())

    def test_planificar_balancea_carga_entre_tres_mesas_inferiores(self):
        """Con 6 modulos y 3 inferiores, cada mesa recibe 2 modulos."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        # 6 modulos en bastidores de 1 modulo cada uno (ancho > 10cm).
        modulos = [self.modulo]
        for i in range(2, 7):
            modulos.append(
                Modulo.objects.create(
                    nombre=f"M-0{i}",
                    proyecto=self.project,
                    planta=self.planta,
                    ancho_cm="15.00",
                )
            )
        self.modulo.ancho_cm = "15.00"
        self.modulo.save(update_fields=["ancho_cm"])
        for modulo in modulos:
            DetalleModuloFase.objects.create(
                modulo=modulo, fase="INFERIOR", espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo 3 INF")
        # Añade una tercera mesa inferior (INF3) via API
        add_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "INFERIOR"}, format="json",
        )
        self.assertEqual(add_resp.status_code, 201)
        # Indice global por grupo: la cuarta mesa creada lleva indice 4.
        self.assertEqual(add_resp.data["indice"], 4)

        plan_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        self.assertEqual(plan_resp.status_code, 200)

        # Cada mesa inferior tiene 2 modulos exactos.
        mesas_inf = grupo.mesas.filter(tipo="INFERIOR").order_by("indice")
        counts = [m.queue_items.count() for m in mesas_inf]
        self.assertEqual(counts, [2, 2, 2])

    def test_planificar_distribuye_superior_entre_dos_mesas_sup(self):
        """Con 4 modulos cuyas fases SUP estan pendientes, las 2 SUP
        reciben round-robin: 2 cada una."""
        self.project.bastidor_longitud_cm = 40
        self.project.save(update_fields=["bastidor_longitud_cm"])

        modulos = [self.modulo]
        for i in range(2, 5):
            modulos.append(
                Modulo.objects.create(
                    nombre=f"M-0{i}",
                    proyecto=self.project,
                    planta=self.planta,
                    ancho_cm="10.00",
                )
            )
        self.modulo.ancho_cm = "10.00"
        self.modulo.save(update_fields=["ancho_cm"])
        for modulo in modulos:
            DetalleModuloFase.objects.create(
                modulo=modulo, fase="INFERIOR", espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo 2 SUP")
        add_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "SUPERIOR"}, format="json",
        )
        self.assertEqual(add_resp.status_code, 201)
        # Indice global por grupo: la cuarta mesa creada lleva indice 4.
        self.assertEqual(add_resp.data["indice"], 4)

        plan_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        self.assertEqual(plan_resp.status_code, 200)

        mesas_sup = grupo.mesas.filter(tipo="SUPERIOR").order_by("indice")
        counts = [m.queue_items.filter(fase="SUPERIOR").count() for m in mesas_sup]
        # 4 modulos, 2 mesas SUP -> 2+2.
        self.assertEqual(counts, [2, 2])

    def test_planificar_payload_devuelve_lista_dinamica_de_colas(self):
        """El payload `queues` ahora es una lista, no un dict de roles."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        DetalleModuloFase.objects.create(
            modulo=self.modulo, fase="INFERIOR", espesor_cm="10.00",
        )

        grupo = self._crear_grupo("Grupo Payload")
        plan_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        self.assertEqual(plan_resp.status_code, 200)

        plan = plan_resp.data["plan"]
        self.assertIsInstance(plan["queues"], list)
        # Default: 2 INF + 1 SUP -> 3 entradas.
        self.assertEqual(len(plan["queues"]), 3)
        for entry in plan["queues"]:
            self.assertIn("mesa_id", entry)
            self.assertIn("tipo", entry)
            self.assertIn("indice", entry)
            self.assertIn("mesa_nombre", entry)
            self.assertIn("modulos", entry)

    def test_planificar_sin_mesa_inferior_salta_fase_inferior(self):
        """Si el grupo no tiene mesas INF activas, planificar salta la
        fase INFERIOR silenciosamente (devuelve 200, sin items INF)."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])
        DetalleModuloFase.objects.create(
            modulo=self.modulo, fase="INFERIOR", espesor_cm="10.00",
        )

        grupo = self._crear_grupo("Grupo Sin INF")
        # Borra las dos inferiores: ahora se puede (la regla 'ultima' ya
        # no existe). Queda solo la SUP del default.
        for mesa in list(grupo.mesas.filter(tipo="INFERIOR")):
            self.client.delete(f"/api/mesas/{mesa.id}/")
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 0)

        plan_resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        self.assertEqual(plan_resp.status_code, 200)
        # No se crearon items de fase INFERIOR (no hay donde ponerlos).
        self.assertEqual(
            MesaQueueItem.objects.filter(
                mesa__grupo=grupo, fase="INFERIOR",
            ).count(),
            0,
        )
        # Pero la mesa SUP restante si debe recibir la fase superior:
        # permite operar una prueba o lote con una sola mesa configurada
        # como superior.
        self.assertEqual(
            MesaQueueItem.objects.filter(
                mesa__grupo=grupo, fase="SUPERIOR",
            ).count(),
            1,
        )

    # =========================================================================
    # CAMBIAR TIPOS (switch INF <-> SUP en mesas existentes)
    # =========================================================================

    def _setup_grupo_con_dos_inf_un_sup_y_un_modulo(self, nombre):
        """Helper: crea proyecto+modulo+grupo y un plan inicial. Devuelve
        (grupo, modulo)."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])
        DetalleModuloFase.objects.create(
            modulo=self.modulo, fase="INFERIOR", espesor_cm="10.00",
        )
        grupo = self._crear_grupo(nombre)
        plan = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        self.assertEqual(plan.status_code, 200)
        return grupo, self.modulo

    def test_cambiar_tipos_caso_feliz_redistribuye(self):
        """Convertir Mesa 2 (INF) a SUP deja 1 INF + 2 SUP. Los indices son
        globales y NO se recompactan: Mesa 2 sigue siendo indice 2."""
        grupo, _ = self._setup_grupo_con_dos_inf_un_sup_y_un_modulo("Grupo Switch")
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_2.id, "tipo": "SUPERIOR"}]},
            format="json",
        )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 1)
        self.assertEqual(grupo.mesas.filter(tipo="SUPERIOR").count(), 2)
        # Indices se conservan: las dos SUP ahora tienen indices 2 y 3.
        sup_indices = sorted(grupo.mesas.filter(tipo="SUPERIOR").values_list("indice", flat=True))
        self.assertEqual(sup_indices, [2, 3])

    def test_cambiar_tipos_permite_quedar_sin_inferior(self):
        """La regla 'minimo 1 INF + 1 SUP' fue eliminada en Fase 8: el
        cliente puede dejar el grupo solo con SUPs (o solo con INFs)."""
        grupo, _ = self._setup_grupo_con_dos_inf_un_sup_y_un_modulo("Grupo Sin INF")
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [
                {"mesa_id": mesa_inf_1.id, "tipo": "SUPERIOR"},
                {"mesa_id": mesa_inf_2.id, "tipo": "SUPERIOR"},
            ]},
            format="json",
        )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 0)
        self.assertEqual(grupo.mesas.filter(tipo="SUPERIOR").count(), 3)

    def test_cambiar_tipos_ancla_bastidor_inf_en_curso(self):
        """Si un bastidor tiene >=1 modulo inferior_hecho, el item INFERIOR
        de los otros modulos del mismo bastidor queda anclado tras el cambio."""
        from api.models import GrupoBastidor

        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])
        # Dos modulos en el mismo bastidor (caben los dos con ancho 10cm).
        modulo_b = Modulo.objects.create(
            nombre="M-02", proyecto=self.project, planta=self.planta,
            ancho_cm="10.00",
        )
        self.modulo.ancho_cm = "10.00"
        self.modulo.save(update_fields=["ancho_cm"])
        gb = GrupoBastidor.objects.create(
            proyecto=self.project, indice=1, nombre="GB1",
        )
        self.modulo.grupo_bastidor = gb
        self.modulo.save(update_fields=["grupo_bastidor"])
        modulo_b.grupo_bastidor = gb
        modulo_b.save(update_fields=["grupo_bastidor"])
        for m in (self.modulo, modulo_b):
            DetalleModuloFase.objects.create(
                modulo=m, fase="INFERIOR", espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo Ancla INF")
        self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )

        # Marca M-01 como inferior_hecho (sin tocar el item).
        self.modulo.inferior_hecho = True
        self.modulo.actualizar_estado()

        # M-02 sigue activo en alguna INF.
        item_m2 = MesaQueueItem.objects.filter(
            modulo=modulo_b, fase="INFERIOR", status__in=["EN_COLA", "MOSTRANDO"],
        ).first()
        self.assertIsNotNone(item_m2)
        mesa_original = item_m2.mesa

        # Convertimos la OTRA inferior (no la de M-02) a SUP.
        otra_inf = grupo.mesas.filter(tipo="INFERIOR").exclude(id=mesa_original.id).first()
        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": otra_inf.id, "tipo": "SUPERIOR"}]},
            format="json",
        )

        self.assertEqual(resp.status_code, 200)
        # El item del bastidor en curso sigue en su mesa original.
        item_m2.refresh_from_db()
        self.assertEqual(item_m2.mesa_id, mesa_original.id)

    def test_cambiar_tipos_ancla_sup_con_foto(self):
        """Item SUP con FotoFabricacion registrada no se mueve."""
        grupo, modulo = self._setup_grupo_con_dos_inf_un_sup_y_un_modulo("Grupo Ancla SUP")
        modulo.inferior_hecho = True
        modulo.superior_hecho = False
        modulo.actualizar_estado()

        # Asegurar un item SUP en cola (replanificar para que aparezca).
        self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )
        item_sup = MesaQueueItem.objects.filter(modulo=modulo, fase="SUPERIOR").first()
        self.assertIsNotNone(item_sup)
        mesa_sup_original = item_sup.mesa

        # Crea una foto fabricacion para anclarlo.
        FotoFabricacion.objects.create(
            modulo=modulo, mesa=mesa_sup_original, fase="SUPERIOR",
            paso=0, url="test/foto.jpg",
        )

        # Convertir la INF2 a SUP (anade una SUP mas).
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_2.id, "tipo": "SUPERIOR"}]},
            format="json",
        )

        self.assertEqual(resp.status_code, 200)
        item_sup.refresh_from_db()
        # El item SUP con foto sigue en su mesa original.
        self.assertEqual(item_sup.mesa_id, mesa_sup_original.id)

    def test_cambiar_tipos_rechaza_sin_cambios_efectivos(self):
        grupo, _ = self._setup_grupo_con_dos_inf_un_sup_y_un_modulo("Grupo Sin Cambios")
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)

        # Mandar el mismo tipo que ya tiene -> rechazo.
        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_1.id, "tipo": "INFERIOR"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_cambiar_tipos_rechaza_mesa_que_no_es_del_grupo(self):
        grupo, _ = self._setup_grupo_con_dos_inf_un_sup_y_un_modulo("Grupo A")
        otro_grupo = self._crear_grupo("Grupo B")
        mesa_otro = otro_grupo.mesas.first()

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_otro.id, "tipo": "SUPERIOR"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    # =========================================================================
    # ACTIVAR / DESACTIVAR MESA
    # =========================================================================

    def test_desactivar_mesa_marca_activa_false_y_replan_redistribuye(self):
        """Al desactivar Mesa 2 (INF), Mesa 1 (INF) absorbe la carga."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])
        modulos = [self.modulo]
        for i in range(2, 5):
            modulos.append(
                Modulo.objects.create(
                    nombre=f"M-0{i}", proyecto=self.project, planta=self.planta,
                    ancho_cm="15.00",
                )
            )
        self.modulo.ancho_cm = "15.00"
        self.modulo.save(update_fields=["ancho_cm"])
        for m in modulos:
            DetalleModuloFase.objects.create(
                modulo=m, fase="INFERIOR", espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo Desactivar")
        self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )

        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_2.id, "activa": False}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)

        mesa_inf_2.refresh_from_db()
        self.assertFalse(mesa_inf_2.activa)

        # Mesa 2 ya no tiene items (no anclada => todo redistribuido).
        self.assertEqual(
            mesa_inf_2.queue_items.filter(status__in=["EN_COLA", "MOSTRANDO"]).count(),
            0,
        )
        # Mesa 1 absorbe los 4 items INFERIOR.
        self.assertEqual(
            mesa_inf_1.queue_items.filter(status__in=["EN_COLA", "MOSTRANDO"]).count(),
            4,
        )

    def test_reactivar_mesa_la_devuelve_al_planner(self):
        """Reactivar una mesa la incluye de nuevo en la distribucion."""
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])
        modulos = [self.modulo]
        for i in range(2, 5):
            modulos.append(
                Modulo.objects.create(
                    nombre=f"M-0{i}", proyecto=self.project, planta=self.planta,
                    ancho_cm="15.00",
                )
            )
        self.modulo.ancho_cm = "15.00"
        self.modulo.save(update_fields=["ancho_cm"])
        for m in modulos:
            DetalleModuloFase.objects.create(
                modulo=m, fase="INFERIOR", espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo Reactivar")
        self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id}, format="json",
        )

        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        # Desactivar concentra todo en INF1.
        self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_2.id, "activa": False}]},
            format="json",
        )
        # Reactivar redistribuye.
        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa_inf_2.id, "activa": True}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)

        mesa_inf_2.refresh_from_db()
        self.assertTrue(mesa_inf_2.activa)

        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        # 4 modulos repartidos entre 2 INF: 2 + 2.
        self.assertEqual(
            mesa_inf_1.queue_items.filter(status__in=["EN_COLA", "MOSTRANDO"]).count(),
            2,
        )
        self.assertEqual(
            mesa_inf_2.queue_items.filter(status__in=["EN_COLA", "MOSTRANDO"]).count(),
            2,
        )

    def test_actualizar_mesas_combina_tipo_y_activa(self):
        """El endpoint unificado acepta cambios de tipo y activa juntos
        en una sola llamada y replanifica una sola vez."""
        grupo = self._crear_grupo("Grupo Combo")
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [
                {"mesa_id": mesa_inf_2.id, "tipo": "SUPERIOR", "activa": True},
                {"mesa_id": mesa_sup.id, "activa": False},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)

        mesa_inf_2.refresh_from_db()
        mesa_sup.refresh_from_db()
        self.assertEqual(mesa_inf_2.tipo, "SUPERIOR")
        self.assertTrue(mesa_inf_2.activa)
        self.assertFalse(mesa_sup.activa)

    def test_actualizar_mesas_rechaza_sin_cambios_efectivos(self):
        grupo = self._crear_grupo("Grupo Sin Cambios Combo")
        mesa = grupo.mesas.get(tipo="INFERIOR", indice=1)

        resp = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/actualizar-mesas/",
            {"cambios": [{"mesa_id": mesa.id, "tipo": "INFERIOR", "activa": True}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_import_technical_data_from_json_creates_phase_details(self):
        technical_file = SimpleUploadedFile(
            "detalles.json",
            json.dumps([
                {
                    "modulo": "M-01",
                    "ancho_cm": 18,
                    "fase": "INF",
                    "espesor_cm": 12,
                    "cantidad_cortes": 8,
                    "dificultad": 3.5,
                },
                {
                    "modulo": "M-01",
                    "fase": "SUP",
                    "espesor_cm": 10,
                    "cantidad_refuerzos": 5,
                }
            ]).encode("utf-8"),
            content_type="application/json",
        )

        response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-technical-data/",
            {"technical_file": technical_file},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["stats"]["created"], 2)
        self.modulo.refresh_from_db()
        self.assertEqual(str(self.modulo.ancho_cm), "18.00")
        self.assertEqual(DetalleModuloFase.objects.filter(modulo=self.modulo).count(), 2)

    def test_base_tecnica_adelantada_se_aplica_al_importar_modulo(self):
        technical_file = self._technical_db_file(
            "base_completa.db",
            [
                {
                    "nombre": "M-01",
                    "ancho": 18,
                    "cortes_inf": 2,
                    "cortes_sup": 1,
                },
                {
                    "nombre": "M-02",
                    "ancho": 21,
                    "tipo": "LADO LARGO",
                    "cortes_inf": 8,
                    "cortes_sup": 4,
                    "refuerzos_inf": 3,
                    "refuerzos_sup": 2,
                },
            ],
        )
        technical_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-technical-data/",
            {"technical_file": technical_file},
            format="multipart",
        )

        self.assertEqual(technical_response.status_code, 200)
        self.project.refresh_from_db()
        self.assertTrue(self.project.fichero_datos_tecnicos)

        import_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-structure/",
            {
                "plantas": json.dumps([{
                    "nombre": "General",
                    "orden": 2,
                    "modulos": [{"nombre": "M-02", "imagenes": []}],
                }]),
            },
            format="multipart",
        )

        self.assertEqual(import_response.status_code, 200)
        self.assertEqual(import_response.data["stats"]["detalles_fase"], 2)
        nuevo = Modulo.objects.get(proyecto=self.project, nombre="M-02")
        self.assertEqual(str(nuevo.ancho_cm), "21.00")
        self.assertEqual(nuevo.tipo_modulo, "LADO_LARGO")
        self.assertEqual(nuevo.detalles_fase.count(), 2)
        inferior = nuevo.detalles_fase.get(fase="INFERIOR")
        self.assertEqual(inferior.cantidad_cortes, 8)
        self.assertGreater(inferior.dificultad_calculada, 0)
        self.assertIsNotNone(nuevo.grupo_bastidor_id)

    def test_nueva_base_actualiza_datos_sin_reconstruir_bastidores(self):
        first_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-technical-data/",
            {
                "technical_file": self._technical_db_file(
                    "base_v1.db",
                    [{"nombre": "M-01", "ancho": 18, "cortes_inf": 2}],
                ),
            },
            format="multipart",
        )
        self.assertEqual(first_response.status_code, 200)
        self.modulo.refresh_from_db()
        original_group_id = self.modulo.grupo_bastidor_id
        original_group_count = self.project.grupos_bastidor.count()
        self.project.refresh_from_db()
        original_source_path = Path(
            self.project.fichero_datos_tecnicos.path
        )

        with self.captureOnCommitCallbacks(execute=True):
            update_response = self.client.post(
                f"/api/proyectos/{self.project.id}/import-technical-data/",
                {
                    "technical_file": self._technical_db_file(
                        "base_v2.db",
                        [{
                            "nombre": "M-01",
                            "ancho": 23,
                            "cortes_inf": 9,
                            "refuerzos_inf": 4,
                        }],
                    ),
                },
                format="multipart",
            )

        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.data["stats"]["grupos_bastidor"], 0)
        self.assertTrue(update_response.data["stats"]["base_actualizada"])
        self.modulo.refresh_from_db()
        self.project.refresh_from_db()
        inferior = self.modulo.detalles_fase.get(fase="INFERIOR")
        self.assertEqual(str(self.modulo.ancho_cm), "23.00")
        self.assertEqual(inferior.cantidad_cortes, 9)
        self.assertEqual(self.modulo.grupo_bastidor_id, original_group_id)
        self.assertEqual(
            self.project.grupos_bastidor.count(),
            original_group_count,
        )
        self.assertFalse(original_source_path.exists())
        self.assertTrue(Path(self.project.fichero_datos_tecnicos.path).exists())

    def test_importacion_con_base_nueva_usa_la_nueva_version(self):
        first_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-technical-data/",
            {
                "technical_file": self._technical_db_file(
                    "base_anterior.db",
                    [
                        {"nombre": "M-01", "ancho": 18},
                        {"nombre": "M-02", "ancho": 11},
                    ],
                ),
            },
            format="multipart",
        )
        self.assertEqual(first_response.status_code, 200)

        import_response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-structure/",
            {
                "plantas": json.dumps([{
                    "nombre": "General",
                    "orden": 2,
                    "modulos": [{"nombre": "M-02", "imagenes": []}],
                }]),
                "technical_file": self._technical_db_file(
                    "base_nueva.db",
                    [
                        {"nombre": "M-01", "ancho": 18},
                        {
                            "nombre": "M-02",
                            "ancho": 27,
                            "cortes_inf": 7,
                            "cortes_sup": 5,
                        },
                    ],
                ),
            },
            format="multipart",
        )

        self.assertEqual(import_response.status_code, 200)
        self.assertTrue(
            import_response.data["stats"]["base_tecnica_actualizada"]
        )
        nuevo = Modulo.objects.get(proyecto=self.project, nombre="M-02")
        self.assertEqual(str(nuevo.ancho_cm), "27.00")
        self.assertEqual(
            nuevo.detalles_fase.get(fase="INFERIOR").cantidad_cortes,
            7,
        )
        self.project.refresh_from_db()
        self.assertEqual(
            os.path.basename(self.project.fichero_datos_tecnicos.name),
            "base_nueva.db",
        )

    def test_import_technical_data_from_csv_prefixed_columns(self):
        csv_content = (
            "planta,modulo,inf_espesor_cm,inf_cantidad_cortes,sup_espesor_cm,sup_cantidad_refuerzos\n"
            "P1,M-01,14,6,11,4\n"
        )
        technical_file = SimpleUploadedFile(
            "detalles.csv",
            csv_content.encode("utf-8"),
            content_type="text/csv",
        )

        response = self.client.post(
            f"/api/proyectos/{self.project.id}/import-technical-data/",
            {"technical_file": technical_file},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["stats"]["created"], 2)
        inferior = DetalleModuloFase.objects.get(modulo=self.modulo, fase="INFERIOR")
        superior = DetalleModuloFase.objects.get(modulo=self.modulo, fase="SUPERIOR")
        self.assertEqual(str(inferior.espesor_cm), "14.00")
        self.assertEqual(superior.cantidad_refuerzos, 4)

    def test_import_technical_data_from_sqlite_db_uses_default_width_when_missing(self):
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as temp_file:
                temp_path = temp_file.name

            connection = sqlite3.connect(temp_path)
            cursor = connection.cursor()
            cursor.execute(
                """
                CREATE TABLE resumen (
                    id INTEGER PRIMARY KEY,
                    nombre_modulo TEXT,
                    peso_mallazo_pedido_inf REAL,
                    peso_mallazo_pedido_sup REAL,
                    peso_mallazo_desperdicio_inf REAL,
                    peso_mallazo_desperdicio_sup REAL,
                    peso_mallazo_recortado_inf REAL,
                    peso_mallazo_recortado_sup REAL,
                    numero_cortes_mallazo INTEGER,
                    cantidad_refuerzos_sup INTEGER,
                    peso_refuerzos_sup REAL,
                    cantidad_refuerzos_inf INTEGER,
                    peso_refuerzos_inf REAL,
                    cantidad_zunchos INTEGER,
                    peso_zunchos REAL,
                    cantidad_punzonamientos INTEGER,
                    peso_punzonamientos REAL,
                    cantidad_separadores INTEGER,
                    peso_separadores REAL
                )
                """
            )
            cursor.execute(
                """
                INSERT INTO resumen (
                    id, nombre_modulo,
                    peso_mallazo_pedido_inf, peso_mallazo_pedido_sup,
                    peso_mallazo_desperdicio_inf, peso_mallazo_desperdicio_sup,
                    peso_mallazo_recortado_inf, peso_mallazo_recortado_sup,
                    numero_cortes_mallazo,
                    cantidad_refuerzos_sup, peso_refuerzos_sup,
                    cantidad_refuerzos_inf, peso_refuerzos_inf,
                    cantidad_zunchos, peso_zunchos,
                    cantidad_punzonamientos, peso_punzonamientos,
                    cantidad_separadores, peso_separadores
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    1, "M-01",
                    20.5, 18.25,
                    1.1, 0.8,
                    19.4, 17.45,
                    9,
                    4, 6.5,
                    3, 5.75,
                    2, 1.2,
                    1, 0.7,
                    5, 2.1,
                ),
            )
            connection.commit()
            connection.close()

            with open(temp_path, "rb") as db_file:
                technical_file = SimpleUploadedFile(
                    "resumen_modulos.db",
                    db_file.read(),
                    content_type="application/octet-stream",
                )

            response = self.client.post(
                f"/api/proyectos/{self.project.id}/import-technical-data/",
                {"technical_file": technical_file},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["stats"]["created"], 2)

            self.modulo.refresh_from_db()
            self.assertEqual(str(self.modulo.ancho_cm), "17.00")

            inferior = DetalleModuloFase.objects.get(modulo=self.modulo, fase="INFERIOR")
            superior = DetalleModuloFase.objects.get(modulo=self.modulo, fase="SUPERIOR")
            self.assertEqual(str(inferior.peso_malla_inicial_kg), "20.50")
            self.assertEqual(str(superior.peso_malla_inicial_kg), "18.25")
            self.assertEqual(inferior.cantidad_cortes, 9)
            self.assertEqual(inferior.cantidad_refuerzos, 3)
            self.assertEqual(superior.cantidad_refuerzos, 4)
            self.assertEqual(inferior.cantidad_zunchos, 2)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)

    def test_lista_materiales_usa_tipos_de_mallazo_segun_tipo_modulo_y_fase(self):
        self.modulo.tipo_modulo = "CENTRAL"
        self.modulo.save(update_fields=["tipo_modulo"])

        modulo_largo = Modulo.objects.create(
            nombre="M-02",
            proyecto=self.project,
            planta=self.planta,
            tipo_modulo="LADO_LARGO",
        )
        modulo_corto = Modulo.objects.create(
            nombre="M-03",
            proyecto=self.project,
            planta=self.planta,
            tipo_modulo="LADO_CORTO",
        )
        modulo_esquina = Modulo.objects.create(
            nombre="M-04",
            proyecto=self.project,
            planta=self.planta,
            tipo_modulo="ESQUINA",
        )
        modulo_girado = Modulo.objects.create(
            nombre="M-05",
            proyecto=self.project,
            planta=self.planta,
            tipo_modulo="CENTRAL_GIRADO",
        )

        response = self.client.get(
            f"/api/proyectos/{self.project.id}/lista-materiales/"
        )

        self.assertEqual(response.status_code, 200)
        rows = {
            row["clave"]: row
            for row in response.data["renglones"]
        }

        self.assertEqual(rows["mallazo_tipo_1"]["etiqueta"], "Mallazo TIPO 1")
        self.assertEqual(rows["mallazo_tipo_1"]["total"], 5.0)
        self.assertEqual(rows["mallazo_tipo_1"]["pendiente"], 5.0)

        self.assertEqual(rows["mallazo_tipo_2"]["etiqueta"], "Mallazo TIPO 2")
        self.assertEqual(rows["mallazo_tipo_2"]["total"], 2.0)
        self.assertEqual(rows["mallazo_tipo_2"]["pendiente"], 2.0)

        self.assertEqual(rows["mallazo_tipo_6"]["etiqueta"], "Mallazo TIPO 6")
        self.assertEqual(rows["mallazo_tipo_6"]["total"], 1.0)
        self.assertEqual(rows["mallazo_tipo_6"]["pendiente"], 1.0)

        self.assertEqual(rows["mallazo_tipo_7"]["etiqueta"], "Mallazo TIPO 7")
        self.assertEqual(rows["mallazo_tipo_7"]["total"], 2.0)
        self.assertEqual(rows["mallazo_tipo_7"]["pendiente"], 2.0)

        self.assertNotIn("mallazo_inf", rows)
        self.assertNotIn("mallazo_sup", rows)

    def test_planificar_grupo_crea_colas_automaticas(self):
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        extra_modules = []
        for index in range(2, 5):
            modulo = Modulo.objects.create(
                nombre=f"M-0{index}",
                proyecto=self.project,
                planta=self.planta,
            )
            extra_modules.append(modulo)

        all_modules = [self.modulo, *extra_modules]
        for difficulty, modulo in enumerate(all_modules, start=1):
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="10.00",
                dificultad_fabricacion=str(difficulty),
            )

        grupo_response = self.client.post(
            "/api/grupos-mesas/",
            {
                "nombre": "Grupo Planificador",
                "usuario": self.user.id,
            },
            format="json",
        )
        self.assertEqual(grupo_response.status_code, 201)

        plan_response = self.client.post(
            f"/api/grupos-mesas/{grupo_response.data['id']}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )
        self.assertEqual(plan_response.status_code, 200)

        grupo = GrupoMesas.objects.get(id=grupo_response.data["id"])
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)

        inf_1_queue = list(MesaQueueItem.objects.filter(mesa=mesa_inf_1).order_by("position").values_list("modulo__nombre", flat=True))
        inf_2_queue = list(MesaQueueItem.objects.filter(mesa=mesa_inf_2).order_by("position").values_list("modulo__nombre", flat=True))
        sup_queue = list(MesaQueueItem.objects.filter(mesa=mesa_sup).order_by("position").values_list("modulo__nombre", flat=True))

        self.assertEqual(inf_1_queue, ["M-02", "M-01"])
        self.assertEqual(inf_2_queue, ["M-04", "M-03"])
        self.assertEqual(sup_queue, ["M-04", "M-02", "M-03", "M-01"])

    def test_planificar_grupo_usa_ancho_del_modulo_para_agrupacion(self):
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        self.modulo.ancho_cm = "12.00"
        self.modulo.save(update_fields=["ancho_cm"])

        modulo_b = Modulo.objects.create(
            nombre="M-02",
            proyecto=self.project,
            planta=self.planta,
            ancho_cm="12.00",
        )
        modulo_c = Modulo.objects.create(
            nombre="M-03",
            proyecto=self.project,
            planta=self.planta,
            ancho_cm="8.00",
        )

        for modulo in [self.modulo, modulo_b, modulo_c]:
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="1.00",
            )

        grupo_response = self.client.post(
            "/api/grupos-mesas/",
            {
                "nombre": "Grupo Anchura",
                "usuario": self.user.id,
            },
            format="json",
        )
        self.assertEqual(grupo_response.status_code, 201)

        plan_response = self.client.post(
            f"/api/grupos-mesas/{grupo_response.data['id']}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )
        self.assertEqual(plan_response.status_code, 200)

        grupo = GrupoMesas.objects.get(id=grupo_response.data["id"])
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        inf_1_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_1).order_by("position").values_list("modulo__nombre", flat=True)
        )
        inf_2_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_2).order_by("position").values_list("modulo__nombre", flat=True)
        )

        # Se respeta el orden natural de bastidores: M-01 entra primero,
        # y el bastidor M-02 + M-03 mantiene su unidad en la otra mesa.
        self.assertEqual(inf_1_queue, ["M-01"])
        self.assertEqual(inf_2_queue, ["M-03", "M-02"])

    def test_planificar_grupo_respeta_orden_manual_de_bastidores(self):
        from api.models import GrupoBastidor

        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        # Aislamos este caso del modulo base del setUp para que solo entren
        # los bastidores persistidos que simulan el orden visual del admin.
        self.modulo.cerrado = True
        self.modulo.save(update_fields=["cerrado"])

        grupo_1 = GrupoBastidor.objects.create(
            proyecto=self.project, indice=1, nombre="MOD Central",
        )
        grupo_2 = GrupoBastidor.objects.create(
            proyecto=self.project, indice=2, nombre="MOD Pilar",
        )
        grupo_3 = GrupoBastidor.objects.create(
            proyecto=self.project, indice=3, nombre="Grupo grande",
        )

        specs = [
            ("A05", grupo_1, 1),
            ("A01", grupo_2, 1),
            ("A02", grupo_3, 1),
            ("A03", grupo_3, 2),
            ("A04", grupo_3, 3),
        ]
        for nombre, grupo_bastidor, orden in specs:
            modulo = Modulo.objects.create(
                nombre=nombre,
                proyecto=self.project,
                planta=self.planta,
                ancho_cm="10.00",
                grupo_bastidor=grupo_bastidor,
                orden_intra=orden,
            )
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="10.00",
            )

        grupo = self._crear_grupo("Grupo Orden Manual")
        plan_response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )
        self.assertEqual(plan_response.status_code, 200)

        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        inf_1_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_1)
            .order_by("position")
            .values_list("modulo__nombre", flat=True)
        )
        inf_2_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_2)
            .order_by("position")
            .values_list("modulo__nombre", flat=True)
        )

        self.assertEqual(inf_1_queue, ["A05", "A04", "A03", "A02"])
        self.assertEqual(inf_2_queue, ["A01"])

    def test_planificar_grupo_conserva_grupo_iniciado_y_reemplaza_lo_pendiente(self):
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        modules_old = [self.modulo]
        for index in range(2, 5):
            modules_old.append(
                Modulo.objects.create(
                    nombre=f"M-0{index}",
                    proyecto=self.project,
                    planta=self.planta,
                    ancho_cm="10.00",
                )
            )

        self.modulo.ancho_cm = "10.00"
        self.modulo.save(update_fields=["ancho_cm"])

        for modulo in modules_old:
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="10.00",
            )

        grupo_response = self.client.post(
            "/api/grupos-mesas/",
            {
                "nombre": "Grupo Replan",
                "usuario": self.user.id,
            },
            format="json",
        )
        self.assertEqual(grupo_response.status_code, 201)

        first_plan = self.client.post(
            f"/api/grupos-mesas/{grupo_response.data['id']}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )
        self.assertEqual(first_plan.status_code, 200)

        completed_module = Modulo.objects.get(nombre="M-02", proyecto=self.project)
        completed_module.inferior_hecho = True
        completed_module.superior_hecho = True
        completed_module.actualizar_estado()

        proyecto_nuevo = Proyecto.objects.create(nombre="Proyecto Nuevo", usuario=self.user, bastidor_longitud_cm=20)
        planta_nueva = Planta.objects.create(nombre="P2", proyecto=proyecto_nuevo, orden=1)
        nuevo_1 = Modulo.objects.create(nombre="N-01", proyecto=proyecto_nuevo, planta=planta_nueva, ancho_cm="10.00")
        nuevo_2 = Modulo.objects.create(nombre="N-02", proyecto=proyecto_nuevo, planta=planta_nueva, ancho_cm="10.00")
        for modulo in [nuevo_1, nuevo_2]:
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="10.00",
            )

        second_plan = self.client.post(
            f"/api/grupos-mesas/{grupo_response.data['id']}/planificar/",
            {"proyecto_id": proyecto_nuevo.id},
            format="json",
        )
        self.assertEqual(second_plan.status_code, 200)

        grupo = GrupoMesas.objects.get(id=grupo_response.data["id"])
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)

        inf_1_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_1, status__in=["EN_COLA", "MOSTRANDO"])
            .order_by("position")
            .values_list("modulo__nombre", flat=True)
        )
        inf_2_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_2, status__in=["EN_COLA", "MOSTRANDO"])
            .order_by("position")
            .values_list("modulo__nombre", flat=True)
        )

        # En el destructive del original (pos 0 del cola) M-02 conserva
        # su bastidor (M-01 va con el), M-03/M-04 se replanifican a INF2.
        # En el append del nuevo (pos 1) ambas mesas tienen carga 2 -> el
        # tie-break va a la mesa de menor indice (INF1).
        self.assertEqual(inf_1_queue, ["M-02", "M-01", "N-02", "N-01"])
        self.assertEqual(inf_2_queue, ["M-04", "M-03"])

    def test_planificar_grupo_ignora_fases_activas_en_otro_grupo(self):
        self.project.bastidor_longitud_cm = 20
        self.project.save(update_fields=["bastidor_longitud_cm"])

        modules = [self.modulo]
        for index in range(2, 5):
            modules.append(
                Modulo.objects.create(
                    nombre=f"M-0{index}",
                    proyecto=self.project,
                    planta=self.planta,
                    ancho_cm="10.00",
                )
            )

        self.modulo.ancho_cm = "10.00"
        self.modulo.save(update_fields=["ancho_cm"])

        for modulo in modules:
            DetalleModuloFase.objects.create(
                modulo=modulo,
                fase="INFERIOR",
                espesor_cm="10.00",
            )

        grupo_1 = self.client.post(
            "/api/grupos-mesas/",
            {"nombre": "Grupo Uno", "usuario": self.user.id},
            format="json",
        )
        grupo_2 = self.client.post(
            "/api/grupos-mesas/",
            {"nombre": "Grupo Dos", "usuario": self.user.id},
            format="json",
        )

        self.assertEqual(grupo_1.status_code, 201)
        self.assertEqual(grupo_2.status_code, 201)

        first_plan = self.client.post(
            f"/api/grupos-mesas/{grupo_1.data['id']}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )
        second_plan = self.client.post(
            f"/api/grupos-mesas/{grupo_2.data['id']}/planificar/",
            {"proyecto_id": self.project.id},
            format="json",
        )

        self.assertEqual(first_plan.status_code, 200)
        self.assertEqual(second_plan.status_code, 200)

        grupo = GrupoMesas.objects.get(id=grupo_2.data["id"])
        mesa_inf_1 = grupo.mesas.get(tipo="INFERIOR", indice=1)
        mesa_inf_2 = grupo.mesas.get(tipo="INFERIOR", indice=2)
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR", indice=3)

        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_inf_1, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_inf_2, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_sup, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
