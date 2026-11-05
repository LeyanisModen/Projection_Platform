from datetime import date

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from .media_access import user_may_read
from .models import DetalleModuloFase, Edificio, GrupoBastidor, GrupoMesas, Modulo, Proyecto
from .planificacion_moden import planificacion_moden
from .planning import plan_ferralla

LUNES = date(2026, 11, 2)


def filas(respuesta):
    return respuesta.data['results'] if isinstance(respuesta.data, dict) else respuesta.data


class FantasmasTests(APITestCase):
    def setUp(self):
        self.oficina = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla', first_name='Ferralia')
        self.otra = User.objects.create_user('otra')
        aceptado = timezone.now()
        # Lo real: 8 modulos para el 12/11 y 4 para el 20/11.
        self.p1 = Proyecto.objects.create(
            nombre='OBRA_P01', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
            fecha_montaje=date(2026, 11, 10), fecha_montaje_obra=date(2026, 11, 12),
        )
        self.p2 = Proyecto.objects.create(
            nombre='OBRA_P02', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
            fecha_montaje=date(2026, 11, 20), fecha_montaje_obra=date(2026, 11, 20),
        )
        for indice in range(8):
            Modulo.objects.create(nombre=f'A{indice:02d}', proyecto=self.p1)
        for indice in range(4):
            Modulo.objects.create(nombre=f'B{indice:02d}', proyecto=self.p2)
        # Lo que Moden simula: 10 modulos mas para el 20/11, en un edificio solo suyo.
        self.edificio = Edificio.objects.create(nombre='TORRE_SECRETA', usuario=self.ferralla)
        self.fantasma = Proyecto.objects.create(
            nombre='TORRE_SECRETA_P01', usuario=self.ferralla, fantasma=True, edificio=self.edificio,
            fecha_montaje=date(2026, 11, 20), modulos_previstos=10,
        )
        bastidor = GrupoBastidor.objects.create(proyecto=self.fantasma, indice=1, nombre='Bastidor 1')
        self.modulo_fantasma = Modulo.objects.create(nombre='Z01', proyecto=self.fantasma, grupo_bastidor=bastidor)
        DetalleModuloFase.objects.create(modulo=self.modulo_fantasma, fase='INFERIOR', peso_malla_final_kg=500)

    def test_moden_sees_each_factory_with_and_without_its_ghosts(self):
        datos = planificacion_moden(LUNES)

        self.assertEqual(datos['hasta'], '2027-05-02')
        ferrallas = {f['ferralla']['nombre']: f for f in datos['ferrallas']}
        self.assertEqual(set(ferrallas), {'Ferralia'})
        ferralia = ferrallas['Ferralia']
        por_dia = {dia['fecha']: dia for dia in ferralia['dias']}
        # Lo real: 8 modulos en 8 dias y luego 4 en 6. Con el fantasma, los 22
        # que montan hasta el 20/11 en sus 14 dias laborables.
        self.assertEqual(por_dia['2026-11-02']['real'], 1.0)
        self.assertEqual(por_dia['2026-11-12']['real'], 0.7)
        self.assertEqual(por_dia['2026-11-02']['con_fantasmas'], 1.6)
        self.assertEqual(por_dia['2026-11-20']['con_fantasmas'], 0)
        resumen = ferralia['resumen']
        self.assertEqual((resumen['ritmo_real'], resumen['ritmo_con_fantasmas']), (1.0, 1.6))
        self.assertEqual((resumen['fantasmas'], resumen['modulos_real'], resumen['modulos_fantasmas']), (1, 12, 10))
        por_nombre = {fila['nombre']: fila for fila in ferralia['proyectos']}
        self.assertTrue(por_nombre['TORRE_SECRETA_P01']['fantasma'])
        self.assertFalse(por_nombre['OBRA_P01']['fantasma'])
        self.assertEqual(por_nombre['TORRE_SECRETA_P01']['modulos_pendientes'], 10)
        self.assertIn(
            {'proyecto': self.fantasma.id, 'nombre': 'TORRE_SECRETA_P01', 'fecha': '2026-11-20',
             'orientativa': True, 'fantasma': True, 'modulos_pendientes': 10},
            ferralia['entregas'],
        )

    def test_only_the_office_opens_moden_planning(self):
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get('/api/planificacion-moden/').status_code, 403)
        self.client.force_authenticate(self.oficina)
        respuesta = self.client.get('/api/planificacion-moden/')
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(len(respuesta.data['ferrallas']), 1)

    def test_a_ghost_does_not_exist_for_the_factory(self):
        self.client.force_authenticate(self.ferralla)
        for ruta in (
            '/api/proyectos/', f'/api/modulos/?proyecto={self.fantasma.id}', '/api/modulos/',
            f'/api/grupos-bastidor/?proyecto={self.fantasma.id}', '/api/detalle-modulo-fases/',
            '/api/edificios/', '/api/planificacion/',
        ):
            respuesta = self.client.get(ruta)
            self.assertEqual(respuesta.status_code, 200, ruta)
            cuerpo = respuesta.content.decode().replace(' ', '')
            self.assertNotIn('TORRE_SECRETA', cuerpo, ruta)
            self.assertNotIn(f'"proyecto":{self.fantasma.id},', cuerpo, ruta)
            self.assertNotIn(f'"modulo":{self.modulo_fantasma.id},', cuerpo, ruta)
        self.assertEqual(self.client.get(f'/api/proyectos/{self.fantasma.id}/').status_code, 404)
        self.assertEqual(self.client.get(f'/api/modulos/{self.modulo_fantasma.id}/').status_code, 404)
        self.assertEqual(self.client.post(f'/api/proyectos/{self.fantasma.id}/aceptar/').status_code, 404)
        self.assertFalse(user_may_read(self.ferralla, f'imagenes/{self.fantasma.id}/{self.modulo_fantasma.id}/01.png'))
        self.assertTrue(user_may_read(self.ferralla, f'imagenes/{self.p1.id}/1/01.png'))
        # Ni en su plan ni en su objetivo.
        self.assertNotIn(self.fantasma.id, plan_ferralla(self.ferralla.id, LUNES)['proyectos'])
        grupo = GrupoMesas.objects.create(nombre='Línea 1', usuario=self.ferralla)
        self.assertEqual(
            self.client.post(f'/api/grupos-mesas/{grupo.id}/cola/add/', {'proyecto': self.fantasma.id}, format='json').status_code,
            404,
        )
        self.client.force_authenticate(self.oficina)
        self.assertEqual(
            self.client.post(f'/api/grupos-mesas/{grupo.id}/cola/add/', {'proyecto': self.fantasma.id}, format='json').status_code,
            400,
        )

    def test_moden_creates_a_ghost_and_later_makes_it_real(self):
        self.client.force_authenticate(self.oficina)
        sin_ferralla = self.client.post('/api/proyectos/', {'nombre': 'PRUEBA', 'fantasma': True}, format='json')
        self.assertEqual(sin_ferralla.status_code, 400)
        creado = self.client.post('/api/proyectos/', {
            'nombre': 'NUEVA_P01', 'fantasma': True, 'usuario': f'http://testserver/api/users/{self.ferralla.id}/',
            'fecha_montaje': '2026-12-10', 'modulos_previstos': 40,
        }, format='json')
        self.assertEqual(creado.status_code, 201, creado.data)
        self.assertTrue(creado.data['fantasma'])
        self.assertIsNone(creado.data['aceptado_por_ferralla_at'])
        # El suyo en la lista de Moden, con su plan entre los fantasmas.
        self.assertEqual(creado.data['planificacion']['estado'], 'PLANIFICADO')
        nuevo = creado.data['id']

        self.client.force_authenticate(self.ferralla)
        self.assertNotIn(nuevo, [p['id'] for p in filas(self.client.get('/api/proyectos/'))])

        self.client.force_authenticate(self.oficina)
        real = self.client.patch(f'/api/proyectos/{nuevo}/', {'fantasma': False}, format='json')
        self.assertEqual(real.status_code, 200, real.data)
        # Le llega como cualquier proyecto nuevo: pendiente de aceptar.
        self.client.force_authenticate(self.ferralla)
        suyo = [p for p in filas(self.client.get('/api/proyectos/')) if p['id'] == nuevo]
        self.assertEqual(len(suyo), 1)
        self.assertIsNone(suyo[0]['aceptado_por_ferralla_at'])
        self.assertEqual(self.client.post(f'/api/proyectos/{nuevo}/aceptar/').status_code, 200)

        # Aceptado ya es suyo: no vuelve a fantasma, y la ferralla nunca toca el estado.
        self.client.force_authenticate(self.oficina)
        self.assertEqual(self.client.patch(f'/api/proyectos/{nuevo}/', {'fantasma': True}, format='json').status_code, 400)
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.patch(f'/api/proyectos/{self.p1.id}/', {'fantasma': True}, format='json').status_code, 400)
        self.assertFalse(Proyecto.objects.get(pk=self.p1.id).fantasma)

    def test_a_pending_project_can_go_back_to_ghost(self):
        pendiente = Proyecto.objects.create(nombre='OBRA_P03', usuario=self.ferralla, fecha_montaje=date(2026, 12, 1))
        self.client.force_authenticate(self.oficina)
        respuesta = self.client.patch(f'/api/proyectos/{pendiente.id}/', {'fantasma': True}, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get(f'/api/proyectos/{pendiente.id}/').status_code, 404)
