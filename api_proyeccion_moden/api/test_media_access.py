import hashlib
import os
import secrets
import tempfile

from django.contrib.auth.models import User
from django.test import override_settings
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from api.media_access import DEVICE_COOKIE, USER_COOKIE
from api.models import GrupoMesas, Mesa, Proyecto


class MediaAccessTests(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # ignore_cleanup_errors: on Windows a FileResponse whose body was not
        # consumed keeps the file open; a failed rmtree here must never
        # abort tearDownClass, or the class-level transaction stays open
        # and breaks the TransactionTestCases that run afterwards.
        cls._media_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls._override = override_settings(MEDIA_ROOT=cls._media_dir.name, MEDIA_REQUIRE_AUTH=True)
        cls._override.enable()
        cls.addClassCleanup(cls._media_dir.cleanup)
        cls.addClassCleanup(cls._override.disable)

    def setUp(self):
        self.ferralla_a = User.objects.create_user('ferralla_a', password='x')
        self.ferralla_b = User.objects.create_user('ferralla_b', password='x')
        self.admin = User.objects.create_user('admin', password='x', is_staff=True)
        self.token_a = Token.objects.create(user=self.ferralla_a)
        self.token_b = Token.objects.create(user=self.ferralla_b)
        self.token_admin = Token.objects.create(user=self.admin)

        self.project_a = Proyecto.objects.create(nombre='A', usuario=self.ferralla_a)
        self.project_b = Proyecto.objects.create(nombre='B', usuario=self.ferralla_b)
        self.project_a.plano_archivo.name = 'planos/plano_a.pdf'
        self.project_a.save(update_fields=['plano_archivo'])

        self.image_a = self._write(f'imagenes/{self.project_a.id}/7/MOD_A01_INF_01.png')
        self.foto_b = self._write(f'fotos/{self.project_b.id}/9/MOD_B01_SUP_03_foto.jpg')
        self.plano_a = self._write('planos/plano_a.pdf')
        self.legacy = self._write('cortes/viejo.png')

        grupo = GrupoMesas.objects.create(usuario=self.ferralla_b, nombre='G1')
        self.device_token = secrets.token_urlsafe(32)
        self.mesa = Mesa.objects.create(
            nombre='Mesa 1', usuario=self.ferralla_b, grupo=grupo,
            device_token_hash=hashlib.sha256(self.device_token.encode()).hexdigest(),
        )

    def _write(self, rel_path):
        from django.conf import settings
        full = os.path.join(settings.MEDIA_ROOT, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'wb') as fh:
            fh.write(b'binary')
        return f'/media/{rel_path}'

    def _read(self, response):
        return b''.join(response.streaming_content) if response.streaming else response.content

    def _get(self, url, **extra):
        """GET and close the response so served files do not stay open."""
        response = self.client.get(url, **extra)
        response.close()
        return response

    # ---- anonymous -------------------------------------------------------
    def test_anonymous_gets_401(self):
        self.assertEqual(self._get(self.image_a).status_code, 401)

    def test_kill_switch_restores_public_media(self):
        with override_settings(MEDIA_REQUIRE_AUTH=False):
            response = self.client.get(self.image_a)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._read(response), b'binary')
        response.close()

    # ---- user token via header ---------------------------------------------
    def test_owner_reads_own_project_image(self):
        response = self.client.get(self.image_a, HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._read(response), b'binary')
        self.assertIn('private', response['Cache-Control'])
        response.close()

    def test_other_ferralla_is_forbidden(self):
        response = self._get(self.image_a, HTTP_AUTHORIZATION=f'Token {self.token_b.key}')
        self.assertEqual(response.status_code, 403)
        response = self._get(self.foto_b, HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(response.status_code, 403)

    def test_admin_reads_everything(self):
        for url in (self.image_a, self.foto_b, self.plano_a, self.legacy):
            response = self._get(url, HTTP_AUTHORIZATION=f'Token {self.token_admin.key}')
            self.assertEqual(response.status_code, 200, url)

    def test_project_files_follow_project_owner(self):
        ok = self._get(self.plano_a, HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(ok.status_code, 200)
        denied = self._get(self.plano_a, HTTP_AUTHORIZATION=f'Token {self.token_b.key}')
        self.assertEqual(denied.status_code, 403)

    def test_legacy_folder_is_admin_only(self):
        response = self._get(self.legacy, HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(response.status_code, 403)

    def test_file_names_with_spaces_and_parentheses_are_served(self):
        # Real imports carry names like "Planta 1_D10_INF_JPG(SP)_07.jpg".
        url = self._write(f'imagenes/{self.project_a.id}/7/PROY MODULO (SP) FOTO INTERM.jpg')
        encoded = url.replace(' ', '%20').replace('(', '%28').replace(')', '%29')
        response = self.client.get(encoded, HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._read(response), b'binary')
        response.close()

    def test_missing_file_for_owner_is_404_not_403(self):
        response = self.client.get(
            f'/media/imagenes/{self.project_a.id}/7/missing.png',
            HTTP_AUTHORIZATION=f'Token {self.token_a.key}',
        )
        self.assertEqual(response.status_code, 404)

    def test_invalid_token_is_401(self):
        response = self._get(self.image_a, HTTP_AUTHORIZATION='Token nope')
        self.assertEqual(response.status_code, 401)

    # ---- cookies (what <img src> actually sends) ---------------------------
    def test_user_cookie_authenticates_like_header(self):
        self.client.cookies[USER_COOKIE] = self.token_a.key
        self.assertEqual(self._get(self.image_a).status_code, 200)
        self.assertEqual(self._get(self.foto_b).status_code, 403)

    def test_device_cookie_reads_any_media(self):
        self.client.cookies[DEVICE_COOKIE] = self.device_token
        for url in (self.image_a, self.foto_b):
            self.assertEqual(self._get(url).status_code, 200, url)

    def test_device_only_reads_images_and_photos(self):
        # Checklist attachments (and project PDFs) are staff material; a
        # paired mini-PC must not be able to fetch them even with a token.
        control = self._write(f'controles/{self.project_b.id}/4/aprobacion.pdf')
        self.client.cookies[DEVICE_COOKIE] = self.device_token
        self.assertEqual(self._get(control).status_code, 403)
        self.assertEqual(self._get(self.plano_a).status_code, 403)
        self.assertEqual(self._get(self.image_a).status_code, 200)

    def test_checklist_attachments_are_staff_only(self):
        control = self._write(f'controles/{self.project_a.id}/4/aprobacion.pdf')
        self.assertEqual(self._get(control, HTTP_AUTHORIZATION=f'Token {self.token_a.key}').status_code, 403, 'ni el dueno del proyecto')
        self.assertEqual(self._get(control, HTTP_AUTHORIZATION=f'Token {self.token_admin.key}').status_code, 200)

    def test_device_bearer_header_reads_media(self):
        response = self._get(self.image_a, HTTP_AUTHORIZATION=f'Bearer {self.device_token}')
        self.assertEqual(response.status_code, 200)

    # ---- cookie issuance ----------------------------------------------------
    def test_login_sets_user_media_cookie(self):
        response = self.client.post(
            '/api/token-auth/', {'username': 'ferralla_a', 'password': 'x'}, format='json',
        )
        self.assertEqual(response.status_code, 200)
        cookie = response.cookies[USER_COOKIE]
        self.assertEqual(cookie.value, self.token_a.key)
        self.assertEqual(cookie['path'], '/media/')

    def test_authenticated_api_call_sets_user_cookie_once(self):
        first = self.client.get('/api/proyectos/', HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.cookies[USER_COOKIE].value, self.token_a.key)
        # The test client keeps the cookie; a second call must not re-send it.
        second = self.client.get('/api/proyectos/', HTTP_AUTHORIZATION=f'Token {self.token_a.key}')
        self.assertNotIn(USER_COOKIE, second.cookies)

    def test_device_api_call_sets_device_cookie(self):
        response = self.client.get('/api/device/state/', HTTP_AUTHORIZATION=f'Bearer {self.device_token}')
        self.assertEqual(response.status_code, 200)
        cookie = response.cookies[DEVICE_COOKIE]
        self.assertEqual(cookie.value, self.device_token)
        self.assertEqual(cookie['path'], '/media/')

    def test_project_file_urls_are_relative_so_they_go_through_nginx(self):
        response = self.client.get(
            f'/api/proyectos/{self.project_a.id}/',
            HTTP_AUTHORIZATION=f'Token {self.token_a.key}',
            HTTP_HOST='projectionplatform-production.up.railway.app',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['plano_archivo'], '/media/planos/plano_a.pdf')
        self.assertIsNone(response.data['documentos_archivo'])
