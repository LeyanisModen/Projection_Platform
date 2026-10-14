from datetime import date, datetime
from importlib import import_module

from django.apps import apps
from django.contrib.auth.models import User
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .edificios import leer_nombre
from .models import Edificio, Modulo, PlantaTipo, Proyecto, orden_planta


class LeerNombreTests(SimpleTestCase):
    def test_obra_bloque_y_planta_segun_la_convencion_de_la_oficina(self):
        casos = {
            'ESNABIDE_27_PB': ('ESNABIDE_27', PlantaTipo.BAJA, None),
            'ESNABIDE_27_P1': ('ESNABIDE_27', PlantaTipo.PLANTA, 1),
            'RIPAGAINA108_BH_P02': ('RIPAGAINA108_BH', PlantaTipo.PLANTA, 2),
            'VALDEBEBAS946_B5_P10': ('VALDEBEBAS946_B5', PlantaTipo.PLANTA, 10),
            'VAL946_B1_PS2': ('VAL946_B1', PlantaTipo.SOTANO, 2),
            'VAL946_B1_PSS': ('VAL946_B1', PlantaTipo.SEMISOTANO, None),
            'VAL946_BA_PM': ('VAL946_BA', PlantaTipo.ENTREPLANTA, None),
            'VAL946_BA_PC': ('VAL946_BA', PlantaTipo.CUBIERTA, None),
        }
        for nombre, esperado in casos.items():
            self.assertEqual(leer_nombre(nombre), esperado, nombre)
        self.assertIsNone(leer_nombre('Test_presentaciones_monitor'))

    def test_de_abajo_arriba(self):
        plantas = [
            (PlantaTipo.CUBIERTA, None), (PlantaTipo.PLANTA, 2), (PlantaTipo.SOTANO, 1),
            (PlantaTipo.CASETON, None), (PlantaTipo.BAJA, None), (PlantaTipo.SOTANO, 2),
            (PlantaTipo.PLANTA, 10), (PlantaTipo.ENTREPLANTA, None), (PlantaTipo.SEMISOTANO, None),
            (None, None),
        ]
        ordenadas = sorted(plantas, key=lambda p: orden_planta(*p))
        self.assertEqual(ordenadas, [
            (PlantaTipo.SOTANO, 2), (PlantaTipo.SOTANO, 1), (PlantaTipo.SEMISOTANO, None),
            (PlantaTipo.BAJA, None), (PlantaTipo.ENTREPLANTA, None), (PlantaTipo.PLANTA, 2),
            (PlantaTipo.PLANTA, 10), (PlantaTipo.CUBIERTA, None), (PlantaTipo.CASETON, None),
            (None, None),
        ])


class EdificiosApiTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla')
        self.otra = User.objects.create_user('otra-ferralla')
        self.client.force_authenticate(self.admin)

    def _crear(self, nombre, usuario=None):
        usuario = usuario or self.ferralla
        respuesta = self.client.post('/api/proyectos/', {
            'nombre': nombre, 'usuario': f'http://testserver/api/users/{usuario.pk}/',
        }, format='json')
        self.assertEqual(respuesta.status_code, 201, respuesta.data)
        return Proyecto.objects.get(pk=respuesta.data['id'])

    def test_al_crear_un_forjado_va_a_su_edificio_y_planta_por_el_nombre(self):
        p1 = self._crear('OBRA1_BA_P1')
        pb = self._crear('OBRA1_BA_PB')
        s1 = self._crear('OBRA1_BA_PS1')
        otro_bloque = self._crear('OBRA1_BB_P1')
        self.assertEqual(p1.edificio.nombre, 'OBRA1_BA')
        self.assertEqual(p1.edificio_id, pb.edificio_id)
        self.assertEqual(p1.edificio_id, s1.edificio_id)
        self.assertNotEqual(p1.edificio_id, otro_bloque.edificio_id)
        self.assertEqual(Edificio.objects.filter(usuario=self.ferralla).count(), 2)
        datos = {p['nombre']: p for p in self.client.get('/api/proyectos/').data['results']}
        self.assertEqual(datos['OBRA1_BA_PB']['planta_etiqueta'], 'PB')
        orden = sorted(['OBRA1_BA_P1', 'OBRA1_BA_PB', 'OBRA1_BA_PS1'], key=lambda n: datos[n]['orden_planta'])
        self.assertEqual(orden, ['OBRA1_BA_PS1', 'OBRA1_BA_PB', 'OBRA1_BA_P1'])
        # Lo puesto a mano no se pisa: un nombre sin convencion no tiene edificio.
        self.assertIsNone(self._crear('Prueba suelta').edificio_id)

    def test_un_edificio_es_de_una_sola_ferralla(self):
        p1 = self._crear('OBRA2_P1')
        ajeno = Edificio.objects.create(nombre='Ajeno', usuario=self.otra)
        respuesta = self.client.patch(f'/api/proyectos/{p1.pk}/', {'edificio': ajeno.pk}, format='json')
        self.assertEqual(respuesta.status_code, 400)
        # Cambiar de ferralla lo saca del edificio de la anterior y lo lleva al suyo.
        respuesta = self.client.patch(f'/api/proyectos/{p1.pk}/', {
            'usuario': f'http://testserver/api/users/{self.otra.pk}/',
        }, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        p1.refresh_from_db()
        self.assertEqual((p1.edificio.nombre, p1.edificio.usuario_id), ('OBRA2', self.otra.pk))

    def test_la_oficina_gestiona_los_edificios_y_cada_ferralla_ve_los_suyos(self):
        self._crear('OBRA3_P1')
        Edificio.objects.create(nombre='De la otra', usuario=self.otra)
        edificio = Edificio.objects.get(nombre='OBRA3')
        respuesta = self.client.patch(f'/api/edificios/{edificio.pk}/', {'nombre': 'Obra 3 · Bloque único'}, format='json')
        self.assertEqual(respuesta.status_code, 200)
        self.client.force_authenticate(self.ferralla)
        self.assertEqual([e['nombre'] for e in self.client.get('/api/edificios/').data], ['Obra 3 · Bloque único'])
        self.assertEqual(self.client.post('/api/edificios/', {'nombre': 'X', 'usuario': self.ferralla.pk}, format='json').status_code, 403)
        proyecto = Proyecto.objects.get(nombre='OBRA3_P1')
        self.assertEqual(self.client.patch(f'/api/proyectos/{proyecto.pk}/', {'planta_tipo': 'BAJA'}, format='json').status_code, 400)

    def test_estadisticas_de_todo_el_edificio_con_una_fila_por_forjado(self):
        p1 = self._crear('OBRA4_P1')
        pb = self._crear('OBRA4_PB')
        suelto = self._crear('OBRA5_P1')
        hecho = timezone.make_aware(datetime(2026, 10, 6, 10, 0))
        for proyecto, n in ((p1, 2), (pb, 3), (suelto, 4)):
            for i in range(n):
                Modulo.objects.create(nombre=f'A{i}', proyecto=proyecto, inferior_hecho=True, superior_hecho=True,
                                      estado='COMPLETADO', completado_at=hecho)
        Modulo.objects.create(nombre='Z', proyecto=p1)
        Proyecto.objects.filter(pk=p1.pk).update(fecha_montaje=date(2026, 11, 20))
        edificio = p1.edificio
        stats = self.client.get(f'/api/stats/production/?edificio={edificio.pk}&rango=edificio').data
        self.assertEqual(stats['totals']['modulos_completados'], 5)
        cabecera = stats['proyecto']
        self.assertEqual((cabecera['tipo'], cabecera['nombre'], cabecera['modulos_total'], cabecera['modulos_completados']),
                         ('edificio', 'OBRA4', 6, 5))
        self.assertEqual(stats['range']['from'], '2026-10-06')
        self.assertEqual([(f['nombre'], f['planta'], f['modulos_completados'], f['modulos_periodo']) for f in cabecera['forjados']],
                         [('OBRA4_PB', 'PB', 3, 3), ('OBRA4_P1', 'P1', 2, 2)])
        # Una ferralla no ve los edificios de otra.
        self.client.force_authenticate(self.otra)
        ajeno = self.client.get(f'/api/stats/production/?edificio={edificio.pk}&rango=edificio').data
        self.assertEqual(ajeno['totals']['modulos_completados'], 0)
        self.assertIsNone(ajeno['proyecto'])

    def test_la_migracion_pasa_los_proyectos_existentes_a_su_edificio(self):
        migracion = import_module('api.migrations.0076_edificios_por_nombre')
        viejos = [Proyecto.objects.create(nombre=n, usuario=self.ferralla) for n in ('VIEJA_B2_P3', 'VIEJA_B2_PSS', 'Suelto')]
        migracion.asignar_edificios(apps, None)
        for proyecto in viejos:
            proyecto.refresh_from_db()
        self.assertEqual(viejos[0].edificio_id, viejos[1].edificio_id)
        self.assertEqual((viejos[0].edificio.nombre, viejos[0].planta_tipo, viejos[0].planta_numero), ('VIEJA_B2', 'PLANTA', 3))
        self.assertEqual(viejos[1].planta_tipo, 'SEMISOTANO')
        self.assertIsNone(viejos[2].edificio_id)
