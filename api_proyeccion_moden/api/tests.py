import hashlib
import json
import os
import sqlite3
import tempfile
from datetime import timedelta

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.models import (
    Imagen, Mesa, MesaQueueItem, Modulo, Planta, Proyecto,
    DetalleModuloFase, GrupoMesas
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
class PlanningFoundationTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="planning_user", password="pass123")
        self.token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")

        self.project = Proyecto.objects.create(nombre="Proyecto Plan", usuario=self.user)
        self.planta = Planta.objects.create(nombre="P1", proyecto=self.project, orden=1)
        self.modulo = Modulo.objects.create(nombre="M-01", proyecto=self.project, planta=self.planta)

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
        roles = set(grupo.mesas.values_list("rol", flat=True))

        self.assertEqual(grupo.mesas.count(), 3)
        self.assertSetEqual(roles, {"INFERIOR_1", "INFERIOR_2", "SUPERIORES"})

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

    def test_add_mesa_inferior_asigna_siguiente_indice_libre(self):
        grupo = self._crear_grupo("Grupo INF Extra")

        response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "INFERIOR"},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["tipo"], "INFERIOR")
        self.assertEqual(response.data["indice"], 3)
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
        self.assertEqual(response.data["indice"], 2)

    def test_add_mesa_rechaza_tipo_invalido(self):
        grupo = self._crear_grupo("Grupo Tipo Invalido")

        response = self.client.post(
            f"/api/grupos-mesas/{grupo.id}/mesas/",
            {"tipo": "XYZ"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_destroy_mesa_rechaza_la_unica_superior_del_grupo(self):
        grupo = self._crear_grupo("Grupo Unica SUP")
        mesa_sup = grupo.mesas.get(tipo="SUPERIOR")

        response = self.client.delete(f"/api/mesas/{mesa_sup.id}/")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(Mesa.objects.filter(id=mesa_sup.id).exists())

    def test_destroy_mesa_permite_borrar_si_hay_otra_del_mismo_tipo(self):
        grupo = self._crear_grupo("Grupo Dos INF")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Mesa.objects.filter(id=mesa_inf_2.id).exists())
        self.assertEqual(grupo.mesas.filter(tipo="INFERIOR").count(), 1)

    def test_destroy_mesa_rechaza_si_tiene_device_sin_force(self):
        grupo = self._crear_grupo("Grupo Device")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")
        mesa_inf_2.device_token_hash = "x" * 64
        mesa_inf_2.save(update_fields=["device_token_hash"])

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.data.get("device_vinculado"))
        self.assertTrue(Mesa.objects.filter(id=mesa_inf_2.id).exists())

    def test_destroy_mesa_con_force_borra_aunque_tenga_device(self):
        grupo = self._crear_grupo("Grupo Device Force")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")
        mesa_inf_2.device_token_hash = "y" * 64
        mesa_inf_2.save(update_fields=["device_token_hash"])

        response = self.client.delete(f"/api/mesas/{mesa_inf_2.id}/?force=true")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Mesa.objects.filter(id=mesa_inf_2.id).exists())

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
        mesa_inf_1 = grupo.mesas.get(rol="INFERIOR_1")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")
        mesa_sup = grupo.mesas.get(rol="SUPERIORES")

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
        mesa_inf_1 = grupo.mesas.get(rol="INFERIOR_1")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")

        inf_1_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_1).order_by("position").values_list("modulo__nombre", flat=True)
        )
        inf_2_queue = list(
            MesaQueueItem.objects.filter(mesa=mesa_inf_2).order_by("position").values_list("modulo__nombre", flat=True)
        )

        self.assertEqual(inf_1_queue, ["M-01"])
        self.assertEqual(inf_2_queue, ["M-03", "M-02"])

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
        mesa_inf_1 = grupo.mesas.get(rol="INFERIOR_1")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")

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

        self.assertEqual(inf_1_queue, ["M-02", "M-01"])
        self.assertEqual(inf_2_queue, ["N-02", "N-01"])

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
        mesa_inf_1 = grupo.mesas.get(rol="INFERIOR_1")
        mesa_inf_2 = grupo.mesas.get(rol="INFERIOR_2")
        mesa_sup = grupo.mesas.get(rol="SUPERIORES")

        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_inf_1, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_inf_2, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
        self.assertEqual(MesaQueueItem.objects.filter(mesa=mesa_sup, status__in=["EN_COLA", "MOSTRANDO"]).count(), 0)
