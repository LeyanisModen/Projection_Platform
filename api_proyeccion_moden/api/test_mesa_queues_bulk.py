import hashlib
import secrets

from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.models import (
    GrupoMesas, Imagen, Mesa, MesaQueueItem, MesaQueueStatus, Modulo, Proyecto,
)


class MesaColasBulkTests(APITestCase):
    """GET /api/mesas/colas/ replaces one request per mesa from the dashboard."""

    def setUp(self):
        self.user = User.objects.create_user('ferralla', password='x')
        self.other = User.objects.create_user('otra', password='x')
        self.token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f'Token {self.token.key}')

        self.project = Proyecto.objects.create(nombre='P', usuario=self.user)
        grupo = GrupoMesas.objects.create(nombre='G', usuario=self.user)
        self.mesa_a = Mesa.objects.create(nombre='Mesa A', usuario=self.user, grupo=grupo, indice=1)
        self.mesa_b = Mesa.objects.create(nombre='Mesa B', usuario=self.user, grupo=grupo, indice=2)
        other_group = GrupoMesas.objects.create(nombre='Ajeno', usuario=self.other)
        self.mesa_other = Mesa.objects.create(nombre='Ajena', usuario=self.other, grupo=other_group, indice=1)

        self.modulo_1 = Modulo.objects.create(nombre='M-1', proyecto=self.project)
        self.modulo_2 = Modulo.objects.create(nombre='M-2', proyecto=self.project)
        self.imagen_1 = Imagen.objects.create(
            modulo=self.modulo_1, fase='INFERIOR', orden=1, url='/media/imagenes/1/1/m1.png', activo=True,
        )

    def _queue(self, mesa, modulo, position, status=MesaQueueStatus.EN_COLA, imagen=None):
        return MesaQueueItem.objects.create(
            mesa=mesa, modulo=modulo, fase='INFERIOR', status=status, position=position, imagen=imagen,
        )

    def test_returns_only_own_mesas_keyed_by_id(self):
        self._queue(self.mesa_a, self.modulo_1, 0, imagen=self.imagen_1)
        self._queue(self.mesa_other, self.modulo_2, 0)

        response = self.client.get('/api/mesas/colas/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), {str(self.mesa_a.id), str(self.mesa_b.id)})
        self.assertEqual(len(response.data[str(self.mesa_a.id)]), 1)
        self.assertEqual(response.data[str(self.mesa_b.id)], [])

    def test_ids_filter_and_same_shape_as_queue_items(self):
        self._queue(self.mesa_a, self.modulo_1, 0, status=MesaQueueStatus.MOSTRANDO, imagen=self.imagen_1)
        self._queue(self.mesa_a, self.modulo_2, 1)

        bulk = self.client.get(f'/api/mesas/colas/?ids={self.mesa_a.id}')
        single = self.client.get(f'/api/mesas/{self.mesa_a.id}/queue_items/')

        self.assertEqual(list(bulk.data), [str(self.mesa_a.id)])
        self.assertEqual(bulk.data[str(self.mesa_a.id)], single.data)

    def test_promotes_first_en_cola_when_nothing_is_showing(self):
        first = self._queue(self.mesa_a, self.modulo_1, 0, imagen=self.imagen_1)
        second = self._queue(self.mesa_a, self.modulo_2, 1)

        response = self.client.get('/api/mesas/colas/')

        statuses = {row['id']: row['status'] for row in response.data[str(self.mesa_a.id)]}
        self.assertEqual(statuses[first.id], MesaQueueStatus.MOSTRANDO)
        self.assertEqual(statuses[second.id], MesaQueueStatus.EN_COLA)
        self.mesa_a.refresh_from_db()
        self.assertEqual(self.mesa_a.imagen_actual_id, self.imagen_1.id)
        self.assertEqual(self.mesa_a.current_image_index, 0)

    def test_does_not_touch_a_mesa_that_is_already_showing(self):
        showing = self._queue(self.mesa_a, self.modulo_2, 1, status=MesaQueueStatus.MOSTRANDO)
        queued = self._queue(self.mesa_a, self.modulo_1, 0, imagen=self.imagen_1)
        self.mesa_a.current_image_index = 4
        self.mesa_a.save(update_fields=['current_image_index'])

        self.client.get('/api/mesas/colas/')

        showing.refresh_from_db()
        queued.refresh_from_db()
        self.mesa_a.refresh_from_db()
        self.assertEqual(showing.status, MesaQueueStatus.MOSTRANDO)
        self.assertEqual(queued.status, MesaQueueStatus.EN_COLA)
        self.assertEqual(self.mesa_a.current_image_index, 4)

    def test_player_current_item_promotes_when_idle(self):
        raw = secrets.token_urlsafe(32)
        self.mesa_a.device_token_hash = hashlib.sha256(raw.encode()).hexdigest()
        self.mesa_a.save(update_fields=['device_token_hash'])
        first = self._queue(self.mesa_a, self.modulo_1, 0, imagen=self.imagen_1)
        self.client.credentials()

        response = self.client.get('/api/device/current_item/', HTTP_AUTHORIZATION=f'Bearer {raw}')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['id'], first.id)
        self.assertEqual(response.data['status'], MesaQueueStatus.MOSTRANDO)
