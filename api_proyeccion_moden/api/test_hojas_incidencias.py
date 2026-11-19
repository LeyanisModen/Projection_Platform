import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from .media_access import USER_COOKIE
from .models import HojaIncidencias, Proyecto


def pdf(nombre='hojas.pdf', contenido=b'%PDF-1.7 hojas firmadas'):
    return SimpleUploadedFile(nombre, contenido, content_type='application/pdf')


class HojasIncidenciasTests(APITestCase):
    """La ferralla sube desde la tarjeta del proyecto el PDF de las hojas que
    firma el supervisor; Moden las ve, las descarga y las sube tambien."""

    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media, MEDIA_REQUIRE_AUTH=True)
        override.enable()
        self.addCleanup(override.disable)
        self.ferralla = User.objects.create_user('sanchos')
        self.otra = User.objects.create_user('otra')
        self.admin = User.objects.create_user('oficina', is_staff=True)
        self.proyecto = Proyecto.objects.create(nombre='ESN_P4', usuario=self.ferralla)
        self.url = f'/api/proyectos/{self.proyecto.pk}/hojas-incidencias/'

    def subir(self, *archivos, usuario=None):
        self.client.force_authenticate(usuario or self.ferralla)
        return self.client.post(self.url, {'archivos': list(archivos)}, format='multipart')

    def test_la_ferralla_sube_varios_pdf_y_los_ve_con_quien_y_cuando(self):
        respuesta = self.subir(pdf('Mesa 1.pdf'), pdf('Mesa 2.pdf'))
        self.assertEqual(respuesta.status_code, 201, respuesta.data)
        self.assertEqual(sorted(h['nombre'] for h in respuesta.data), ['Mesa 1.pdf', 'Mesa 2.pdf'])
        hoja = respuesta.data[0]
        self.assertEqual((hoja['subido_por'], hoja['de_moden'], hoja['puede_borrar']), ('sanchos', False, True))
        self.assertTrue(hoja['url'].startswith(f'/media/incidencias/{self.proyecto.pk}/'))
        self.assertTrue((Path(self.media) / hoja['url'][len('/media/'):]).is_file())

        # El numero va con el proyecto: la tarjeta lo enseña y el admin, la ultima.
        datos = self.client.get(f'/api/proyectos/{self.proyecto.pk}/').data
        self.assertEqual(datos['hojas_incidencias_count'], 2)
        self.assertIsNotNone(datos['hojas_incidencias_ultima'])
        self.client.force_authenticate(self.admin)
        fila = next(p for p in self.client.get('/api/proyectos/').data['results'] if p['id'] == self.proyecto.pk)
        self.assertEqual(fila['hojas_incidencias_count'], 2)
        # Moden la ve, pero no es suya: la puede borrar igualmente.
        self.assertTrue(self.client.get(self.url).data[0]['puede_borrar'])

    def test_solo_acepta_pdf(self):
        respuesta = self.subir(pdf('foto.jpg'))
        self.assertEqual(respuesta.status_code, 400)
        self.assertIn('solo se pueden subir PDF', respuesta.data['detail'])
        respuesta = self.subir(pdf('falso.pdf', b'no soy un pdf'))
        self.assertEqual(respuesta.status_code, 400)
        self.assertIn('no es un PDF', respuesta.data['detail'])
        with mock.patch('api.views.HOJA_INCIDENCIAS_MAX_BYTES', 10):
            respuesta = self.subir(pdf())
        self.assertEqual(respuesta.status_code, 400)
        self.assertIn('30 MB', respuesta.data['detail'])
        # Si uno falla no se sube ninguno.
        self.assertEqual(self.subir(pdf('bien.pdf'), pdf('mal.txt')).status_code, 400)
        self.assertFalse(HojaIncidencias.objects.exists())
        self.assertEqual(self.subir().status_code, 400)

    def test_otra_ferralla_ni_las_ve_ni_las_sube_y_un_archivado_no_admite_mas(self):
        self.subir(pdf())
        self.client.force_authenticate(self.otra)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.post(self.url, {'archivos': [pdf()]}, format='multipart').status_code, 404)
        # Un proyecto en estudio no existe para la ferralla.
        Proyecto.objects.filter(pk=self.proyecto.pk).update(fantasma=True)
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        Proyecto.objects.filter(pk=self.proyecto.pk).update(fantasma=False, archivado_at=timezone.now())
        respuesta = self.subir(pdf())
        self.assertEqual(respuesta.status_code, 400)
        self.assertIn('archivado', respuesta.data['detail'])

    def test_la_ferralla_borra_las_suyas_y_moden_cualquiera(self):
        de_moden = self.subir(pdf('de moden.pdf'), usuario=self.admin).data[0]
        suya = self.subir(pdf('suya.pdf')).data[0]
        self.assertFalse(next(h for h in self.client.get(self.url).data if h['id'] == de_moden['id'])['puede_borrar'])
        self.assertEqual(self.client.delete(f"{self.url}{de_moden['id']}/").status_code, 403)

        fichero = Path(self.media) / suya['url'][len('/media/'):]
        with self.captureOnCommitCallbacks(execute=True):
            respuesta = self.client.delete(f"{self.url}{suya['id']}/")
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual([h['nombre'] for h in respuesta.data], ['de moden.pdf'])
        self.assertFalse(fichero.exists())

        self.client.force_authenticate(self.admin)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f"{self.url}{de_moden['id']}/").data, [])
        self.assertEqual(self.client.delete(f"{self.url}{de_moden['id']}/").status_code, 404)

    def test_el_pdf_solo_lo_abren_moden_y_su_ferralla_y_se_puede_ver_en_la_pagina(self):
        url = self.subir(pdf()).data[0]['url']
        self.client.force_authenticate(None)

        def abrir(usuario):
            if usuario is not None:
                self.client.cookies[USER_COOKIE] = Token.objects.get_or_create(user=usuario)[0].key
            else:
                self.client.cookies.pop(USER_COOKIE, None)
            respuesta = self.client.get(url)
            respuesta.close()
            return respuesta

        self.assertEqual(abrir(None).status_code, 401)
        self.assertEqual(abrir(self.otra).status_code, 403)
        for usuario in (self.ferralla, self.admin):
            respuesta = abrir(usuario)
            self.assertEqual(respuesta.status_code, 200)
            self.assertEqual(respuesta['Content-Type'], 'application/pdf')
            # Dentro de un <iframe> de la propia web (el resto de /media/ sigue en DENY).
            self.assertEqual(respuesta['X-Frame-Options'], 'SAMEORIGIN')
