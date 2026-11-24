import random
from datetime import date, timedelta

from django.contrib.auth.models import User
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .acopio import cuerda, dia_de_salida
from .models import AcopioCapacidad, Camion, GrupoBastidor, Modulo, Proyecto
from .planning import _Produccion, dias_laborables, plan_ferralla, tramos_de_ritmo

LUNES = date(2026, 9, 14)


class CuerdaTests(SimpleTestCase):
    """La cuerda tensa entre lo minimo y lo maximo fabricado."""

    def test_sin_techo_es_el_plan_por_tramos_de_siempre(self):
        azar = random.Random(7)
        for _ in range(200):
            forjados, montaje = [], LUNES
            for clave in range(azar.randint(1, 6)):
                montaje += timedelta(days=azar.randint(1, 15))
                forjados.append((montaje, azar.randint(1, 60), clave))
            tramos = tramos_de_ritmo(forjados, LUNES, frozenset())
            produccion = _Produccion(tramos, frozenset())
            dias = produccion.dias
            minimos = [sum(m for f, m, _c in forjados if dia_de_salida(f, frozenset()) <= dia) for dia in dias]
            hecho = cuerda(minimos, [float('inf')] * len(dias))
            for k in range(len(dias)):
                self.assertAlmostEqual(hecho[k], produccion.acumulado[k], places=6)

    def test_con_techo_no_se_pasa_y_llega_a_los_plazos(self):
        # 10 dias; 60 modulos para el dia 10, pero hasta el 5 solo caben 10.
        minimos = [0] * 9 + [60]
        maximos = [10] * 5 + [60] * 5
        hecho = cuerda(minimos, maximos)
        for k, valor in enumerate(hecho):
            self.assertLessEqual(valor, maximos[k] + 1e-9)
            self.assertGreaterEqual(valor, minimos[k] - 1e-9)
        ritmos = [hecho[0]] + [hecho[k] - hecho[k - 1] for k in range(1, 10)]
        # Lo mas suave: 2 al dia mientras no cabe mas y luego 10 al dia.
        self.assertEqual([round(r, 6) for r in ritmos], [2] * 5 + [10] * 5)


class AcopioPlanTests(TestCase):
    """El plan de la ferralla con la capacidad del patio."""

    def setUp(self):
        self.ferralla = User.objects.create_user('acopio-ferralla')

    def forjado(self, nombre, montaje, modulos, bastidores):
        proyecto = Proyecto.objects.create(nombre=nombre, usuario=self.ferralla, fecha_montaje=montaje)
        Modulo.objects.bulk_create([Modulo(nombre=f'{nombre}-{i}', proyecto=proyecto) for i in range(modulos)])
        for indice in range(1, bastidores + 1):
            GrupoBastidor.objects.create(proyecto=proyecto, indice=indice)
        return proyecto

    def ritmos(self, plan):
        return [(t['desde'], t['hasta'], t['ritmo'], t['motivo']) for t in plan['tramos']]

    def test_sin_capacidad_no_cambia_nada_y_con_mucha_tampoco(self):
        self.forjado('P1', date(2026, 9, 21), 40, 8)
        self.forjado('P2', date(2026, 10, 5), 60, 12)
        sin = plan_ferralla(self.ferralla.pk, LUNES)
        self.assertIsNone(sin['acopio'])
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=1000)
        con = plan_ferralla(self.ferralla.pk, LUNES)
        self.assertIsNotNone(con['acopio'])
        self.assertEqual([(t['desde'], t['hasta'], t['ritmo']) for t in con['tramos']],
                         [(t['desde'], t['hasta'], t['ritmo']) for t in sin['tramos']])
        self.assertEqual(con['ritmo'], sin['ritmo'])
        self.assertEqual(con['manda_nombre'], sin['manda_nombre'])

    def test_el_patio_lleno_frena_y_despues_aprieta(self):
        # P1 (10 modulos, 2 bastidores) sale el viernes 18; P2 (50, 10) el 02/10.
        self.forjado('P1', date(2026, 9, 21), 10, 2)
        p2 = self.forjado('P2', date(2026, 10, 5), 50, 10)
        sin = plan_ferralla(self.ferralla.pk, LUNES)
        # Sin limite: 60 modulos en 15 dias, 4 al dia desde hoy.
        self.assertEqual(sin['ritmo'], 4.0)

        # Hasta que sale P1 solo caben sus 2 bastidores; despues, 12.
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=2)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=date(2026, 9, 19), bastidores=12)
        plan = plan_ferralla(self.ferralla.pk, LUNES)
        acopio = plan['acopio']
        for dia in dias_laborables(LUNES, date(2026, 10, 5), frozenset()):
            en_patio, caben = acopio.ocupacion(dia)
            self.assertLessEqual(en_patio, caben + 1e-6, dia)
        # La primera semana solo P1 (2 al dia): el patio esta lleno hasta que
        # sale. Despues, los 50 de P2 en sus 10 dias.
        self.assertEqual([(t['ritmo'], t['dias'], t['motivo']) for t in plan['tramos']],
                         [(2.0, 5, 'acopio'), (5.0, 10, 'montaje')])
        self.assertIsNone(plan['manda_nombre'])
        self.assertEqual(plan['proyectos'][p2.pk]['fabricacion_inicio'], '2026-09-21')
        self.assertEqual(acopio.excesos, [])
        # El viernes esta P1 entero esperando su camion; el lunes, lo de P2.
        self.assertEqual(round(acopio.ocupacion(date(2026, 9, 18))[0], 6), 2.0)
        self.assertEqual(round(acopio.ocupacion(date(2026, 9, 21))[0], 6), 1.0)

    def test_un_forjado_que_no_cabe_entero_se_apunta_como_exceso(self):
        self.forjado('Grande', date(2026, 9, 28), 60, 12)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=8)
        plan = plan_ferralla(self.ferralla.pk, LUNES)
        excesos = plan['acopio'].resumen()['excesos']
        # Llega igual a su montaje, pero el ultimo dia hacen falta 4 bastidores mas.
        self.assertEqual(round(sum(t['modulos'] for t in plan['tramos'])), 60)
        self.assertEqual(excesos[-1], {'fecha': '2026-09-25', 'bastidores': 4.0})
        # No lo deja todo para el ultimo dia: se pasa lo justo y reparte (6 al dia).
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan['tramos']], [(6.0, 10)])

    def test_lo_ya_fabricado_ocupa_hasta_que_sale(self):
        uno = self.forjado('Hecho', date(2026, 9, 28), 20, 4)
        uno.modulos.update(estado='COMPLETADO')
        self.forjado('Siguiente', date(2026, 10, 5), 20, 4)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=6)
        plan = plan_ferralla(self.ferralla.pk, LUNES)
        # Caben 6 y hay 4 de lo hecho: hasta que sale (viernes 25) solo 2
        # bastidores mas (10 modulos en 10 dias); despues, los otros 10 en 5.
        self.assertEqual([(t['ritmo'], t['dias'], t['motivo']) for t in plan['tramos']],
                         [(1.0, 10, 'acopio'), (2.0, 5, 'montaje')])
        ocupacion = plan['acopio'].ocupacion
        self.assertEqual(round(ocupacion(LUNES)[0], 6), 4.2)
        self.assertEqual(round(ocupacion(date(2026, 9, 25))[0], 6), 6.0)
        self.assertEqual(round(ocupacion(date(2026, 9, 28))[0], 6), 2.4)
        self.assertEqual(ocupacion(date(2026, 9, 28))[1], 6)


class AcopioPantallasTests(APITestCase):
    """La capacidad se guarda desde la planificacion de Moden y el patio sale en las dos planificaciones."""

    def setUp(self):
        self.ferralla = User.objects.create_user('acopio-pantallas')
        self.oficina = User.objects.create_user('acopio-oficina', is_staff=True)
        self.url = f'/api/planificacion-moden/acopio/{self.ferralla.pk}/'
        proyecto = Proyecto.objects.create(
            nombre='P1', usuario=self.ferralla, fecha_montaje=date(2026, 9, 21), aceptado_por_ferralla_at=timezone.now(),
        )
        Modulo.objects.bulk_create([Modulo(nombre=f'M{i}', proyecto=proyecto) for i in range(10)])
        GrupoBastidor.objects.create(proyecto=proyecto, indice=1)
        GrupoBastidor.objects.create(proyecto=proyecto, indice=2)
        Proyecto.objects.create(
            nombre='Estudio', usuario=self.ferralla, fecha_montaje=date(2026, 9, 21), fantasma=True, modulos_previstos=10,
        )

    def test_solo_la_oficina_guarda_la_capacidad_y_se_sustituye_entera(self):
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(self.oficina)
        self.assertEqual(self.client.get(f'/api/planificacion-moden/acopio/{self.oficina.pk}/').status_code, 404)
        respuesta = self.client.put(self.url, {'capacidades': [
            {'desde': '2026-12-15', 'bastidores': 90}, {'desde': '2026-09-14', 'bastidores': 30},
        ]}, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.assertEqual(respuesta.data, [{'desde': '2026-09-14', 'bastidores': 30}, {'desde': '2026-12-15', 'bastidores': 90}])
        repetida = self.client.put(self.url, {'capacidades': [
            {'desde': '2026-09-14', 'bastidores': 30}, {'desde': '2026-09-14', 'bastidores': 40},
        ]}, format='json')
        self.assertEqual(repetida.status_code, 400)
        self.assertEqual(self.client.put(self.url, {'capacidades': [{'desde': 'ayer', 'bastidores': 3}]}, format='json').status_code, 400)
        self.assertEqual(self.client.put(self.url, {'capacidades': []}, format='json').data, [])
        self.assertFalse(AcopioCapacidad.objects.exists())

    def test_el_patio_sale_en_las_dos_planificaciones(self):
        from .planificacion import planificacion_de
        from .planificacion_moden import planificacion_ferralla

        self.assertIsNone(planificacion_de(self.ferralla.pk, desde=LUNES)['acopio'])
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=3)

        ferralla = planificacion_de(self.ferralla.pk, desde=LUNES)
        viernes = next(d for d in ferralla['acopio']['dias'] if d['fecha'] == '2026-09-18')
        # El viernes P1 esta entero (2 bastidores) esperando el camion; la ferralla no ve lo que esta en estudio.
        self.assertEqual(viernes, {'fecha': '2026-09-18', 'bastidores': 2.0, 'capacidad': 3})
        self.assertEqual(ferralla['acopio']['excesos'], [])

        moden = planificacion_ferralla(self.ferralla, LUNES, date(2026, 10, 16))['acopio']
        viernes = next(d for d in moden['dias'] if d['fecha'] == '2026-09-18')
        # Con el proyecto en estudio (10 modulos mas, a 5 por bastidor) no cabe: 4 de 3.
        self.assertEqual(viernes, {'fecha': '2026-09-18', 'real': 2.0, 'con_fantasmas': 4.0, 'capacidad': 3})
        self.assertEqual(moden['excesos_real'], [])
        self.assertEqual(moden['excesos_con_fantasmas'], [{'fecha': '2026-09-18', 'bastidores': 1.0}])


class CamionesTests(APITestCase):
    """Cada forjado sale en camiones de 4 bastidores; por defecto el dia antes
    del montaje, y moverlos cambia cuando tienen que estar y cuando hay sitio."""

    def setUp(self):
        self.ferralla = User.objects.create_user('camiones-ferralla')
        self.otra = User.objects.create_user('camiones-otra')
        self.oficina = User.objects.create_user('camiones-oficina', is_staff=True)

    def forjado(self, nombre, montaje, modulos, bastidores, hechos=0):
        proyecto = Proyecto.objects.create(
            nombre=nombre, usuario=self.ferralla, fecha_montaje=montaje, aceptado_por_ferralla_at=timezone.now(),
        )
        Modulo.objects.bulk_create([
            Modulo(nombre=f'{nombre}-{i}', proyecto=proyecto, estado='COMPLETADO' if i < hechos else 'PENDIENTE')
            for i in range(modulos)
        ])
        for indice in range(1, bastidores + 1):
            GrupoBastidor.objects.create(proyecto=proyecto, indice=indice)
        return proyecto

    def url(self, proyecto):
        return f'/api/proyectos/{proyecto.pk}/camiones/'

    def test_por_defecto_salen_de_cuatro_en_cuatro_el_dia_antes_del_montaje(self):
        proyecto = self.forjado('P', date(2026, 9, 28), 50, 10)
        self.client.force_authenticate(self.oficina)
        datos = self.client.get(self.url(proyecto)).data
        self.assertEqual((datos['bastidores'], datos['salida'], datos['por_defecto']), (10, '2026-09-25', True))
        self.assertEqual([(c['fecha'], c['bastidores']) for c in datos['camiones']],
                         [('2026-09-25', 4), ('2026-09-25', 4), ('2026-09-25', 2)])

    def test_mover_un_camion_antes_adelanta_sus_bastidores(self):
        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_ferralla(self.ferralla.pk, LUNES)['tramos']], [(3.0, 10)])
        self.client.force_authenticate(self.oficina)
        respuesta = self.client.put(self.url(proyecto), {'camiones': [{'fecha': '2026-09-18', 'bastidores': 4}]}, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        # Lo que no lleva el camion movido sale por defecto el dia antes del montaje.
        self.assertEqual([(c['fecha'], c['bastidores'], c['por_defecto']) for c in respuesta.data['camiones']],
                         [('2026-09-18', 4, False), ('2026-09-25', 2, True)])
        # Sus 4 bastidores (20 modulos) para el viernes 18; los otros 10, despues.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_ferralla(self.ferralla.pk, LUNES)['tramos']],
                         [(4.0, 5), (2.0, 5)])
        # Volver a los de por defecto.
        self.assertTrue(self.client.delete(self.url(proyecto)).data['por_defecto'])
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_ferralla(self.ferralla.pk, LUNES)['tramos']], [(3.0, 10)])

    def test_mover_un_camion_antes_deja_sitio_en_el_patio(self):
        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=4)
        self.assertTrue(plan_ferralla(self.ferralla.pk, LUNES)['acopio'].excesos)
        Camion.objects.create(proyecto=proyecto, orden=1, fecha=date(2026, 9, 18), bastidores=4)
        plan = plan_ferralla(self.ferralla.pk, LUNES)
        self.assertEqual(plan['acopio'].excesos, [])
        self.assertEqual(round(plan['acopio'].ocupacion(date(2026, 9, 18))[0], 6), 4.0)
        self.assertEqual(round(plan['acopio'].ocupacion(date(2026, 9, 21))[0], 6), 0.4)

    def test_un_camion_enviado_ya_no_ocupa(self):
        hecho = self.forjado('Hecho', date(2026, 9, 28), 30, 6, hechos=30)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=10)
        self.assertEqual(round(plan_ferralla(self.ferralla.pk, LUNES)['acopio'].ocupacion(LUNES)[0], 6), 6.0)
        Camion.objects.create(proyecto=hecho, orden=1, fecha=date(2026, 9, 11), bastidores=4, enviado=True)
        self.assertEqual(round(plan_ferralla(self.ferralla.pk, LUNES)['acopio'].ocupacion(LUNES)[0], 6), 2.0)

    def test_si_un_camion_de_la_planta_siguiente_sale_antes_se_fabrica_antes(self):
        primera = self.forjado('P1', date(2026, 10, 5), 30, 6)
        segunda = self.forjado('P2', date(2026, 10, 12), 10, 2)
        Camion.objects.create(proyecto=segunda, orden=1, fecha=date(2026, 9, 18), bastidores=2)
        plan = plan_ferralla(self.ferralla.pk, LUNES)
        self.assertEqual(plan['proyectos'][segunda.pk]['fabricacion_inicio'], '2026-09-14')
        self.assertLessEqual(plan['proyectos'][segunda.pk]['fabricacion_fin'], '2026-09-18')
        self.assertGreater(plan['proyectos'][primera.pk]['fabricacion_inicio'], '2026-09-14')

    def test_quien_los_mueve_y_que_se_acepta(self):
        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        self.client.force_authenticate(self.otra)
        self.assertEqual(self.client.get(self.url(proyecto)).status_code, 404)
        # La ferralla del forjado los mueve (cuando lo vea en su dashboard).
        self.client.force_authenticate(self.ferralla)
        uno = {'fecha': '2026-09-18', 'bastidores': 2}
        self.assertEqual(self.client.put(self.url(proyecto), {'camiones': [uno]}, format='json').status_code, 200)
        self.assertEqual(self.client.put(self.url(proyecto), {'camiones': [{**uno, 'bastidores': 5}]}, format='json').status_code, 400)
        self.assertEqual(self.client.put(self.url(proyecto), {'camiones': [{**uno, 'fecha': 'mañana'}]}, format='json').status_code, 400)
        futuro = (timezone.localdate() + timedelta(days=3)).isoformat()
        enviado_futuro = self.client.put(self.url(proyecto), {'camiones': [{'fecha': futuro, 'bastidores': 4, 'enviado': True}]}, format='json')
        self.assertEqual(enviado_futuro.status_code, 400)
        enviado = self.client.put(self.url(proyecto), {'camiones': [{'fecha': '2026-09-11', 'bastidores': 4, 'enviado': True}]}, format='json')
        self.assertEqual(enviado.status_code, 200)
        self.assertTrue(enviado.data['camiones'][0]['enviado'])
        self.assertIsNotNone(enviado.data['camiones'][0]['enviado_at'])
