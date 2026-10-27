import hashlib
import secrets
from datetime import date, datetime, time
from importlib import import_module
from unittest.mock import patch

from django.apps import apps
from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (
    EventoFabricacion, HistorialTurnos, Mesa, MesaQueueItem, MesaQueueStatus, Modulo, Proyecto, UserProfile,
)
from .planning import plan_ferralla
from .turnos import PRINCIPIO, Jornada, Vigencias, leer_turnos, tramos, turnos_de

MANANA = {'nombre': 'Mañana', 'activo': True,
          'horario': {day: ['06:00', '16:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}
NOCHE = {'nombre': 'Noche', 'activo': True,
         'horario': {day: ['19:00', '05:00'] for day in ('SUN', 'MON', 'TUE', 'WED', 'THU')}}


def aware(*args):
    return timezone.make_aware(datetime(*args))


class TurnosTests(TestCase):
    def test_el_turno_de_noche_cuenta_para_el_dia_en_que_empieza(self):
        turnos = leer_turnos([MANANA, NOCHE])
        lunes = date(2026, 9, 28)
        del_lunes = tramos(turnos, lunes, lunes)
        self.assertEqual([(t.turno.nombre, t.inicio, t.fin) for t in del_lunes], [
            ('Mañana', aware(2026, 9, 28, 6), aware(2026, 9, 28, 16)),
            ('Noche', aware(2026, 9, 28, 19), aware(2026, 9, 29, 5)),
        ])
        jornada = Jornada(turnos, lunes, lunes)
        # El martes a las 03:00 es aun el turno de noche del lunes.
        self.assertEqual(jornada.dia_de(aware(2026, 9, 29, 3)), lunes)
        self.assertEqual(jornada.tramo_de(aware(2026, 9, 29, 3)).turno.nombre, 'Noche')
        # Entre turnos no se trabaja: de 15:00 a 20:00 solo cuentan dos horas.
        self.assertEqual(jornada.segundos_entre(aware(2026, 9, 28, 15), aware(2026, 9, 28, 20)), 2 * 3600)
        # El domingo solo hay turno de noche; un festivo no tiene turnos.
        self.assertEqual([t.turno.nombre for t in tramos(turnos, date(2026, 9, 27), date(2026, 9, 27))], ['Noche'])
        self.assertEqual(tramos(turnos, lunes, lunes, festivos={lunes}), [])

    def test_sin_turnos_guardados_se_usa_el_horario_de_antes_y_los_apagados_no_cuentan(self):
        user = User.objects.create_user('sin-turnos')
        profile = UserProfile.objects.create(
            user=user, capture_active_days=['MON'], capture_start_time=time(7), capture_end_time=time(15),
        )
        self.assertEqual([(t.nombre, t.horario) for t in turnos_de(profile)], [('Mañana', {'MON': (time(7), time(15))})])
        profile.turnos = [MANANA, {**NOCHE, 'activo': False}]
        self.assertEqual([t.nombre for t in turnos_de(profile)], ['Mañana'])
        self.assertEqual([t.nombre for t in turnos_de(profile, solo_activos=False)], ['Mañana', 'Noche'])


    def test_cada_dia_cuenta_con_los_turnos_que_tenia(self):
        antes = [turno for turno in leer_turnos([MANANA, {**NOCHE, 'activo': False}]) if turno.activo]
        vigencias = Vigencias([(date(2026, 10, 18), leer_turnos([MANANA, NOCHE])), (PRINCIPIO, antes)])
        cada_dia = tramos(vigencias, date(2026, 10, 15), date(2026, 10, 19))
        self.assertEqual([(t.fecha.isoformat(), t.turno.nombre) for t in cada_dia], [
            ('2026-10-15', 'Mañana'),
            ('2026-10-16', 'Mañana'),
            # El domingo 18, la primera noche; el lunes, los dos.
            ('2026-10-18', 'Noche'),
            ('2026-10-19', 'Mañana'), ('2026-10-19', 'Noche'),
        ])
        # Antes de la primera version, la primera.
        self.assertEqual([t.turno.nombre for t in tramos(vigencias, date(1999, 1, 4), date(1999, 1, 4))], ['Mañana'])


class TurnosPlanYEstadisticasTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('ferralla-turnos')
        self.profile = UserProfile.objects.create(user=self.user, turnos=[MANANA, NOCHE])
        self.client.force_authenticate(self.user)
        self.project = Proyecto.objects.create(nombre='Obra', usuario=self.user, fecha_montaje=date(2026, 10, 9))
        self.mesa = Mesa.objects.create(nombre='Mesa 1', usuario=self.user, tipo='INFERIOR', indice=1)

    def test_el_plan_va_por_dias_laborables_aunque_haya_dos_turnos(self):
        Modulo.objects.bulk_create([Modulo(nombre=f'A{i}', proyecto=self.project) for i in range(100)])
        plan = plan_ferralla(self.user.pk, today=date(2026, 9, 28))
        fila = plan['proyectos'][self.project.pk]
        # Del lunes 28 al jueves 8: 9 dias laborables, con o sin turno de noche.
        self.assertEqual((fila['dias_disponibles'], plan['ritmo'], plan['objetivo_hoy']), (9, 11.1, 11.1))
        self.assertEqual((fila['fabricacion_inicio'], fila['fabricacion_fin'], fila['margen_dias']), ('2026-09-28', '2026-10-08', 0))
        self.assertEqual((fila['modulos_hoy'], fila['modulos_semana']), (11, 56))
        self.assertNotIn('SUN', fila['dias_produccion'])
        self.profile.turnos = [MANANA, {**NOCHE, 'activo': False}]
        self.profile.save()
        self.assertEqual(plan_ferralla(self.user.pk, today=date(2026, 9, 28))['ritmo'], 11.1)

    def _hecho(self, nombre, at):
        modulo = Modulo.objects.create(nombre=nombre, proyecto=self.project, estado='COMPLETADO',
                                       inferior_hecho=True, superior_hecho=True, completado_at=at)
        return MesaQueueItem.objects.create(modulo=modulo, mesa=self.mesa, fase='INFERIOR',
                                            status=MesaQueueStatus.HECHO, done_at=at)

    def test_las_estadisticas_van_por_dia_del_calendario_y_se_filtran_por_turno(self):
        self._hecho('M1', aware(2026, 9, 28, 10))        # lunes, manana
        noche = self._hecho('N1', aware(2026, 9, 29, 0, 20))  # madrugada del martes (noche del lunes)
        self._hecho('M2', aware(2026, 9, 29, 10))        # martes, manana
        # Panel de noche que pasa la medianoche: 40 minutos medidos.
        for tipo, at in (('INICIO', aware(2026, 9, 28, 23, 40)), ('FIN', aware(2026, 9, 29, 0, 20))):
            EventoFabricacion.objects.create(item=noche, mesa=self.mesa, modulo=noche.modulo, fase='INFERIOR', tipo=tipo, at=at)

        # El lunes es de 00:00 a 24:00: la madrugada (noche del domingo), la
        # manana y el principio de su noche.
        stats = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28'}).data
        self.assertEqual(stats['totals']['modulos_completados'], 1)
        self.assertEqual(stats['totals']['horas_productivas'], 20.0)
        self.assertEqual([{k: v for k, v in d.items() if k != 'objetivo'} for d in stats['range']['dias']],
                         [{'fecha': '2026-09-28', 'turnos': 2.0, 'horas': 20.0}])
        horas = stats['range']['horas']
        self.assertEqual((horas[0], horas[4], horas[5], horas[-1]), ('00', '04', '06', '23'))
        self.assertEqual(stats['turnos'], [{'indice': 0, 'nombre': 'Mañana'}, {'indice': 1, 'nombre': 'Noche'}])
        self.assertEqual({m['nombre']: m['turno'] for m in stats['modulos']}, {'M1': 'Mañana'})

        # Lo de las 00:20 del martes cuenta el martes.
        martes = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29'}).data
        self.assertEqual(martes['totals']['modulos_completados'], 2)
        self.assertIsNone(martes['range']['eje'])

        # Con el turno de noche, el martes es la noche del lunes al martes
        # entera. Lo hecho justo antes o despues cuenta en el turno mas cercano.
        self._hecho('N0', aware(2026, 9, 28, 18, 40))   # antes de empezar la noche
        self._hecho('N2', aware(2026, 9, 29, 5, 20))    # al acabar la noche
        noche_stats = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29', 'turno': 1}).data
        self.assertEqual(noche_stats['turno'], 1)
        self.assertEqual(sorted(m['nombre'] for m in noche_stats['modulos']), ['N0', 'N1', 'N2'])
        self.assertEqual(noche_stats['totals']['horas_productivas'], 10.0)
        self.assertEqual([{k: v for k, v in d.items() if k != 'objetivo'} for d in noche_stats['range']['dias']],
                         [{'fecha': '2026-09-29', 'turnos': 1.0, 'horas': 10.0}])
        # La grafica: de una hora antes (18h del lunes) a la hora en que acaba (05h).
        eje = noche_stats['range']['eje']
        self.assertEqual([h['hora'] for h in eje], ['18', '19', '20', '21', '22', '23', '00', '01', '02', '03', '04', '05'])
        self.assertTrue(eje[0]['inicio'].startswith('2026-09-28T18:00'))
        self.assertEqual(noche_stats['range']['horas'], ['19', '20', '21', '22', '23', '00', '01', '02', '03', '04'])
        fila_noche = next(m for m in noche_stats['modulos'] if m['nombre'] == 'N1')
        self.assertEqual((fila_noche['inferior']['minutos'], fila_noche['inferior']['medido']), (40.0, True))
        # Lo de la manana sigue siendo de la manana.
        manana = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29', 'turno': 0}).data
        self.assertEqual([m['nombre'] for m in manana['modulos']], ['M2'])

    def test_los_kilos_por_hora_hombre_usan_las_personas_fijas_de_cada_turno(self):
        # Sin personas configuradas no hay cifra.
        sin = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28'}).data['totals']
        self.assertEqual((sin['horas_hombre'], sin['kg_por_hora_hombre']), (0.0, None))

        self.profile.turnos = [{**MANANA, 'personas': 4}, {**NOCHE, 'personas': 2}]
        self.profile.save(update_fields=['turnos'])
        # Lunes 28: madrugada de la noche del domingo (5 h x 2), manana (10 h x 4)
        # y el principio de su noche (5 h x 2).
        lunes = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28'}).data['totals']
        self.assertEqual((lunes['horas_productivas'], lunes['horas_hombre']), (20.0, 60.0))
        self.assertEqual(lunes['kg_por_hora_hombre'], 0.0)
        # Solo la noche del lunes al martes: 10 h x 2 personas.
        noche = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29', 'turno': 1}).data['totals']
        self.assertEqual((noche['horas_productivas'], noche['horas_hombre']), (10.0, 20.0))

    def test_las_estadisticas_de_cada_dia_usan_los_turnos_que_habia_ese_dia(self):
        self.profile.turnos = [{**MANANA, 'personas': 4}, {**NOCHE, 'personas': 2}]
        self.profile.save(update_fields=['turnos'])
        # Hasta el lunes 28 solo habia manana, con 3 personas.
        HistorialTurnos.objects.create(ferralla=self.user, desde=PRINCIPIO,
                                       turnos=[{**MANANA, 'personas': 3}, {**NOCHE, 'activo': False}])
        HistorialTurnos.objects.create(ferralla=self.user, desde=date(2026, 9, 28), turnos=self.profile.turnos)
        dia = lambda fecha: self.client.get('/api/stats/production/', {'from': fecha, 'to': fecha}).data['totals']

        viernes = dia('2026-09-25')
        self.assertEqual((viernes['horas_productivas'], viernes['horas_hombre']), (10.0, 30.0))
        # El lunes 28 ya con los de ahora, pero la noche del domingo aun no existia:
        # manana (10 h x 4) y el principio de su noche (5 h x 2).
        lunes = dia('2026-09-28')
        self.assertEqual((lunes['horas_productivas'], lunes['horas_hombre']), (15.0, 50.0))

    def test_el_objetivo_de_un_turno_es_su_parte_de_los_turnos(self):
        Modulo.objects.bulk_create([Modulo(nombre=f'A{i}', proyecto=self.project) for i in range(100)])
        todos = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28'}).data
        manana = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28', 'turno': 0}).data
        # 100 modulos en los 9 dias laborables hasta el 09/10: 11,1 al dia, y la
        # manana es la mitad de los dos turnos que empiezan el lunes.
        self.assertEqual(todos['esperado']['modulos_esperados'], 11)
        self.assertEqual(manana['esperado']['modulos_esperados'], 6)
        self.assertEqual(manana['esperado']['por_dia'], {'2026-09-28': 5.5})
        # La noche que acaba el martes es la del lunes: su objetivo es la otra
        # mitad del lunes y se ve el martes. El viernes no tiene noche propia.
        noche = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-10-03', 'turno': 1}).data
        self.assertEqual(noche['esperado']['por_dia'], {'2026-09-29': 5.5, '2026-09-30': 5.5, '2026-10-01': 5.5, '2026-10-02': 5.5})
        self.assertEqual(noche['esperado']['modulos_esperados'], 22)
        dias = {d['fecha']: d['objetivo'] for d in noche['range']['dias']}
        self.assertEqual(dias['2026-09-29'], 5.5)


class TurnosConfiguracionTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user('oficina-turnos', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla-config')
        self.mesa = Mesa.objects.create(nombre='Mesa 1', usuario=self.ferralla, tipo='INFERIOR', indice=1)
        self.client.force_authenticate(self.admin)

    def _turno(self, turno):
        return {
            'nombre': turno['nombre'], 'activo': turno['activo'],
            'horario': [{'day': day, 'start_time': a, 'end_time': b} for day, (a, b) in turno['horario'].items()],
        }

    def test_se_guardan_turnos_que_cruzan_la_medianoche_y_el_mini_pc_hace_fotos_todo_el_dia(self):
        url = f'/api/users/{self.ferralla.pk}/capture-config/'
        response = self.client.put(url, {'turnos': [self._turno(MANANA), self._turno(NOCHE)], 'interval_seconds': 20}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        datos = self.client.get(url).data
        self.assertEqual([(t['nombre'], t['activo']) for t in datos['turnos']], [('Mañana', True), ('Noche', True)])
        self.assertEqual(datos['turnos'][1]['horario'][0], {'day': 'MON', 'start_time': '19:00', 'end_time': '05:00'})
        self.assertEqual(datos['capture_window'], {'start_time': '00:00', 'end_time': '23:59'})

        raw = secrets.token_urlsafe(32)
        self.mesa.device_token_hash = hashlib.sha256(raw.encode()).hexdigest()
        self.mesa.save(update_fields=['device_token_hash'])
        self.client.force_authenticate(None)
        schedule = self.client.get('/api/device/config/', HTTP_AUTHORIZATION=f'Bearer {raw}').data['schedule']
        # La noche del jueves acaba el viernes; la del domingo empieza el domingo.
        self.assertEqual(schedule['active_days'], ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SUN'])
        self.assertEqual((schedule['start_time'], schedule['end_time']), ('00:00', '23:59'))

    def test_las_personas_de_cada_turno_se_guardan_y_vuelven(self):
        url = f'/api/users/{self.ferralla.pk}/capture-config/'
        turnos = [{**self._turno(MANANA), 'personas': 6}, self._turno(NOCHE)]
        response = self.client.put(url, {'turnos': turnos, 'interval_seconds': 20}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        datos = self.client.get(url).data
        self.assertEqual([(t['nombre'], t['personas']) for t in datos['turnos']], [('Mañana', 6), ('Noche', 0)])
        negativo = [{**self._turno(MANANA), 'personas': -1}]
        self.assertEqual(self.client.put(url, {'turnos': negativo, 'interval_seconds': 20}, format='json').status_code, 400)

    def test_un_turno_tiene_que_durar_algo_y_no_se_repiten_nombres(self):
        url = f'/api/users/{self.ferralla.pk}/capture-config/'
        vacio = {**self._turno(MANANA), 'horario': [{'day': 'MON', 'start_time': '06:00', 'end_time': '06:00'}]}
        self.assertEqual(self.client.put(url, {'turnos': [vacio], 'interval_seconds': 20}, format='json').status_code, 400)
        repetido = [self._turno(MANANA), self._turno(MANANA)]
        self.assertEqual(self.client.put(url, {'turnos': repetido, 'interval_seconds': 20}, format='json').status_code, 400)

    def test_cambiar_los_turnos_vale_desde_hoy_y_lo_de_antes_se_queda(self):
        url = f'/api/users/{self.ferralla.pk}/capture-config/'
        UserProfile.objects.create(user=self.ferralla, turnos=[{**MANANA, 'personas': 3}])
        guardar = lambda personas: self.client.put(
            url, {'turnos': [{**self._turno(MANANA), 'personas': personas}], 'interval_seconds': 20}, format='json',
        )
        historial = lambda: [(v.desde, v.turnos[0]['personas']) for v in HistorialTurnos.objects.filter(ferralla=self.ferralla)]

        with patch('django.utils.timezone.localdate', return_value=date(2026, 10, 27)):
            self.assertEqual(guardar(5).status_code, 200)
            # Lo que habia, desde siempre; lo nuevo, desde hoy.
            self.assertEqual(historial(), [(PRINCIPIO, 3), (date(2026, 10, 27), 5)])
            # Otro cambio el mismo dia corrige el de hoy; sin cambios, nada.
            guardar(6)
            guardar(6)
            self.assertEqual(historial(), [(PRINCIPIO, 3), (date(2026, 10, 27), 6)])
        with patch('django.utils.timezone.localdate', return_value=date(2026, 11, 2)):
            guardar(4)
        self.assertEqual(historial(), [(PRINCIPIO, 3), (date(2026, 10, 27), 6), (date(2026, 11, 2), 4)])

    def test_la_migracion_deja_el_turno_de_noche_desde_el_18_de_octubre(self):
        migracion = import_module('api.migrations.0089_historial_turnos_inicial')
        UserProfile.objects.create(user=self.ferralla, turnos=[{**MANANA, 'personas': 4}, {**NOCHE, 'personas': 4}])
        UserProfile.objects.create(user=self.admin, turnos=[MANANA])
        migracion.turnos_iniciales(apps, None)
        migracion.turnos_iniciales(apps, None)

        versiones = lambda user: [
            (v.desde, [(t['nombre'], t['activo'], t['personas']) for t in v.turnos])
            for v in HistorialTurnos.objects.filter(ferralla=user)
        ]
        self.assertEqual(versiones(self.ferralla), [
            (PRINCIPIO, [('Mañana', True, 4), ('Noche', False, 4)]),
            (date(2026, 10, 18), [('Mañana', True, 4), ('Noche', True, 4)]),
        ])
        self.assertEqual(versiones(self.admin), [(PRINCIPIO, [('Mañana', True, 0)])])
        # El horario, el de hoy.
        self.assertEqual(HistorialTurnos.objects.filter(ferralla=self.ferralla).first().turnos[0]['horario'], MANANA['horario'])

    def test_la_migracion_pasa_el_horario_a_un_turno(self):
        migracion = import_module('api.migrations.0079_turnos_desde_horario')
        con_viernes = UserProfile.objects.create(
            user=self.ferralla, capture_horario={'MON': ['06:30', '16:30'], 'FRI': ['06:30', '14:30']},
        )
        propia = UserProfile.objects.create(user=self.admin, turnos=[NOCHE])
        migracion.horario_como_turno(apps, None)
        con_viernes.refresh_from_db()
        propia.refresh_from_db()
        self.assertEqual(con_viernes.turnos, [{'nombre': 'Mañana', 'activo': True,
                                               'horario': {'MON': ['06:30', '16:30'], 'FRI': ['06:30', '14:30']}}])
        self.assertEqual(propia.turnos, [NOCHE])
