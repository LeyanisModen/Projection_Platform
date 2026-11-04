import hashlib
from datetime import datetime, time, timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import GrupoMesas, Mesa, MesaQueueItem, Modulo, PausaMesa, Proyecto
from .pausas import pausa_activa


def local(anio, mes, dia, hora, minuto=0):
    return timezone.make_aware(datetime(anio, mes, dia, hora, minuto))


class PausaActivaTests(APITestCase):
    def setUp(self):
        self.mesa = Mesa.objects.create(nombre='Mesa 1', usuario=User.objects.create_user('ferralla'))

    def test_una_vez_desde_ahora_hasta_una_hora_o_hasta_reanudarla(self):
        ahora = local(2026, 11, 5, 9)
        PausaMesa.objects.create(mesa=self.mesa, inicio=local(2026, 11, 5, 8), fin=local(2026, 11, 5, 11), motivo='Formación')
        self.assertEqual(pausa_activa(self.mesa, ahora)['hasta'], local(2026, 11, 5, 11).isoformat())
        self.assertEqual(pausa_activa(self.mesa, ahora)['motivo'], 'Formación')
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 5, 11)))
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 5, 7, 59)))
        # Sin fin manda sobre la que acaba antes.
        PausaMesa.objects.create(mesa=self.mesa, inicio=local(2026, 11, 5, 8))
        self.assertIsNone(pausa_activa(self.mesa, ahora)['hasta'])

    def test_cada_dia_de_una_hora_a_otra(self):
        PausaMesa.objects.create(
            mesa=self.mesa, tipo='DIARIA', inicio=local(2026, 11, 4, 20), hora_desde=time(13), hora_hasta=time(16),
        )
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 5, 12, 59)))
        self.assertEqual(pausa_activa(self.mesa, local(2026, 11, 5, 13))['hasta'], local(2026, 11, 5, 16).isoformat())
        self.assertIsNotNone(pausa_activa(self.mesa, local(2026, 11, 9, 15, 30)))
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 5, 16)))

    def test_cada_dia_cruzando_la_medianoche_y_hasta_que_se_quita(self):
        pausa = PausaMesa.objects.create(
            mesa=self.mesa, tipo='DIARIA', inicio=local(2026, 11, 4, 20), hora_desde=time(22), hora_hasta=time(2),
        )
        self.assertEqual(pausa_activa(self.mesa, local(2026, 11, 5, 23))['hasta'], local(2026, 11, 6, 2).isoformat())
        self.assertEqual(pausa_activa(self.mesa, local(2026, 11, 6, 1))['hasta'], local(2026, 11, 6, 2).isoformat())
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 6, 3)))
        pausa.fin = local(2026, 11, 7, 23, 30)
        pausa.save()
        self.assertEqual(pausa_activa(self.mesa, local(2026, 11, 7, 23))['hasta'], local(2026, 11, 7, 23, 30).isoformat())
        self.assertIsNone(pausa_activa(self.mesa, local(2026, 11, 8, 23)))


class PausaMesaApiTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla')
        grupo = GrupoMesas.objects.create(nombre='Línea 1', usuario=self.ferralla)
        self.mesas = [Mesa.objects.create(nombre=f'Mesa {i}', usuario=self.ferralla, grupo=grupo, indice=i) for i in (1, 2, 3)]
        self.mesa = self.mesas[0]
        self.token = 'token-de-la-mesa'
        self.mesa.device_token_hash = hashlib.sha256(self.token.encode()).hexdigest()
        self.mesa.save(update_fields=['device_token_hash'])
        proyecto = Proyecto.objects.create(nombre='OBRA', usuario=self.ferralla)
        self.item = MesaQueueItem.objects.create(
            mesa=self.mesa, modulo=Modulo.objects.create(nombre='A01', proyecto=proyecto),
            fase='INFERIOR', status='MOSTRANDO', position=0,
        )

    def _device(self, metodo, ruta, datos=None):
        return getattr(self.client, metodo)(f'/api/device/{ruta}/', datos or {}, format='json', HTTP_AUTHORIZATION=f'Bearer {self.token}')

    def _pausar(self, **datos):
        self.client.force_authenticate(self.admin)
        return self.client.post('/api/pausas-mesa/', {'mesas': [m.id for m in self.mesas[:2]], **datos}, format='json')

    def test_la_oficina_pausa_varias_mesas_y_la_mesa_no_avanza(self):
        respuesta = self._pausar(motivo='Formación')
        self.assertEqual(respuesta.status_code, 201, respuesta.data)
        self.assertEqual([p['mesa'] for p in respuesta.data], [self.mesas[0].id, self.mesas[1].id])
        self.assertTrue(all(p['activa'] for p in respuesta.data))

        self.client.force_authenticate(None)
        estado = self._device('get', 'state')
        self.assertEqual(estado.data['pausa']['motivo'], 'Formación')
        self.assertIsNone(estado.data['pausa']['hasta'])
        # Un player de antes, que no sabe de pausas, deja la mesa en negro.
        self.assertTrue(estado.data['blackout'])
        self.mesa.refresh_from_db()
        self.assertFalse(self.mesa.blackout)
        for metodo, ruta, datos in (('post', 'set_index', {'index': 3}), ('post', 'mark_done', {})):
            respuesta = self._device(metodo, ruta, datos)
            self.assertEqual(respuesta.status_code, 409, ruta)
            self.assertEqual(respuesta.data['detail'], 'Mesa en pausa.')
        self.mesa.refresh_from_db()
        self.item.refresh_from_db()
        self.assertEqual((self.mesa.current_image_index, self.item.status), (0, 'MOSTRANDO'))
        # La tercera sigue: es la de la formación.
        self.assertIsNone(pausa_activa(self.mesas[2]))

    def test_la_ferralla_no_la_quita_ni_avanza_desde_su_dashboard(self):
        pausa_id = self._pausar().data[0]['id']
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.post(f'/api/pausas-mesa/{pausa_id}/terminar/').status_code, 403)
        self.assertEqual(self.client.post('/api/pausas-mesa/', {'mesas': [self.mesas[2].id]}, format='json').status_code, 403)
        self.assertEqual(self.client.get('/api/pausas-mesa/').status_code, 403)
        for ruta in (f'/api/mesa-queue-items/{self.item.id}/marcar_hecho/', f'/api/mesa-queue-items/{self.item.id}/mark_done/',
                     f'/api/mesa-queue-items/{self.item.id}/mostrar/'):
            self.assertEqual(self.client.post(ruta).status_code, 409, ruta)
        self.assertEqual(self.client.post(f'/api/mesas/{self.mesa.id}/set_index/', {'index': 2}, format='json').status_code, 409)
        # Ni tocando la mesa: la pausa no es un campo suyo.
        self.client.patch(f'/api/mesas/{self.mesa.id}/', {'pausa': None, 'blackout': False}, format='json')
        self.assertIsNotNone(pausa_activa(self.mesa))
        self.assertIsNotNone(self.client.get(f'/api/mesas/{self.mesa.id}/').data['pausa'])
        self.item.refresh_from_db()
        self.assertEqual(self.item.status, 'MOSTRANDO')

    def test_reanudar_y_quitar_una_programada(self):
        activa = self._pausar().data[0]['id']
        mañana = timezone.now() + timedelta(days=1)
        programada = self._pausar(inicio=mañana.isoformat(), fin=(mañana + timedelta(hours=3)).isoformat()).data[0]
        self.assertFalse(programada['activa'])
        self.assertEqual(len(self.client.get(f'/api/pausas-mesa/?usuario={self.ferralla.id}').data), 4)

        self.assertEqual(self.client.post(f'/api/pausas-mesa/{activa}/terminar/').status_code, 204)
        self.assertIsNone(pausa_activa(self.mesa))
        self.assertIsNotNone(PausaMesa.objects.get(pk=activa).fin)
        self.assertEqual(self._device('post', 'set_index', {'index': 1}).status_code, 200)
        self.assertFalse(self._device('get', 'state').data['blackout'])
        # La programada que no ha empezado se borra: no queda nada que guardar.
        self.client.force_authenticate(self.admin)
        self.client.post(f'/api/pausas-mesa/{programada["id"]}/terminar/')
        self.assertFalse(PausaMesa.objects.filter(pk=programada['id']).exists())
        self.assertEqual(len(self.client.get(f'/api/pausas-mesa/?usuario={self.ferralla.id}').data), 2)

    def test_cada_dia_y_datos_que_no_valen(self):
        diaria = self._pausar(tipo='DIARIA', hora_desde='13:00', hora_hasta='16:00', motivo='Luz de las ventanas')
        self.assertEqual(diaria.status_code, 201, diaria.data)
        self.assertEqual((diaria.data[0]['hora_desde'], diaria.data[0]['hora_hasta']), ('13:00', '16:00'))
        self.assertEqual(self._pausar(tipo='DIARIA', hora_desde='13:00', hora_hasta='13:00').status_code, 400)
        self.assertEqual(self._pausar(fin=(timezone.now() - timedelta(minutes=5)).isoformat()).status_code, 400)
        self.assertEqual(self._pausar(tipo='OTRA').status_code, 400)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.post('/api/pausas-mesa/', {'mesas': [], 'tipo': 'PUNTUAL'}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/pausas-mesa/', {'mesas': [999]}, format='json').status_code, 400)
