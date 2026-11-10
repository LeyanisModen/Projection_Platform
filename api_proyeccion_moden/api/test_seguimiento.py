from datetime import date, datetime, timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (
    DetalleModuloFase, EventoFabricacion, FotoFabricacion, Mesa, MesaQueueItem, MesaQueueStatus, Modulo, PausaMesa,
    Proyecto, UserProfile,
)
from .seguimiento import ahora_de


def aware(*args):
    return timezone.make_aware(datetime(*args))


MANANA = {'nombre': 'Mañana', 'activo': True,
          'horario': {day: ['06:00', '16:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}


def terminado(proyecto, nombre, at, kilos=500):
    modulo = Modulo.objects.create(nombre=nombre, proyecto=proyecto, estado='COMPLETADO', completado_at=at)
    DetalleModuloFase.objects.create(modulo=modulo, fase='INFERIOR', peso_malla_final_kg=kilos, cantidad_cortes=3)
    return modulo


class EstadisticasDeUnaFerrallaParaLaOficinaTests(APITestCase):
    """Lunes 28/09/2026: la oficina pide las estadisticas de una ferralla con ?usuario=."""

    def setUp(self):
        self.oficina = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla-a', first_name='Ferralla A')
        UserProfile.objects.create(user=self.ferralla, turnos=[MANANA])
        self.otra = User.objects.create_user('ferralla-b')
        UserProfile.objects.create(user=self.otra, turnos=[MANANA])
        obra = Proyecto.objects.create(nombre='Obra A', usuario=self.ferralla, fecha_montaje=date(2026, 10, 30))
        Modulo.objects.create(nombre='A-pendiente', proyecto=obra)
        terminado(obra, 'A1', aware(2026, 9, 28, 9))
        terminado(obra, 'A2', aware(2026, 9, 28, 11), kilos=700)
        mesa = Mesa.objects.create(nombre='Mesa 1', usuario=self.ferralla, tipo='INFERIOR', indice=1)
        item = MesaQueueItem.objects.create(modulo=Modulo.objects.get(nombre='A1'), mesa=mesa, fase='INFERIOR',
                                            status=MesaQueueStatus.HECHO, done_at=aware(2026, 9, 28, 9))
        for minuto in (0, 15, 30, 45):
            EventoFabricacion.objects.create(item=item, mesa=mesa, modulo=item.modulo, fase='INFERIOR',
                                             tipo='PASO', at=aware(2026, 9, 28, 8, minuto))
        # Lo que la ferralla no ve: un proyecto en estudio. Y lo de otra ferralla.
        estudio = Proyecto.objects.create(nombre='Estudio A', usuario=self.ferralla, fantasma=True,
                                          fecha_montaje=date(2026, 10, 20), modulos_previstos=40)
        terminado(estudio, 'E1', aware(2026, 9, 28, 10))
        terminado(Proyecto.objects.create(nombre='Obra B', usuario=self.otra), 'B1', aware(2026, 9, 28, 10))

    def _stats(self, user, **params):
        self.client.force_authenticate(user)
        return self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28', **params})

    def test_la_oficina_ve_lo_mismo_que_la_ferralla(self):
        suya = self._stats(self.ferralla).data
        oficina = self._stats(self.oficina, usuario=self.ferralla.id).data
        self.assertEqual(oficina, suya)
        self.assertEqual(oficina['totals']['modulos_completados'], 2)
        self.assertEqual(oficina['totals']['peso_total_kg'], 1200.0)
        self.assertEqual({m['nombre'] for m in oficina['modulos']}, {'A1', 'A2'})
        # Con su horario: el turno de 10 h y el trabajo de las mesas.
        self.assertEqual(oficina['totals']['horas_productivas'], 10.0)
        self.assertGreater(oficina['totals']['horas_trabajo'], 0)
        self.assertEqual(oficina['turnos'], [{'indice': 0, 'nombre': 'Mañana'}])

    def test_sin_usuario_la_oficina_sigue_viendo_todas(self):
        nombres = {m['nombre'] for m in self._stats(self.oficina).data['modulos']}
        self.assertTrue({'A1', 'A2', 'B1'} <= nombres)

    def test_una_ferralla_no_puede_mirar_otra(self):
        self.assertEqual(self._stats(self.ferralla, usuario=self.otra.id).data, self._stats(self.ferralla).data)

    def test_una_ferralla_que_no_existe_no_da_las_de_todas(self):
        self.assertEqual(self._stats(self.oficina, usuario=999999).status_code, 404)
        self.assertEqual(self._stats(self.oficina, usuario=self.oficina.id).status_code, 404)
        self.assertEqual(self._stats(self.oficina, usuario='abc').status_code, 404)


class AhoraDeUnaFerrallaTests(APITestCase):
    """Lunes 28/09/2026 a las 10:00, turno de 06:00 a 16:00, dos inferiores y una superior."""

    AHORA = aware(2026, 9, 28, 10)

    def setUp(self):
        self.ferralla = User.objects.create_user('ferralla-ahora', first_name='Sanchos')
        UserProfile.objects.create(user=self.ferralla, turnos=[MANANA])
        self.mesa1 = Mesa.objects.create(nombre='Mesa 1', usuario=self.ferralla, tipo='INFERIOR', indice=1)
        self.mesa2 = Mesa.objects.create(nombre='Mesa 2', usuario=self.ferralla, tipo='INFERIOR', indice=2)
        self.mesa3 = Mesa.objects.create(nombre='Mesa 3', usuario=self.ferralla, tipo='SUPERIOR', indice=1)
        # Una mesa apagada no cuenta.
        Mesa.objects.create(nombre='Vieja', usuario=self.ferralla, tipo='INFERIOR', indice=3, activa=False)
        self.obra = Proyecto.objects.create(nombre='OBRA_P01', usuario=self.ferralla, fecha_montaje=date(2026, 10, 30))
        self.otra = Proyecto.objects.create(nombre='OBRA_P02', usuario=self.ferralla)
        for indice in range(4):
            if indice == 0:
                terminado(self.obra, 'P01-0', aware(2026, 9, 25, 12))
            else:
                Modulo.objects.create(nombre=f'P01-{indice}', proyecto=self.obra)
        Modulo.objects.create(nombre='P02-0', proyecto=self.otra)

    def _item(self, mesa, modulo, status=MesaQueueStatus.MOSTRANDO, **campos):
        return MesaQueueItem.objects.create(mesa=mesa, modulo=Modulo.objects.get(nombre=modulo),
                                            fase='SUPERIOR' if mesa.tipo == 'SUPERIOR' else 'INFERIOR', status=status, **campos)

    def _paso(self, item, at):
        EventoFabricacion.objects.create(item=item, mesa=item.mesa, modulo=item.modulo, fase=item.fase, tipo='PASO', at=at)

    def test_trabaja_la_mesa_con_una_senal_de_hace_menos_de_20_minutos(self):
        self._paso(self._item(self.mesa1, 'P01-1'), self.AHORA - timedelta(minutes=5))
        self._paso(self._item(self.mesa2, 'P01-2'), self.AHORA - timedelta(minutes=30))
        datos = ahora_de(self.ferralla, self.AHORA)
        self.assertEqual((datos['mesas'], datos['mesas_trabajando'], datos['mesas_en_pausa']), (3, 1, 0))
        self.assertEqual(datos['ultima_senal'], timezone.localtime(self.AHORA - timedelta(minutes=5)).isoformat())
        self.assertEqual(datos['turno'], {
            'nombre': 'Mañana', 'inicio': '2026-09-28T06:00:00+02:00', 'fin': '2026-09-28T16:00:00+02:00',
        })
        # Una foto vale 45 minutos (las mesas que solo tienen camara).
        foto = FotoFabricacion.objects.create(mesa=self.mesa3, modulo=Modulo.objects.get(nombre='P01-3'), fase='SUPERIOR', paso=1)
        FotoFabricacion.objects.filter(pk=foto.pk).update(capturada_at=self.AHORA - timedelta(minutes=30))
        self.assertEqual(ahora_de(self.ferralla, self.AHORA)['mesas_trabajando'], 2)

    def test_parados_en_turno_y_fuera_de_turno(self):
        hecho = self._item(self.mesa1, 'P01-1', status=MesaQueueStatus.HECHO, done_at=aware(2026, 9, 28, 9, 38))
        self._paso(hecho, aware(2026, 9, 28, 9, 30))
        datos = ahora_de(self.ferralla, self.AHORA)
        self.assertEqual(datos['mesas_trabajando'], 0)
        self.assertEqual(datos['ultima_senal'], '2026-09-28T09:38:00+02:00')
        self.assertEqual(datos['turno']['nombre'], 'Mañana')
        # A las 18:00 ya no hay turno: el siguiente es el martes a las 06:00.
        tarde = ahora_de(self.ferralla, aware(2026, 9, 28, 18))
        self.assertIsNone(tarde['turno'])
        self.assertEqual(tarde['siguiente_turno']['inicio'], '2026-09-29T06:00:00+02:00')
        # El viernes por la tarde, el lunes.
        viernes = ahora_de(self.ferralla, aware(2026, 10, 2, 18))
        self.assertEqual(viernes['siguiente_turno']['inicio'], '2026-10-05T06:00:00+02:00')

    def test_en_las_mesas_los_proyectos_que_estan_mostrando(self):
        self._item(self.mesa1, 'P01-1')
        self._item(self.mesa2, 'P02-0')
        self._item(self.mesa3, 'P01-2')
        self._item(self.mesa3, 'P01-3', status=MesaQueueStatus.EN_COLA)
        datos = ahora_de(self.ferralla, self.AHORA)
        self.assertEqual(datos['en_mesa'], [
            {'id': self.obra.id, 'nombre': 'OBRA_P01', 'modulos': 4, 'terminados': 1, 'fecha_montaje': '2026-10-30'},
            {'id': self.otra.id, 'nombre': 'OBRA_P02', 'modulos': 1, 'terminados': 0, 'fecha_montaje': None},
        ])
        self.assertEqual(ahora_de(User.objects.create_user('sin-mesas'), self.AHORA)['en_mesa'], [])

    def test_las_mesas_en_pausa(self):
        PausaMesa.objects.create(mesa=self.mesa2, inicio=self.AHORA - timedelta(hours=1))
        PausaMesa.objects.create(mesa=self.mesa3, inicio=self.AHORA + timedelta(hours=1))
        self.assertEqual(ahora_de(self.ferralla, self.AHORA)['mesas_en_pausa'], 1)


class SeguimientoViewTests(APITestCase):
    def setUp(self):
        self.oficina = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla-vista', first_name='Sanchos')
        Mesa.objects.create(nombre='Mesa 1', usuario=self.ferralla, tipo='INFERIOR', indice=1)

    def test_solo_la_oficina_y_la_ferralla_se_elige(self):
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get('/api/seguimiento/').status_code, 403)
        self.client.force_authenticate(self.oficina)
        lista = self.client.get('/api/seguimiento/').data
        self.assertEqual(lista, {'ferrallas': [{'id': self.ferralla.id, 'nombre': 'Sanchos'}], 'ferralla': None})
        elegida = self.client.get('/api/seguimiento/', {'usuario': self.ferralla.id}).data
        self.assertEqual(elegida['ferralla'], {'id': self.ferralla.id, 'nombre': 'Sanchos'})
        self.assertEqual((elegida['mesas'], elegida['mesas_trabajando']), (1, 0))
        self.assertEqual(self.client.get('/api/seguimiento/', {'usuario': self.oficina.id}).status_code, 404)
