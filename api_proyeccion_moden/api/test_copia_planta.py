import shutil
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from . import copia_planta
from .models import DetalleModuloFase, GrupoBastidor, Imagen, MaterialPieza, Modulo, Proyecto


class CopiarPlantaTipoTests(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)

        self.admin = User.objects.create_user('oficina', is_staff=True)
        self.ferralla = User.objects.create_user('ferralla')
        self.origen = Proyecto.objects.create(
            nombre='OBRA_BI_P03', usuario=self.ferralla, modulos_previstos=3,
            datos_tecnicos_importados=True, peso_elementos_sueltos_kg=Decimal('120.50'),
            fichero_datos_tecnicos=SimpleUploadedFile('resumen_modulos.db', b'db de la planta'),
            despiece_archivo=SimpleUploadedFile('despiece.xlsx', b'excel de la planta'),
        )
        # Bastidor 1 dividido en fabricacion (A02 paso a la parte B) y 2 apartado.
        b1 = GrupoBastidor.objects.create(proyecto=self.origen, indice=1, nombre='Bastidor 1', sin_division_automatica=True)
        b1b = GrupoBastidor.objects.create(proyecto=self.origen, indice=1, sufijo='B', dividido_de=b1)
        b2 = GrupoBastidor.objects.create(proyecto=self.origen, indice=2, nombre='Bastidor 2', en_espera=True)
        self.a01 = Modulo.objects.create(
            proyecto=self.origen, nombre='A01', grupo_bastidor=b1, orden_intra=1, orden_intra_previo=1,
            tipo_modulo='ESQUINA', ancho_cm=Decimal('18.50'), codigos_color='ygxxxxxx',
            estado='COMPLETADO', completado_at=timezone.now(),
        )
        a02 = Modulo.objects.create(proyecto=self.origen, nombre='A02', grupo_bastidor=b1b, orden_intra=1, orden_intra_previo=2)
        Modulo.objects.create(proyecto=self.origen, nombre='A03', grupo_bastidor=b1, orden_intra=2, orden_intra_previo=3)
        Modulo.objects.create(proyecto=self.origen, nombre='A04', grupo_bastidor=b2, orden_intra=1)
        DetalleModuloFase.objects.create(modulo=self.a01, fase='INFERIOR', peso_malla_final_kg=Decimal('10.50'), cantidad_cortes=7)
        DetalleModuloFase.objects.create(modulo=self.a01, fase='SUPERIOR', peso_refuerzos_kg=Decimal('3.25'))
        MaterialPieza.objects.create(proyecto=self.origen, modulo=self.a01, tipo='REFUERZO', capa='INFERIOR', subtipo='10', longitud=Decimal('2.5'))
        self._imagen(self.a01, 'INFERIOR', 1, 'MOD_A01_INF_00.png', 'MOD_A01_INF_MONITOR_00.png')
        self._imagen(a02, 'SUPERIOR', 1, 'MOD_A02_SUP_00.png', None)

        self.destino = Proyecto.objects.create(
            nombre='OBRA_BH_P05', usuario=self.ferralla, planta_numero=5,
            fichero_datos_tecnicos=SimpleUploadedFile('resumen_modulos.db', b'db vieja'),
            despiece_archivo=SimpleUploadedFile('despiece.xlsx', b'excel viejo'),
        )
        self.tecnico_viejo = self.destino.fichero_datos_tecnicos.name
        # Un bastidor que se quedo vacio al borrar sus modulos.
        GrupoBastidor.objects.create(proyecto=self.destino, indice=7, nombre='Bastidor 7')
        self.client.force_authenticate(self.admin)

    def _imagen(self, modulo, fase, orden, nombre, monitor):
        urls = {}
        for campo, fichero in (('url', nombre), ('url_monitor', monitor)):
            if fichero:
                ruta = Path(self.media) / f'imagenes/{modulo.proyecto_id}/{modulo.id}/{fichero}'
                ruta.parent.mkdir(parents=True, exist_ok=True)
                ruta.write_bytes(fichero.encode())
                urls[campo] = f'/media/imagenes/{modulo.proyecto_id}/{modulo.id}/{fichero}'
        Imagen.objects.create(modulo=modulo, fase=fase, orden=orden, status='PUBLISHED', **urls)

    def _copiar(self, origen=None):
        return self.client.post(
            f'/api/proyectos/{self.destino.pk}/copiar-de/', {'origen': (origen or self.origen).pk}, format='json',
        )

    def _ficheros(self):
        return sorted(p.relative_to(self.media).as_posix() for p in Path(self.media).rglob('*') if p.is_file())

    def test_copia_la_planta_en_un_proyecto_vacio(self):
        with self.captureOnCommitCallbacks(execute=True):
            response = self._copiar()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['modulos_count'], 4)

        bastidores = [
            (g.indice, g.sufijo, g.nombre, g.en_espera, g.sin_division_automatica,
             list(g.modulos.order_by('orden_intra').values_list('nombre', flat=True)))
            for g in GrupoBastidor.objects.filter(proyecto=self.destino).order_by('indice')
        ]
        # Sin partes ni apartados: eso era de la fabricacion del origen.
        self.assertEqual(bastidores, [
            (1, '', 'Bastidor 1', False, False, ['A01', 'A02', 'A03']),
            (2, '', 'Bastidor 2', False, False, ['A04']),
        ])
        a01 = Modulo.objects.get(proyecto=self.destino, nombre='A01')
        self.assertEqual(
            (a01.estado, a01.inferior_hecho, a01.completado_at, a01.tipo_modulo, a01.ancho_cm, a01.codigos_color),
            ('PENDIENTE', False, None, 'ESQUINA', Decimal('18.50'), 'ygxxxxxx'),
        )
        self.assertEqual(a01.peso_total_kg, Decimal('13.75'))
        self.assertEqual(MaterialPieza.objects.get(proyecto=self.destino).modulo, a01)

        imagenes = list(Imagen.objects.filter(modulo__proyecto=self.destino).order_by('modulo__nombre'))
        self.assertEqual([(i.modulo.nombre, i.fase, i.status) for i in imagenes], [
            ('A01', 'INFERIOR', 'PUBLISHED'), ('A02', 'SUPERIOR', 'PUBLISHED'),
        ])
        self.assertEqual(imagenes[0].url, f'/media/imagenes/{self.destino.pk}/{a01.pk}/MOD_A01_INF_00.png')
        self.assertIsNone(imagenes[1].url_monitor)
        for url in (imagenes[0].url, imagenes[0].url_monitor, imagenes[1].url):
            self.assertEqual((Path(self.media) / url[len('/media/'):]).read_bytes(), url.rsplit('/', 1)[1].encode())

        self.destino.refresh_from_db()
        self.assertEqual((self.destino.nombre, self.destino.planta_numero), ('OBRA_BH_P05', 5))
        self.assertEqual(
            (self.destino.modulos_previstos, self.destino.datos_tecnicos_importados, self.destino.peso_elementos_sueltos_kg),
            (3, True, Decimal('120.50')),
        )
        with default_storage.open(self.destino.despiece_archivo.name) as fichero:
            self.assertEqual(fichero.read(), b'excel de la planta')
        self.assertNotEqual(self.destino.despiece_archivo.name, self.origen.despiece_archivo.name)
        self.assertFalse(default_storage.exists(self.tecnico_viejo))
        # El origen sigue igual.
        self.assertEqual(Modulo.objects.filter(proyecto=self.origen).count(), 4)
        self.assertTrue(default_storage.exists(self.origen.despiece_archivo.name))
        self.assertEqual(GrupoBastidor.objects.filter(proyecto=self.origen, sufijo='B').count(), 1)

    def test_lo_que_el_origen_no_trae_se_queda(self):
        Proyecto.objects.filter(pk=self.origen.pk).update(despiece_archivo='', modulos_previstos=None)
        self.origen.refresh_from_db()
        despiece = self.destino.despiece_archivo.name
        self.destino.modulos_previstos = 64
        self.destino.save(update_fields=['modulos_previstos'])

        self.assertEqual(self._copiar().status_code, 200)
        self.destino.refresh_from_db()
        self.assertEqual((self.destino.despiece_archivo.name, self.destino.modulos_previstos), (despiece, 64))
        self.assertTrue(default_storage.exists(despiece))

    def test_solo_en_un_proyecto_sin_modulos(self):
        Modulo.objects.create(proyecto=self.destino, nombre='X01')
        response = self._copiar()
        self.assertEqual(response.status_code, 400)
        self.assertIn('ya tiene módulos', response.data['detail'])
        self.assertEqual(list(Modulo.objects.filter(proyecto=self.destino).values_list('nombre', flat=True)), ['X01'])

    def test_no_copia_de_un_origen_incompleto(self):
        (Path(self.media) / f'imagenes/{self.origen.pk}/{self.a01.pk}/MOD_A01_INF_MONITOR_00.png').unlink()
        response = self._copiar()
        self.assertEqual(response.status_code, 400)
        self.assertIn('le faltan 1 ficheros', response.data['detail'])

        Proyecto.objects.filter(pk=self.origen.pk).update(archivado_at=timezone.now())
        self.assertIn('está archivado', self._copiar().data['detail'])
        self.assertIn('de sí mismo', self._copiar(self.destino).data['detail'])
        response = self.client.post(f'/api/proyectos/{self.destino.pk}/copiar-de/', {'origen': 'x'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Modulo.objects.filter(proyecto=self.destino).exists())

    def test_solo_la_oficina(self):
        self.client.force_authenticate(self.ferralla)
        self.assertEqual(self._copiar().status_code, 403)
        self.assertFalse(Modulo.objects.filter(proyecto=self.destino).exists())

    def test_si_falla_a_medias_no_deja_nada(self):
        antes = self._ficheros()
        with mock.patch.object(copia_planta.MaterialPieza.objects, 'bulk_create', side_effect=RuntimeError('fallo')):
            with self.assertRaises(RuntimeError):
                copia_planta.copiar(self.origen, self.destino)
        self.assertEqual(self._ficheros(), antes)
        self.assertFalse(Modulo.objects.filter(proyecto=self.destino).exists())
        self.assertEqual(list(GrupoBastidor.objects.filter(proyecto=self.destino).values_list('indice', flat=True)), [7])
        self.destino.refresh_from_db()
        self.assertEqual(self.destino.fichero_datos_tecnicos.name, self.tecnico_viejo)
