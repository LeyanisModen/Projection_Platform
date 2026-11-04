"""Copiar una planta tipo: un proyecto sin modulos toma los de otro ya hecho.

Se copia lo que define la planta: modulos con sus datos tecnicos, bastidores
y su orden, presentaciones (player y monitor), base tecnica, despiece y
elementos sueltos. Lo del destino se queda: nombre, ferralla, edificio y
planta, fechas, lista de control y lista de compra. Las imagenes y ficheros
se copian al proyecto destino (no se comparten), asi que archivar o borrar
uno no toca al otro.

Los modulos empiezan pendientes y los bastidores sin dividir ni apartar:
eso es de la fabricacion del origen, no de la planta.
"""
import os
import posixpath
import re
import shutil
from urllib.parse import unquote, urlparse

from django.conf import settings
from django.core.files.storage import default_storage
from django.db import transaction
from django.utils import timezone

from .models import DetalleModuloFase, GrupoBastidor, Imagen, MaterialPieza, Modulo, Proyecto
from .project_media import delete_unreferenced_storage_files

CAMPOS_FICHERO = ('fichero_datos_tecnicos', 'despiece_archivo', 'elementos_sueltos_archivo', 'plano_archivo')
# Vienen de importar la base tecnica: solo se copian con ella.
CAMPOS_BASE_TECNICA = ('datos_tecnicos_importados', 'peso_elementos_sueltos_kg')
CAMPOS_PLANTA = ('modulos_previstos', 'estrategia_bastidor')


def _campos(instancia, fuera):
    return {
        campo.attname: getattr(instancia, campo.attname)
        for campo in instancia._meta.concrete_fields
        if not campo.primary_key and campo.name not in fuera
    }


def _ruta_media(url):
    ruta = unquote(urlparse(url).path)
    prefijo = settings.MEDIA_URL or '/media/'
    if not ruta.startswith(prefijo):
        return None
    return os.path.join(settings.MEDIA_ROOT, ruta[len(prefijo):])


def _clave_natural(nombre):
    return [int(trozo) if trozo.isdigit() else trozo.casefold() for trozo in re.split(r'(\d+)', nombre or '')]


def motivos_para_no_copiar(origen, destino):
    """Por que no se puede copiar (lista vacia: se puede)."""
    motivos = []
    if origen.pk == destino.pk:
        motivos.append('Elige otro proyecto: no se puede copiar de sí mismo.')
    if destino.archivado_at:
        motivos.append('El proyecto está archivado.')
    if Modulo.objects.filter(proyecto=destino).exists():
        motivos.append('El proyecto ya tiene módulos: solo se copia en uno vacío.')
    if origen.archivado_at:
        motivos.append(f'{origen.nombre} está archivado: sus presentaciones ya no están en la plataforma.')
    elif not Modulo.objects.filter(proyecto=origen).exists():
        motivos.append(f'{origen.nombre} no tiene módulos.')
    else:
        urls = [
            url for pareja in Imagen.objects.filter(modulo__proyecto=origen).values_list('url', 'url_monitor')
            for url in pareja if url
        ]
        faltan = sum(1 for url in urls if not (_ruta_media(url) and os.path.isfile(_ruta_media(url))))
        faltan += sum(
            1 for campo in CAMPOS_FICHERO
            if getattr(origen, campo) and not default_storage.exists(getattr(origen, campo).name)
        )
        if faltan:
            motivos.append(f'A {origen.nombre} le faltan {faltan} ficheros en la plataforma.')
    return motivos


def _copiar_bastidores(origen, destino):
    """Solo los bastidores reales; las partes vuelven a su raiz en el orden de
    antes de dividir, como al unir."""
    bastidores = {}
    for raiz in GrupoBastidor.objects.filter(proyecto=origen, dividido_de__isnull=True).order_by('indice'):
        nuevo = GrupoBastidor.objects.create(proyecto=destino, indice=raiz.indice, nombre=raiz.nombre)
        bastidores[raiz.id] = nuevo
        for parte_id in raiz.divisiones.values_list('id', flat=True):
            bastidores[parte_id] = nuevo
    return bastidores


def copiar(origen, destino):
    """Copia la planta de origen en destino; todo o nada. Devuelve los modulos nuevos."""
    carpetas_nuevas = set()
    ficheros_nuevos = []
    try:
        with transaction.atomic():
            destino = Proyecto.objects.select_for_update().get(pk=destino.pk)
            motivos = motivos_para_no_copiar(origen, destino)
            if motivos:
                raise ValueError(' '.join(motivos))

            # Bastidores vacios y piezas de una base tecnica anterior.
            GrupoBastidor.objects.filter(proyecto=destino).delete()
            bastidores = _copiar_bastidores(origen, destino)

            por_bastidor = {}
            for modulo in Modulo.objects.filter(proyecto=origen):
                por_bastidor.setdefault(bastidores.get(modulo.grupo_bastidor_id), []).append(modulo)
            modulos = {}
            for bastidor, del_bastidor in por_bastidor.items():
                del_bastidor.sort(key=lambda m: (
                    m.orden_intra_previo is None, m.orden_intra_previo or 0, m.orden_intra or 0,
                    _clave_natural(m.nombre),
                ))
                for posicion, modulo in enumerate(del_bastidor, start=1):
                    modulos[modulo.id] = Modulo.objects.create(
                        proyecto=destino, grupo_bastidor=bastidor,
                        orden_intra=posicion if bastidor else modulo.orden_intra,
                        nombre=modulo.nombre, tipo_modulo=modulo.tipo_modulo, ancho_cm=modulo.ancho_cm,
                        codigos_color=modulo.codigos_color,
                    )

            DetalleModuloFase.objects.bulk_create([
                DetalleModuloFase(modulo=modulos[detalle.modulo_id], **_campos(detalle, {'modulo', 'created_at', 'updated_at'}))
                for detalle in DetalleModuloFase.objects.filter(modulo__proyecto=origen)
            ])

            imagenes = []
            for imagen in Imagen.objects.filter(modulo__proyecto=origen).order_by('id'):
                nuevo = modulos[imagen.modulo_id]
                urls = {}
                for campo in ('url', 'url_monitor'):
                    url = getattr(imagen, campo)
                    if not url:
                        urls[campo] = url
                        continue
                    nombre = posixpath.basename(urlparse(url).path)
                    urls[campo] = f'{settings.MEDIA_URL}imagenes/{destino.id}/{nuevo.id}/{nombre}'
                    ruta = _ruta_media(urls[campo])
                    carpeta = os.path.dirname(ruta)
                    if carpeta not in carpetas_nuevas:
                        os.makedirs(carpeta, exist_ok=True)
                        carpetas_nuevas.add(carpeta)
                    shutil.copy2(_ruta_media(url), ruta)
                imagenes.append(Imagen(
                    modulo=nuevo, archivo=None,
                    **_campos(imagen, {'modulo', 'archivo', 'url', 'url_monitor'}), **urls,
                ))
            Imagen.objects.bulk_create(imagenes, batch_size=500)

            # Lo que el origen no trae se queda como estaba en el destino.
            ficheros_viejos = []
            for campo in CAMPOS_FICHERO:
                fichero = getattr(origen, campo)
                if not fichero:
                    continue
                ficheros_viejos.append(getattr(destino, campo).name)
                with default_storage.open(fichero.name, 'rb') as contenido:
                    getattr(destino, campo).save(os.path.basename(fichero.name), contenido, save=False)
                ficheros_nuevos.append(getattr(destino, campo).name)
            campos = [*CAMPOS_FICHERO, *CAMPOS_PLANTA]
            if origen.fichero_datos_tecnicos:
                MaterialPieza.objects.filter(proyecto=destino).delete()
                MaterialPieza.objects.bulk_create([
                    MaterialPieza(proyecto=destino, modulo=modulos.get(pieza.modulo_id), **_campos(pieza, {'proyecto', 'modulo'}))
                    for pieza in MaterialPieza.objects.filter(proyecto=origen)
                ], batch_size=500)
                destino.datos_tecnicos_actualizados_at = timezone.now()
                campos += [*CAMPOS_BASE_TECNICA, 'datos_tecnicos_actualizados_at']
            for campo in CAMPOS_PLANTA:
                if getattr(origen, campo) is not None:
                    setattr(destino, campo, getattr(origen, campo))
            if origen.fichero_datos_tecnicos:
                for campo in CAMPOS_BASE_TECNICA:
                    setattr(destino, campo, getattr(origen, campo))
            destino.save(update_fields=campos)

            transaction.on_commit(
                lambda viejos=tuple(ficheros_viejos): delete_unreferenced_storage_files(viejos),
                robust=True,
            )
    except Exception:
        for carpeta in carpetas_nuevas:
            shutil.rmtree(carpeta, ignore_errors=True)
        for nombre in ficheros_nuevos:
            default_storage.delete(nombre)
        raise
    return list(modulos.values())
