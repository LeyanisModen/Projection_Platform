from datetime import date, timedelta
from importlib import import_module
from unittest.mock import patch

from django.apps import apps
from django.contrib.auth.models import User
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (
    EventoCalendario, Mesa, MesaQueueItem, Modulo, Proyecto,
    ProyectoCheckDefinicion, ProyectoCheckEstado, TrabajadorOficina, UserProfile,
)
from .planning import DAY_CODES, demand_summary, production_day_count, project_demand


class ProductionDayTests(SimpleTestCase):
    def test_weekends_and_mounting_day_are_excluded(self):
        self.assertEqual(production_day_count(date(2026, 9, 4), date(2026, 9, 8), DAY_CODES[:5]), 2)

    def test_selected_weekend_days_are_counted(self):
        self.assertEqual(production_day_count(date(2026, 9, 4), date(2026, 9, 8), DAY_CODES), 4)

    def test_past_or_today_deadline_has_no_days(self):
        for end in [date(2026, 9, 3), date(2026, 9, 4)]:
            self.assertEqual(production_day_count(date(2026, 9, 4), end, DAY_CODES), 0)

    def test_multiweek_count_matches_day_by_day(self):
        start = date(2026, 9, 4)
        active = ('TUE', 'THU', 'SAT')
        for span in (1, 7, 12, 31, 366):
            expected = sum(DAY_CODES[(start + timedelta(days=i)).weekday()] in active for i in range(span))
            self.assertEqual(production_day_count(start, start + timedelta(days=span), active), expected)


class OfficePlanningTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user('office-admin', is_staff=True)
        self.factory = User.objects.create_user('factory')
        self.other = User.objects.create_user('other-factory')
        self.profile = UserProfile.objects.create(user=self.factory)
        self.project = Proyecto.objects.create(nombre='P1', usuario=self.factory)
        self.project2 = Proyecto.objects.create(nombre='P2', usuario=self.factory)
        self.foreign_project = Proyecto.objects.create(nombre='Other', usuario=self.other)
        self.client.force_authenticate(self.admin)

    def create_module(self, project=None, **kwargs):
        return Modulo.objects.create(nombre='A01', proyecto=project or self.project, **kwargs)

    def test_global_checks_appear_in_existing_and_future_projects(self):
        response = self.client.post('/api/check-definiciones/', {'titulo': 'Planos entregados'}, format='json')
        self.assertEqual(response.status_code, 201)
        definition = response.data['id']
        future = Proyecto.objects.create(nombre='Future', usuario=self.factory)
        for project in [self.project, self.project2, future]:
            rows = self.client.get(f'/api/proyecto-checklist/{project.pk}/').data
            self.assertEqual([(r['id'], r['completado']) for r in rows], [(definition, False)])

    def test_check_state_is_independent_and_records_editor(self):
        definition = ProyectoCheckDefinicion.objects.create(titulo='Entrega')
        url = f'/api/proyecto-checklist/{self.project.pk}/checks/{definition.pk}/'
        response = self.client.patch(url, {'completado': True}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data[0]['completado'])
        self.assertEqual(response.data[0]['actualizado_por'], self.admin.username)
        self.assertIsNotNone(response.data[0]['actualizado_at'])
        self.assertFalse(self.client.get(f'/api/proyecto-checklist/{self.project2.pk}/').data[0]['completado'])
        self.client.patch(url, {'completado': False}, format='json')
        self.assertEqual(ProyectoCheckEstado.objects.count(), 1)
        self.assertFalse(ProyectoCheckEstado.objects.get().completado)

    def test_archiving_and_restoring_definition_preserves_states(self):
        definition = ProyectoCheckDefinicion.objects.create(titulo='Entrega')
        ProyectoCheckEstado.objects.create(proyecto=self.project, definicion=definition, completado=True)
        url = f'/api/check-definiciones/{definition.pk}/'
        self.assertEqual(self.client.patch(url, {'activo': False}, format='json').status_code, 200)
        self.assertEqual(self.client.get(f'/api/proyecto-checklist/{self.project.pk}/').data, [])
        self.assertEqual(self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{definition.pk}/', {'completado': False}, format='json').status_code, 400)
        self.client.patch(url, {'activo': True, 'titulo': 'Entrega confirmada'}, format='json')
        row = self.client.get(f'/api/proyecto-checklist/{self.project.pk}/').data[0]
        self.assertEqual(row['titulo'], 'Entrega confirmada')
        self.assertTrue(row['completado'])
        self.assertEqual(self.client.delete(url).status_code, 405)

    def test_office_data_is_admin_only(self):
        self.client.force_authenticate(self.factory)
        for url in ['/api/check-definiciones/', '/api/trabajadores/', '/api/eventos/', f'/api/proyecto-checklist/{self.project.pk}/']:
            self.assertEqual(self.client.get(url).status_code, 403, url)
        self.assertEqual(self.client.post('/api/eventos/', {}).status_code, 403)
        self.assertEqual(self.client.post('/api/check-definiciones/', {'titulo': 'No'}).status_code, 403)

    def test_vacations_require_worker_and_valid_range(self):
        data = {'titulo': 'Vacaciones', 'tipo': 'VACACIONES', 'inicio': '2026-09-10', 'fin': '2026-09-12'}
        self.assertEqual(self.client.post('/api/eventos/', data, format='json').status_code, 400)
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        response = self.client.post('/api/eventos/', {**data, 'trabajadores': [worker.pk]}, format='json')
        self.assertEqual(response.status_code, 201)
        url = f"/api/eventos/{response.data['id']}/"
        self.assertEqual(self.client.patch(url, {'fin': '2026-09-09'}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(url, {'trabajadores': []}, format='json').status_code, 400)
        self.assertEqual(EventoCalendario.objects.get().creado_por_id, self.admin.pk)

    def test_events_use_inclusive_overlap_filters_and_project_link(self):
        response = self.client.post('/api/eventos/', {'titulo': 'Reunion', 'inicio': '2026-08-30', 'fin': '2026-09-02', 'proyecto': self.project.pk}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.client.get('/api/eventos/?desde=2026-09-02&hasta=2026-09-02').data[0]['proyecto'], self.project.pk)
        self.assertEqual(self.client.get('/api/eventos/?desde=2026-09-03&hasta=2026-09-30').data, [])
        self.assertEqual(self.client.get('/api/eventos/?desde=not-a-date').status_code, 400)

    def test_inactive_worker_cannot_be_assigned_but_history_is_editable(self):
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        event = EventoCalendario.objects.create(titulo='Vacaciones', tipo='VACACIONES', inicio=date(2026, 9, 1), fin=date(2026, 9, 3))
        event.trabajadores.add(worker)
        self.client.patch(f'/api/trabajadores/{worker.pk}/', {'activo': False}, format='json')
        self.assertEqual(self.client.patch(f'/api/eventos/{event.pk}/', {'titulo': 'Vacaciones anteriores'}, format='json').status_code, 200)
        self.assertEqual(self.client.post('/api/eventos/', {'titulo': 'Nuevo', 'inicio': '2026-09-10', 'fin': '2026-09-11', 'trabajadores': [worker.pk]}, format='json').status_code, 400)

    def test_project_only_accepts_mounting_date_not_working_days(self):
        url = f'/api/proyectos/{self.project.pk}/'
        for days in ([], ['SAT', 'SUN'], ['BAD'], 'MON'):
            self.assertEqual(self.client.patch(url, {'dias_produccion': days}, format='json').status_code, 400)
        response = self.client.patch(url, {'fecha_montaje': '2026-10-01'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('dias_produccion', response.data)
        self.assertNotIn('dias_produccion', {f.name for f in Proyecto._meta.get_fields()})
        self.assertEqual(response.data['planificacion']['dias_produccion'], list(DAY_CODES[:5]))
        self.profile.refresh_from_db()
        self.assertEqual(self.profile.capture_active_days, list(DAY_CODES[:5]))
        self.client.force_authenticate(self.factory)
        self.assertEqual(self.client.patch(url, {'fecha_montaje': '2026-10-02'}, format='json').status_code, 400)

    @patch('api.planning.timezone.localdate', return_value=date(2026, 9, 4))
    def test_factory_schedule_change_recalculates_all_projects_and_total(self, _today):
        for project in (self.project, self.project2):
            project.fecha_montaje = date(2026, 9, 8)
            project.save()
            for _ in range(6):
                self.create_module(project)
            plan = self.client.get(f'/api/proyectos/{project.pk}/').data['planificacion']
            self.assertEqual((plan['dias_disponibles'], plan['modulos_por_dia']), (2, 3))
        response = self.client.put(f'/api/users/{self.factory.pk}/capture-config/', {
            'active_days': list(DAY_CODES), 'start_time': '06:50',
            'end_time': '18:30', 'interval_seconds': 20,
        }, format='json')
        self.assertEqual(response.status_code, 200)
        for project in (self.project, self.project2):
            plan = self.client.get(f'/api/proyectos/{project.pk}/').data['planificacion']
            self.assertEqual(plan['dias_produccion'], list(DAY_CODES))
            self.assertEqual((plan['dias_disponibles'], plan['modulos_por_dia']), (4, 2))
        self.client.force_authenticate(self.factory)
        stats = self.client.get('/api/stats/production/?from=2026-09-04&to=2026-09-04')
        self.assertEqual(stats.status_code, 200)
        self.assertEqual(stats.data['planificacion']['modulos_por_dia'], 4)
        self.assertEqual(stats.data['planificacion']['modulos_hoy'], 4)

    @patch('api.planning.timezone.localdate', return_value=date(2026, 9, 4))
    def test_reassignment_uses_new_factory_schedule_immediately(self, _today):
        UserProfile.objects.create(user=self.other, capture_active_days=['MON'])
        self.project.fecha_montaje = date(2026, 9, 8)
        self.project.save()
        for _ in range(6):
            self.create_module()
        response = self.client.patch(f'/api/proyectos/{self.project.pk}/', {
            'usuario': f'http://testserver/api/users/{self.other.pk}/',
        }, format='json')
        self.assertEqual(response.status_code, 200)
        plan = response.data['planificacion']
        self.assertEqual(plan['dias_produccion'], ['MON'])
        self.assertEqual((plan['dias_disponibles'], plan['modulos_por_dia']), (1, 6))

    def test_empty_factory_schedule_does_not_fall_back_to_weekdays(self):
        self.profile.capture_active_days = []
        self.profile.save()
        self.project.fecha_montaje = date(2026, 9, 8)
        self.create_module()
        plan = project_demand(self.project, date(2026, 9, 4))
        self.assertEqual(plan['dias_produccion'], [])
        self.assertEqual(plan['estado'], 'SIN_DIAS')
        self.assertIsNone(plan['modulos_por_dia'])

    def test_unassigned_project_has_no_assumed_working_days(self):
        self.project.usuario = None
        self.project.fecha_montaje = date(2026, 9, 8)
        self.create_module()
        plan = project_demand(self.project, date(2026, 9, 4))
        self.assertEqual(plan['dias_produccion'], [])
        self.assertEqual(plan['estado'], 'SIN_FERRALLA')
        self.assertIsNone(plan['modulos_por_dia'])

    def test_missing_profile_uses_existing_factory_default_without_writing(self):
        self.profile.delete()
        project = Proyecto.objects.get(pk=self.project.pk)
        plan = project_demand(project, date(2026, 9, 4))
        self.assertEqual(plan['dias_produccion'], list(DAY_CODES[:5]))
        self.assertFalse(UserProfile.objects.filter(user=self.factory).exists())

    def test_demand_rounds_up_and_sums_projects_not_nominal_capacity(self):
        self.project.fecha_montaje = date(2026, 9, 8)
        self.project.save()
        for _ in range(5):
            self.create_module()
        self.create_module(estado='COMPLETADO')
        self.project2.fecha_montaje = date(2026, 9, 7)
        self.project2.save()
        self.create_module(self.project2)
        today = date(2026, 9, 4)
        plan = project_demand(self.project, today)
        self.assertEqual((plan['modulos_pendientes'], plan['dias_disponibles'], plan['modulos_por_dia']), (5, 2, 3))
        summary = demand_summary([self.project, self.project2], today)
        self.assertEqual(summary['modulos_por_dia'], 4)
        self.assertEqual(summary['modulos_hoy'], 4)
        self.assertEqual(demand_summary([self.project], date(2026, 9, 5))['modulos_hoy'], 0)

    def test_unplanned_overdue_and_complete_demand(self):
        module = self.create_module()
        today = date(2026, 9, 4)
        self.assertEqual(project_demand(self.project, today)['estado'], 'SIN_FECHA')
        self.project.fecha_montaje = today
        self.assertEqual(project_demand(self.project, today)['estado'], 'VENCIDO')
        self.assertIsNone(project_demand(self.project, today)['modulos_por_dia'])
        self.project.fecha_montaje = date(2026, 9, 6)
        self.profile.capture_active_days = ['MON']
        self.profile.save()
        self.assertEqual(project_demand(self.project, today)['estado'], 'SIN_DIAS')
        module.estado = 'COMPLETADO'
        module.save()
        self.assertEqual(project_demand(self.project, today)['estado'], 'COMPLETADO')
        self.assertEqual(project_demand(self.project, today)['modulos_por_dia'], 0)

    def test_factory_can_reset_own_phase_preserving_other_phase_date(self):
        module = self.create_module(estado='COMPLETADO')
        inferior_date = module.inferior_completado_at
        self.client.force_authenticate(self.factory)
        response = self.client.post(f'/api/modulos/{module.pk}/reiniciar-fase/', {'fase': 'SUPERIOR'}, format='json')
        self.assertEqual(response.status_code, 200)
        module.refresh_from_db()
        self.assertFalse(module.superior_hecho)
        self.assertIsNone(module.superior_completado_at)
        self.assertTrue(module.inferior_hecho)
        self.assertEqual(module.inferior_completado_at, inferior_date)
        self.assertIsNotNone(response.data['inferior_completado_at'])

    def test_factory_cannot_reset_foreign_module_or_complete_any_phase(self):
        own = self.create_module(estado='COMPLETADO')
        foreign = self.create_module(self.foreign_project)
        self.client.force_authenticate(self.factory)
        self.assertEqual(self.client.post(f'/api/modulos/{foreign.pk}/reiniciar-fase/', {'fase': 'SUPERIOR'}, format='json').status_code, 404)
        for action in ('completar', 'completar-fase', 'cerrar', 'reiniciar'):
            self.assertEqual(self.client.post(f'/api/modulos/{own.pk}/{action}/', {'fase': 'SUPERIOR'}, format='json').status_code, 403)
        self.assertEqual(self.client.patch(f'/api/modulos/{own.pk}/', {'superior_hecho': True}, format='json').status_code, 403)

    def test_admin_completion_stamps_date_only_once(self):
        module = self.create_module()
        url = f'/api/modulos/{module.pk}/completar-fase/'
        self.assertEqual(self.client.post(url, {'fase': 'SUPERIOR'}, format='json').status_code, 200)
        module.refresh_from_db()
        first_date = module.superior_completado_at
        self.assertIsNotNone(first_date)
        self.assertIsNone(module.inferior_completado_at)
        self.client.post(url, {'fase': 'SUPERIOR'}, format='json')
        module.refresh_from_db()
        self.assertEqual(module.superior_completado_at, first_date)

    def test_historical_completed_phase_without_date_is_not_fabricated_on_save(self):
        module = self.create_module()
        Modulo.objects.filter(pk=module.pk).update(superior_hecho=True, estado='EN_PROGRESO')
        module.refresh_from_db()
        module.actualizar_estado()
        self.assertIsNone(module.superior_completado_at)

    def test_date_backfill_uses_only_done_queue_for_completed_phases(self):
        module = self.create_module(estado='COMPLETADO')
        pending = self.create_module()
        unknown = self.create_module(estado='COMPLETADO')
        mesa = Mesa.objects.create(nombre='Mesa', usuario=self.factory)
        done_at = timezone.now() - timedelta(days=4)
        MesaQueueItem.objects.create(mesa=mesa, modulo=module, fase='SUPERIOR', status='HECHO', done_at=done_at, position=0)
        MesaQueueItem.objects.create(mesa=mesa, modulo=pending, fase='SUPERIOR', status='HECHO', done_at=done_at, position=1)
        migration = import_module('api.migrations.0054_office_planning_and_phase_dates')
        migration.backfill_phase_dates(apps, None)
        module.refresh_from_db()
        pending.refresh_from_db()
        unknown.refresh_from_db()
        self.assertEqual(module.superior_completado_at, done_at)
        self.assertIsNone(module.inferior_completado_at)
        self.assertIsNone(pending.superior_completado_at)
        self.assertIsNone(unknown.superior_completado_at)
