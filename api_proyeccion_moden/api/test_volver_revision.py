import hashlib
from datetime import timedelta

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from .models import (
    EventoFabricacion, GrupoMesas, GrupoMesasProyecto, Imagen, Mesa, MesaQueueItem, Modulo, Proyecto,
)


class VolverAlAnteriorYRevisionTests(APITestCase):
    def setUp(self):
        self.ferralla = User.objects.create_user('ferralla')
        self.grupo = GrupoMesas.objects.create(nombre='Línea 1', usuario=self.ferralla)
        self.mesa = Mesa.objects.create(nombre='Mesa 1', usuario=self.ferralla, grupo=self.grupo, tipo='INFERIOR')
        self.token = 'token-de-la-mesa'
        self.mesa.device_token_hash = hashlib.sha256(self.token.encode()).hexdigest()
        self.mesa.save(update_fields=['device_token_hash'])
        self.proyecto = Proyecto.objects.create(nombre='OBRA_P01', usuario=self.ferralla)
        GrupoMesasProyecto.objects.create(grupo_mesas=self.grupo, proyecto=self.proyecto, orden=0)
        self.a = Modulo.objects.create(nombre='A01', proyecto=self.proyecto)
        self.b = Modulo.objects.create(nombre='A02', proyecto=self.proyecto)
        self.items = {}
        for posicion, modulo in enumerate((self.a, self.b)):
            imagenes = [
                Imagen.objects.create(modulo=modulo, fase='INFERIOR', orden=orden, url=f'/media/{modulo.nombre}_{orden:02d}.png')
                for orden in range(1, 5)
            ]
            self.items[modulo.nombre] = MesaQueueItem.objects.create(
                mesa=self.mesa, modulo=modulo, fase='INFERIOR', imagen=imagenes[0], position=posicion,
                status='MOSTRANDO' if posicion == 0 else 'EN_COLA',
            )

    def _device(self, ruta, datos=None):
        return self.client.post(f'/api/device/{ruta}/', datos or {}, format='json', HTTP_AUTHORIZATION=f'Bearer {self.token}')

    def _estado(self):
        for item in self.items.values():
            item.refresh_from_db()
        self.mesa.refresh_from_db()
        return self.items['A01'].status, self.items['A02'].status, self.mesa.current_image_index

    def test_double_back_on_the_first_image_reopens_what_was_passed_by_mistake(self):
        self._device('set_index', {'index': 3})
        self.assertEqual(self._device('mark_done').status_code, 200)
        self.assertEqual(self._estado(), ('HECHO', 'MOSTRANDO', 0))

        respuesta = self._device('volver_anterior')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.assertEqual(respuesta.data['index'], 3)
        self.assertEqual(self._estado(), ('MOSTRANDO', 'EN_COLA', 3))
        self.a.refresh_from_db()
        self.assertFalse(self.a.inferior_hecho)
        self.assertIsNone(self.items['A01'].done_at)
        # El FIN se queda como senal; su tiempo vuelve a contar desde ahora.
        tipos = list(EventoFabricacion.objects.filter(item=self.items['A01']).values_list('tipo', 'paso'))
        self.assertEqual(tipos[-2:], [('FIN', None), ('INICIO', 3)])

        # Se termina otra vez y sale el siguiente donde estaba.
        self.assertEqual(self._device('mark_done').status_code, 200)
        self.assertEqual(self._estado(), ('HECHO', 'MOSTRANDO', 0))

    def test_not_once_the_next_one_has_moved_on(self):
        self._device('mark_done')
        self._device('set_index', {'index': 1})
        self._device('set_index', {'index': 0})
        respuesta = self._device('volver_anterior')
        self.assertEqual(respuesta.status_code, 409)
        self.assertEqual(respuesta.data['detail'], 'El módulo de ahora ya ha avanzado.')
        self.assertEqual(self._estado(), ('HECHO', 'MOSTRANDO', 0))
        # Ni sin nada terminado en la mesa.
        MesaQueueItem.objects.filter(status='HECHO').update(status='EN_COLA', done_at=None)
        self.mesa.current_image_index = 0
        self.mesa.save()
        self.assertEqual(self._device('volver_anterior').status_code, 409)

    def test_a_finished_project_goes_back_to_the_head_of_its_queue(self):
        # A01 es el ultimo que le faltaba al proyecto (la superior ya estaba).
        Modulo.objects.filter(pk=self.b.pk).update(inferior_hecho=True, superior_hecho=True, estado='COMPLETADO')
        Modulo.objects.filter(pk=self.a.pk).update(superior_hecho=True)
        self.items['A02'].delete()
        del self.items['A02']
        otro = Proyecto.objects.create(nombre='OBRA_P02', usuario=self.ferralla)
        GrupoMesasProyecto.objects.create(grupo_mesas=self.grupo, proyecto=otro, orden=1)
        self._device('mark_done')
        self.assertEqual(list(self.grupo.proyectos_cola.values_list('proyecto_id', flat=True)), [otro.id])
        self.a.refresh_from_db()
        self.assertEqual(self.a.estado, 'COMPLETADO')

        self.assertEqual(self._device('volver_anterior').status_code, 200)
        self.assertEqual(
            list(self.grupo.proyectos_cola.order_by('orden').values_list('proyecto_id', flat=True)), [self.proyecto.id, otro.id],
        )
        self.grupo.refresh_from_db()
        self.assertEqual(self.grupo.proyecto_actual_id, self.proyecto.id)
        self.a.refresh_from_db()
        self.assertEqual((self.a.estado, self.a.completado_at), ('EN_PROGRESO', None))

    def test_the_supervisor_review_keeps_its_time(self):
        self._device('set_index', {'index': 1})
        item = self.items['A01']
        item.refresh_from_db()
        self.assertIsNone(item.revisado_at)
        self.assertEqual(self._device('set_index', {'index': 2, 'revision': True}).status_code, 200)
        item.refresh_from_db()
        self.assertIsNotNone(item.revisado_at)
        # Desde el visor del supervisor en el dashboard, igual.
        self.client.force_authenticate(self.ferralla)
        # Atras a mano: en Windows dos peticiones seguidas pueden dar la misma hora.
        anterior = item.revisado_at - timedelta(seconds=1)
        MesaQueueItem.objects.filter(pk=item.pk).update(revisado_at=anterior)
        respuesta = self.client.post(f'/api/mesas/{self.mesa.id}/set_index/', {'index': 3, 'revision': True}, format='json')
        self.assertEqual(respuesta.status_code, 200)
        item.refresh_from_db()
        self.assertGreater(item.revisado_at, anterior)
