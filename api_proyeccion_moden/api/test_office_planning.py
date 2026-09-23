from datetime import date, timedelta
from importlib import import_module
from unittest.mock import patch

from django.apps import apps
from django.contrib.auth.models import User
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from .models import (
    EventoCalendario, GrupoMesas, Mesa, MesaQueueItem, Modulo, Proyecto,
    ProyectoCheckAdjunto, ProyectoCheckDefinicion, TrabajadorOficina, UserProfile,
)
from .office import CHECK_ATTACHMENT_MAX_BYTES
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


import tempfile
_MEDIA_TMP = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)


@override_settings(MEDIA_ROOT=_MEDIA_TMP.name, MEDIA_REQUIRE_AUTH=True)
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

    # ------------------------------------------------------------------
    # Lista de control: plantilla maestra + copia por proyecto
    # ------------------------------------------------------------------
    def _rows(self, project):
        return self.client.get(f'/api/proyecto-checklist/{project.pk}/').data

    def _definir(self, titulo, **fields):
        """Paso de la lista maestra por la API: llega a todos los proyectos."""
        response = self.client.post('/api/check-definiciones/', {'titulo': titulo, **fields}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def test_new_project_is_seeded_from_master_list_in_order(self):
        ProyectoCheckDefinicion.objects.create(titulo='Planos entregados', orden=2)
        ProyectoCheckDefinicion.objects.create(titulo='Aprobacion equivalencias', orden=1)

        response = self.client.post('/api/proyectos/', {'nombre': 'Nuevo'}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['checks_total'], 2)
        self.assertEqual(response.data['checks_completados'], 0)

        rows = self._rows(Proyecto.objects.get(pk=response.data['id']))
        self.assertEqual([r['titulo'] for r in rows], ['Aprobacion equivalencias', 'Planos entregados'])
        self.assertTrue(all(r['origen'] == 'PLANTILLA' and not r['completado'] for r in rows))

    def test_master_list_changes_reach_every_project(self):
        definition = self._definir('Entrega', requiere_documento=True)
        for project in (self.project, self.project2, self.foreign_project):
            rows = self._rows(project)
            self.assertEqual([(r['titulo'], r['origen'], r['definicion']) for r in rows], [('Entrega', 'PLANTILLA', definition['id'])])
            self.assertTrue(rows[0]['requiere_documento'])

        self.assertEqual(self.client.patch(
            f'/api/check-definiciones/{definition["id"]}/', {'titulo': 'Entrega final', 'requiere_documento': False}, format='json',
        ).status_code, 200)
        rows = self._rows(self.project2)
        self.assertEqual(rows[0]['titulo'], 'Entrega final')
        self.assertFalse(rows[0]['requiere_documento'])

        # Una copia completada sobrevive al borrado como paso propio del proyecto.
        check_id = self._rows(self.project)[0]['id']
        self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{check_id}/', {'completado': True}, format='json')
        self.assertEqual(self.client.delete(f'/api/check-definiciones/{definition["id"]}/').status_code, 204)
        kept = self._rows(self.project)
        self.assertEqual([(r['titulo'], r['origen'], r['definicion'], r['completado']) for r in kept], [('Entrega final', 'MANUAL', None, True)])
        self.assertEqual(self._rows(self.project2), [])

    def test_master_titles_are_unique_and_project_steps_follow_master_order(self):
        self._definir('Planos')
        self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Paso manual'}, format='json')
        acta = self._definir('Acta')
        self.assertEqual(self.client.post('/api/check-definiciones/', {'titulo': '  planos  '}, format='json').status_code, 400)
        self.assertEqual([r['titulo'] for r in self._rows(self.project)], ['Planos', 'Paso manual', 'Acta'])

        planos_id = [d['id'] for d in self.client.get('/api/check-definiciones/').data if d['titulo'] == 'Planos'][0]
        self.client.post('/api/check-definiciones/reorder/', {'ids': [acta['id'], planos_id]}, format='json')
        # Las copias siguen el orden de la maestra; los pasos propios del proyecto van detras.
        self.assertEqual([r['titulo'] for r in self._rows(self.project)], ['Acta', 'Planos', 'Paso manual'])
        self.assertEqual([r['titulo'] for r in self._rows(self.project2)], ['Acta', 'Planos'])

    def test_sync_command_aligns_old_copies_with_the_master_list(self):
        from django.core.management import call_command
        definicion = ProyectoCheckDefinicion.objects.create(titulo='Geometria', dias_antes_montaje=30, bloquea_produccion=True)
        # Copia antigua: enlazada por la migracion pero sin la configuracion actual.
        self.project.fecha_montaje = date(2026, 11, 20)
        self.project.save()
        self.project.checks.create(titulo='Geometria', origen='PLANTILLA', definicion=definicion)
        call_command('sincronizar_checklist')
        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.assertEqual(rows['Geometria']['fecha_limite'], '2026-10-21')
        self.assertTrue(rows['Geometria']['bloquea_produccion'])
        self.assertEqual([r['titulo'] for r in self._rows(self.project2)], ['Geometria'])

    def test_deleting_a_master_step_keeps_copies_with_documents(self):
        definition = self._definir('Planos', requiere_documento=True)
        check_id = self._rows(self.project)[0]['id']
        upload = SimpleUploadedFile('ok.pdf', b'%PDF-1.4 ok', content_type='application/pdf')
        self.assertEqual(self.client.post(
            f'/api/proyecto-checklist/{self.project.pk}/checks/{check_id}/adjuntos/', {'archivo': upload}, format='multipart',
        ).status_code, 201)
        self.assertEqual(self.client.delete(f'/api/check-definiciones/{definition["id"]}/').status_code, 204)
        rows = self._rows(self.project)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['origen'], 'MANUAL')
        self.assertEqual(len(rows[0]['adjuntos']), 1)
        self.assertEqual(self._rows(self.project2), [])

    def test_manual_step_is_project_only_and_rejects_duplicates(self):
        url = f'/api/proyecto-checklist/{self.project.pk}/checks/'
        response = self.client.post(url, {'titulo': '  Acta de inicio  '}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data[0]['titulo'], 'Acta de inicio')
        self.assertEqual(response.data[0]['origen'], 'MANUAL')

        self.assertEqual(self.client.post(url, {'titulo': 'acta de inicio'}, format='json').status_code, 400)
        self.assertEqual(self.client.post(url, {'titulo': '   '}, format='json').status_code, 400)
        self.assertEqual(self._rows(self.project2), [])
        self.assertEqual(ProyectoCheckDefinicion.objects.count(), 0)

    def test_completing_records_who_and_when_and_unmarking_clears_them(self):
        self._definir('Entrega')
        check = self._rows(self.project)[0]
        url = f'/api/proyecto-checklist/{self.project.pk}/checks/{check["id"]}/'

        done = self.client.patch(url, {'completado': True}, format='json')
        self.assertEqual(done.status_code, 200)
        self.assertTrue(done.data[0]['completado'])
        self.assertEqual(done.data[0]['completado_por'], self.admin.username)
        self.assertIsNotNone(done.data[0]['completado_at'])

        project = self.client.get(f'/api/proyectos/{self.project.pk}/').data
        self.assertEqual((project['checks_completados'], project['checks_total']), (1, 1))

        again = self.client.patch(url, {'titulo': 'Entrega firmada'}, format='json').data[0]
        self.assertEqual(again['titulo'], 'Entrega firmada')
        self.assertEqual(again['completado_por'], self.admin.username, 'editar el titulo no cambia quien lo completo')

        undone = self.client.patch(url, {'completado': False}, format='json').data[0]
        self.assertFalse(undone['completado'])
        self.assertIsNone(undone['completado_por'])
        self.assertIsNone(undone['completado_at'])

    def test_project_step_can_be_deleted_and_unknown_step_is_rejected(self):
        check = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Temporal'}, format='json').data[0]
        self.assertEqual(self.client.delete(f'/api/proyecto-checklist/{self.project.pk}/checks/{check["id"]}/').data, [])
        self.assertEqual(self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{check["id"]}/', {'completado': True}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(f'/api/proyecto-checklist/{self.project2.pk}/checks/{check["id"]}/', {'completado': True}, format='json').status_code, 400)

    def test_master_list_reorder_requires_every_id_once(self):
        a = ProyectoCheckDefinicion.objects.create(titulo='A')
        b = ProyectoCheckDefinicion.objects.create(titulo='B')
        c = self.client.post('/api/check-definiciones/', {'titulo': 'C'}, format='json').data
        self.assertGreater(c['orden'], max(a.orden, b.orden), 'un paso nuevo va al final')

        response = self.client.post('/api/check-definiciones/reorder/', {'ids': [c['id'], a.pk, b.pk]}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([r['titulo'] for r in response.data], ['C', 'A', 'B'])
        self.assertEqual([r['titulo'] for r in self.client.get('/api/check-definiciones/').data], ['C', 'A', 'B'])

        self.assertEqual(self.client.post('/api/check-definiciones/reorder/', {'ids': [a.pk, b.pk]}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/check-definiciones/reorder/', {'ids': [a.pk, a.pk, b.pk]}, format='json').status_code, 400)

    # ------------------------------------------------------------------
    # Fechas limite y documentos de confirmacion por paso
    # ------------------------------------------------------------------
    def test_master_flags_are_copied_when_seeding(self):
        self._definir('Aprobacion equivalencias', requiere_fecha=True, requiere_documento=True)
        self._definir('Planos entregados')
        rows = self._rows(self.project)
        by_title = {r['titulo']: r for r in rows}
        self.assertTrue(by_title['Aprobacion equivalencias']['requiere_fecha'])
        self.assertTrue(by_title['Aprobacion equivalencias']['requiere_documento'])
        self.assertFalse(by_title['Planos entregados']['requiere_fecha'])
        self.assertIsNone(by_title['Aprobacion equivalencias']['fecha_limite'])
        self.assertEqual(by_title['Aprobacion equivalencias']['adjuntos'], [])

    # ------------------------------------------------------------------
    # Plazos relativos a D, requisitos entre pasos y bloqueo de produccion
    # ------------------------------------------------------------------
    def test_relative_deadline_is_computed_from_mounting_date_when_seeding(self):
        with_date = Proyecto.objects.create(nombre='Con D', usuario=self.factory, fecha_montaje=date(2026, 11, 20))
        without_date = Proyecto.objects.create(nombre='Sin D', usuario=self.factory)
        self._definir('Geometria y armados', dias_antes_montaje=30)
        self._definir('Sin plazo', requiere_fecha=True)
        rows = {r['titulo']: r for r in self._rows(with_date)}
        self.assertEqual(rows['Geometria y armados']['fecha_limite'], '2026-10-21')
        self.assertEqual(rows['Geometria y armados']['dias_antes_montaje'], 30)
        self.assertTrue(rows['Geometria y armados']['requiere_fecha'])
        self.assertIsNone(rows['Sin plazo']['fecha_limite'])
        rows = {r['titulo']: r for r in self._rows(without_date)}
        self.assertIsNone(rows['Geometria y armados']['fecha_limite'])

    def test_master_relative_deadline_forces_date_flag(self):
        row = self.client.post('/api/check-definiciones/', {'titulo': 'Equivalencias', 'dias_antes_montaje': 21}).data
        self.assertTrue(row['requiere_fecha'])
        self.assertEqual(row['dias_antes_montaje'], 21)

    def test_changing_mounting_date_recalculates_pending_relative_steps_only(self):
        self.project.fecha_montaje = date(2026, 11, 20)
        self.project.save()
        self._definir('Geometria', dias_antes_montaje=30)
        self._definir('Equivalencias', dias_antes_montaje=21)
        self._definir('Manual', requiere_fecha=True)
        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{rows["Geometria"]["id"]}/', {'completado': True})
        self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{rows["Manual"]["id"]}/', {'fecha_limite': '2026-10-01'})

        self.client.patch(f'/api/proyectos/{self.project.pk}/', {'fecha_montaje': '2026-12-04'})

        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.assertEqual(rows['Equivalencias']['fecha_limite'], '2026-11-13')
        self.assertEqual(rows['Geometria']['fecha_limite'], '2026-10-21', 'completed steps keep their date')
        self.assertEqual(rows['Manual']['fecha_limite'], '2026-10-01', 'hand-set dates are not touched')

        self.client.patch(f'/api/proyectos/{self.project.pk}/', {'fecha_montaje': None}, format='json')
        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.assertIsNone(rows['Equivalencias']['fecha_limite'])

    def test_step_cannot_be_completed_before_its_prerequisites(self):
        geometria = self._definir('Geometria')
        self._definir('Ingenieria definitiva', requisitos=[geometria['id']])
        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.assertEqual(rows['Ingenieria definitiva']['requisitos'], [rows['Geometria']['id']])
        self.assertEqual(rows['Ingenieria definitiva']['requisitos_pendientes'], ['Geometria'])

        url = f'/api/proyecto-checklist/{self.project.pk}/checks/{rows["Ingenieria definitiva"]["id"]}/'
        response = self.client.patch(url, {'completado': True})
        self.assertEqual(response.status_code, 400)
        self.assertIn('Geometria', response.data['completado'])

        self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{rows["Geometria"]["id"]}/', {'completado': True})
        response = self.client.patch(url, {'completado': True})
        self.assertEqual(response.status_code, 200)
        rows = {r['titulo']: r for r in response.data}
        self.assertTrue(rows['Ingenieria definitiva']['completado'])
        self.assertEqual(rows['Ingenieria definitiva']['requisitos_pendientes'], [])

    def test_master_step_cannot_require_itself(self):
        step = ProyectoCheckDefinicion.objects.create(titulo='Solo')
        response = self.client.patch(f'/api/check-definiciones/{step.pk}/', {'requisitos': [step.pk]}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_blocking_steps_keep_project_out_of_production(self):
        self._definir('Geometria', bloquea_produccion=True)
        self._definir('Fotos', bloquea_produccion=False)
        self.create_module()

        listed = {p['id']: p for p in self.client.get('/api/proyectos/').data['results']}
        self.assertTrue(listed[self.project.pk]['produccion_bloqueada'])
        self.assertEqual(listed[self.project.pk]['checks_bloqueantes_pendientes'], 1)
        self.assertTrue(listed[self.project2.pk]['produccion_bloqueada'], 'la lista maestra llega a todos los proyectos')

        grupo = GrupoMesas.objects.create(nombre='G', usuario=self.factory)
        self.client.force_authenticate(self.factory)
        response = self.client.post(f'/api/grupos-mesas/{grupo.pk}/cola/add/', {'proyecto': self.project.pk})
        self.assertEqual(response.status_code, 400)
        self.assertIn('Geometria', response.data['detail'])

        self.client.force_authenticate(self.admin)
        rows = {r['titulo']: r for r in self._rows(self.project)}
        self.client.patch(f'/api/proyecto-checklist/{self.project.pk}/checks/{rows["Geometria"]["id"]}/', {'completado': True})
        self.client.force_authenticate(self.factory)
        response = self.client.post(f'/api/grupos-mesas/{grupo.pk}/cola/add/', {'proyecto': self.project.pk})
        self.assertEqual(response.status_code, 200, response.data)
        self.client.force_authenticate(self.admin)
        listed = {p['id']: p for p in self.client.get('/api/proyectos/').data['results']}
        self.assertFalse(listed[self.project.pk]['produccion_bloqueada'])
        self.assertTrue(listed[self.project2.pk]['produccion_bloqueada'], 'cada proyecto completa lo suyo')

    def test_manual_step_can_declare_date_and_document_and_set_deadline(self):
        response = self.client.post(
            f'/api/proyecto-checklist/{self.project.pk}/checks/',
            {'titulo': 'Grua contratada', 'requiere_fecha': True, 'fecha_limite': '2026-10-05'},
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        row = response.data[0]
        self.assertTrue(row['requiere_fecha'])
        self.assertFalse(row['requiere_documento'])
        self.assertEqual(row['fecha_limite'], '2026-10-05')

    def test_deadline_is_dropped_when_step_does_not_require_a_date(self):
        row = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Sin fecha', 'fecha_limite': '2026-10-05'}, format='json').data[0]
        self.assertIsNone(row['fecha_limite'], 'sin requiere_fecha no se guarda fecha')

        url = f'/api/proyecto-checklist/{self.project.pk}/checks/{row["id"]}/'
        with_date = self.client.patch(url, {'requiere_fecha': True, 'fecha_limite': '2026-10-05'}, format='json').data[0]
        self.assertEqual(with_date['fecha_limite'], '2026-10-05')
        cleared = self.client.patch(url, {'requiere_fecha': False}, format='json').data[0]
        self.assertIsNone(cleared['fecha_limite'], 'quitar la fecha requerida limpia la fecha limite')

    def test_deadlines_feed_the_calendar_within_a_range(self):
        for titulo, fecha in [('Antes', '2026-09-30'), ('Dentro', '2026-10-10'), ('Despues', '2026-11-02')]:
            self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': titulo, 'requiere_fecha': True, 'fecha_limite': fecha}, format='json')
        self.client.post(f'/api/proyecto-checklist/{self.project2.pk}/checks/', {'titulo': 'Otro proyecto', 'requiere_fecha': True, 'fecha_limite': '2026-10-20'}, format='json')
        self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Sin fecha', 'requiere_fecha': True}, format='json')

        response = self.client.get('/api/proyecto-checklist/vencimientos/?desde=2026-10-01&hasta=2026-10-31')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([(r['titulo'], r['fecha_limite'], r['proyecto_nombre']) for r in response.data],
                         [('Dentro', '2026-10-10', 'P1'), ('Otro proyecto', '2026-10-20', 'P2')])
        self.assertFalse(response.data[0]['completado'])
        self.assertEqual(self.client.get('/api/proyecto-checklist/vencimientos/?desde=mal').status_code, 400)
        self.assertEqual(len(self.client.get('/api/proyecto-checklist/vencimientos/').data), 4, 'sin rango devuelve todas las fechas')

    def test_attachments_upload_list_download_and_delete(self):
        row = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Aprobacion', 'requiere_documento': True}, format='json').data[0]
        url = f'/api/proyecto-checklist/{self.project.pk}/checks/{row["id"]}/adjuntos/'

        upload = self.client.post(url, {'archivo': SimpleUploadedFile('aprobacion planos.pdf', b'%PDF-1.4 ok', content_type='application/pdf')}, format='multipart')
        self.assertEqual(upload.status_code, 201)
        adjunto = upload.data[0]['adjuntos'][0]
        self.assertEqual(adjunto['nombre_original'], 'aprobacion planos.pdf')
        self.assertEqual(adjunto['tamano'], 11)
        self.assertEqual(adjunto['subido_por'], self.admin.username)
        self.assertTrue(adjunto['url'].startswith(f'/media/controles/{self.project.pk}/{row["id"]}/'), adjunto['url'])

        # /media/ autentica por cabecera Token o cookie, no por force_authenticate.
        served = self.client.get(adjunto['url'], HTTP_AUTHORIZATION=f'Token {Token.objects.get_or_create(user=self.admin)[0].key}')
        self.assertEqual(served.status_code, 200)
        served.close()

        self.assertEqual(self.client.post(url, {}, format='multipart').status_code, 400)

        deleted = self.client.delete(f'{url}{adjunto["id"]}/')
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.data[0]['adjuntos'], [])
        self.assertFalse(default_storage.exists(f'controles/{self.project.pk}/{row["id"]}/aprobacion planos.pdf'))

    def test_deleting_a_step_removes_its_attachment_files(self):
        row = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Con doc', 'requiere_documento': True}, format='json').data[0]
        self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/{row["id"]}/adjuntos/', {'archivo': SimpleUploadedFile('ok.txt', b'x')}, format='multipart')
        stored = ProyectoCheckAdjunto.objects.get().archivo.name
        self.assertTrue(default_storage.exists(stored))
        self.client.delete(f'/api/proyecto-checklist/{self.project.pk}/checks/{row["id"]}/')
        self.assertFalse(default_storage.exists(stored))
        self.assertEqual(ProyectoCheckAdjunto.objects.count(), 0)

    def test_attachment_size_limit(self):
        row = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'Grande'}, format='json').data[0]
        too_big = SimpleUploadedFile('grande.bin', b'0' * (CHECK_ATTACHMENT_MAX_BYTES + 1))
        response = self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/{row["id"]}/adjuntos/', {'archivo': too_big}, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertIn('20 MB', str(response.data))

    def test_office_data_is_admin_only(self):
        self.client.force_authenticate(self.factory)
        for url in ['/api/check-definiciones/', '/api/trabajadores/', '/api/eventos/', f'/api/proyecto-checklist/{self.project.pk}/']:
            self.assertEqual(self.client.get(url).status_code, 403, url)
        self.assertEqual(self.client.post('/api/eventos/', {}).status_code, 403)
        self.assertEqual(self.client.post('/api/check-definiciones/', {'titulo': 'No'}).status_code, 403)
        self.assertEqual(self.client.post(f'/api/proyecto-checklist/{self.project.pk}/checks/', {'titulo': 'No'}).status_code, 403)

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

    def test_overlapping_office_entries_remain_allowed_for_the_same_person(self):
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        data = {'inicio': '2026-09-10', 'fin': '2026-09-12', 'trabajadores': [worker.pk]}
        vacation = self.client.post('/api/eventos/', {**data, 'tipo': 'VACACIONES'}, format='json')
        first = self.client.post('/api/eventos/', {**data, 'titulo': 'Visita'}, format='json')
        second = self.client.post('/api/eventos/', {**data, 'titulo': 'Entrega'}, format='json')
        self.assertEqual([vacation.status_code, first.status_code, second.status_code], [201, 201, 201])
        response = self.client.patch(f"/api/eventos/{first.data['id']}/", {'fin': '2026-09-15'}, format='json')
        self.assertEqual(response.status_code, 200)
        overlaps = self.client.get('/api/eventos/?desde=2026-09-12&hasta=2026-09-12').data
        self.assertCountEqual([event['id'] for event in overlaps], [vacation.data['id'], first.data['id'], second.data['id']])

    def test_worker_color_is_saved_normalized_and_preserved_on_other_edits(self):
        response = self.client.post('/api/trabajadores/', {'nombre': 'Ana', 'color': '#BE185D'}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['color'], '#be185d')
        url = f"/api/trabajadores/{response.data['id']}/"
        self.assertEqual(self.client.patch(url, {'color': '#0f766e'}, format='json').data['color'], '#0f766e')
        self.assertEqual(self.client.patch(url, {'activo': False}, format='json').data['color'], '#0f766e')
        self.assertEqual(self.client.get('/api/trabajadores/').data[0]['color'], '#0f766e')

    def test_vacation_title_is_generated_without_manual_title_or_project(self):
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        response = self.client.post('/api/eventos/', {
            'tipo': 'VACACIONES', 'inicio': '2026-09-10', 'fin': '2026-09-10',
            'trabajadores': [worker.pk], 'proyecto': self.project.pk, 'notas': 'Viaje familiar',
        }, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['titulo'], 'Vacaciones de Ana')
        self.assertIsNone(response.data['proyecto'])
        event = EventoCalendario.objects.get(pk=response.data['id'])
        self.assertEqual(event.titulo, 'Vacaciones de Ana')
        self.assertEqual(event.notas, 'Viaje familiar')

    def test_event_title_remains_required_but_project_and_people_are_optional(self):
        data = {'inicio': '2026-09-10', 'fin': '2026-09-10'}
        for title in ({}, {'titulo': ''}, {'titulo': '   '}):
            response = self.client.post('/api/eventos/', {**data, **title}, format='json')
            self.assertEqual(response.status_code, 400)
            self.assertIn('titulo', response.data)
        response = self.client.post('/api/eventos/', {**data, 'titulo': 'Entrega'}, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['trabajadores'], [])
        self.assertIsNone(response.data['proyecto'])
        self.assertEqual(self.client.patch(f"/api/eventos/{response.data['id']}/", {'titulo': ''}, format='json').status_code, 400)

    def test_vacation_edit_keeps_multiple_people_and_reflects_name_changes(self):
        ana = TrabajadorOficina.objects.create(nombre='Ana')
        luis = TrabajadorOficina.objects.create(nombre='Luis')
        event = EventoCalendario.objects.create(titulo='Titulo antiguo', tipo='VACACIONES', inicio=date(2026, 9, 1), fin=date(2026, 9, 3))
        event.trabajadores.add(ana, luis)
        url = f'/api/eventos/{event.pk}/'
        response = self.client.patch(url, {'notas': 'Conservadas'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['titulo'], 'Vacaciones de Ana, Luis')
        self.assertCountEqual(response.data['trabajadores'], [ana.pk, luis.pk])
        self.client.patch(f'/api/trabajadores/{ana.pk}/', {'nombre': 'Ana Maria'}, format='json')
        self.assertEqual(self.client.get(url).data['titulo'], 'Vacaciones de Ana Maria, Luis')
        response = self.client.patch(url, {'trabajadores': [luis.pk]}, format='json')
        self.assertEqual(response.data['titulo'], 'Vacaciones de Luis')
        self.assertEqual(response.data['notas'], 'Conservadas')

    def test_converting_an_event_to_vacations_enforces_workers_and_generates_title(self):
        event = EventoCalendario.objects.create(titulo='Visita', inicio=date(2026, 9, 1), fin=date(2026, 9, 3), proyecto=self.project)
        url = f'/api/eventos/{event.pk}/'
        self.assertEqual(self.client.patch(url, {'tipo': 'VACACIONES'}, format='json').status_code, 400)
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        response = self.client.patch(url, {'tipo': 'VACACIONES', 'trabajadores': [worker.pk]}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['titulo'], 'Vacaciones de Ana')
        self.assertIsNone(response.data['proyecto'])

    def test_worker_color_validation_and_permissions(self):
        worker = TrabajadorOficina.objects.create(nombre='Ana')
        url = f'/api/trabajadores/{worker.pk}/'
        for color in ('red', '#abc', '#1234567', '', 'url(example)', None):
            self.assertEqual(self.client.patch(url, {'color': color}, format='json').status_code, 400)
        self.client.force_authenticate(self.factory)
        self.assertEqual(self.client.patch(url, {'color': '#123456'}, format='json').status_code, 403)

    def test_default_worker_colors_use_available_palette(self):
        first = self.client.post('/api/trabajadores/', {'nombre': 'Ana'}, format='json')
        second = self.client.post('/api/trabajadores/', {'nombre': 'Luis'}, format='json')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(first.data['color'], second.data['color'])

    def test_color_backfill_keeps_workers_and_events(self):
        from types import SimpleNamespace
        from django.db import connection
        worker1 = TrabajadorOficina.objects.create(nombre='Ana')
        worker2 = TrabajadorOficina.objects.create(nombre='Luis')
        event = EventoCalendario.objects.create(titulo='Vacaciones', inicio=date(2026, 9, 1), fin=date(2026, 9, 3))
        event.trabajadores.add(worker1, worker2)
        migration = import_module('api.migrations.0055_office_worker_color')
        migration.assign_existing_colors(apps, SimpleNamespace(connection=connection))
        worker1.refresh_from_db()
        worker2.refresh_from_db()
        self.assertNotEqual(worker1.color, worker2.color)
        self.assertEqual(event.trabajadores.count(), 2)

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
