import hashlib
import secrets
from datetime import date, datetime, time
from importlib import import_module

from django.apps import apps
from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import EventoFabricacion, Mesa, MesaQueueItem, MesaQueueStatus, Modulo, Proyecto, UserProfile
from .planning import plan_ferralla
from .turnos import Jornada, leer_turnos, tramos, turnos_de

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


class TurnosPlanYEstadisticasTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('ferralla-turnos')
        self.profile = UserProfile.objects.create(user=self.user, turnos=[MANANA, NOCHE], capacidad_diaria_modulos=25)
        self.client.force_authenticate(self.user)
        self.project = Proyecto.objects.create(nombre='Obra', usuario=self.user, fecha_montaje=date(2026, 10, 9))
        self.mesa = Mesa.objects.create(nombre='Mesa 1', usuario=self.user, tipo='INFERIOR', indice=1)

    def test_el_plan_cuenta_turnos_y_la_capacidad_es_por_turno(self):
        Modulo.objects.bulk_create([Modulo(nombre=f'A{i}', proyecto=self.project) for i in range(100)])
        plan = plan_ferralla(self.user.pk, today=date(2026, 9, 28))
        fila = plan['proyectos'][self.project.pk]
        # Del lunes 28 al jueves 8: 9 turnos de manana y 9 de noche.
        self.assertEqual(fila['dias_disponibles'], 18)
        self.assertEqual((plan['ritmo'], plan['capacidad']), (6, 25))
        # A 25 por turno y dos turnos al dia, 100 modulos son lunes y martes.
        self.assertEqual((fila['fabricacion_inicio'], fila['fabricacion_fin']), ('2026-09-28', '2026-09-29'))
        self.assertEqual(fila['modulos_hoy'], 50)
        self.assertIn('SUN', fila['dias_produccion'])
        # Apagado el turno de noche, el mismo trabajo lleva cuatro dias.
        self.profile.turnos = [MANANA, {**NOCHE, 'activo': False}]
        self.profile.save()
        fila = plan_ferralla(self.user.pk, today=date(2026, 9, 28))['proyectos'][self.project.pk]
        self.assertEqual((fila['dias_disponibles'], fila['fabricacion_fin'], fila['modulos_hoy']), (9, '2026-10-01', 25))

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
        self.assertEqual(stats['range']['dias'], [{'fecha': '2026-09-28', 'turnos': 2.0, 'horas': 20.0}])
        horas = stats['range']['horas']
        self.assertEqual((horas[0], horas[4], horas[5], horas[-1]), ('00', '04', '06', '23'))
        self.assertEqual(stats['turnos'], [{'indice': 0, 'nombre': 'Mañana'}, {'indice': 1, 'nombre': 'Noche'}])
        self.assertEqual({m['nombre']: m['turno'] for m in stats['modulos']}, {'M1': 'Mañana'})

        # Lo de las 00:20 del martes cuenta el martes; con el filtro de noche,
        # solo lo hecho en horas de noche.
        martes = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29'}).data
        self.assertEqual(martes['totals']['modulos_completados'], 2)
        noche_stats = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29', 'turno': 1}).data
        self.assertEqual(noche_stats['turno'], 1)
        self.assertEqual([m['nombre'] for m in noche_stats['modulos']], ['N1'])
        self.assertEqual(noche_stats['totals']['horas_productivas'], 10.0)
        self.assertEqual(noche_stats['range']['dias'], [{'fecha': '2026-09-29', 'turnos': 1.0, 'horas': 10.0}])
        fila_noche = noche_stats['modulos'][0]
        self.assertEqual((fila_noche['inferior']['minutos'], fila_noche['inferior']['medido']), (40.0, True))

    def test_el_objetivo_de_un_turno_es_su_parte_de_los_turnos(self):
        Modulo.objects.bulk_create([Modulo(nombre=f'A{i}', proyecto=self.project) for i in range(100)])
        todos = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28'}).data
        manana = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28', 'turno': 0}).data
        self.assertEqual(todos['esperado']['modulos_esperados'], 12)  # 6 por turno, dos turnos
        self.assertEqual(manana['esperado']['modulos_esperados'], 6)


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

    def test_un_turno_tiene_que_durar_algo_y_no_se_repiten_nombres(self):
        url = f'/api/users/{self.ferralla.pk}/capture-config/'
        vacio = {**self._turno(MANANA), 'horario': [{'day': 'MON', 'start_time': '06:00', 'end_time': '06:00'}]}
        self.assertEqual(self.client.put(url, {'turnos': [vacio], 'interval_seconds': 20}, format='json').status_code, 400)
        repetido = [self._turno(MANANA), self._turno(MANANA)]
        self.assertEqual(self.client.put(url, {'turnos': repetido, 'interval_seconds': 20}, format='json').status_code, 400)

    def test_la_migracion_pasa_el_horario_a_un_turno_y_la_capacidad_a_25(self):
        migracion = import_module('api.migrations.0079_turnos_desde_horario')
        con_viernes = UserProfile.objects.create(
            user=self.ferralla, capacidad_diaria_modulos=35,
            capture_horario={'MON': ['06:30', '16:30'], 'FRI': ['06:30', '14:30']},
        )
        propia = UserProfile.objects.create(user=self.admin, capacidad_diaria_modulos=30, turnos=[NOCHE])
        migracion.horario_como_turno(apps, None)
        con_viernes.refresh_from_db()
        propia.refresh_from_db()
        self.assertEqual(con_viernes.turnos, [{'nombre': 'Mañana', 'activo': True,
                                               'horario': {'MON': ['06:30', '16:30'], 'FRI': ['06:30', '14:30']}}])
        self.assertEqual(con_viernes.capacidad_diaria_modulos, 25)
        self.assertEqual((propia.turnos, propia.capacidad_diaria_modulos), ([NOCHE], 30))
