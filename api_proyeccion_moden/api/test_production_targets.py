from datetime import date, datetime

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Modulo, Proyecto, UserProfile


class ProductionTargetTests(APITestCase):
    def setUp(self):
        self.factory = User.objects.create_user('target-factory')
        self.profile = UserProfile.objects.create(
            user=self.factory, capture_active_days=['MON', 'TUE', 'WED', 'THU', 'FRI'],
        )
        self.project = Proyecto.objects.create(
            nombre='Deadline', usuario=self.factory, fecha_montaje=date(2026, 9, 28),
        )
        Modulo.objects.bulk_create([
            Modulo(nombre=f'A{i:02}', proyecto=self.project) for i in range(80)
        ])
        self.client.force_authenticate(self.factory)

    def stats(self, start='2026-09-14', end=None, project=None):
        params = {'from': start, 'to': end or start}
        if project:
            params['proyecto'] = project.pk
        response = self.client.get('/api/stats/production/', params)
        self.assertEqual(response.status_code, 200)
        return response.data

    def complete(self, count, at):
        ids = list(self.project.modulos.filter(estado='PENDIENTE').values_list('id', flat=True)[:count])
        self.project.modulos.filter(pk__in=ids).update(
            estado='COMPLETADO', inferior_hecho=True, superior_hecho=True,
            completado_at=timezone.make_aware(datetime.fromisoformat(at)),
        )

    def test_zero_production_still_has_a_deadline_target_without_table_assignments(self):
        stats = self.stats()
        self.assertEqual(stats['totals']['modulos_completados'], 0)
        self.assertEqual(stats['esperado']['modulos_esperados'], 8)

    def test_completing_modules_in_the_period_does_not_lower_its_target(self):
        self.complete(20, '2026-09-11T15:00:00')
        self.assertEqual(self.stats()['esperado']['modulos_esperados'], 6)
        self.complete(6, '2026-09-14T09:00:00')
        stats = self.stats()
        self.assertEqual(stats['totals']['modulos_completados'], 6)
        self.assertEqual(stats['esperado']['modulos_esperados'], 6)

    def test_even_finishing_the_project_does_not_erase_the_period_target(self):
        self.complete(80, '2026-09-14T09:00:00')
        stats = self.stats()
        self.assertEqual(stats['totals']['modulos_completados'], 80)
        self.assertEqual(stats['esperado']['modulos_esperados'], 8)
        self.assertEqual(self.stats('2026-09-15')['esperado']['modulos_esperados'], 0)

    def test_periods_use_working_days_and_stop_at_mounting_date(self):
        self.assertEqual(self.stats(end='2026-09-16')['esperado']['modulos_esperados'], 24)
        self.assertEqual(self.stats(end='2026-09-30')['esperado']['modulos_esperados'], 80)
        self.assertEqual(self.stats('2026-09-19', '2026-09-20')['esperado']['modulos_esperados'], 0)

    def test_rounding_never_demands_more_than_the_outstanding_project(self):
        self.complete(75, '2026-09-11T15:00:00')
        self.assertEqual(self.stats(end='2026-09-30')['esperado']['modulos_esperados'], 5)

    def test_factory_weekends_are_used_instead_of_a_fixed_monday_friday_schedule(self):
        self.profile.capture_active_days = ['SAT', 'SUN']
        self.profile.save()
        self.assertEqual(self.stats('2026-09-19', '2026-09-20')['esperado']['modulos_esperados'], 40)
        self.assertEqual(self.stats()['esperado']['modulos_esperados'], 0)

    def test_sums_own_projects_and_respects_project_and_factory_scope(self):
        second = Proyecto.objects.create(
            nombre='Second', usuario=self.factory, fecha_montaje=date(2026, 9, 16),
        )
        Modulo.objects.bulk_create([Modulo(nombre=f'B{i}', proyecto=second) for i in range(10)])
        other = User.objects.create_user('other-target-factory')
        foreign = Proyecto.objects.create(nombre='Other', usuario=other, fecha_montaje=date(2026, 9, 16))
        Modulo.objects.bulk_create([Modulo(nombre=f'C{i}', proyecto=foreign) for i in range(100)])
        self.assertEqual(self.stats()['esperado']['modulos_esperados'], 13)
        self.assertEqual(self.stats(project=second)['esperado']['modulos_esperados'], 5)
        self.assertEqual(self.stats(project=foreign)['esperado']['modulos_esperados'], 0)

    def test_missing_or_impossible_plans_are_unknown_not_zero(self):
        for deadline in (None, date(2026, 9, 14), date(2026, 9, 11)):
            self.project.fecha_montaje = deadline
            self.project.save()
            expected = self.stats()['esperado']
            self.assertIsNone(expected['modulos_esperados'])
            self.assertEqual(expected['proyectos_sin_objetivo'], 1)

    def test_partial_target_identifies_projects_not_included(self):
        missing = Proyecto.objects.create(nombre='No date', usuario=self.factory)
        Modulo.objects.create(nombre='X', proyecto=missing)
        expected = self.stats()['esperado']
        self.assertEqual(expected['modulos_esperados'], 8)
        self.assertEqual(expected['proyectos_sin_objetivo'], 1)

    def test_historical_period_can_reach_a_deadline_that_is_now_past(self):
        self.project.fecha_montaje = date(2026, 9, 18)
        self.project.save()
        self.complete(80, '2026-09-17T15:00:00')
        expected = self.stats('2026-09-14', '2026-09-20')['esperado']
        self.assertEqual(expected['modulos_esperados'], 80)
        self.assertEqual(expected['proyectos_sin_objetivo'], 0)

    def test_period_baseline_uses_factory_local_midnight(self):
        with timezone.override('Europe/Madrid'):
            ids = list(self.project.modulos.values_list('id', flat=True)[:20])
            self.project.modulos.filter(pk__in=ids).update(
                estado='COMPLETADO', completado_at=datetime.fromisoformat('2026-09-13T22:05:00+00:00'),
            )
            stats = self.stats()
            self.assertEqual(stats['totals']['modulos_completados'], 20)
            self.assertEqual(stats['esperado']['modulos_esperados'], 8)

    def test_no_configured_working_days_has_no_target(self):
        self.profile.capture_active_days = []
        self.profile.save()
        self.assertIsNone(self.stats()['esperado']['modulos_esperados'])
