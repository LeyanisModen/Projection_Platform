import os
import shutil
import sqlite3
import tempfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from . import plano
from .models import GrupoBastidor, Modulo, Proyecto


def base_tecnica(con_plano=True):
    """Una base .db pequeña: losa de 10x10 m con un hueco, un pilar y cinco encajes."""
    carpeta = tempfile.mkdtemp()
    ruta = os.path.join(carpeta, 'base.db')
    conexion = sqlite3.connect(ruta)
    conexion.execute('CREATE TABLE resumen (id INTEGER PRIMARY KEY, nombre_modulo TEXT)')
    if con_plano:
        conexion.executescript('''
            CREATE TABLE contorno (id INTEGER PRIMARY KEY, posX1 FLOAT, posY1 FLOAT);
            INSERT INTO contorno (posX1, posY1) VALUES (100, 200), (110, 200), (110, 210), (100, 210);
            CREATE TABLE huecos_pol (id INTEGER PRIMARY KEY, posX1 FLOAT, posY1 FLOAT, id_hueco INT);
            INSERT INTO huecos_pol (posX1, posY1, id_hueco) VALUES (104, 204, 7), (106, 204, 7), (106, 206, 7), (104, 206, 7);
            CREATE TABLE huecos_circ (id INTEGER PRIMARY KEY, posX1 FLOAT, posY1 FLOAT, radio FLOAT, id_hueco INT);
            INSERT INTO huecos_circ (posX1, posY1, radio, id_hueco) VALUES (101, 201, 0.17, 1);
            CREATE TABLE pilares (id INTEGER PRIMARY KEY, posX1 FLOAT, posY1 FLOAT, id_hueco INT, name TEXT);
            INSERT INTO pilares (posX1, posY1, id_hueco, name) VALUES (108, 208, 2, 'G02'), (108.4, 208, 2, 'G02'), (108.4, 208.4, 2, 'G02');
            CREATE TABLE rectangulos_encaje (id INTEGER PRIMARY KEY, modulo TEXT, pt1X REAL, pt1Y REAL, pt3X REAL, pt3Y REAL);
            INSERT INTO rectangulos_encaje (modulo, pt1X, pt1Y, pt3X, pt3Y) VALUES
                ('A01', 100, 200, 104.8, 201.8), ('A02', 100, 201.8, 104.8, 203.6), ('A03', 104.8, 200, 109.6, 201.8),
                ('SDA02', 104.8, 201.8, 106, 203), ('X99', 106, 208, 107, 209);
            CREATE TABLE detalles (id INTEGER PRIMARY KEY, detalle TEXT, valor TEXT, unidad TEXT);
            INSERT INTO detalles (detalle, valor, unidad) VALUES ('CANTO_LOSA', '23.0', 'cm');
        ''')
    conexion.commit()
    conexion.close()
    with open(ruta, 'rb') as fichero:
        contenido = fichero.read()
    shutil.rmtree(carpeta)
    return SimpleUploadedFile('resumen_modulos.db', contenido)


class PlanoProyectoTests(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)
        plano._geometria.cache_clear()

        self.ferralla = User.objects.create_user('ferralla')
        self.proyecto = Proyecto.objects.create(nombre='OBRA_P03', usuario=self.ferralla, fichero_datos_tecnicos=base_tecnica())
        b1 = GrupoBastidor.objects.create(proyecto=self.proyecto, indice=1, nombre='Bastidor 1')
        b1b = GrupoBastidor.objects.create(proyecto=self.proyecto, indice=1, sufijo='B', dividido_de=b1)
        b2 = GrupoBastidor.objects.create(proyecto=self.proyecto, indice=2, nombre='Bastidor 2')
        Modulo.objects.create(proyecto=self.proyecto, nombre='A01', grupo_bastidor=b1, estado='COMPLETADO')
        Modulo.objects.create(proyecto=self.proyecto, nombre='A03', grupo_bastidor=b1b, estado='COMPLETADO')
        Modulo.objects.create(proyecto=self.proyecto, nombre='A02', grupo_bastidor=b2, estado='EN_PROGRESO', superior_hecho=True)
        Modulo.objects.create(proyecto=self.proyecto, nombre='A04', grupo_bastidor=b2)
        self.b1, self.b2 = b1, b2
        self.client.force_authenticate(self.ferralla)

    def test_plano_con_el_estado_de_modulos_y_bastidores(self):
        response = self.client.get(f'/api/proyectos/{self.proyecto.pk}/plano/')
        self.assertEqual(response.status_code, 200, response.data)
        datos = response.data
        # Metros desde la esquina de arriba a la izquierda, con 0,5 m de margen.
        self.assertEqual((datos['ancho'], datos['alto'], datos['canto_losa_cm']), (11.0, 11.0, 23.0))
        self.assertEqual(datos['contorno'], [[0.5, 10.5], [10.5, 10.5], [10.5, 0.5], [0.5, 0.5]])
        self.assertEqual(datos['huecos'], [[[4.5, 6.5], [6.5, 6.5], [6.5, 4.5], [4.5, 4.5]]])
        self.assertEqual(datos['huecos_circulares'], [{'x': 1.5, 'y': 9.5, 'r': 0.17}])
        self.assertEqual(datos['pilares'][0]['nombre'], 'G02')

        modulos = {m['nombre']: m for m in datos['modulos']}
        self.assertEqual(
            {k: modulos['A01'][k] for k in ('x', 'y', 'ancho', 'alto', 'estado', 'bastidor')},
            {'x': 0.5, 'y': 8.7, 'ancho': 4.8, 'alto': 1.8, 'estado': 'terminado', 'bastidor': self.b1.id},
        )
        # La parte 1B cuenta en su bastidor real.
        self.assertEqual(modulos['A03']['bastidor'], self.b1.id)
        self.assertEqual(modulos['A02']['estado'], 'en_curso')
        # El SD se hace con el superior de su modulo.
        self.assertEqual((modulos['SDA02']['estado'], modulos['SDA02']['sd_de'], modulos['SDA02']['bastidor']), ('terminado', 'A02', self.b2.id))
        self.assertEqual((modulos['X99']['estado'], modulos['X99']['bastidor']), (None, None))
        self.assertEqual(datos['bastidores'], [
            {'id': self.b1.id, 'indice': 1, 'etiqueta': 'Bastidor 1', 'modulos': 2, 'terminados': 2, 'terminado': True},
            {'id': self.b2.id, 'indice': 2, 'etiqueta': 'Bastidor 2', 'modulos': 2, 'terminados': 0, 'terminado': False},
        ])
        self.assertTrue(self.client.get(f'/api/proyectos/{self.proyecto.pk}/').data['plano_disponible'])

    def test_sin_plano_en_la_base_o_sin_base(self):
        sin_tablas = Proyecto.objects.create(nombre='OBRA_P04', usuario=self.ferralla, fichero_datos_tecnicos=base_tecnica(False))
        sin_base = Proyecto.objects.create(nombre='OBRA_P05', usuario=self.ferralla)
        for proyecto in (sin_tablas, sin_base):
            self.assertEqual(self.client.get(f'/api/proyectos/{proyecto.pk}/plano/').status_code, 404)
            self.assertFalse(self.client.get(f'/api/proyectos/{proyecto.pk}/').data['plano_disponible'])

    def test_una_base_nueva_cambia_el_plano(self):
        self.assertEqual(len(self.client.get(f'/api/proyectos/{self.proyecto.pk}/plano/').data['modulos']), 5)
        self.proyecto.fichero_datos_tecnicos = base_tecnica(False)
        self.proyecto.save()
        self.assertEqual(self.client.get(f'/api/proyectos/{self.proyecto.pk}/plano/').status_code, 404)

    def test_otra_ferralla_no_lo_ve(self):
        self.client.force_authenticate(User.objects.create_user('otra'))
        self.assertEqual(self.client.get(f'/api/proyectos/{self.proyecto.pk}/plano/').status_code, 404)
