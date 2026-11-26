import random
from datetime import date, timedelta

from django.contrib.auth.models import User
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .acopio import cuerda, dia_de_salida
from .models import AcopioCapacidad, Camion, GrupoBastidor, Modulo, Proyecto
from .planning import PATIO_LIMITA, _Produccion, dias_laborables, plan_ferralla, tramos_de_ritmo

LUNES = date(2026, 9, 14)


def plan_patio(*args, **kwargs):
    """El plan con el patio y los camiones: la Planificacion 2 de Moden."""
    return plan_ferralla(*args, patio=PATIO_LIMITA, **kwargs)


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
        sin = plan_patio(self.ferralla.pk, LUNES)
        self.assertIsNone(sin['acopio'])
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=1000)
        con = plan_patio(self.ferralla.pk, LUNES)
        self.assertIsNotNone(con['acopio'])
        self.assertEqual([(t['desde'], t['hasta'], t['ritmo']) for t in con['tramos']],
                         [(t['desde'], t['hasta'], t['ritmo']) for t in sin['tramos']])
        self.assertEqual(con['ritmo'], sin['ritmo'])
        self.assertEqual(con['manda_nombre'], sin['manda_nombre'])

    def test_el_patio_lleno_frena_y_despues_aprieta(self):
        # P1 (10 modulos, 2 bastidores) sale el viernes 18; P2 (50, 10) el 02/10.
        self.forjado('P1', date(2026, 9, 21), 10, 2)
        p2 = self.forjado('P2', date(2026, 10, 5), 50, 10)
        sin = plan_patio(self.ferralla.pk, LUNES)
        # Sin limite: 60 modulos en 15 dias, 4 al dia desde hoy.
        self.assertEqual(sin['ritmo'], 4.0)

        # Hasta que sale P1 solo caben sus 2 bastidores; despues, 12.
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=2)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=date(2026, 9, 19), bastidores=12)
        plan = plan_patio(self.ferralla.pk, LUNES)
        acopio = plan['acopio']
        for dia in dias_laborables(LUNES, date(2026, 10, 5), frozenset()):
            en_patio, caben = acopio.ocupacion(dia)
            self.assertLessEqual(en_patio, caben + 1e-6, dia)
        # Hasta el jueves solo P1 (2,5 al dia): el patio esta lleno. El viernes
        # sale P1 y su sitio vale ya ese dia; despues, los 50 de P2 en 11 dias.
        self.assertEqual([(t['ritmo'], t['dias'], t['motivo']) for t in plan['tramos']],
                         [(2.5, 4, 'acopio'), (4.5, 11, 'montaje')])
        self.assertIsNone(plan['manda_nombre'])
        self.assertEqual(plan['proyectos'][p2.pk]['fabricacion_inicio'], '2026-09-18')
        self.assertEqual(acopio.excesos, [])
        # El jueves esta P1 entero esperando su camion; el viernes, ya salido, lo de P2.
        self.assertEqual(round(acopio.ocupacion(date(2026, 9, 17))[0], 6), 2.0)
        self.assertEqual(round(acopio.ocupacion(date(2026, 9, 18))[0], 3), 0.909)

    def test_un_forjado_que_no_cabe_entero_deja_lo_ultimo_para_el_dia_que_sale(self):
        self.forjado('Grande', date(2026, 9, 28), 60, 12)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=8)
        plan = plan_patio(self.ferralla.pk, LUNES)
        # Caben 8 de sus 12: el viernes, mientras salen los camiones, se hacen los 4 que faltan.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan['tramos']], [(4.4, 9), (20.0, 1)])
        self.assertEqual(plan['acopio'].excesos, [])

    def test_lo_hecho_que_no_cabe_se_apunta_como_exceso(self):
        hecho = self.forjado('Hecho', date(2026, 9, 28), 60, 12)
        hecho.modulos.update(estado='COMPLETADO')
        self.forjado('Siguiente', date(2026, 10, 5), 20, 4)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=8)
        plan = plan_patio(self.ferralla.pk, LUNES)
        excesos = plan['acopio'].resumen()['excesos']
        # Hay 12 donde caben 8 hasta que sale (viernes 25): nada mas hasta entonces.
        self.assertEqual((excesos[0], excesos[-1]), (
            {'fecha': '2026-09-14', 'bastidores': 4.0}, {'fecha': '2026-09-24', 'bastidores': 4.0},
        ))
        self.assertEqual([(t['ritmo'], t['dias'], t['motivo']) for t in plan['tramos']],
                         [(0.0, 9, 'acopio'), (3.3, 6, 'montaje')])

    def test_lo_ya_fabricado_ocupa_hasta_que_sale(self):
        uno = self.forjado('Hecho', date(2026, 9, 28), 20, 4)
        uno.modulos.update(estado='COMPLETADO')
        self.forjado('Siguiente', date(2026, 10, 5), 20, 4)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=6)
        plan = plan_patio(self.ferralla.pk, LUNES)
        # Caben 6 y hay 4 de lo hecho: hasta el jueves 24 solo 2 bastidores
        # mas (10 modulos en 9 dias); desde que sale (viernes 25), los otros 10 en 6.
        self.assertEqual([(t['ritmo'], t['dias'], t['motivo']) for t in plan['tramos']],
                         [(1.1, 9, 'acopio'), (1.7, 6, 'montaje')])
        ocupacion = plan['acopio'].ocupacion
        self.assertEqual(round(ocupacion(LUNES)[0], 3), 4.222)
        self.assertEqual(round(ocupacion(date(2026, 9, 24))[0], 6), 6.0)
        self.assertEqual(round(ocupacion(date(2026, 9, 25))[0], 3), 2.333)
        self.assertEqual(ocupacion(date(2026, 9, 28))[1], 6)

    def test_marca_los_dias_con_el_patio_lleno_y_dice_lo_que_no_llega(self):
        from .models import UserProfile

        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=4)
        plan = plan_patio(self.ferralla.pk, LUNES)
        # Caben 4 de sus 6 bastidores: el viernes empieza lleno y solo se hace lo que sale.
        self.assertEqual(plan['acopio'].llenos, [date(2026, 9, 25)])
        # Sin saber lo que fabrican al dia, no se puede decir que no llega.
        self.assertEqual(plan['no_llegan'], [])
        UserProfile.objects.create(user=self.ferralla, modulos_dia_max=5)
        # Con 5 al dia: hasta el jueves, los 20 que caben; el viernes, 25 de sus 30.
        self.assertEqual(plan_patio(self.ferralla.pk, LUNES)['no_llegan'], [{
            'proyecto': proyecto.pk, 'nombre': 'P', 'fantasma': False, 'montaje': '2026-09-28',
            'fecha': '2026-09-25', 'faltan': 5,
        }])
        UserProfile.objects.filter(user=self.ferralla).update(modulos_dia_max=10)
        self.assertEqual(plan_patio(self.ferralla.pk, LUNES)['no_llegan'], [])


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
        # Lo que fabrican al dia como mucho va con el patio; sin decirlo, no cambia.
        from .models import UserProfile

        self.assertEqual(self.client.put(self.url, {'capacidades': [], 'modulos_dia_max': 0}, format='json').status_code, 400)
        self.assertEqual(self.client.put(self.url, {'capacidades': [], 'modulos_dia_max': 30}, format='json').status_code, 200)
        self.assertEqual(UserProfile.objects.get(user=self.ferralla).modulos_dia_max, 30)
        self.client.put(self.url, {'capacidades': []}, format='json')
        self.assertEqual(UserProfile.objects.get(user=self.ferralla).modulos_dia_max, 30)
        self.client.put(self.url, {'capacidades': [], 'modulos_dia_max': None}, format='json')
        self.assertIsNone(UserProfile.objects.get(user=self.ferralla).modulos_dia_max)

    def test_el_patio_solo_lo_ve_moden(self):
        from .planificacion import planificacion_de
        from .planificacion_moden import planificacion_ferralla

        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=3)
        # La ferralla sigue con su minimo de siempre y no ve nada del patio.
        ferralla = planificacion_de(self.ferralla.pk, desde=LUNES)
        self.assertNotIn('acopio', ferralla)
        self.assertEqual([(t['desde'], t['ritmo']) for t in ferralla['tramos']], [('2026-09-14', 2.0)])

        moden = planificacion_ferralla(self.ferralla, LUNES, date(2026, 10, 16), vista=2)['acopio']
        jueves = next(d for d in moden['dias'] if d['fecha'] == '2026-09-17')
        # Con el proyecto en estudio (10 modulos mas, a 5 por bastidor) el patio se llena el jueves.
        self.assertEqual(jueves, {'fecha': '2026-09-17', 'real': 1.6, 'con_fantasmas': 3.0, 'capacidad': 3})
        self.assertEqual(moden['excesos_real'], [])
        self.assertEqual(moden['excesos_con_fantasmas'], [])
        # El viernes empieza con el patio lleno, solo con lo que esta en estudio.
        self.assertEqual((moden['llenos_real'], moden['llenos_con_fantasmas']), ([], ['2026-09-18']))

    def test_la_planificacion_1_es_el_minimo_y_lo_que_se_acopia_si_todo_sale_el_dia_antes(self):
        from .planificacion_moden import planificacion_ferralla

        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=3)
        datos = planificacion_ferralla(self.ferralla, LUNES, date(2026, 10, 16))
        # El minimo de siempre: los 10 modulos de P1 en 5 dias; con el estudio, 20.
        self.assertEqual([(d['fecha'], d['real'], d['con_fantasmas']) for d in datos['dias'][:6]], [
            ('2026-09-14', 2.0, 4.0), ('2026-09-15', 2.0, 4.0), ('2026-09-16', 2.0, 4.0),
            ('2026-09-17', 2.0, 4.0), ('2026-09-18', 2.0, 4.0), ('2026-09-21', 0, 0),
        ])
        # Se va acopiando hasta que sale entero el viernes, aunque no quepa.
        patio = {d['fecha']: (d['real'], d['con_fantasmas'], d['capacidad']) for d in datos['patio']['dias']}
        self.assertEqual(patio['2026-09-14'], (0.4, 0.8, 3))
        self.assertEqual(patio['2026-09-17'], (1.6, 3.2, 3))
        self.assertEqual(patio['2026-09-18'], (0.0, 0.0, 3))
        self.assertEqual(datos['patio']['capacidades'], [{'desde': '2026-09-14', 'bastidores': 3}])
        # Ni camiones ni lo que no llega: eso es la planificacion 2.
        for clave in ('acopio', 'camiones', 'no_llegan_real', 'modulos_dia_max'):
            self.assertNotIn(clave, datos)
        # Cuando se fabrica cada obra, con lo que esta en estudio: primero P1 y despues el estudio.
        self.assertEqual({p['nombre']: (p['fabricacion_inicio'], p['fabricacion_fin']) for p in datos['proyectos']},
                         {'P1': ('2026-09-14', '2026-09-16'), 'Estudio': ('2026-09-16', '2026-09-18')})
        self.assertFalse(any('envio' in p for p in datos['proyectos']))

    def test_cada_pestana_pide_lo_suyo(self):
        self.client.force_authenticate(self.oficina)
        uno = self.client.get('/api/planificacion-moden/')
        dos = self.client.get('/api/planificacion-moden/?vista=2')
        self.assertEqual((uno.status_code, dos.status_code), (200, 200))
        self.assertEqual((uno.data['vista'], dos.data['vista']), (1, 2))
        ferralla = next(f for f in uno.data['ferrallas'] if f['ferralla']['id'] == self.ferralla.pk)
        self.assertIn('patio', ferralla)
        ferralla = next(f for f in dos.data['ferrallas'] if f['ferralla']['id'] == self.ferralla.pk)
        self.assertIn('camiones', ferralla)
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get('/api/planificacion-moden/?vista=2').status_code, 403)


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
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']], [(3.0, 10)])
        self.client.force_authenticate(self.oficina)
        respuesta = self.client.put(self.url(proyecto), {'camiones': [{'fecha': '2026-09-18', 'bastidores': 4}]}, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        # Lo que no lleva el camion movido sale por defecto el dia antes del montaje.
        self.assertEqual([(c['fecha'], c['bastidores'], c['por_defecto']) for c in respuesta.data['camiones']],
                         [('2026-09-18', 4, False), ('2026-09-25', 2, True)])
        # Sus 4 bastidores (20 modulos) para el viernes 18; los otros 10, despues.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']],
                         [(4.0, 5), (2.0, 5)])
        # Volver a los de por defecto.
        self.assertTrue(self.client.delete(self.url(proyecto)).data['por_defecto'])
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']], [(3.0, 10)])

    def test_la_ferralla_sigue_con_su_minimo_aunque_se_muevan_camiones(self):
        from .planning import period_target_summary

        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        sin = plan_ferralla(self.ferralla.pk, LUNES)
        objetivo = period_target_summary(Proyecto.objects.filter(pk=proyecto.pk), LUNES, LUNES + timedelta(days=4))
        Camion.objects.create(proyecto=proyecto, orden=1, fecha=date(2026, 9, 18), bastidores=4)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=1)
        con = plan_ferralla(self.ferralla.pk, LUNES)
        self.assertEqual(con['tramos'], sin['tramos'])
        self.assertIsNone(con['acopio'])
        self.assertEqual(con['envios'], {})
        self.assertEqual(
            period_target_summary(Proyecto.objects.filter(pk=proyecto.pk), LUNES, LUNES + timedelta(days=4)), objetivo,
        )
        # Con el patio (Planificacion 2 de Moden) si cambia.
        self.assertNotEqual(plan_patio(self.ferralla.pk, LUNES)['tramos'], sin['tramos'])

    def test_mover_un_camion_antes_deja_sitio_en_el_patio(self):
        proyecto = self.forjado('P', date(2026, 9, 28), 30, 6)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=4)
        # Caben 4 de sus 6 bastidores: los otros 2 (10 modulos), el viernes que sale.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']],
                         [(2.2, 9), (10.0, 1)])
        Camion.objects.create(proyecto=proyecto, orden=1, fecha=date(2026, 9, 18), bastidores=4)
        plan = plan_patio(self.ferralla.pk, LUNES)
        # Con un camion el viernes 18 se recupera su sitio: 4 al dia y luego 2.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan['tramos']], [(4.0, 5), (2.0, 5)])
        self.assertEqual(plan['acopio'].excesos, [])
        self.assertEqual(round(plan['acopio'].ocupacion(date(2026, 9, 17))[0], 6), 3.2)
        self.assertEqual(round(plan['acopio'].ocupacion(date(2026, 9, 18))[0], 6), 0.0)
        self.assertEqual(round(plan['acopio'].ocupacion(date(2026, 9, 21))[0], 6), 0.4)

    def test_un_camion_enviado_ya_no_ocupa(self):
        hecho = self.forjado('Hecho', date(2026, 9, 28), 30, 6, hechos=30)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=10)
        self.assertEqual(round(plan_patio(self.ferralla.pk, LUNES)['acopio'].ocupacion(LUNES)[0], 6), 6.0)
        Camion.objects.create(proyecto=hecho, orden=1, fecha=date(2026, 9, 11), bastidores=4, enviado=True)
        self.assertEqual(round(plan_patio(self.ferralla.pk, LUNES)['acopio'].ocupacion(LUNES)[0], 6), 2.0)

    def test_si_un_camion_de_la_planta_siguiente_sale_antes_se_fabrica_antes(self):
        primera = self.forjado('P1', date(2026, 10, 5), 30, 6)
        segunda = self.forjado('P2', date(2026, 10, 12), 10, 2)
        Camion.objects.create(proyecto=segunda, orden=1, fecha=date(2026, 9, 18), bastidores=2)
        plan = plan_patio(self.ferralla.pk, LUNES)
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


class RepartoCamionesTests(APITestCase):
    """La ferralla saca unos camiones al dia: un forjado grande empieza a salir
    unos dias antes del montaje, y Moden puede elegir en cuantos dias sale."""

    def setUp(self):
        self.ferralla = User.objects.create_user('reparto-ferralla')
        self.oficina = User.objects.create_user('reparto-oficina', is_staff=True)

    def forjado(self, nombre, montaje, bastidores, por_bastidor=2, fantasma=False):
        modulos = bastidores * por_bastidor
        proyecto = Proyecto.objects.create(
            nombre=nombre, usuario=self.ferralla, fecha_montaje=montaje, aceptado_por_ferralla_at=timezone.now(),
            fantasma=fantasma, modulos_previstos=modulos if fantasma else None,
        )
        if not fantasma:
            Modulo.objects.bulk_create([Modulo(nombre=f'{nombre}-{i}', proyecto=proyecto) for i in range(modulos)])
            GrupoBastidor.objects.bulk_create([GrupoBastidor(proyecto=proyecto, indice=i) for i in range(1, bastidores + 1)])
        return proyecto

    def dias(self, proyecto, desde=LUNES):
        """{fecha: camiones} del forjado en su ficha."""
        from .acopio import camiones_del_proyecto

        cuenta = {}
        for camion in camiones_del_proyecto(proyecto, desde)['camiones']:
            cuenta[camion['fecha']] = cuenta.get(camion['fecha'], 0) + 1
        return cuenta

    def test_un_forjado_grande_empieza_a_salir_unos_dias_antes(self):
        # 40 bastidores, 10 camiones: como mucho 4 al dia, lo mas tarde posible.
        proyecto = self.forjado('Grande', date(2026, 9, 28), 40)
        self.assertEqual(self.dias(proyecto), {'2026-09-23': 2, '2026-09-24': 4, '2026-09-25': 4})
        envio = plan_patio(self.ferralla.pk, LUNES)['envios'][proyecto.pk]
        self.assertEqual((envio['camiones'], envio['desde'], envio['hasta'], envio['dias'], envio['dias_minimos']),
                         (10, '2026-09-23', '2026-09-25', 3, 3))

    def test_dos_forjados_seguidos_no_se_adelantan_y_avisan_de_los_camiones_de_mas(self):
        # A se monta el lunes 28 y B el martes 29, 12 camiones cada uno. La obra
        # no admite nada antes: cada uno sale en sus tres dias, aunque el 24 y
        # el 25 salgan 8 donde caben 4.
        a = self.forjado('A', date(2026, 9, 28), 48)
        b = self.forjado('B', date(2026, 9, 29), 48)
        plan = plan_patio(self.ferralla.pk, LUNES)
        self.assertEqual((plan['envios'][b.pk]['desde'], plan['envios'][b.pk]['hasta']), ('2026-09-24', '2026-09-28'))
        self.assertEqual((plan['envios'][a.pk]['desde'], plan['envios'][a.pk]['hasta']), ('2026-09-23', '2026-09-25'))
        self.assertEqual(plan['envios'][a.pk]['salidas'], [
            {'fecha': '2026-09-23', 'camiones': 4}, {'fecha': '2026-09-24', 'camiones': 4}, {'fecha': '2026-09-25', 'camiones': 4},
        ])
        self.assertEqual(plan['sobrecargas'], [(date(2026, 9, 24), 8.0), (date(2026, 9, 25), 8.0)])

    def test_con_un_camion_al_dia_el_patio_se_vacia_antes(self):
        self.forjado('P', date(2026, 9, 28), 6, por_bastidor=5)
        AcopioCapacidad.objects.create(usuario=self.ferralla, desde=LUNES, bastidores=4)
        # Con 4 al dia sale todo el viernes: hasta entonces caben 4 de sus 6.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']],
                         [(2.2, 9), (10.0, 1)])
        from .models import UserProfile

        UserProfile.objects.create(user=self.ferralla, camiones_por_dia=1)
        # Con uno al dia, el primero (4 bastidores) sale el jueves y deja su sitio.
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan_patio(self.ferralla.pk, LUNES)['tramos']],
                         [(2.5, 8), (5.0, 2)])

    def test_los_dias_elegidos_reparten_parejo_y_nunca_menos_de_los_que_hacen_falta(self):
        proyecto = self.forjado('A', date(2026, 9, 28), 48)
        proyecto.dias_envio = 5
        proyecto.save()
        # 12 camiones en 5 dias: 2 los primeros y 3 los dos ultimos.
        self.assertEqual(self.dias(proyecto), {
            '2026-09-21': 2, '2026-09-22': 2, '2026-09-23': 2, '2026-09-24': 3, '2026-09-25': 3,
        })
        # En 2 dias no salen 12 camiones con 4 al dia: los 3 que hacen falta.
        proyecto.dias_envio = 2
        proyecto.save()
        self.assertEqual(self.dias(proyecto), {'2026-09-23': 4, '2026-09-24': 4, '2026-09-25': 4})
        # Con pocos camiones y muchos dias: el primero el primer dia y el ultimo el ultimo.
        pequeno = self.forjado('B', date(2026, 10, 5), 12)
        pequeno.dias_envio = 5
        pequeno.save()
        self.assertEqual(self.dias(pequeno), {'2026-09-28': 1, '2026-09-30': 1, '2026-10-02': 1})

    def test_un_forjado_que_empieza_a_salir_antes_no_se_hace_entero_antes(self):
        a = self.forjado('A', date(2026, 9, 28), 20)
        b = self.forjado('B', date(2026, 10, 5), 20)
        b.dias_envio = 10
        b.save()
        plan = plan_patio(self.ferralla.pk, LUNES)
        # B saca un camion el 21, el 23, el 25, el 30 y el 02; A, 2 el 24 y 3 el 25.
        self.assertEqual((plan['envios'][b.pk]['desde'], plan['envios'][a.pk]['desde']), ('2026-09-21', '2026-09-24'))
        # Se fabrica por camiones: el 25 tienen que estar los de B hasta ese dia
        # y todo A (64 modulos), no B entero antes que A (que pediria 8 al dia).
        self.assertEqual([(t['ritmo'], t['dias']) for t in plan['tramos']], [(6.4, 10), (3.2, 5)])
        self.assertEqual(plan['proyectos'][b.pk]['fabricacion_inicio'], '2026-09-14')
        self.assertLess(plan['proyectos'][a.pk]['fabricacion_fin'], plan['proyectos'][b.pk]['fabricacion_fin'])

    def test_lo_en_estudio_sale_en_sus_dias_y_se_ve_lo_que_no_cabe(self):
        real = self.forjado('Real', date(2026, 9, 29), 48)
        estudio = self.forjado('Estudio', date(2026, 9, 28), 48, fantasma=True)
        solo_real = plan_patio(self.ferralla.pk, LUNES)
        con = plan_patio(self.ferralla.pk, LUNES, con_fantasmas=True)
        self.assertEqual(con['envios'][real.pk], solo_real['envios'][real.pk])
        self.assertEqual((con['envios'][real.pk]['desde'], con['envios'][real.pk]['hasta']), ('2026-09-24', '2026-09-28'))
        # Tampoco el que esta en estudio se adelanta: los dias que coinciden salen de mas.
        self.assertEqual((con['envios'][estudio.pk]['desde'], con['envios'][estudio.pk]['hasta']), ('2026-09-23', '2026-09-25'))
        self.assertEqual(solo_real['sobrecargas'], [])
        self.assertEqual(con['sobrecargas'], [(date(2026, 9, 24), 8.0), (date(2026, 9, 25), 8.0)])
        from .planificacion_moden import planificacion_ferralla

        camiones = planificacion_ferralla(self.ferralla, LUNES, LUNES + timedelta(days=60), vista=2)['camiones']
        self.assertEqual(camiones['sobrecargas_real'], [])
        self.assertEqual(camiones['sobrecargas_con_fantasmas'],
                         [{'fecha': '2026-09-24', 'camiones': 8.0}, {'fecha': '2026-09-25', 'camiones': 8.0}])

    def test_la_ficha_guarda_el_dia_solo_de_los_movidos_y_avisa_si_salen_de_mas(self):
        proyecto = self.forjado('A', date(2026, 9, 28), 12)
        self.client.force_authenticate(self.oficina)
        url = f'/api/proyectos/{proyecto.pk}/camiones/'
        datos = self.client.get(url).data
        self.assertEqual([(c['fecha_fija'], c['por_defecto']) for c in datos['camiones']], [(False, True)] * 3)
        self.assertEqual(datos['montaje'], '2026-09-28')
        filas = [{'fecha': c['fecha'], 'fecha_fija': False, 'bastidores': c['bastidores']} for c in datos['camiones']]
        # Ninguno despues del montaje; el dia del montaje, si.
        filas[0] = {'fecha': '2026-09-29', 'fecha_fija': True, 'bastidores': 2}
        self.assertEqual(self.client.put(url, {'camiones': filas}, format='json').status_code, 400)
        filas[0] = {'fecha': '2026-09-28', 'fecha_fija': True, 'bastidores': 2}
        self.assertEqual(self.client.put(url, {'camiones': filas}, format='json').status_code, 200)
        filas[0] = {'fecha': '2026-09-18', 'fecha_fija': True, 'bastidores': 2}
        respuesta = self.client.put(url, {'camiones': filas}, format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.assertEqual(list(Camion.objects.filter(proyecto=proyecto).values_list('fecha', 'bastidores')),
                         [(date(2026, 9, 18), 2), (None, 4), (None, 4)])
        # Los 2 que ya no lleva el primero van en un cuarto camion del reparto.
        self.assertEqual([(c['fecha_fija'], c['bastidores']) for c in respuesta.data['camiones']],
                         [(True, 2), (False, 4), (False, 4), (False, 2)])

        # Volver al reparto no olvida lo enviado.
        Camion.objects.filter(proyecto=proyecto, orden=2).update(fecha=date(2026, 9, 11), enviado=True, enviado_at=timezone.now())
        vuelta = self.client.delete(url).data
        self.assertEqual(list(Camion.objects.filter(proyecto=proyecto).values_list('orden', 'fecha', 'enviado')),
                         [(1, date(2026, 9, 11), True)])
        self.assertEqual([(c['fecha'], c['enviado']) for c in vuelta['camiones']],
                         [('2026-09-11', True), ('2026-09-25', False), ('2026-09-25', False)])

        # Todos a mano el mismo dia: salen 12 camiones donde caben 4.
        grande = self.forjado('B', date(2026, 10, 5), 48)
        Camion.objects.bulk_create([
            Camion(proyecto=grande, orden=i, fecha=date(2026, 10, 2), bastidores=4) for i in range(1, 13)
        ])
        self.assertEqual(plan_patio(self.ferralla.pk, LUNES)['sobrecargas'], [(date(2026, 10, 2), 12.0)])

    def test_moden_elige_los_camiones_al_dia_y_los_dias_de_envio(self):
        from .models import UserProfile

        proyecto = self.forjado('A', date(2026, 9, 28), 48)
        otra = User.objects.create_user('reparto-otra')
        ajeno = Proyecto.objects.create(nombre='Ajeno', usuario=otra, fecha_montaje=date(2026, 9, 28))
        movido = Camion.objects.create(proyecto=proyecto, orden=1, fecha=date(2026, 9, 14), bastidores=4)
        enviado = Camion.objects.create(proyecto=proyecto, orden=2, fecha=date(2026, 9, 11), bastidores=4,
                                        enviado=True, enviado_at=timezone.now())
        url = f'/api/planificacion-moden/camiones/{self.ferralla.pk}/'
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.put(url, {'camiones_por_dia': 2}, format='json').status_code, 403)

        self.client.force_authenticate(self.oficina)
        for malo in ({'camiones_por_dia': 0}, {'proyectos': [{'id': proyecto.pk, 'dias_envio': 0}]},
                     {'proyectos': [{'id': ajeno.pk, 'dias_envio': 3}]}, {'camiones_por_dia': 'muchos'}):
            self.assertEqual(self.client.put(url, malo, format='json').status_code, 400, malo)
        respuesta = self.client.put(url, {'camiones_por_dia': 2, 'proyectos': [{'id': proyecto.pk, 'dias_envio': 8}]},
                                    format='json')
        self.assertEqual(respuesta.status_code, 200, respuesta.data)
        self.assertEqual(respuesta.data, {'camiones_por_dia': 2, 'proyectos': [{'id': proyecto.pk, 'dias_envio': 8}]})
        self.assertEqual(UserProfile.objects.get(user=self.ferralla).camiones_por_dia, 2)
        # El que se movio en la ficha vuelve al reparto; el enviado se queda donde salio.
        movido.refresh_from_db()
        enviado.refresh_from_db()
        self.assertIsNone(movido.fecha)
        self.assertEqual(enviado.fecha, date(2026, 9, 11))
        # Vaciar los dias: los justos otra vez.
        self.client.put(url, {'proyectos': [{'id': proyecto.pk, 'dias_envio': None}]}, format='json')
        proyecto.refresh_from_db()
        self.assertIsNone(proyecto.dias_envio)

    def test_la_planificacion_2_trae_los_camiones_de_todas_las_obras_como_su_ficha(self):
        from unittest.mock import patch

        from .acopio import camiones_de_la_ferralla, camiones_del_proyecto

        grande = self.forjado('Grande', date(2026, 9, 28), 48)
        estudio = self.forjado('Estudio', date(2026, 9, 21), 10, fantasma=True)
        self.forjado('Pasado', date(2026, 9, 11), 8)
        Camion.objects.create(proyecto=grande, orden=1, fecha=date(2026, 9, 21), bastidores=4)
        datos = camiones_de_la_ferralla(self.ferralla.pk, LUNES)
        self.assertEqual(datos['camiones_por_dia'], 4)
        # Por montaje; lo ya montado no.
        self.assertEqual([(f['nombre'], f['fantasma'], f['montaje']) for f in datos['proyectos']],
                         [('Estudio', True, '2026-09-21'), ('Grande', False, '2026-09-28')])
        for fila in datos['proyectos']:
            proyecto = Proyecto.objects.get(pk=fila['id'])
            ficha = {k: v for k, v in fila.items() if k not in ('id', 'nombre', 'fantasma')}
            self.assertEqual(ficha, camiones_del_proyecto(proyecto, LUNES), fila['nombre'])
        self.assertFalse(datos['proyectos'][1]['por_defecto'])

        url = f'/api/planificacion-moden/camiones/{self.ferralla.pk}/'
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get(url).status_code, 403)
        self.client.force_authenticate(self.oficina)
        with patch('django.utils.timezone.localdate', return_value=LUNES):
            respuesta = self.client.get(url)
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual([f['id'] for f in respuesta.data['proyectos']], [estudio.pk, grande.pk])

    def test_por_defecto_vuelve_a_los_dias_justos(self):
        proyecto = self.forjado('A', date(2026, 9, 28), 48)
        Proyecto.objects.filter(pk=proyecto.pk).update(dias_envio=8)
        Camion.objects.create(proyecto=proyecto, orden=1, fecha=date(2026, 9, 14), bastidores=4)
        self.client.force_authenticate(self.oficina)
        respuesta = self.client.delete(f'/api/proyectos/{proyecto.pk}/camiones/')
        self.assertEqual(respuesta.status_code, 200)
        proyecto.refresh_from_db()
        self.assertIsNone(proyecto.dias_envio)
        self.assertIsNone(respuesta.data['envio']['dias_elegidos'])
        self.assertTrue(respuesta.data['por_defecto'])
