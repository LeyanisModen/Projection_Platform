import os
import sqlite3
import tempfile
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import DetalleModuloFase, EventoCalendario, Modulo, Proyecto, ProyectoKilosOtros
from .planificacion import planificacion_de, sumar_meses

_MEDIA_TMP = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
LUNES = date(2026, 11, 2)


class SumarMesesTests(SimpleTestCase):
    def test_keeps_the_day_or_takes_the_last_one_of_a_short_month(self):
        self.assertEqual(sumar_meses(date(2026, 11, 2), 3), date(2027, 2, 2))
        self.assertEqual(sumar_meses(date(2026, 11, 30), 3), date(2027, 2, 28))
        self.assertEqual(sumar_meses(date(2027, 11, 30), 3), date(2028, 2, 29))


def base_tecnica(nombre, sueltos=None):
    """Una base tecnica .db minima; con ``sueltos`` (lista de kg), su tabla de elementos sueltos."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as temporal:
        ruta = temporal.name
    try:
        conexion = sqlite3.connect(ruta)
        conexion.execute('CREATE TABLE resumen (id INTEGER PRIMARY KEY, nombre_modulo TEXT)')
        conexion.execute("INSERT INTO resumen (nombre_modulo) VALUES ('B00')")
        if sueltos is not None:
            conexion.execute(
                'CREATE TABLE elementos_sueltos (id INTEGER PRIMARY KEY, titulo TEXT, momento TEXT, peso_kg REAL NOT NULL)'
            )
            conexion.executemany(
                'INSERT INTO elementos_sueltos (titulo, momento, peso_kg) VALUES (?, ?, ?)',
                [('ARMADURA PILARES', 'PRE', kg) for kg in sueltos],
            )
        conexion.commit()
        conexion.close()
        with open(ruta, 'rb') as leido:
            return SimpleUploadedFile(nombre, leido.read(), content_type='application/octet-stream')
    finally:
        os.unlink(ruta)


@override_settings(MEDIA_ROOT=_MEDIA_TMP.name)
class PlanificacionTests(APITestCase):
    def setUp(self):
        self.oficina = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla', first_name='Ferralia')
        self.otra = User.objects.create_user('otra')
        aceptado = timezone.now()
        # Entrega a obra el 12/11 (la suya) y el 20/11 (solo la orientativa).
        self.p1 = Proyecto.objects.create(
            nombre='OBRA_P01', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
            fecha_montaje=date(2026, 11, 10), fecha_montaje_obra=date(2026, 11, 12),
        )
        self.p2 = Proyecto.objects.create(
            nombre='OBRA_P02', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
            fecha_montaje=date(2026, 11, 20),
        )
        self.ajeno = Proyecto.objects.create(
            nombre='AJENO', usuario=self.otra, aceptado_por_ferralla_at=aceptado, fecha_montaje=date(2026, 11, 12),
        )
        for indice in range(8):
            Modulo.objects.create(nombre=f'A{indice:02d}', proyecto=self.p1)
        for indice in range(4):
            Modulo.objects.create(nombre=f'B{indice:02d}', proyecto=self.p2)

    def detalle(self, modulo, fase, **pesos):
        return DetalleModuloFase.objects.create(modulo=modulo, fase=fase, **pesos)

    def test_three_months_of_working_days_at_the_pace_of_each_delivery(self):
        datos = planificacion_de(self.ferralla.id, LUNES)

        self.assertEqual(datos['desde'], '2026-11-02')
        self.assertEqual(datos['hasta'], '2027-02-02')
        fechas = [dia['fecha'] for dia in datos['dias']]
        self.assertEqual(fechas[0], '2026-11-02')
        self.assertEqual(fechas[-1], '2027-02-02')
        self.assertNotIn('2026-11-07', fechas)  # sabado
        por_dia = {dia['fecha']: dia['modulos'] for dia in datos['dias']}
        # 8 modulos en los 8 dias laborables hasta el 12 y 4 en los 6 siguientes.
        self.assertEqual(por_dia['2026-11-02'], 1.0)
        self.assertEqual(por_dia['2026-11-11'], 1.0)
        self.assertEqual(por_dia['2026-11-12'], 0.7)
        self.assertEqual(por_dia['2026-11-19'], 0.7)
        self.assertEqual(por_dia['2026-11-20'], 0)
        self.assertEqual(
            datos['entregas'],
            [
                {'proyecto': self.p1.id, 'nombre': 'OBRA_P01', 'fecha': '2026-11-12', 'orientativa': False, 'modulos_pendientes': 8},
                {'proyecto': self.p2.id, 'nombre': 'OBRA_P02', 'fecha': '2026-11-20', 'orientativa': True, 'modulos_pendientes': 4},
            ],
        )

    def test_a_holiday_is_out_of_the_chart_and_listed(self):
        EventoCalendario.objects.create(
            titulo='Fiesta', tipo='FESTIVO', inicio=date(2026, 11, 9), fin=date(2026, 11, 9), ferralla=self.ferralla,
        )
        datos = planificacion_de(self.ferralla.id, LUNES)

        self.assertNotIn('2026-11-09', [dia['fecha'] for dia in datos['dias']])
        # El suyo y los nacionales de la ventana.
        self.assertEqual(datos['festivos'][:3], ['2026-11-09', '2026-12-06', '2026-12-08'])
        self.assertNotIn('2026-12-08', [dia['fecha'] for dia in datos['dias']])

    def test_each_card_adds_up_the_kilos_that_go_to_site(self):
        hecho = Modulo.objects.filter(proyecto=self.p1).first()
        hecho.completado_at = timezone.now()
        hecho.estado = 'COMPLETADO'
        hecho.save(update_fields=['completado_at', 'estado'])
        self.detalle(hecho, 'INFERIOR', peso_malla_final_kg=Decimal('100'), peso_refuerzos_kg=Decimal('20'),
                     desperdicio_kg=Decimal('7.5'))
        self.detalle(hecho, 'SUPERIOR', peso_malla_final_kg=Decimal('50'), desperdicio_kg=Decimal('2.5'))
        pendiente = Modulo.objects.filter(proyecto=self.p1).last()
        self.detalle(pendiente, 'INFERIOR', peso_malla_manual_kg=Decimal('30'), peso_zunchos_kg=Decimal('5'),
                     desperdicio_kg=Decimal('9'))
        self.p1.peso_elementos_sueltos_kg = Decimal('412.40')
        self.p1.save(update_fields=['peso_elementos_sueltos_kg'])
        ProyectoKilosOtros.objects.create(proyecto=self.p1, concepto='Esperas de pilares', kg=Decimal('80'))

        tarjetas = {t['id']: t for t in planificacion_de(self.ferralla.id, LUNES)['proyectos']}

        self.assertEqual([t['nombre'] for t in tarjetas.values()], ['OBRA_P01', 'OBRA_P02'])
        kilos = tarjetas[self.p1.id]['kilos']
        self.assertEqual(kilos['modulos'], 205.0)
        self.assertEqual(kilos['fabricado'], 170.0)
        # Desperdicio solo de lo fabricado, como en Estadisticas.
        self.assertEqual(kilos['desperdicio'], 10.0)
        self.assertEqual(kilos['sueltos'], 412.4)
        self.assertEqual(kilos['otros'][0]['concepto'], 'Esperas de pilares')
        self.assertEqual(kilos['total'], 697.4)
        self.assertEqual(tarjetas[self.p1.id]['fecha_entrega'], '2026-11-12')
        self.assertIsNone(tarjetas[self.p1.id]['edificio'])
        self.assertFalse(tarjetas[self.p1.id]['entrega_orientativa'])
        # Sin tabla de sueltos en la base tecnica: pendiente, no cero. Y sin detalles de
        # sus modulos, sus kilos tampoco se saben: sin total.
        self.assertIsNone(tarjetas[self.p2.id]['kilos']['sueltos'])
        self.assertIsNone(tarjetas[self.p2.id]['kilos']['modulos'])
        self.assertIsNone(tarjetas[self.p2.id]['kilos']['total'])
        self.assertTrue(tarjetas[self.p2.id]['entrega_orientativa'])

    def test_cards_are_what_is_due_in_the_window_or_still_pending(self):
        aceptado = timezone.now()
        Proyecto.objects.create(nombre='LEJOS', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
                                fecha_montaje_obra=date(2027, 3, 1))
        Proyecto.objects.create(nombre='SIN_ACEPTAR', usuario=self.ferralla, fecha_montaje_obra=date(2026, 11, 25))
        Proyecto.objects.create(nombre='SIN_FECHA', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado)
        entregado = Proyecto.objects.create(nombre='ENTREGADO', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
                                            fecha_montaje_obra=date(2026, 10, 20))
        Modulo.objects.create(nombre='Z1', proyecto=entregado, estado='COMPLETADO', completado_at=timezone.now())
        Proyecto.objects.create(nombre='ATRASADO', usuario=self.ferralla, aceptado_por_ferralla_at=aceptado,
                                fecha_montaje_obra=date(2026, 10, 28))

        datos = planificacion_de(self.ferralla.id, LUNES)

        self.assertEqual([t['nombre'] for t in datos['proyectos']], ['ATRASADO', 'OBRA_P01', 'OBRA_P02', 'SIN_FECHA'])
        self.assertEqual([e['nombre'] for e in datos['entregas']], ['OBRA_P01', 'OBRA_P02'])

    @patch('api.planificacion.timezone.localdate', return_value=LUNES)
    def test_the_factory_sees_its_own_and_the_office_picks_one(self, _hoy):
        self.client.force_authenticate(self.ferralla)
        propia = self.client.get('/api/planificacion/', {'usuario': self.otra.id})
        self.assertEqual(propia.status_code, 200)
        self.assertIsNone(propia.data['ferrallas'])
        self.assertEqual(propia.data['ferralla'], {'id': self.ferralla.id, 'nombre': 'Ferralia'})
        self.assertEqual([t['nombre'] for t in propia.data['proyectos']], ['OBRA_P01', 'OBRA_P02'])

        self.client.force_authenticate(self.oficina)
        sin_elegir = self.client.get('/api/planificacion/')
        self.assertEqual(sin_elegir.status_code, 200)
        self.assertIsNone(sin_elegir.data['ferralla'])
        self.assertEqual([f['id'] for f in sin_elegir.data['ferrallas']], [self.ferralla.id, self.otra.id])
        elegida = self.client.get('/api/planificacion/', {'usuario': self.otra.id})
        self.assertEqual([t['nombre'] for t in elegida.data['proyectos']], ['AJENO'])
        self.assertEqual(self.client.get('/api/planificacion/', {'usuario': self.oficina.id}).status_code, 404)
        self.assertEqual(self.client.get('/api/planificacion/', {'usuario': 'x'}).status_code, 404)

    def test_the_factory_adds_and_removes_its_own_kilos(self):
        self.client.force_authenticate(self.ferralla)
        url = f'/api/proyectos/{self.p1.id}/kilos-otros/'

        creada = self.client.post(url, {'concepto': '  Mallas de reparto ', 'kg': '125,5'}, format='json')
        self.assertEqual(creada.status_code, 201)
        self.assertEqual(creada.data, [{'id': creada.data[0]['id'], 'concepto': 'Mallas de reparto', 'kg': 125.5}])
        linea = ProyectoKilosOtros.objects.get()
        self.assertEqual(linea.creado_por, self.ferralla)
        self.assertEqual(linea.kg, Decimal('125.50'))

        for malo in [{'concepto': '', 'kg': 3}, {'concepto': 'x' * 121, 'kg': 3}, {'concepto': 'A', 'kg': 'mucho'},
                     {'concepto': 'A', 'kg': 0}, {'concepto': 'A', 'kg': -4}, {'concepto': 'A', 'kg': 'NaN'},
                     {'concepto': 'A'}]:
            self.assertEqual(self.client.post(url, malo, format='json').status_code, 400, malo)

        self.assertEqual(self.client.delete(f'{url}{linea.id}/').data, [])
        self.assertEqual(self.client.delete(f'{url}{linea.id}/').status_code, 404)

    def test_nobody_touches_the_kilos_of_another_factory(self):
        ajena = ProyectoKilosOtros.objects.create(proyecto=self.ajeno, concepto='Suyo', kg=Decimal('10'))
        self.client.force_authenticate(self.ferralla)
        url = f'/api/proyectos/{self.ajeno.id}/kilos-otros/'
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.post(url, {'concepto': 'A', 'kg': 1}, format='json').status_code, 404)
        self.assertEqual(self.client.delete(f'{url}{ajena.id}/').status_code, 404)
        # Una linea de otro proyecto no se borra desde uno propio.
        self.assertEqual(self.client.delete(f'/api/proyectos/{self.p1.id}/kilos-otros/{ajena.id}/').status_code, 404)
        self.assertTrue(ProyectoKilosOtros.objects.filter(pk=ajena.pk).exists())

        self.client.force_authenticate(self.oficina)
        self.assertEqual(self.client.get(url).data, [{'id': ajena.id, 'concepto': 'Suyo', 'kg': 10.0}])

    def test_the_loose_elements_weight_comes_with_the_technical_base(self):
        self.client.force_authenticate(self.oficina)
        url = f'/api/proyectos/{self.p2.id}/import-technical-data/'

        respuesta = self.client.post(url, {'technical_file': base_tecnica('p2.db', [120.25, 80, 4.1])}, format='multipart')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.p2.refresh_from_db()
        self.assertEqual(self.p2.peso_elementos_sueltos_kg, Decimal('204.35'))
        self.assertEqual(self.client.get(f'/api/proyectos/{self.p2.id}/').data['peso_elementos_sueltos_kg'], '204.35')

        # Una base sin la tabla: el dato vuelve a estar pendiente.
        self.client.post(url, {'technical_file': base_tecnica('p2_v2.db')}, format='multipart')
        self.p2.refresh_from_db()
        self.assertIsNone(self.p2.peso_elementos_sueltos_kg)
        # Con la tabla vacia, no hay sueltos: cero.
        self.client.post(url, {'technical_file': base_tecnica('p2_v3.db', [])}, format='multipart')
        self.p2.refresh_from_db()
        self.assertEqual(self.p2.peso_elementos_sueltos_kg, Decimal('0.00'))
