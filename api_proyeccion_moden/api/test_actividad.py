from datetime import date, datetime, timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .actividad import huecos, sesiones, solape, union
from .models import (
    DetalleModuloFase, EventoFabricacion, FotoFabricacion, Mesa, MesaQueueItem, MesaQueueStatus, Modulo, Proyecto, UserProfile,
)


def aware(*args):
    return timezone.make_aware(datetime(*args))


MANANA = {'nombre': 'Mañana', 'activo': True,
          'horario': {day: ['06:00', '16:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}


class SesionesTests(SimpleTestCase):
    def test_las_senales_cercanas_forman_una_sesion_y_los_huecos_grandes_la_cortan(self):
        base = aware(2026, 9, 28, 8)
        senales = [(base + timedelta(minutes=m), 'evento') for m in (0, 5, 12, 40, 45)]
        self.assertEqual(sesiones(senales, timedelta(minutes=20)), [
            (base, base + timedelta(minutes=12)), (base + timedelta(minutes=40), base + timedelta(minutes=45)),
        ])
        # Con 45 minutos (solo fotos) todo es una sesion.
        self.assertEqual(sesiones(senales, timedelta(minutes=45)), [(base, base + timedelta(minutes=45))])
        self.assertEqual(sesiones([], timedelta(minutes=20)), [])

    def test_la_fabrica_es_la_union_de_sus_mesas(self):
        base = aware(2026, 9, 28, 8)
        mesa1 = [(base, base + timedelta(hours=2))]
        mesa2 = [(base + timedelta(hours=1), base + timedelta(hours=3)), (base + timedelta(hours=5), base + timedelta(hours=6))]
        fabrica = union(mesa1 + mesa2)
        self.assertEqual(fabrica, [(base, base + timedelta(hours=3)), (base + timedelta(hours=5), base + timedelta(hours=6))])
        turno = (base - timedelta(hours=2), base + timedelta(hours=8))
        self.assertEqual(solape(fabrica, *turno), 4 * 3600)
        self.assertEqual(huecos(fabrica, *turno), [
            (base - timedelta(hours=2), base), (base + timedelta(hours=3), base + timedelta(hours=5)),
            (base + timedelta(hours=6), base + timedelta(hours=8)),
        ])


class ActividadEnEstadisticasTests(APITestCase):
    """Lunes 28/09/2026, turno 06:00-16:00, dos mesas inferiores y una superior."""

    def setUp(self):
        self.user = User.objects.create_user('ferralla-actividad')
        UserProfile.objects.create(user=self.user, turnos=[MANANA])
        self.client.force_authenticate(self.user)
        self.project = Proyecto.objects.create(nombre='Obra', usuario=self.user, fecha_montaje=date(2026, 10, 30))
        self.mesa1 = Mesa.objects.create(nombre='Mesa 1', usuario=self.user, tipo='INFERIOR', indice=1)
        self.mesa2 = Mesa.objects.create(nombre='Mesa 2', usuario=self.user, tipo='INFERIOR', indice=2)
        self.mesa3 = Mesa.objects.create(nombre='Mesa 3', usuario=self.user, tipo='SUPERIOR', indice=1)

    def _fase(self, mesa, nombre, fase, done_at, pasos=()):
        modulo, _ = Modulo.objects.get_or_create(nombre=nombre, proyecto=self.project)
        item = MesaQueueItem.objects.create(modulo=modulo, mesa=mesa, fase=fase, status=MesaQueueStatus.HECHO, done_at=done_at)
        for indice, at in enumerate(pasos):
            EventoFabricacion.objects.create(item=item, mesa=mesa, modulo=modulo, fase=fase,
                                             tipo='INICIO' if indice == 0 else 'PASO', paso=indice, at=at)
        EventoFabricacion.objects.create(item=item, mesa=mesa, modulo=modulo, fase=fase, tipo='FIN', at=done_at)
        return item

    @staticmethod
    def _cada(desde, hasta, minutos=15):
        """Pasos cada ``minutos`` desde ``desde`` hasta antes de ``hasta``."""
        pasos = []
        momento = desde
        while momento < hasta:
            pasos.append(momento)
            momento += timedelta(minutes=minutos)
        return pasos

    def _stats(self, **params):
        return self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-28', **params}).data

    def test_el_dia_se_ensena_como_trabajo_mas_tiempo_muerto_con_sus_causas(self):
        # Mesa 1: empieza a las 07:00 (una hora tarde), trabaja hasta las 09:00,
        # para a comer de 13:00 a 14:00 y acaba a las 15:00.
        self._fase(self.mesa1, 'A1', 'INFERIOR', aware(2026, 9, 28, 9), pasos=self._cada(aware(2026, 9, 28, 7), aware(2026, 9, 28, 9)))
        self._fase(self.mesa1, 'A2', 'INFERIOR', aware(2026, 9, 28, 13), pasos=self._cada(aware(2026, 9, 28, 9, 10), aware(2026, 9, 28, 13)))
        self._fase(self.mesa1, 'A3', 'INFERIOR', aware(2026, 9, 28, 15), pasos=self._cada(aware(2026, 9, 28, 14), aware(2026, 9, 28, 15)))
        # La superior solo trabaja de 07:00 a 08:00 y luego nada mas.
        self._fase(self.mesa3, 'A1', 'SUPERIOR', aware(2026, 9, 28, 8), pasos=[aware(2026, 9, 28, 7, m) for m in (0, 20, 40)])
        stats = self._stats()
        totales = stats['totals']
        # Turno de 10 h: la fabrica trabajo de 07:00 a 13:00 y de 14:00 a 15:00 (7 h).
        self.assertEqual(totales['horas_productivas'], 10.0)
        self.assertEqual((totales['horas_trabajo'], totales['horas_muertas'], totales['horas_fuera_turno']), (7.0, 3.0, 0.0))
        self.assertEqual(stats['muerto_por_causa'], {'sin_registro': 0.0, 'empezo_tarde': 1.0, 'acabo_pronto': 1.0, 'paradas': 1.0})
        self.assertEqual(stats['criterio'], {'version': 'v1', 'umbral_min': 20, 'umbral_fotos_min': 45, 'sin_pulsar_min': 90})
        dia = stats['por_dia'][0]
        self.assertEqual((dia['horas_turno'], dia['horas_trabajo'], dia['horas_muertas'], dia['sin_registro'], dia['estimado']), (10.0, 7.0, 3.0, False, False))
        self.assertTrue(dia['abre'].endswith('07:00:00+02:00') and dia['cierra'].endswith('15:00:00+02:00'))
        # Por mesa: la superior tiene 9 h muertas de 10; la mesa 2, todo el turno sin tocar.
        por_mesa = {m['mesa_nombre']: m for m in stats['por_mesa']}
        self.assertEqual((por_mesa['Mesa 3']['horas_trabajo'], por_mesa['Mesa 3']['horas_muertas'], por_mesa['Mesa 3']['paradas']), (1.0, 9.0, 0))
        self.assertEqual((por_mesa['Mesa 1']['horas_trabajo'], por_mesa['Mesa 1']['horas_muertas'], por_mesa['Mesa 1']['paradas']), (7.0, 3.0, 1))
        # 7 h de trabajo para 3 paneles hechos en la mesa (aunque sus modulos no esten terminados).
        self.assertEqual(por_mesa['Mesa 1']['min_trabajo_por_panel'], 140.0)
        self.assertEqual((por_mesa['Mesa 2']['horas_trabajo'], por_mesa['Mesa 2']['horas_muertas']), (0.0, 10.0))
        # Por hora: a las 13 todo es muerto, a las 10 todo trabajo, a las 05 no hay turno.
        por_hora = {h['hora']: h for h in stats['por_hora']}
        self.assertEqual((por_hora['13']['minutos_trabajo'], por_hora['13']['minutos_muertos']), (0.0, 60.0))
        self.assertEqual((por_hora['10']['minutos_trabajo'], por_hora['10']['minutos_muertos']), (60.0, 0.0))
        self.assertNotIn('05', por_hora)
        # Modulos por hora de trabajo, no de turno: 2 modulos completos (A1 y A2 no, falta su superior)...
        self.assertEqual(totales['modulos_por_hora_trabajo'], round(totales['modulos_completados'] / 7.0, 2))

    def test_los_kilos_por_hora_hombre_salen_con_las_horas_trabajadas_y_con_todas(self):
        self.user.profile.turnos = [{**MANANA, 'personas': 3}]
        self.user.profile.save(update_fields=['turnos'])
        self._fase(self.mesa1, 'K1', 'INFERIOR', aware(2026, 9, 28, 13), pasos=self._cada(aware(2026, 9, 28, 7), aware(2026, 9, 28, 13)))
        self._fase(self.mesa1, 'K1', 'SUPERIOR', aware(2026, 9, 28, 15), pasos=self._cada(aware(2026, 9, 28, 14), aware(2026, 9, 28, 15)))
        Modulo.objects.filter(nombre='K1').update(estado='COMPLETADO', completado_at=aware(2026, 9, 28, 15))
        DetalleModuloFase.objects.create(modulo=Modulo.objects.get(nombre='K1'), fase='INFERIOR', peso_malla_final_kg=630)
        totales = self._stats()['totals']
        # 7 h trabajadas de un turno de 10, con 3 personas.
        self.assertEqual((totales['horas_hombre_trabajo'], totales['horas_hombre']), (21.0, 30.0))
        self.assertEqual((totales['kg_por_hora_hombre_trabajo'], totales['kg_por_hora_hombre']), (30.0, 21.0))

    def test_lo_trabajado_fuera_de_turno_cuenta_con_las_personas_del_turno_mas_cercano(self):
        self.user.profile.turnos = [{**MANANA, 'personas': 3}]
        self.user.profile.save(update_fields=['turnos'])
        # Viernes 2/10 de 07:00 a 09:00 (en turno) y sabado 3/10, sin turno, de 08:00 a 10:00.
        self._fase(self.mesa1, 'F1', 'INFERIOR', aware(2026, 10, 2, 9), pasos=self._cada(aware(2026, 10, 2, 7), aware(2026, 10, 2, 9)))
        self._fase(self.mesa1, 'F2', 'INFERIOR', aware(2026, 10, 3, 10), pasos=self._cada(aware(2026, 10, 3, 8), aware(2026, 10, 3, 10)))
        totales = self.client.get('/api/stats/production/', {'from': '2026-10-02', 'to': '2026-10-04'}).data['totals']
        self.assertEqual((totales['horas_trabajo'], totales['horas_hombre_trabajo']), (4.0, 12.0))
        # Sin kilos fabricados no hay cifra que dar, pero tampoco se rompe.
        self.assertEqual(totales['kg_por_hora_hombre_trabajo'], 0.0)

    def test_un_dia_sin_ninguna_senal_es_sin_registro_y_el_trabajo_fuera_de_turno_se_suma(self):
        # Martes 29: nadie toca nada. Lunes 28: trabajan de 05:00 a 07:00 (una hora antes del turno).
        self._fase(self.mesa1, 'B1', 'INFERIOR', aware(2026, 9, 28, 7), pasos=self._cada(aware(2026, 9, 28, 5), aware(2026, 9, 28, 7)))
        stats = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-09-29'}).data
        dias = {d['fecha']: d for d in stats['por_dia']}
        self.assertEqual((dias['2026-09-28']['horas_trabajo'], dias['2026-09-28']['horas_fuera_turno'], dias['2026-09-28']['horas_muertas']), (2.0, 1.0, 9.0))
        self.assertEqual((dias['2026-09-29']['horas_trabajo'], dias['2026-09-29']['horas_muertas'], dias['2026-09-29']['sin_registro']), (0.0, 10.0, True))
        self.assertEqual(stats['muerto_por_causa']['sin_registro'], 10.0)
        self.assertEqual(stats['totals']['horas_trabajo'], 2.0)

    def test_sin_eventos_se_estima_con_las_fotos_y_las_fases_hechas(self):
        modulo = Modulo.objects.create(nombre='C1', proyecto=self.project)
        item = MesaQueueItem.objects.create(modulo=modulo, mesa=self.mesa1, fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=aware(2026, 9, 28, 9))
        for m in (0, 30):
            # capturada_at se pone sola al crear: se fija despues.
            foto = FotoFabricacion.objects.create(modulo=modulo, mesa=self.mesa1, fase='INFERIOR', paso=m)
            FotoFabricacion.objects.filter(pk=foto.pk).update(capturada_at=aware(2026, 9, 28, 8, m))
        stats = self._stats()
        dia = stats['por_dia'][0]
        # Fotos a 30 min: con 45 de umbral son una sesion de 08:00 a 09:00.
        self.assertEqual((dia['horas_trabajo'], dia['estimado']), (1.0, True))
        # Una mesa con una fase hecha y nada mas cuenta su piso (40 min la inferior).
        MesaQueueItem.objects.create(modulo=Modulo.objects.create(nombre='C2', proyecto=self.project), mesa=self.mesa2,
                                     fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=aware(2026, 9, 28, 12))
        por_mesa = {m['mesa_nombre']: m for m in self._stats()['por_mesa']}
        self.assertEqual((por_mesa['Mesa 2']['horas_trabajo'], por_mesa['Mesa 2']['estimado']), (0.67, True))
        # Que la mesa 2 tenga fotos otro dia no le quita el piso a la fase hecha del lunes.
        for m in (0, 10):
            foto = FotoFabricacion.objects.create(modulo=modulo, mesa=self.mesa2, fase='INFERIOR', paso=m)
            FotoFabricacion.objects.filter(pk=foto.pk).update(capturada_at=aware(2026, 9, 29, 10, m))
        por_mesa = {m['mesa_nombre']: m for m in self._stats()['por_mesa']}
        self.assertEqual(por_mesa['Mesa 2']['horas_trabajo'], 0.67)

    def test_el_tiempo_de_cada_fase_es_trabajo_mas_parado(self):
        # Empieza el lunes a las 15:00, 3 pasos seguidos, y se marca hecha el martes a las 07:00.
        item = self._fase(self.mesa1, 'D1', 'INFERIOR', aware(2026, 9, 29, 7),
                          pasos=[aware(2026, 9, 28, 15, 0), aware(2026, 9, 28, 15, 10), aware(2026, 9, 28, 15, 40), aware(2026, 9, 28, 15, 55)])
        Modulo.objects.filter(nombre='D1').update(estado='COMPLETADO', completado_at=aware(2026, 9, 29, 7, 1))
        self._fase(self.mesa3, 'D1', 'SUPERIOR', aware(2026, 9, 29, 7, 1), pasos=[aware(2026, 9, 29, 6, 30), aware(2026, 9, 29, 6, 50)])
        stats = self.client.get('/api/stats/production/', {'from': '2026-09-29', 'to': '2026-09-29'}).data
        fila = next(m for m in stats['modulos'] if m['nombre'] == 'D1')
        inferior = fila['inferior']
        # Trabajo: 15:00-15:55 (el hueco de 30 min es "sin pulsar" y cuenta). Parado:
        # 15:55-07:00 (5 min de turno el lunes, 60 el martes y 14 h fuera), pernoctando.
        self.assertEqual(
            (inferior['minutos'], inferior['medido'], inferior['pernocto'], inferior['sin_pulsar_min']),
            (55.0, True, True, 30.0),
        )
        self.assertEqual((inferior['parado_turno_min'], inferior['parado_fuera_min']), (65.0, 14 * 60.0))
        self.assertEqual(fila['superior']['parado_min'], 0.0)

    def test_lo_que_queda_de_turno_no_es_tiempo_muerto(self):
        # Lunes 28 a las 10:00: la mesa 1 lleva trabajando desde las 06:00.
        self._fase(self.mesa1, 'E1', 'INFERIOR', aware(2026, 9, 28, 10), pasos=self._cada(aware(2026, 9, 28, 6), aware(2026, 9, 28, 10)))
        with mock.patch('django.utils.timezone.now', return_value=aware(2026, 9, 28, 10)):
            stats = self._stats()
        self.assertEqual(stats['totals']['horas_productivas'], 4.0)
        self.assertEqual((stats['totals']['horas_trabajo'], stats['totals']['horas_muertas']), (4.0, 0.0))
        self.assertEqual(stats['muerto_por_causa']['acabo_pronto'], 0.0)
        dia = stats['por_dia'][0]
        self.assertEqual((dia['horas_turno'], dia['horas_muertas']), (4.0, 0.0))
        self.assertNotIn('14', {h['hora'] for h in stats['por_hora']})
        # Las otras mesas llevan parado lo que va de turno, no el turno entero.
        por_mesa = {m['mesa_nombre']: m for m in stats['por_mesa']}
        self.assertEqual(por_mesa['Mesa 2']['horas_muertas'], 4.0)

    def test_el_trabajo_de_un_dia_sin_turno_se_suma_como_fuera_de_turno(self):
        # Viernes 2/10 de 07:00 a 09:00 y sabado 3/10 (sin turno) de 08:00 a 10:00.
        self._fase(self.mesa1, 'F1', 'INFERIOR', aware(2026, 10, 2, 9), pasos=self._cada(aware(2026, 10, 2, 7), aware(2026, 10, 2, 9)))
        self._fase(self.mesa1, 'F2', 'INFERIOR', aware(2026, 10, 3, 10), pasos=self._cada(aware(2026, 10, 3, 8), aware(2026, 10, 3, 10)))
        stats = self.client.get('/api/stats/production/', {'from': '2026-10-02', 'to': '2026-10-04'}).data
        self.assertEqual((stats['totals']['horas_trabajo'], stats['totals']['horas_fuera_turno']), (4.0, 2.0))
        dias = {d['fecha']: d for d in stats['por_dia']}
        self.assertEqual(
            (dias['2026-10-03']['horas_turno'], dias['2026-10-03']['horas_trabajo'], dias['2026-10-03']['horas_muertas']),
            (0.0, 2.0, 0.0),
        )
        # El domingo, sin turno ni trabajo, no sale.
        self.assertNotIn('2026-10-04', dias)

    def test_el_hueco_tras_una_pausa_es_parado_aunque_sea_corto(self):
        # G1 se aparta a las 10:10 para hacer G2 y vuelve a las 10:40: ese rato no es trabajo de G1.
        items = {}
        for nombre, done_at in (('G1', aware(2026, 9, 28, 11)), ('G2', aware(2026, 9, 28, 10, 40))):
            modulo = Modulo.objects.create(nombre=nombre, proyecto=self.project)
            items[nombre] = MesaQueueItem.objects.create(
                modulo=modulo, mesa=self.mesa1, fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=done_at,
            )
        for nombre, tipo, at in (
            ('G1', 'INICIO', aware(2026, 9, 28, 10, 0)), ('G1', 'PASO', aware(2026, 9, 28, 10, 5)), ('G1', 'PAUSA', aware(2026, 9, 28, 10, 10)),
            ('G2', 'INICIO', aware(2026, 9, 28, 10, 10)), ('G2', 'PASO', aware(2026, 9, 28, 10, 20)), ('G2', 'FIN', aware(2026, 9, 28, 10, 40)),
            ('G1', 'INICIO', aware(2026, 9, 28, 10, 40)), ('G1', 'PASO', aware(2026, 9, 28, 10, 50)), ('G1', 'FIN', aware(2026, 9, 28, 11)),
        ):
            item = items[nombre]
            EventoFabricacion.objects.create(item=item, mesa=self.mesa1, modulo=item.modulo, fase='INFERIOR', tipo=tipo, at=at)
        tiempos = self._stats()['tiempos']['inferior']
        # G1: 30 min de trabajo y 30 parada; G2: 30 min. En una hora de mesa no caben 90 de trabajo.
        self.assertEqual(tiempos, {'mediana_min': 30.0, 'media_min': 30.0, 'paneles': 2, 'medidos': 2, 'parado_min': 15.0})

    def test_una_fase_con_inicio_y_fin_sin_pasos_se_mide(self):
        self._fase(self.mesa1, 'H0', 'INFERIOR', aware(2026, 9, 28, 8))
        self._fase(self.mesa1, 'H1', 'INFERIOR', aware(2026, 9, 28, 10, 10), pasos=[aware(2026, 9, 28, 10, 0)])
        tiempos = self._stats()['tiempos']['inferior']
        # H0, sin registro, se aproxima desde el inicio del turno con tope (60); H1 son 10 min medidos.
        self.assertEqual(tiempos, {'mediana_min': 35.0, 'media_min': 35.0, 'paneles': 2, 'medidos': 1, 'parado_min': 0.0})

    def test_un_turno_sin_nadie_no_hace_estimado_el_trabajo_medido_del_otro(self):
        noche = {'nombre': 'Noche', 'activo': True,
                 'horario': {day: ['19:00', '05:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}
        UserProfile.objects.filter(user=self.user).update(turnos=[MANANA, noche])
        # El perfil queda cacheado en self.user: la vista tiene que ver los dos turnos.
        self.client.force_authenticate(User.objects.get(pk=self.user.pk))
        self._fase(self.mesa1, 'I1', 'INFERIOR', aware(2026, 9, 28, 9), pasos=self._cada(aware(2026, 9, 28, 7), aware(2026, 9, 28, 9)))
        dia = self._stats()['por_dia'][0]
        self.assertEqual(
            (dia['horas_turno'], dia['horas_trabajo'], dia['estimado'], dia['sin_registro']), (15.0, 2.0, False, False),
        )

    def test_el_admin_mirando_todas_las_ferrallas_no_tiene_trabajo_ni_tiempo_muerto(self):
        self._fase(self.mesa1, 'J1', 'INFERIOR', aware(2026, 9, 28, 9), pasos=self._cada(aware(2026, 9, 28, 7), aware(2026, 9, 28, 9)))
        self.client.force_authenticate(User.objects.create_superuser('admin-actividad', 'admin@example.com', 'x'))
        stats = self._stats()
        self.assertNotIn('horas_trabajo', stats['totals'])
        self.assertIsNone(stats['muerto_por_causa'])
        self.assertEqual([m['mesa_nombre'] for m in stats['por_mesa']], ['Mesa 1'])
        self.assertNotIn('horas_muertas', stats['por_mesa'][0])
        # Con un proyecto delante, la ferralla de ese proyecto.
        stats = self._stats(proyecto=self.project.id)
        self.assertEqual((stats['totals']['horas_trabajo'], stats['totals']['horas_muertas']), (2.0, 8.0))

    def test_con_un_turno_elegido_lo_de_fuera_de_turno_cuenta_en_el_turno_mas_cercano(self):
        # Trabajan de 05:00 a 07:00: la hora de antes del turno es de la manana, como el modulo que acaben entonces.
        self._fase(self.mesa1, 'K1', 'INFERIOR', aware(2026, 9, 28, 7), pasos=self._cada(aware(2026, 9, 28, 5), aware(2026, 9, 28, 7)))
        todos = self._stats()['totals']
        manana = self._stats(turno=0)['totals']
        self.assertEqual((todos['horas_trabajo'], todos['horas_fuera_turno']), (2.0, 1.0))
        self.assertEqual((manana['horas_trabajo'], manana['horas_fuera_turno']), (2.0, 1.0))

    def test_estimado_es_por_dia_y_el_piso_solo_sin_ninguna_otra_senal(self):
        # Lunes 28 con eventos; jueves 1/10 solo fotos cada 15 min y la fase hecha a las 09:00.
        self._fase(self.mesa1, 'L1', 'INFERIOR', aware(2026, 9, 28, 9), pasos=self._cada(aware(2026, 9, 28, 7), aware(2026, 9, 28, 9)))
        modulo = Modulo.objects.create(nombre='L2', proyecto=self.project)
        MesaQueueItem.objects.create(modulo=modulo, mesa=self.mesa1, fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=aware(2026, 10, 1, 9))
        for m in (0, 15, 30, 45):
            foto = FotoFabricacion.objects.create(modulo=modulo, mesa=self.mesa1, fase='INFERIOR', paso=m)
            FotoFabricacion.objects.filter(pk=foto.pk).update(capturada_at=aware(2026, 10, 1, 8, m))
        # Viernes 2/10: fotos hasta las 12:55 y la fase hecha a las 14:00 con la camara viva: sin piso.
        modulo3 = Modulo.objects.create(nombre='L3', proyecto=self.project)
        MesaQueueItem.objects.create(modulo=modulo3, mesa=self.mesa1, fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=aware(2026, 10, 2, 14))
        for h, m in ((12, 0), (12, 15), (12, 30), (12, 55)):
            foto = FotoFabricacion.objects.create(modulo=modulo3, mesa=self.mesa1, fase='INFERIOR', paso=m)
            FotoFabricacion.objects.filter(pk=foto.pk).update(capturada_at=aware(2026, 10, 2, h, m))
        stats = self.client.get('/api/stats/production/', {'from': '2026-09-28', 'to': '2026-10-02'}).data
        dias = {d['fecha']: d for d in stats['por_dia']}
        self.assertEqual((dias['2026-09-28']['horas_trabajo'], dias['2026-09-28']['estimado']), (2.0, False))
        self.assertEqual((dias['2026-10-01']['horas_trabajo'], dias['2026-10-01']['estimado']), (1.0, True))
        self.assertEqual((dias['2026-10-02']['horas_trabajo'], dias['2026-10-02']['estimado']), (0.92, True))
        # El jueves vale lo mismo mirado solo.
        jueves = self.client.get('/api/stats/production/', {'from': '2026-10-01', 'to': '2026-10-01'}).data['por_dia'][0]
        self.assertEqual((jueves['horas_trabajo'], jueves['estimado']), (1.0, True))
        # El FIN que pone el servidor al marcar hecho no convierte el dia en "con registro".
        EventoFabricacion.objects.create(item=MesaQueueItem.objects.get(modulo=modulo), mesa=self.mesa1, modulo=modulo,
                                         fase='INFERIOR', tipo='FIN', at=aware(2026, 10, 1, 9))
        jueves = self.client.get('/api/stats/production/', {'from': '2026-10-01', 'to': '2026-10-01'}).data['por_dia'][0]
        self.assertEqual((jueves['horas_trabajo'], jueves['estimado']), (1.0, True))

    def test_el_piso_de_una_fase_hecha_al_acabar_el_turno_no_es_sin_registro(self):
        # Mesa 2 solo marca una fase hecha a las 16:05: su piso (15:25-16:05) es trabajo del turno,
        # con causa "empezo tarde", no "sin registro".
        MesaQueueItem.objects.create(modulo=Modulo.objects.create(nombre='M1', proyecto=self.project), mesa=self.mesa2,
                                     fase='INFERIOR', status=MesaQueueStatus.HECHO, done_at=aware(2026, 9, 28, 16, 5))
        dia = self._stats()['por_dia'][0]
        # 35 min dentro del turno y 5 fuera (16:00-16:05).
        self.assertEqual((dia['horas_trabajo'], dia['horas_fuera_turno'], dia['estimado'], dia['sin_registro']), (0.67, 0.08, True, False))
        self.assertEqual((dia['causas']['sin_registro'], dia['causas']['empezo_tarde']), (0.0, 9.42))
        self.assertTrue(dia['abre'].endswith('15:25:00+02:00'))

    def test_con_turnos_solapados_lo_de_fuera_va_al_que_acaba_o_empieza_mas_cerca(self):
        tarde = {'nombre': 'Tarde', 'activo': True,
                 'horario': {day: ['13:00', '21:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}
        manana = {**MANANA, 'horario': {day: ['06:00', '14:00'] for day in ('MON', 'TUE', 'WED', 'THU', 'FRI')}}
        UserProfile.objects.filter(user=self.user).update(turnos=[manana, tarde])
        self.client.force_authenticate(User.objects.get(pk=self.user.pk))
        # De 05:00 a 06:00 (antes de la manana) y de 21:30 a 22:30 (despues de la tarde).
        self._fase(self.mesa1, 'N1', 'INFERIOR', aware(2026, 9, 28, 6), pasos=self._cada(aware(2026, 9, 28, 5), aware(2026, 9, 28, 6)))
        self._fase(self.mesa1, 'N2', 'INFERIOR', aware(2026, 9, 28, 22, 30), pasos=self._cada(aware(2026, 9, 28, 21, 30), aware(2026, 9, 28, 22, 30)))
        todos = self._stats()['totals']
        manana_t = self._stats(turno=0)['totals']
        tarde_t = self._stats(turno=1)['totals']
        self.assertEqual((todos['horas_trabajo'], todos['horas_fuera_turno']), (2.0, 2.0))
        self.assertEqual((manana_t['horas_trabajo'], manana_t['horas_fuera_turno']), (1.0, 1.0))
        self.assertEqual((tarde_t['horas_trabajo'], tarde_t['horas_fuera_turno']), (1.0, 1.0))
