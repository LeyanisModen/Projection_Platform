import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from django.conf import settings
from django.core.files.storage import default_storage
from django.db.models import Q

from api.models import FotoFabricacion, Imagen, Proyecto


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProjectMediaSnapshot:
    project_id: int
    storage_files: tuple[str, ...]
    media_urls: tuple[str, ...]


@dataclass(frozen=True)
class ModuleMediaSnapshot:
    project_id: int
    module_id: int
    storage_files: tuple[str, ...]
    media_urls: tuple[str, ...]


def collect_project_media(project):
    """Collect file references before the project's cascade delete runs."""
    storage_files = {
        field_file.name
        for field_file in (project.plano_archivo, project.documentos_archivo)
        if field_file and field_file.name
    }
    if project.fichero_datos_tecnicos:
        storage_files.add(project.fichero_datos_tecnicos.name)
    storage_files.update(
        Imagen.objects.filter(modulo__proyecto=project)
        .exclude(archivo='')
        .exclude(archivo__isnull=True)
        .values_list('archivo', flat=True)
    )

    image_urls = Imagen.objects.filter(modulo__proyecto=project).exclude(
        url=''
    ).exclude(url__isnull=True).values_list('url', flat=True)
    photo_urls = FotoFabricacion.objects.filter(modulo__proyecto=project).exclude(
        url=''
    ).values_list('url', flat=True)

    return ProjectMediaSnapshot(
        project_id=project.pk,
        storage_files=tuple(sorted(storage_files)),
        media_urls=tuple(sorted(set(image_urls).union(photo_urls))),
    )


def collect_module_media(module):
    storage_files = tuple(sorted(
        Imagen.objects.filter(modulo=module)
        .exclude(archivo='')
        .exclude(archivo__isnull=True)
        .values_list('archivo', flat=True)
    ))
    image_urls = Imagen.objects.filter(modulo=module).exclude(
        url=''
    ).exclude(url__isnull=True).values_list('url', flat=True)
    photo_urls = FotoFabricacion.objects.filter(modulo=module).exclude(
        url=''
    ).values_list('url', flat=True)
    return ModuleMediaSnapshot(
        project_id=module.proyecto_id,
        module_id=module.pk,
        storage_files=storage_files,
        media_urls=tuple(sorted(set(image_urls).union(photo_urls))),
    )


def _relative_media_path(url):
    path = unquote(urlparse(url).path).replace('\\', '/')
    media_url = settings.MEDIA_URL or '/media/'
    media_prefix = urlparse(media_url).path.replace('\\', '/')
    if not media_prefix.startswith('/'):
        media_prefix = f'/{media_prefix}'
    if not media_prefix.endswith('/'):
        media_prefix = f'{media_prefix}/'
    if not path.startswith(media_prefix):
        return None
    return path[len(media_prefix):].lstrip('/')


def _safe_local_path(relative_path):
    if not relative_path:
        return None
    media_root = Path(settings.MEDIA_ROOT).resolve()
    candidate = (media_root / relative_path).resolve()
    try:
        candidate.relative_to(media_root)
    except ValueError:
        logger.warning('Skipping media path outside MEDIA_ROOT: %s', relative_path)
        return None
    return candidate


def _storage_file_is_referenced(file_name):
    return (
        Proyecto.objects.filter(
            Q(plano_archivo=file_name)
            | Q(documentos_archivo=file_name)
            | Q(fichero_datos_tecnicos=file_name)
        ).exists()
        or Imagen.objects.filter(archivo=file_name).exists()
    )


def delete_unreferenced_storage_files(file_names):
    """Delete replaced files only after their database references disappear."""
    for file_name in set(filter(None, file_names)):
        try:
            if not _storage_file_is_referenced(file_name):
                default_storage.delete(file_name)
        except Exception:
            logger.exception('Could not delete unreferenced file %s', file_name)


def _media_url_is_referenced(url):
    return (
        Imagen.objects.filter(url=url).exists()
        or FotoFabricacion.objects.filter(url=url).exists()
    )


def _directory_has_references(relative_directory):
    prefix = relative_directory.replace('\\', '/').rstrip('/') + '/'
    media_prefix = (settings.MEDIA_URL or '/media/').rstrip('/') + '/'
    url_prefix = f'{media_prefix}{prefix}'
    return (
        Proyecto.objects.filter(
            Q(plano_archivo__startswith=prefix) | Q(documentos_archivo__startswith=prefix)
        ).exists()
        or Imagen.objects.filter(
            Q(archivo__startswith=prefix) | Q(url__startswith=url_prefix)
        ).exists()
        or FotoFabricacion.objects.filter(url__startswith=url_prefix).exists()
    )


def delete_project_media(snapshot):
    """Delete unreferenced project files after its database commit succeeds."""
    try:
        delete_unreferenced_storage_files(snapshot.storage_files)

        for url in snapshot.media_urls:
            if _media_url_is_referenced(url):
                continue
            relative_path = _relative_media_path(url)
            local_path = _safe_local_path(relative_path)
            if local_path and local_path.is_file():
                local_path.unlink()

        for category in ('imagenes', 'fotos'):
            relative_directory = f'{category}/{snapshot.project_id}'
            if _directory_has_references(relative_directory):
                logger.warning(
                    'Keeping project media directory with active references: %s',
                    relative_directory,
                )
                continue
            local_directory = _safe_local_path(relative_directory)
            if local_directory and local_directory.is_dir():
                shutil.rmtree(local_directory)
    except Exception:
        # The database deletion is already committed. Keep the API response
        # successful and leave an actionable error for operational cleanup.
        logger.exception(
            'Could not fully delete media for project %s', snapshot.project_id
        )


def delete_module_media(snapshot):
    """Delete only the unreferenced files and directories of one module."""
    try:
        delete_unreferenced_storage_files(snapshot.storage_files)

        for url in snapshot.media_urls:
            if _media_url_is_referenced(url):
                continue
            relative_path = _relative_media_path(url)
            local_path = _safe_local_path(relative_path)
            if local_path and local_path.is_file():
                local_path.unlink()

        # Remove empty parent directories left by both legacy
        # project/plant/module paths and the new project/module paths.
        for url in snapshot.media_urls:
            relative_path = _relative_media_path(url)
            local_path = _safe_local_path(relative_path)
            parent = local_path.parent if local_path else None
            media_root = Path(settings.MEDIA_ROOT).resolve()
            while parent and parent != media_root:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
    except Exception:
        logger.exception(
            'Could not fully delete media for module %s', snapshot.module_id
        )
