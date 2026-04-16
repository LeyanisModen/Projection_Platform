import csv
import io
import json
import os
import re
import sqlite3
import tempfile
import unicodedata

from django.contrib.auth.models import User
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from rest_framework import permissions, viewsets, status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from api.serializers import (
    ProyectoSerializer, PlantaSerializer, UserSerializer, ModuloSerializer,
    ImagenSerializer, MesaSerializer,
    ModuloQueueSerializer, ModuloQueueItemSerializer, MesaQueueItemSerializer,
    FotoFabricacionSerializer, GrupoMesasSerializer, DetalleModuloFaseSerializer,
    GrupoBastidorSerializer
)
from api.models import (
    Modulo, Proyecto, Planta, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem,
    FotoFabricacion, GrupoMesas, DetalleModuloFase, MesaQueueStatus,
    GrupoBastidor
)
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.authtoken.models import Token

from rest_framework import renderers


TECHNICAL_FIELD_ALIASES = {
    'espesor_cm': ['espesor_cm', 'espesor', 'canto', 'thickness_cm', 'thickness'],
    'peso_malla_inicial_kg': ['peso_malla_inicial_kg', 'peso_malla_inicial', 'malla_inicial_kg', 'peso_mallazo_inicial_kg'],
    'peso_malla_final_kg': ['peso_malla_final_kg', 'peso_malla_final', 'malla_final_kg', 'peso_mallazo_final_kg'],
    'desperdicio_kg': ['desperdicio_kg', 'desperdicio', 'peso_desperdicio_kg'],
    'cantidad_cortes': ['cantidad_cortes', 'cortes', 'numero_cortes'],
    'cantidad_refuerzos': ['cantidad_refuerzos', 'refuerzos', 'numero_refuerzos'],
    'peso_refuerzos_kg': ['peso_refuerzos_kg', 'peso_refuerzos'],
    'cantidad_zunchos': ['cantidad_zunchos', 'zunchos', 'numero_zunchos'],
    'peso_zunchos_kg': ['peso_zunchos_kg', 'peso_zunchos'],
    'cantidad_separadores': ['cantidad_separadores', 'separadores', 'numero_separadores'],
    'peso_separadores_kg': ['peso_separadores_kg', 'peso_separadores'],
    'cantidad_punzos': ['cantidad_punzos', 'punzos', 'numero_punzos'],
    'peso_punzos_kg': ['peso_punzos_kg', 'peso_punzos'],
    'dificultad_fabricacion': ['dificultad_fabricacion', 'dificultad', 'complejidad'],
    'observaciones': ['observaciones', 'observacion', 'notas', 'comentarios'],
}
MODULE_FIELD_ALIASES = {
    'ancho_cm': [
        'ancho_cm', 'ancho', 'ancho_modulo_cm', 'ancho_modulo',
        'module_width_cm', 'module_width', 'width_cm', 'width',
        'canto_armado_cm', 'canto_armado', 'canto',
    ],
}

MODULE_NAME_ALIASES = ['modulo', 'modulo_nombre', 'nombre_modulo', 'module', 'module_name']
PLANTA_NAME_ALIASES = ['planta', 'planta_nombre', 'nombre_planta', 'nivel', 'floor']
FASE_ALIASES = ['fase', 'phase', 'subfase', 'fase_nombre']
PHASE_PREFIXES = {
    'inf': 'INFERIOR',
    'inferior': 'INFERIOR',
    'sup': 'SUPERIOR',
    'superior': 'SUPERIOR',
}
ACTIVE_QUEUE_STATUSES = ['EN_COLA', 'MOSTRANDO']


def _is_admin(user):
    return bool(user and (user.is_staff or user.is_superuser))


class ServerSentEventRenderer(renderers.BaseRenderer):
    media_type = 'text/event-stream'
    format = 'txt'
    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data


def _canonicalize_key(value):
    if value is None:
        return ''
    normalized = unicodedata.normalize('NFKD', str(value))
    ascii_only = normalized.encode('ascii', 'ignore').decode('ascii')
    ascii_only = ascii_only.strip().lower()
    ascii_only = re.sub(r'[^a-z0-9]+', '_', ascii_only)
    return ascii_only.strip('_')


def _clean_cell(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value == '':
            return None
    return value


def _row_to_canonical_dict(row):
    return {
        _canonicalize_key(key): _clean_cell(value)
        for key, value in row.items()
    }


def _extract_value(row, aliases):
    for alias in aliases:
        value = row.get(_canonicalize_key(alias))
        if value is not None:
            return value
    return None


def _normalize_phase(value):
    if value is None:
        return None
    canonical = _canonicalize_key(value)
    return PHASE_PREFIXES.get(canonical)


DECIMAL_FIELDS_2_PLACES = {
    'espesor_cm',
    'peso_malla_inicial_kg',
    'peso_malla_final_kg',
    'desperdicio_kg',
    'peso_refuerzos_kg',
    'peso_zunchos_kg',
    'peso_separadores_kg',
    'peso_punzos_kg',
    'dificultad_fabricacion',
    'ancho_cm',
}


def _coerce_field_value(target_field, value):
    """Round decimal fields to 2 places so they fit the model's DecimalField precision."""
    if value is None or target_field not in DECIMAL_FIELDS_2_PLACES:
        return value
    try:
        dec = Decimal(str(value))
    except (TypeError, InvalidOperation):
        return value
    return dec.quantize(Decimal('0.01'))


def _extract_detail_fields(row, prefix=None):
    detail_fields = {}
    for target_field, aliases in TECHNICAL_FIELD_ALIASES.items():
        search_aliases = list(aliases)
        if prefix:
            prefixed = []
            for alias in aliases:
                canonical_alias = _canonicalize_key(alias)
                prefixed.extend([
                    f'{prefix}_{canonical_alias}',
                    f'{prefix}{canonical_alias}',
                ])
            search_aliases = prefixed + search_aliases
        value = _extract_value(row, search_aliases)
        if value is not None:
            detail_fields[target_field] = _coerce_field_value(target_field, value)
    return detail_fields


def _extract_module_fields(row):
    module_fields = {}
    for target_field, aliases in MODULE_FIELD_ALIASES.items():
        value = _extract_value(row, aliases)
        if value is not None:
            module_fields[target_field] = _coerce_field_value(target_field, value)
    return module_fields


def _normalize_technical_records(records):
    normalized_records = []

    for raw_row in records:
        row = _row_to_canonical_dict(raw_row)
        modulo_nombre = _extract_value(row, MODULE_NAME_ALIASES)
        planta_nombre = _extract_value(row, PLANTA_NAME_ALIASES)
        module_fields = _extract_module_fields(row)

        if not modulo_nombre:
            continue

        explicit_phase = _normalize_phase(_extract_value(row, FASE_ALIASES))
        explicit_fields = _extract_detail_fields(row)

        if explicit_phase and explicit_fields:
            normalized_records.append({
                'modulo_nombre': modulo_nombre,
                'planta_nombre': planta_nombre,
                'fase': explicit_phase,
                'fields': explicit_fields,
                'module_fields': module_fields,
            })
            continue

        record_added = False
        for prefix, fase in PHASE_PREFIXES.items():
            prefixed_fields = _extract_detail_fields(row, prefix=prefix)
            if not prefixed_fields:
                continue
            record_added = True
            normalized_records.append({
                'modulo_nombre': modulo_nombre,
                'planta_nombre': planta_nombre,
                'fase': fase,
                'fields': prefixed_fields,
                'module_fields': module_fields,
            })

        if not record_added and module_fields:
            normalized_records.append({
                'modulo_nombre': modulo_nombre,
                'planta_nombre': planta_nombre,
                'fase': None,
                'fields': {},
                'module_fields': module_fields,
            })

    return normalized_records


def _flatten_json_technical_data(payload):
    if isinstance(payload, list):
        return payload

    if isinstance(payload, dict):
        for key in ['records', 'rows', 'items', 'data', 'detalles', 'detalles_fase']:
            value = payload.get(key)
            if isinstance(value, list):
                return value

        modules = payload.get('modulos')
        if isinstance(modules, list):
            flattened = []
            for module in modules:
                if not isinstance(module, dict):
                    continue
                modulo_nombre = module.get('nombre') or module.get('modulo') or module.get('modulo_nombre')
                planta_nombre = module.get('planta') or module.get('planta_nombre')
                ancho_cm = module.get('ancho_cm') or module.get('ancho') or module.get('ancho_modulo_cm')
                for detalle in module.get('detalles_fase', []):
                    if not isinstance(detalle, dict):
                        continue
                    flattened.append({
                        'modulo': modulo_nombre,
                        'planta': planta_nombre,
                        'ancho_cm': ancho_cm,
                        **detalle,
                    })
            return flattened

    return []


def _load_technical_records_from_sqlite(uploaded_file):
    temp_path = None
    connection = None
    try:
        suffix = os.path.splitext(uploaded_file.name)[1] or '.db'
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            for chunk in uploaded_file.chunks():
                temp_file.write(chunk)
            temp_path = temp_file.name

        connection = sqlite3.connect(temp_path)
        connection.row_factory = sqlite3.Row
        cursor = connection.cursor()

        table_names = {
            row[0]
            for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if 'resumen' not in table_names:
            raise ValidationError('La base SQLite no contiene la tabla "resumen".')

        technical_records = []
        for row in cursor.execute("SELECT * FROM resumen ORDER BY id"):
            row_dict = dict(row)
            module_name = row_dict.get('nombre_modulo')
            if not module_name:
                continue

            ancho_cm = (
                row_dict.get('ancho_cm')
                or row_dict.get('canto_armado_cm')
                or row_dict.get('canto_armado')
                or row_dict.get('canto')
            )
            if ancho_cm in [None, '']:
                ancho_cm = 17

            technical_records.append({
                'modulo': module_name,
                'ancho_cm': ancho_cm,
                'inf_peso_malla_inicial_kg': row_dict.get('peso_mallazo_pedido_inf'),
                'sup_peso_malla_inicial_kg': row_dict.get('peso_mallazo_pedido_sup'),
                'inf_desperdicio_kg': row_dict.get('peso_mallazo_desperdicio_inf'),
                'sup_desperdicio_kg': row_dict.get('peso_mallazo_desperdicio_sup'),
                'inf_peso_malla_final_kg': row_dict.get('peso_mallazo_recortado_inf'),
                'sup_peso_malla_final_kg': row_dict.get('peso_mallazo_recortado_sup'),
                'inf_cantidad_cortes': row_dict.get('numero_cortes_mallazo'),
                'inf_cantidad_refuerzos': row_dict.get('cantidad_refuerzos_inf'),
                'sup_cantidad_refuerzos': row_dict.get('cantidad_refuerzos_sup'),
                'inf_peso_refuerzos_kg': row_dict.get('peso_refuerzos_inf'),
                'sup_peso_refuerzos_kg': row_dict.get('peso_refuerzos_sup'),
                'inf_cantidad_zunchos': row_dict.get('cantidad_zunchos'),
                'inf_peso_zunchos_kg': row_dict.get('peso_zunchos'),
                'inf_cantidad_punzos': row_dict.get('cantidad_punzonamientos'),
                'inf_peso_punzos_kg': row_dict.get('peso_punzonamientos'),
                'inf_cantidad_separadores': row_dict.get('cantidad_separadores'),
                'inf_peso_separadores_kg': row_dict.get('peso_separadores'),
            })

        return technical_records
    except sqlite3.Error as exc:
        raise ValidationError(f'No se pudo leer la base SQLite: {str(exc)}')
    finally:
        if connection is not None:
            connection.close()
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def _load_technical_records_from_upload(uploaded_file):
    filename = uploaded_file.name.lower()

    if filename.endswith('.db') or filename.endswith('.sqlite') or filename.endswith('.sqlite3'):
        return _load_technical_records_from_sqlite(uploaded_file)

    content = uploaded_file.read()
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')

    if filename.endswith('.json'):
        return _flatten_json_technical_data(json.loads(text))

    if filename.endswith('.csv'):
        reader = csv.DictReader(io.StringIO(text))
        return list(reader)

    raise ValidationError('Formato no soportado. Usa un archivo JSON, CSV o SQLite (.db).')


def _resolve_modulo_for_record(proyecto, modulo_nombre, planta_nombre=None):
    """
    Busca un modulo del proyecto por nombre tolerando prefijos comunes.
    Acepta coincidencia exacta o cualquier variacion con prefijos MOD_, MOD-, MODULO_, MODULO-.
    Devuelve (None, None) cuando no hay match — no es un error, significa que el
    registro tecnico no corresponde a ningun modulo del proyecto (se omite silenciosamente).
    """
    target = str(modulo_nombre).strip()
    if not target:
        return None, None

    candidates = {target}
    # Intentar sin prefijo comun (ej: MOD_A01 -> A01)
    for prefix in ('MODULO_', 'MODULO-', 'MOD_', 'MOD-'):
        if target.upper().startswith(prefix):
            candidates.add(target[len(prefix):])
    # Intentar con prefijo (ej: A01 -> MOD_A01, MODULO_A01)
    for prefix in ('MOD_', 'MODULO_'):
        candidates.add(f'{prefix}{target}')

    name_filter = Q()
    for cand in candidates:
        name_filter |= Q(nombre__iexact=cand)

    queryset = proyecto.modulos.select_related('planta').filter(name_filter)
    if planta_nombre:
        queryset = queryset.filter(planta__nombre__iexact=str(planta_nombre).strip())

    matches = list(queryset[:2])
    if not matches:
        # No es un error: el registro tecnico no tiene contraparte en el proyecto
        return None, None
    if len(matches) > 1:
        return None, f'El modulo "{modulo_nombre}" es ambiguo; indica tambien la planta'
    return matches[0], None


def _natural_sort_key(value):
    parts = re.split(r'(\d+)', value or '')
    return [int(part) if part.isdigit() else part.lower() for part in parts]


def _get_prefetched_detail(modulo, fase):
    details = getattr(modulo, '_prefetched_objects_cache', {}).get('detalles_fase')
    if details is not None:
        for detail in details:
            if detail.fase == fase:
                return detail
        return None
    return modulo.detalles_fase.filter(fase=fase).first()


def _get_module_planning_width(modulo, fallback_length):
    if modulo.ancho_cm not in [None, '']:
        try:
            width = Decimal(modulo.ancho_cm)
        except (TypeError, InvalidOperation):
            width = None
        if width and width > 0:
            return width

    for fase in ['INFERIOR', 'SUPERIOR']:
        detail = _get_prefetched_detail(modulo, fase)
        if not detail or detail.espesor_cm in [None, '']:
            continue
        try:
            width = Decimal(detail.espesor_cm)
        except (TypeError, InvalidOperation):
            continue
        if width > 0:
            return width
    return fallback_length


def _get_inferior_difficulty(modulo):
    detail = _get_prefetched_detail(modulo, 'INFERIOR')
    if not detail or detail.dificultad_fabricacion in [None, '']:
        return Decimal('0')
    try:
        return Decimal(detail.dificultad_fabricacion)
    except (TypeError, InvalidOperation):
        return Decimal('0')


def _build_bastidor_groups(proyecto, modulos):
    try:
        bastidor_longitud = Decimal(proyecto.bastidor_longitud_cm)
    except (TypeError, InvalidOperation):
        bastidor_longitud = Decimal('114')

    ordered = sorted(modulos, key=lambda modulo: _natural_sort_key(modulo.nombre))
    groups = []
    current_group = []
    current_width = Decimal('0')

    for modulo in ordered:
        modulo_width = _get_module_planning_width(modulo, bastidor_longitud)
        if current_group and current_width + modulo_width > bastidor_longitud:
            groups.append(current_group)
            current_group = [modulo]
            current_width = modulo_width
        else:
            current_group.append(modulo)
            current_width += modulo_width

    if current_group:
        groups.append(current_group)

    return groups


def _persist_bastidor_groups(proyecto):
    """
    Calcula y persiste los GrupoBastidor del proyecto.
    Solo se debe llamar cuando el proyecto aun no tiene grupos (primera vez tras importar datos tecnicos).
    """
    from api.models import GrupoBastidor

    modulos = list(
        proyecto.modulos.select_related('proyecto').prefetch_related('detalles_fase')
    )
    if not modulos:
        return 0

    grouped = _build_bastidor_groups(proyecto, modulos)

    created_groups = 0
    for indice, modulos_in_group in enumerate(grouped, start=1):
        grupo = GrupoBastidor.objects.create(proyecto=proyecto, indice=indice)
        created_groups += 1
        modulo_ids = [m.id for m in modulos_in_group]
        proyecto.modulos.filter(id__in=modulo_ids).update(grupo_bastidor=grupo)

    return created_groups


def _assign_modulo_to_group_on_create(modulo):
    """
    Al crear un modulo nuevo en un proyecto que ya tiene grupos calculados,
    lo anade al ultimo grupo si cabe, o crea un grupo nuevo.
    """
    from api.models import GrupoBastidor

    proyecto = modulo.proyecto
    if not proyecto.datos_tecnicos_importados:
        return

    try:
        bastidor_longitud = Decimal(proyecto.bastidor_longitud_cm)
    except (TypeError, InvalidOperation):
        bastidor_longitud = Decimal('114')

    modulo_width = _get_module_planning_width(modulo, bastidor_longitud)

    ultimo_grupo = (
        proyecto.grupos_bastidor.order_by('-indice').first()
    )
    if ultimo_grupo is None:
        nuevo = GrupoBastidor.objects.create(proyecto=proyecto, indice=1)
        modulo.grupo_bastidor = nuevo
        modulo.save(update_fields=['grupo_bastidor'])
        return

    modulos_en_grupo = list(ultimo_grupo.modulos.all())
    suma_actual = sum(
        (_get_module_planning_width(m, bastidor_longitud) for m in modulos_en_grupo),
        Decimal('0'),
    )

    if suma_actual + modulo_width <= bastidor_longitud:
        modulo.grupo_bastidor = ultimo_grupo
    else:
        nuevo = GrupoBastidor.objects.create(
            proyecto=proyecto,
            indice=ultimo_grupo.indice + 1,
        )
        modulo.grupo_bastidor = nuevo
    modulo.save(update_fields=['grupo_bastidor'])


def _merge_superior_sequences(primary_sequence, secondary_sequence):
    merged = []
    first_queue = list(primary_sequence)
    second_queue = list(secondary_sequence)
    use_first_queue = True

    if first_queue and second_queue:
        first_difficulty = _get_inferior_difficulty(first_queue[0])
        second_difficulty = _get_inferior_difficulty(second_queue[0])
        if second_difficulty > first_difficulty:
            use_first_queue = False

    while first_queue or second_queue:
        if use_first_queue and first_queue:
            merged.append(first_queue.pop(0))
            use_first_queue = False
            continue

        if (not use_first_queue) and second_queue:
            merged.append(second_queue.pop(0))
            use_first_queue = True
            continue

        if first_queue:
            merged.append(first_queue.pop(0))
        elif second_queue:
            merged.append(second_queue.pop(0))

    return merged


class CustomAuthToken(ObtainAuthToken):
    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data,
                                           context={'request': request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        token, created = Token.objects.get_or_create(user=user)
        return Response({
            'token': token.key,
            'user_id': user.pk,
            'username': user.username,
            'is_staff': user.is_staff,
            'is_superuser': user.is_superuser
        })


class UserViewSet(viewsets.ModelViewSet):
    """
    API endpoint that allows users to be viewed or edited.
    """
    # queryset = User.objects.all().order_by("-date_joined")
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = User.objects.all().order_by("-date_joined")
        if not _is_admin(self.request.user):
            return queryset.filter(id=self.request.user.id)
        if self.action == 'list':
            return queryset.filter(is_superuser=False)
        return queryset


class ProyectoViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar proyectos.
    """
    queryset = Proyecto.objects.select_related('usuario').all().order_by("nombre")
    serializer_class = ProyectoSerializer
    permission_classes = [permissions.IsAuthenticated]

    def _annotate_counts(self, queryset):
        from django.db.models import Count
        return queryset.annotate(
            _grupos_count=Count('grupos_bastidor', distinct=True),
            _modulos_count=Count('modulos', distinct=True),
            _modulos_completados=Count(
                'modulos',
                filter=Q(modulos__estado__in=['COMPLETADO', 'CERRADO']),
                distinct=True,
            ),
        )

    def get_queryset(self):
        """
        Filter projects by user.
        - Admin: All projects
        - User: Assigned projects
        - Anonymous: None (or All during migration phase if needed)
        """
        user = self.request.user
        if user.is_staff or user.is_superuser:
            return self._annotate_counts(Proyecto.objects.all()).order_by("nombre")
        if user.is_authenticated:
            return self._annotate_counts(Proyecto.objects.filter(usuario=user)).order_by("nombre")
        return Proyecto.objects.none()

    def perform_create(self, serializer):
        """Assign current user as project owner if not provided."""
        if not _is_admin(self.request.user):
            serializer.save(usuario=self.request.user)
            return
        if 'usuario' not in serializer.validated_data:
            serializer.save(usuario=self.request.user)
        else:
            serializer.save()

    def _upsert_modulo_phase_detail(self, modulo, fase, fields):
        existing = DetalleModuloFase.objects.filter(modulo=modulo, fase=fase).first()
        payload = {
            'modulo': modulo.id,
            'fase': fase,
            **fields,
        }
        serializer = DetalleModuloFaseSerializer(
            instance=existing,
            data=payload,
            partial=bool(existing),
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return existing is None

    def _apply_module_fields(self, modulo, fields):
        updated_fields = []

        if 'ancho_cm' in fields and fields['ancho_cm'] not in [None, '']:
            modulo.ancho_cm = fields['ancho_cm']
            updated_fields.append('ancho_cm')

        if updated_fields:
            modulo.save(update_fields=updated_fields)
            return True
        return False

    @action(detail=True, methods=['get'])
    def modulos(self, request, pk=None):
        """Get all modules for a project."""
        proyecto = self.get_object()
        modulos = proyecto.modulos.all().order_by('id')
        serializer = ModuloSerializer(modulos, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def queue(self, request, pk=None):
        """Get the module queue for a project."""
        proyecto = self.get_object()
        try:
            queue = proyecto.modulo_queue
            serializer = ModuloQueueSerializer(queue, context={'request': request})
            return Response(serializer.data)
        except ModuloQueue.DoesNotExist:
            return Response({'detail': 'No queue exists for this project'}, status=404)

    @action(detail=True, methods=['get'])
    def queue_items(self, request, pk=None):
        """Get the ordered queue items for a project."""
        proyecto = self.get_object()
        try:
            queue = proyecto.modulo_queue
            items = queue.items.select_related('modulo', 'modulo__planta').all().order_by('position')
            serializer = ModuloQueueItemSerializer(items, many=True, context={'request': request})
            return Response(serializer.data)
        except ModuloQueue.DoesNotExist:
            return Response([])

    @action(detail=True, methods=['post'], url_path='import-structure')
    def import_structure(self, request, pk=None):
        """
        Import project structure from uploaded folder data.
        Expects multipart form with:
        - 'plantas': JSON string with structure
        - image files referenced by filename in plantas JSON
        """
        import os
        import json
        from django.conf import settings as django_settings
        
        proyecto = self.get_object()
        
        # Get uploaded files
        files = request.FILES
        
        # Parse plantas JSON from string (comes as string in multipart form)
        plantas_raw = request.data.get('plantas', '[]')
        if isinstance(plantas_raw, str):
            try:
                plantas_data = json.loads(plantas_raw)
            except json.JSONDecodeError as e:
                return Response({
                    'status': 'error',
                    'message': f'Invalid JSON in plantas: {str(e)}'
                }, status=400)
        else:
            plantas_data = plantas_raw
        
        print(f"[IMPORT] Proyecto {proyecto.id}: {len(plantas_data)} plantas, {len(files)} files")

        stats = {
            'plantas': 0, 'modulos': 0, 'imagenes': 0, 'detalles_fase': 0,
            'plano_cargado': False, 'planilla_cargada': False, 'errors': []
        }

        for planta_data in plantas_data:
            try:
                # Create Planta
                planta = Planta.objects.create(
                    nombre=planta_data.get('nombre', 'Sin nombre'),
                    proyecto=proyecto,
                    orden=planta_data.get('orden', 0)
                )
                stats['plantas'] += 1

                # Check for Plant Files (Plano and Corte)
                plano_filename = planta_data.get('plano_filename')
                if plano_filename:
                    uploaded_file = files.get(plano_filename)
                    if uploaded_file:
                        planta.plano_imagen.save(uploaded_file.name, uploaded_file)
                        stats['plano_cargado'] = True

                corte_filename = planta_data.get('corte_filename')
                if corte_filename:
                    uploaded_file = files.get(corte_filename)
                    if uploaded_file:
                        planta.fichero_corte.save(uploaded_file.name, uploaded_file)
                        stats['planilla_cargada'] = True
                
                modulos_data = planta_data.get('modulos', [])
                for modulo_data in modulos_data:
                    try:
                        # Create Modulo
                        modulo = Modulo.objects.create(
                            nombre=modulo_data.get('nombre', 'Sin nombre'),
                            ancho_cm=_extract_module_fields(_row_to_canonical_dict(modulo_data)).get('ancho_cm'),
                            planta=planta,
                            proyecto=proyecto,
                            estado='PENDIENTE',
                            codigos_color=modulo_data.get('codigos_color', 'xxxx')
                        )
                        stats['modulos'] += 1
                        
                        imagenes_data = modulo_data.get('imagenes', [])
                        for imagen_data in imagenes_data:
                            try:
                                filename = imagen_data.get('filename')
                                fase = imagen_data.get('fase', 'INFERIOR')
                                orden = imagen_data.get('orden', 1)
                                
                                # Check if file was uploaded
                                uploaded_file = files.get(filename)
                                if uploaded_file:
                                    # Save file to media folder
                                    media_path = os.path.join('imagenes', str(proyecto.id), str(planta.id), str(modulo.id))
                                    full_path = os.path.join(django_settings.MEDIA_ROOT, media_path)
                                    os.makedirs(full_path, exist_ok=True)
                                    
                                    file_path = os.path.join(full_path, uploaded_file.name)
                                    with open(file_path, 'wb+') as destination:
                                        for chunk in uploaded_file.chunks():
                                            destination.write(chunk)
                                    
                                    # Create Imagen record
                                    url = f'/media/{media_path}/{uploaded_file.name}'
                                    Imagen.objects.create(
                                        url=url,
                                        modulo=modulo,
                                        fase=fase,
                                        orden=orden,
                                        activo=True
                                    )
                                    stats['imagenes'] += 1
                                else:
                                    stats['errors'].append(f"File not found: {filename}")
                            except Exception as e:
                                stats['errors'].append(f"Error creating imagen: {str(e)}")

                        detalles_fase_data = modulo_data.get('detalles_fase', [])
                        for detalle_data in detalles_fase_data:
                            try:
                                fase = _normalize_phase(detalle_data.get('fase'))
                                if not fase:
                                    stats['errors'].append(
                                        f"Detalle tecnico sin fase valida para modulo {modulo.nombre}"
                                    )
                                    continue

                                detail_fields = _extract_detail_fields(
                                    _row_to_canonical_dict(detalle_data)
                                )
                                if not detail_fields:
                                    continue

                                self._upsert_modulo_phase_detail(modulo, fase, detail_fields)
                                stats['detalles_fase'] += 1
                            except Exception as e:
                                stats['errors'].append(f"Error creating detalle tecnico: {str(e)}")
                    except Exception as e:
                        stats['errors'].append(f"Error creating modulo: {str(e)}")
            except Exception as e:
                stats['errors'].append(f"Error creating planta: {str(e)}")
        
        return Response({
            'status': 'ok',
            'proyecto_id': proyecto.id,
            'stats': stats
        })

    @action(detail=True, methods=['post'], url_path='import-technical-data')
    def import_technical_data(self, request, pk=None):
        """
        Importa datos tecnicos por modulo y fase desde JSON, CSV o SQLite.
        Soporta dos formatos:
        - una fila por fase con columnas modulo + fase + campos
        - una fila por modulo con columnas prefijadas inf_/sup_
        - una base SQLite con tabla resumen por modulo
        """
        proyecto = self.get_object()

        if proyecto.datos_tecnicos_importados:
            raise ValidationError(
                'Este proyecto ya tiene datos tecnicos importados y grupos de bastidor calculados. '
                'Para cambiarlos, elimina el proyecto y vuelve a crearlo.'
            )

        technical_file = request.FILES.get('technical_file')
        raw_records = request.data.get('records')

        try:
            if technical_file:
                records = _load_technical_records_from_upload(technical_file)
            elif isinstance(raw_records, str):
                records = _flatten_json_technical_data(json.loads(raw_records))
            elif raw_records:
                records = _flatten_json_technical_data(raw_records)
            else:
                raise ValidationError('Debes enviar technical_file o records')
        except json.JSONDecodeError as exc:
            raise ValidationError(f'JSON invalido: {str(exc)}')

        normalized_records = _normalize_technical_records(records)
        stats = {
            'processed': 0,
            'created': 0,
            'updated': 0,
            'skipped': 0,
            'errors': [],
        }

        for record in normalized_records:
            modulo, error = _resolve_modulo_for_record(
                proyecto,
                record['modulo_nombre'],
                record.get('planta_nombre'),
            )
            if error:
                stats['errors'].append(error)
                continue
            if modulo is None:
                # Registro tecnico sin contraparte en el proyecto: se omite
                stats['skipped'] += 1
                continue

            module_updated = self._apply_module_fields(modulo, record.get('module_fields', {}))

            if not record['fields'] or not record['fase']:
                if module_updated:
                    stats['processed'] += 1
                    stats['updated'] += 1
                else:
                    stats['skipped'] += 1
                continue

            try:
                created = self._upsert_modulo_phase_detail(modulo, record['fase'], record['fields'])
                stats['processed'] += 1
                if created:
                    stats['created'] += 1
                else:
                    stats['updated'] += 1
            except Exception as exc:
                stats['errors'].append(
                    f'Error importando {modulo.nombre} {record["fase"]}: {str(exc)}'
                )

        if not normalized_records:
            stats['errors'].append('No se encontraron registros validos para importar')

        grupos_creados = 0
        if stats['processed'] > 0 and not stats['errors']:
            grupos_creados = _persist_bastidor_groups(proyecto)
            if grupos_creados > 0:
                proyecto.datos_tecnicos_importados = True
                proyecto.save(update_fields=['datos_tecnicos_importados'])

        stats['grupos_bastidor'] = grupos_creados

        return Response({
            'status': 'ok',
            'proyecto_id': proyecto.id,
            'stats': stats,
        })


class GrupoBastidorViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint para consultar los grupos de bastidor de un proyecto.
    Filtrar con ?proyecto=ID
    Los grupos se crean automaticamente al importar datos tecnicos y son inmutables.
    """
    queryset = GrupoBastidor.objects.prefetch_related('modulos').all().order_by('proyecto', 'indice')
    serializer_class = GrupoBastidorSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        queryset = GrupoBastidor.objects.prefetch_related('modulos').all().order_by('proyecto', 'indice')
        if not _is_admin(self.request.user):
            queryset = queryset.filter(proyecto__usuario=self.request.user)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


class PlantaViewSet(viewsets.ModelViewSet):
    """
    API endpoint para ver, crear, editar y borrar plantas.
    Filtrar por proyecto con ?proyecto=ID
    """
    queryset = Planta.objects.annotate(modulos_count=Count('modulos')).order_by('orden', 'nombre')
    serializer_class = PlantaSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = Planta.objects.annotate(modulos_count=Count('modulos')).order_by('orden', 'nombre')
        if not _is_admin(self.request.user):
            queryset = queryset.filter(proyecto__usuario=self.request.user)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


class ModuloViewSet(viewsets.ModelViewSet):
    """
    API endpoint que permite ver, crear, editar y borrar módulos.
    """
    queryset = Modulo.objects.prefetch_related('detalles_fase').all().order_by("id")
    serializer_class = ModuloSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        from django.db.models import Count
        queryset = Modulo.objects.prefetch_related('detalles_fase').all().annotate(
            _fotos_count=Count('fotos_fabricacion')
        ).order_by("id")
        if not _is_admin(self.request.user):
            queryset = queryset.filter(proyecto__usuario=self.request.user)
        proyecto_id = self.request.query_params.get('proyecto', None)
        planta_id = self.request.query_params.get('planta', None)
        if planta_id is not None:
            queryset = queryset.filter(planta_id=planta_id)
        elif proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset

    @action(detail=True, methods=['get'])
    def imagenes(self, request, pk=None):
        """Get all images for a module."""
        modulo = self.get_object()
        imagenes = modulo.imagenes.filter(activo=True).order_by('fase', 'orden')
        serializer = ImagenSerializer(imagenes, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def cerrar(self, request, pk=None):
        """Close a module (supervisor action)."""
        from django.utils import timezone
        modulo = self.get_object()
        if not (modulo.inferior_hecho and modulo.superior_hecho):
            return Response(
                {'detail': 'No se puede cerrar: faltan fases por completar'},
                status=status.HTTP_400_BAD_REQUEST
            )
        modulo.cerrado = True
        modulo.cerrado_at = timezone.now()
        modulo.cerrado_by = request.user
        modulo.actualizar_estado()
        serializer = self.get_serializer(modulo)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def reiniciar(self, request, pk=None):
        """Reset module to PENDIENTE, keeping its grupo_bastidor."""
        modulo = self.get_object()
        modulo.inferior_hecho = False
        modulo.superior_hecho = False
        modulo.cerrado = False
        modulo.cerrado_at = None
        modulo.cerrado_by = None
        modulo.estado = 'PENDIENTE'
        modulo.save()
        serializer = self.get_serializer(modulo)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def completar(self, request, pk=None):
        """Force module to COMPLETADO (both phases marked done)."""
        modulo = self.get_object()
        modulo.inferior_hecho = True
        modulo.superior_hecho = True
        modulo.estado = 'COMPLETADO'
        modulo.save()
        serializer = self.get_serializer(modulo)
        return Response(serializer.data)

    def perform_create(self, serializer):
        modulo = serializer.save()
        _assign_modulo_to_group_on_create(modulo)


class ImagenViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar imágenes.
    """
    queryset = Imagen.objects.select_related('modulo').all().order_by("id")
    serializer_class = ImagenSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        queryset = Imagen.objects.select_related('modulo').filter(activo=True).order_by("modulo", "fase", "orden")
        if not _is_admin(self.request.user):
            queryset = queryset.filter(modulo__proyecto__usuario=self.request.user)
        modulo_id = self.request.query_params.get('modulo', None)
        fase = self.request.query_params.get('fase', None)
        if modulo_id is not None:
            queryset = queryset.filter(modulo_id=modulo_id)
        if fase is not None:
            queryset = queryset.filter(fase=fase)
        return queryset


class MesaViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar mesas y asignación de imágenes.
    """
    queryset = Mesa.objects.select_related('imagen_actual', 'imagen_actual__modulo').all().order_by("nombre")
    serializer_class = MesaSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = Mesa.objects.select_related('imagen_actual', 'imagen_actual__modulo').filter(grupo__isnull=False).order_by("nombre")
        if not _is_admin(self.request.user):
            queryset = queryset.filter(usuario=self.request.user)
        usuario_id = self.request.query_params.get('usuario', None)
        if usuario_id is not None:
            queryset = queryset.filter(usuario_id=usuario_id)
        return queryset

    @action(detail=True, methods=['get'])
    def queue_items(self, request, pk=None):
        """Get the work queue for a desk."""
        mesa = self.get_object()
        items = mesa.queue_items.all().order_by('position')
        serializer = MesaQueueItemSerializer(items, many=True, context={'request': request})
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def current_item(self, request, pk=None):
        """Get the current item being shown on a desk."""
        mesa = self.get_object()
        from api.models import MesaQueueStatus
        item = mesa.queue_items.select_related('modulo', 'imagen', 'mesa', 'modulo__planta', 'modulo__planta__proyecto').filter(status=MesaQueueStatus.MOSTRANDO).first()
        if item:
            serializer = MesaQueueItemSerializer(item, context={'request': request})
            return Response(serializer.data)
        return Response({'detail': 'No item currently showing'}, status=404)

    @action(detail=True, methods=['post', 'get'], permission_classes=[permissions.IsAuthenticated])
    def calibration(self, request, pk=None):
        """
        GET: Retrieve current calibration JSON for a mesa.
        POST: Save calibration JSON (corner positions) for a mesa.
        """
        mesa = self.get_object()
        
        if request.method == 'GET':
            return Response({
                'id': mesa.id,
                'nombre': mesa.nombre,
                'calibration_json': mesa.calibration_json
            })
        
        # POST: Save calibration
        calibration_data = request.data.get('calibration_json')
        if calibration_data is None:
            return Response(
                {'detail': 'calibration_json is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        mesa.calibration_json = calibration_data
        # Update calibration_json AND trigger auto_now for ultima_actualizacion
        mesa.save()
        
        return Response({
            'id': mesa.id,
            'nombre': mesa.nombre,
            'calibration_json': mesa.calibration_json,
            'message': 'Calibration saved successfully'
        })

    @action(detail=True, methods=['post'], permission_classes=[permissions.IsAuthenticated])
    def set_index(self, request, pk=None):
        """
        Set current_image_index for a mesa from supervisor/visor context.
        Triggers mesa update timestamp so device SSE picks up the change.
        """
        mesa = self.get_object()
        index = request.data.get('index')
        if index is None:
            return Response({'detail': 'Index required'}, status=400)
        try:
            mesa.current_image_index = int(index)
        except (TypeError, ValueError):
            return Response({'detail': 'Index must be an integer'}, status=400)

        mesa.save(update_fields=['current_image_index', 'ultima_actualizacion'])
        return Response({'status': 'ok', 'index': mesa.current_image_index})


class GrupoMesasViewSet(viewsets.ModelViewSet):
    """
    API endpoint para grupos operativos de tres mesas por ferralla.
    """
    queryset = GrupoMesas.objects.select_related('usuario', 'proyecto_actual').prefetch_related('mesas').all()
    serializer_class = GrupoMesasSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = GrupoMesas.objects.select_related('usuario', 'proyecto_actual').prefetch_related('mesas').all()
        if not _is_admin(self.request.user):
            queryset = queryset.filter(usuario=self.request.user)
        usuario_id = self.request.query_params.get('usuario')
        proyecto_id = self.request.query_params.get('proyecto_actual')
        if usuario_id is not None:
            queryset = queryset.filter(usuario_id=usuario_id)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_actual_id=proyecto_id)
        return queryset.order_by('nombre')

    def perform_create(self, serializer):
        from rest_framework.exceptions import PermissionDenied

        usuario = serializer.validated_data.get('usuario')
        if not _is_admin(self.request.user):
            if usuario and usuario.id != self.request.user.id:
                raise PermissionDenied('No puedes crear grupos para otra ferralla')
            usuario = self.request.user

        grupo = serializer.save(usuario=usuario or self.request.user)
        grupo.ensure_default_mesas()

    def perform_update(self, serializer):
        from rest_framework.exceptions import PermissionDenied

        usuario = serializer.validated_data.get('usuario')
        if not _is_admin(self.request.user) and usuario and usuario.id != self.request.user.id:
            raise PermissionDenied('No puedes mover grupos a otra ferralla')
        serializer.save()

    def perform_destroy(self, instance):
        # Evita dejar mesas huerfanas cuando se elimina un grupo operativo.
        with transaction.atomic():
            instance.mesas.all().delete()
            instance.delete()

    def _create_queue_for_mesa(self, mesa, modules, fase, user, module_group_map, group_offset=0, start_position=0, has_active_items=False):
        created_items = []
        for index, modulo in enumerate(modules):
            item = MesaQueueItem.objects.create(
                mesa=mesa,
                modulo=modulo,
                fase=fase,
                imagen=None,
                position=start_position + index,
                plan_group_index=(group_offset + module_group_map.get(modulo.id)) if module_group_map.get(modulo.id) else None,
                status='MOSTRANDO' if (index == 0 and not has_active_items) else 'EN_COLA',
                assigned_by=user if user.is_authenticated else None,
            )
            created_items.append(item)

        return created_items

    def _normalize_active_queue_for_mesa(self, mesa, preserved_items):
        normalized = []
        ordered_items = list(sorted(preserved_items, key=lambda item: item.position))
        for index, item in enumerate(ordered_items):
            desired_status = 'MOSTRANDO' if index == 0 else 'EN_COLA'
            updates = []
            if item.position != index:
                item.position = index
                updates.append('position')
            if item.status != desired_status:
                item.status = desired_status
                updates.append('status')
            if updates:
                item.save(update_fields=updates)
            normalized.append(item)

        mesa.imagen_actual = normalized[0].imagen if normalized else None
        mesa.current_image_index = 0
        mesa.save(update_fields=['imagen_actual', 'current_image_index', 'ultima_actualizacion'])
        return normalized

    def _get_preserved_active_prefix(self, grupo):
        group_items = MesaQueueItem.objects.select_related('mesa', 'modulo').filter(mesa__grupo=grupo)
        active_items = group_items.filter(status__in=ACTIVE_QUEUE_STATUSES)
        completed_group_indexes = list(
            group_items.filter(
                plan_group_index__isnull=False,
                modulo__inferior_hecho=True,
                modulo__superior_hecho=True,
            ).values_list('plan_group_index', flat=True).distinct()
        )

        preserve_until = max(completed_group_indexes) if completed_group_indexes else None
        preserved_by_role = {}
        preserved_keys = set()

        if preserve_until is None:
            return preserve_until, preserved_by_role, preserved_keys

        preserved_items = active_items.filter(plan_group_index__lte=preserve_until).order_by('mesa_id', 'position')
        for item in preserved_items:
            preserved_keys.add((item.modulo_id, item.fase))
            preserved_by_role.setdefault(item.mesa.rol, []).append(item)

        return preserve_until, preserved_by_role, preserved_keys

    def _build_plan_sequences(self, proyecto, excluded_phase_keys=None, group_index_offset=0):
        excluded_phase_keys = excluded_phase_keys or set()
        modulos = list(
            proyecto.modulos.select_related('planta').prefetch_related('detalles_fase').all()
        )
        inferiors_pending = [
            modulo for modulo in modulos
            if not modulo.cerrado
            and not modulo.inferior_hecho
            and (modulo.id, 'INFERIOR') not in excluded_phase_keys
        ]
        superior_only_pending = [
            modulo for modulo in modulos
            if not modulo.cerrado
            and modulo.inferior_hecho
            and not modulo.superior_hecho
            and (modulo.id, 'SUPERIOR') not in excluded_phase_keys
        ]

        planned_phase_keys = {
            (modulo.id, 'INFERIOR') for modulo in inferiors_pending
        } | {
            (modulo.id, 'SUPERIOR')
            for modulo in modulos
            if not modulo.cerrado
            and not modulo.superior_hecho
            and (modulo.id, 'SUPERIOR') not in excluded_phase_keys
        }

        bastidor_groups = _build_bastidor_groups(proyecto, inferiors_pending)
        inferior_1_sequence = []
        inferior_2_sequence = []
        group_summaries = []
        module_group_map = {}

        for index, modules_in_group in enumerate(bastidor_groups, start=1):
            effective_index = group_index_offset + index
            reversed_group = list(reversed(modules_in_group))
            for module in modules_in_group:
                module_group_map[module.id] = effective_index
            if effective_index % 2 == 1:
                target_role = 'INFERIOR_1'
                inferior_1_sequence.extend(reversed_group)
            else:
                target_role = 'INFERIOR_2'
                inferior_2_sequence.extend(reversed_group)

            group_summaries.append({
                'group_index': effective_index,
                'target_role': target_role,
                'modules': [module.nombre for module in reversed_group],
            })

        superior_from_inferiors = _merge_superior_sequences(
            [module for module in inferior_1_sequence if not module.superior_hecho and (module.id, 'SUPERIOR') not in excluded_phase_keys],
            [module for module in inferior_2_sequence if not module.superior_hecho and (module.id, 'SUPERIOR') not in excluded_phase_keys],
        )
        superior_ids = {module.id for module in superior_from_inferiors}
        standalone_superior = sorted(
            [
                modulo for modulo in superior_only_pending
                if modulo.id not in superior_ids
            ],
            key=lambda modulo: (-_get_inferior_difficulty(modulo), _natural_sort_key(modulo.nombre))
        )
        superior_sequence = superior_from_inferiors + standalone_superior
        for modulo in superior_sequence:
            module_group_map.setdefault(modulo.id, group_index_offset + len(group_summaries) + 1)

        return {
            'planned_phase_keys': planned_phase_keys,
            'group_summaries': group_summaries,
            'module_group_map': module_group_map,
            'inferior_1_sequence': inferior_1_sequence,
            'inferior_2_sequence': inferior_2_sequence,
            'superior_sequence': superior_sequence,
        }

    def _build_group_plan(self, grupo, proyecto, user):
        grupo.ensure_default_mesas()
        grupo.refresh_from_db()

        mesas = {mesa.rol: mesa for mesa in grupo.mesas.all()}
        missing_roles = [rol for rol in ['INFERIOR_1', 'INFERIOR_2', 'SUPERIORES'] if rol not in mesas]
        if missing_roles:
            raise ValidationError(f'Faltan mesas requeridas en el grupo: {", ".join(missing_roles)}')

        preserved_until, preserved_by_role, preserved_phase_keys = self._get_preserved_active_prefix(grupo)
        external_conflicts = MesaQueueItem.objects.select_related('mesa', 'modulo').filter(
            status__in=ACTIVE_QUEUE_STATUSES,
            modulo__proyecto=proyecto,
        ).exclude(mesa__grupo=grupo)

        external_phase_keys = {
            (item.modulo_id, item.fase)
            for item in external_conflicts
        }
        plan_data = self._build_plan_sequences(
            proyecto,
            excluded_phase_keys=preserved_phase_keys | external_phase_keys,
            group_index_offset=preserved_until or 0,
        )
        skipped_external_conflicts = [
                f'{item.modulo.nombre} {item.fase} ya está en {item.mesa.nombre}'
            for item in external_conflicts[:5]
        ]

        with transaction.atomic():
            active_group_items = MesaQueueItem.objects.filter(
                mesa__grupo=grupo,
                status__in=ACTIVE_QUEUE_STATUSES,
            )
            preserved_ids = [
                item.id
                for items in preserved_by_role.values()
                for item in items
            ]
            if preserved_ids:
                active_group_items.exclude(id__in=preserved_ids).delete()
            else:
                active_group_items.delete()

            normalized_preserved = {}
            for role, mesa in mesas.items():
                normalized_preserved[role] = self._normalize_active_queue_for_mesa(
                    mesa,
                    preserved_by_role.get(role, []),
                )

            inferior_1_items = normalized_preserved['INFERIOR_1'] + self._create_queue_for_mesa(
                mesas['INFERIOR_1'],
                plan_data['inferior_1_sequence'],
                'INFERIOR',
                user,
                plan_data['module_group_map'],
                start_position=len(normalized_preserved['INFERIOR_1']),
                has_active_items=bool(normalized_preserved['INFERIOR_1']),
            )
            inferior_2_items = normalized_preserved['INFERIOR_2'] + self._create_queue_for_mesa(
                mesas['INFERIOR_2'],
                plan_data['inferior_2_sequence'],
                'INFERIOR',
                user,
                plan_data['module_group_map'],
                start_position=len(normalized_preserved['INFERIOR_2']),
                has_active_items=bool(normalized_preserved['INFERIOR_2']),
            )
            superiores_items = normalized_preserved['SUPERIORES'] + self._create_queue_for_mesa(
                mesas['SUPERIORES'],
                plan_data['superior_sequence'],
                'SUPERIOR',
                user,
                plan_data['module_group_map'],
                start_position=len(normalized_preserved['SUPERIORES']),
                has_active_items=bool(normalized_preserved['SUPERIORES']),
            )

            for mesa in mesas.values():
                current_item = mesa.queue_items.filter(status=MesaQueueStatus.MOSTRANDO).order_by('position').first()
                mesa.imagen_actual = current_item.imagen if current_item else None
                mesa.current_image_index = 0
                mesa.save(update_fields=['imagen_actual', 'current_image_index', 'ultima_actualizacion'])

        return {
            'project_id': proyecto.id,
            'project_name': proyecto.nombre,
            'preserved_until_group': preserved_until,
            'bastidor_groups': plan_data['group_summaries'],
            'queues': {
                'INFERIOR_1': [item.modulo.nombre for item in inferior_1_items],
                'INFERIOR_2': [item.modulo.nombre for item in inferior_2_items],
                'SUPERIORES': [item.modulo.nombre for item in superiores_items],
            },
        }

    @action(detail=True, methods=['post'], url_path='planificar')
    def planificar(self, request, pk=None):
        from rest_framework.exceptions import PermissionDenied

        grupo = self.get_object()
        proyecto_id = request.data.get('proyecto_id') or request.data.get('proyecto') or grupo.proyecto_actual_id
        if not proyecto_id:
            raise ValidationError({'proyecto_id': 'Debes indicar el proyecto a planificar'})

        try:
            proyecto = Proyecto.objects.get(id=int(proyecto_id))
        except (TypeError, ValueError, Proyecto.DoesNotExist):
            raise ValidationError({'proyecto_id': 'Proyecto inválido'})

        if not _is_admin(request.user) and proyecto.usuario_id != request.user.id:
            raise PermissionDenied('No puedes planificar proyectos de otra ferralla')

        grupo.proyecto_actual = proyecto
        grupo.save(update_fields=['proyecto_actual'])
        plan_summary = self._build_group_plan(grupo, proyecto, request.user)

        serializer = self.get_serializer(grupo)
        return Response({
            'status': 'ok',
            'grupo': serializer.data,
            'plan': plan_summary,
        })


def _parse_iso_date(value, default):
    from datetime import date
    if not value:
        return default
    try:
        parts = str(value).split('-')
        if len(parts) != 3:
            return default
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except (TypeError, ValueError):
        return default


def _count_working_days(start_date, end_date):
    """Count Mon-Fri days inclusive between start_date and end_date."""
    from datetime import timedelta
    if end_date < start_date:
        return 0
    total = 0
    current = start_date
    while current <= end_date:
        if current.weekday() < 5:
            total += 1
        current += timedelta(days=1)
    return total


def _compute_dificultad(detalle):
    """Mirror of DetalleModuloFase.dificultad_calculada but tolerant to None."""
    refuerzos = detalle.cantidad_refuerzos or 0
    zunchos = detalle.cantidad_zunchos or 0
    separadores = detalle.cantidad_separadores or 0
    cortes = detalle.cantidad_cortes or 0

    solderings = refuerzos * 4 + (zunchos + separadores) * 8
    time_units = solderings * 2 + cortes

    peso = Decimal('0')
    values = [
        detalle.peso_malla_final_kg,
        detalle.peso_refuerzos_kg,
        detalle.peso_zunchos_kg,
        detalle.peso_separadores_kg,
        detalle.peso_punzos_kg,
    ]
    for v in values:
        if v is not None:
            try:
                peso += Decimal(v)
            except (TypeError, InvalidOperation):
                pass
    return float(Decimal(time_units) + peso / Decimal('10'))


class ProductionStatsView(APIView):
    """
    Aggregated production stats for the statistics dashboard.

    Query params:
    - from: YYYY-MM-DD (default: today, local time)
    - to:   YYYY-MM-DD (default: same as from)
    - proyecto: project id to scope the stats (optional)
    """
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from datetime import date, timedelta
        from django.utils import timezone

        today = timezone.localdate()
        from_date = _parse_iso_date(request.query_params.get('from'), today)
        to_date = _parse_iso_date(request.query_params.get('to'), from_date)
        proyecto_id = request.query_params.get('proyecto')

        # Build a tz-aware range for filtering done_at (local midnights)
        current_tz = timezone.get_current_timezone()
        from_dt = timezone.make_aware(
            timezone.datetime.combine(from_date, timezone.datetime.min.time()),
            current_tz,
        )
        to_dt_exclusive = timezone.make_aware(
            timezone.datetime.combine(to_date + timedelta(days=1), timezone.datetime.min.time()),
            current_tz,
        )

        # Query MesaQueueItems marked HECHO in the range
        items_qs = (
            MesaQueueItem.objects
            .select_related('mesa', 'modulo', 'modulo__proyecto')
            .filter(status=MesaQueueStatus.HECHO, done_at__isnull=False,
                    done_at__gte=from_dt, done_at__lt=to_dt_exclusive)
        )
        if proyecto_id:
            items_qs = items_qs.filter(modulo__proyecto_id=proyecto_id)
        if not _is_admin(request.user):
            items_qs = items_qs.filter(modulo__proyecto__usuario=request.user)

        # Pre-fetch the DetalleModuloFase for each (modulo, fase) pair
        items = list(items_qs)
        detalle_lookup = {}
        modulo_fase_pairs = {(it.modulo_id, it.fase) for it in items}
        if modulo_fase_pairs:
            modulo_ids = {m for m, _ in modulo_fase_pairs}
            for d in DetalleModuloFase.objects.filter(modulo_id__in=modulo_ids):
                detalle_lookup[(d.modulo_id, d.fase)] = d

        def empty_totals():
            return {
                'fases_completadas': 0,
                'peso_malla_inicial_kg': 0.0,
                'peso_malla_final_kg': 0.0,
                'desperdicio_kg': 0.0,
                'cantidad_cortes': 0,
                'cantidad_refuerzos': 0,
                'cantidad_zunchos': 0,
                'cantidad_separadores': 0,
                'cantidad_punzos': 0,
                'dificultad_total': 0.0,
            }

        def add_detalle(target, detalle):
            target['fases_completadas'] += 1
            if detalle is None:
                return
            if detalle.peso_malla_inicial_kg is not None:
                target['peso_malla_inicial_kg'] += float(detalle.peso_malla_inicial_kg)
            if detalle.peso_malla_final_kg is not None:
                target['peso_malla_final_kg'] += float(detalle.peso_malla_final_kg)
            if detalle.desperdicio_kg is not None:
                target['desperdicio_kg'] += float(detalle.desperdicio_kg)
            target['cantidad_cortes'] += detalle.cantidad_cortes or 0
            target['cantidad_refuerzos'] += detalle.cantidad_refuerzos or 0
            target['cantidad_zunchos'] += detalle.cantidad_zunchos or 0
            target['cantidad_separadores'] += detalle.cantidad_separadores or 0
            target['cantidad_punzos'] += detalle.cantidad_punzos or 0
            target['dificultad_total'] += _compute_dificultad(detalle)

        totals = empty_totals()
        por_mesa = {}
        por_dia = {}

        for item in items:
            detalle = detalle_lookup.get((item.modulo_id, item.fase))
            add_detalle(totals, detalle)

            mesa_key = item.mesa_id
            if mesa_key not in por_mesa:
                por_mesa[mesa_key] = {
                    'mesa_id': mesa_key,
                    'mesa_nombre': item.mesa.nombre,
                    'rol': item.mesa.rol,
                    **empty_totals(),
                }
            add_detalle(por_mesa[mesa_key], detalle)

            dia_key = timezone.localtime(item.done_at, current_tz).date().isoformat()
            if dia_key not in por_dia:
                por_dia[dia_key] = {'fecha': dia_key, **empty_totals()}
            add_detalle(por_dia[dia_key], detalle)

        # Modules fully completed in the range (not just phases)
        modulos_qs = Modulo.objects.filter(
            completado_at__isnull=False,
            completado_at__gte=from_dt,
            completado_at__lt=to_dt_exclusive,
        )
        if proyecto_id:
            modulos_qs = modulos_qs.filter(proyecto_id=proyecto_id)
        if not _is_admin(request.user):
            modulos_qs = modulos_qs.filter(proyecto__usuario=request.user)
        modulos_completados = modulos_qs.count()

        # Expected output for the range (capacity lives on the ferralla/user profile)
        capacidad_diaria = 12
        if proyecto_id:
            proyecto = Proyecto.objects.select_related('usuario__profile').filter(id=proyecto_id).first()
            if proyecto and proyecto.usuario and hasattr(proyecto.usuario, 'profile'):
                profile_cap = proyecto.usuario.profile.capacidad_diaria_modulos
                if profile_cap:
                    capacidad_diaria = profile_cap
        working_days = _count_working_days(from_date, to_date)

        return Response({
            'range': {
                'from': from_date.isoformat(),
                'to': to_date.isoformat(),
                'working_days': working_days,
            },
            'totals': {
                'modulos_completados': modulos_completados,
                **totals,
            },
            'por_mesa': sorted(por_mesa.values(), key=lambda x: (x['rol'], x['mesa_nombre'])),
            'por_dia': sorted(por_dia.values(), key=lambda x: x['fecha']),
            'esperado': {
                'capacidad_diaria_modulos': capacidad_diaria,
                'modulos_esperados': capacidad_diaria * working_days,
            },
        })


class DetalleModuloFaseViewSet(viewsets.ModelViewSet):
    """
    API endpoint para datos tecnicos importados por modulo y fase.
    """
    queryset = DetalleModuloFase.objects.select_related('modulo', 'modulo__proyecto', 'modulo__planta').all()
    serializer_class = DetalleModuloFaseSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = DetalleModuloFase.objects.select_related('modulo', 'modulo__proyecto', 'modulo__planta').all()
        if not _is_admin(self.request.user):
            queryset = queryset.filter(modulo__proyecto__usuario=self.request.user)
        modulo_id = self.request.query_params.get('modulo')
        proyecto_id = self.request.query_params.get('proyecto')
        fase = self.request.query_params.get('fase')
        if modulo_id is not None:
            queryset = queryset.filter(modulo_id=modulo_id)
        if proyecto_id is not None:
            queryset = queryset.filter(modulo__proyecto_id=proyecto_id)
        if fase is not None:
            queryset = queryset.filter(fase=fase)
        return queryset.order_by('modulo_id', 'fase')

    def perform_create(self, serializer):
        from rest_framework.exceptions import PermissionDenied

        modulo = serializer.validated_data.get('modulo')
        if modulo and (not _is_admin(self.request.user)) and modulo.proyecto.usuario_id != self.request.user.id:
            raise PermissionDenied('No puedes crear detalles tecnicos en proyectos de otro usuario')
        serializer.save()

    def perform_update(self, serializer):
        from rest_framework.exceptions import PermissionDenied

        modulo = serializer.validated_data.get('modulo') or serializer.instance.modulo
        if modulo and (not _is_admin(self.request.user)) and modulo.proyecto.usuario_id != self.request.user.id:
            raise PermissionDenied('No puedes editar detalles tecnicos en proyectos de otro usuario')
        serializer.save()


class ModuloQueueViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar colas de módulos por proyecto.
    """
    queryset = ModuloQueue.objects.all()
    serializer_class = ModuloQueueSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = ModuloQueue.objects.all()
        if not _is_admin(self.request.user):
            queryset = queryset.filter(proyecto__usuario=self.request.user)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if proyecto_id is not None:
            queryset = queryset.filter(proyecto_id=proyecto_id)
        return queryset


class ModuloQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de módulos.
    """
    queryset = ModuloQueueItem.objects.select_related('modulo', 'modulo__planta').all().order_by('queue', 'position')
    serializer_class = ModuloQueueItemSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = ModuloQueueItem.objects.select_related('modulo', 'modulo__planta').all().order_by('position')
        if not _is_admin(self.request.user):
            queryset = queryset.filter(queue__proyecto__usuario=self.request.user)
        queue_id = self.request.query_params.get('queue', None)
        proyecto_id = self.request.query_params.get('proyecto', None)
        if queue_id is not None:
            queryset = queryset.filter(queue_id=queue_id)
        if proyecto_id is not None:
            queryset = queryset.filter(queue__proyecto_id=proyecto_id)
        return queryset

    def perform_create(self, serializer):
        queue = serializer.validated_data.get('queue')
        if queue and (not _is_admin(self.request.user)) and queue.proyecto.usuario_id != self.request.user.id:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('No puedes crear items en colas de otro usuario')
        serializer.save()

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        """Reorder items in the queue. Expects: {items: [{id: X, position: Y}, ...]}"""
        items_data = request.data.get('items', [])
        for item_data in items_data:
            try:
                item = ModuloQueueItem.objects.get(id=item_data['id'])
                if not _is_admin(request.user) and item.queue.proyecto.usuario_id != request.user.id:
                    continue
                item.position = item_data['position']
                item.save(update_fields=['position'])
            except ModuloQueueItem.DoesNotExist:
                pass

        return Response({'status': 'ok'})

# =============================================================================
# DEVICE PAIRING VIEWS
# =============================================================================
class DeviceViewSet(viewsets.ViewSet):
    """
    Endpoints for Mini-PC (Kiosk) pairing and operation.
    """
    permission_classes = [permissions.AllowAny] # We handle token auth manually for devices

    @action(detail=False, methods=['post'])
    def init(self, request):
        """
        Device requests a new pairing code.
        Option A: mesa_id provided → code saved to Mesa directly
        Option B: no mesa_id → code saved to PairingSession (flexible linking later)
        """
        from api.serializers import DeviceInitSerializer
        from api.models import PairingSession
        import secrets
        from django.utils import timezone
        
        serializer = DeviceInitSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
            
        mesa_id = serializer.validated_data.get('mesa_id')
        
        # Option A: Mesa ID known
        if mesa_id:
            try:
                mesa = Mesa.objects.get(id=mesa_id)
            except Mesa.DoesNotExist:
                return Response({'detail': 'Mesa not found'}, status=404)
            
            # Reuse existing code if still valid
            if mesa.pairing_code and mesa.pairing_code_expires_at and mesa.pairing_code_expires_at > timezone.now():
                return Response({'pairing_code': mesa.pairing_code, 'expires_at': mesa.pairing_code_expires_at, 'mode': 'mesa'})
            
            # Generate new code
            code = secrets.token_hex(3).upper()
            mesa.pairing_code = code
            mesa.pairing_code_expires_at = timezone.now() + timezone.timedelta(minutes=10)
            mesa.save(update_fields=['pairing_code', 'pairing_code_expires_at'])
            return Response({'pairing_code': code, 'expires_at': mesa.pairing_code_expires_at, 'mode': 'mesa'})
        
        # Option B: No mesa_id - create a PairingSession
        # Check for existing valid session from this device (by code in request if refreshing)
        existing_code = request.data.get('existing_code')
        if existing_code:
            try:
                session = PairingSession.objects.get(pairing_code=existing_code)
                if session.expires_at > timezone.now():
                    return Response({
                        'pairing_code': session.pairing_code, 
                        'expires_at': session.expires_at,
                        'mode': 'session',
                        'mesa': session.mesa.id if session.mesa else None
                    })
            except PairingSession.DoesNotExist:
                pass
        
        # Generate new session
        code = secrets.token_hex(3).upper()
        expires_at = timezone.now() + timezone.timedelta(minutes=10)
        session = PairingSession.objects.create(
            pairing_code=code,
            expires_at=expires_at,
            device_info={'user_agent': request.META.get('HTTP_USER_AGENT', 'unknown')}
        )
        return Response({
            'pairing_code': code, 
            'expires_at': expires_at,
            'mode': 'session'
        })

    @action(detail=False, methods=['get'])
    def status(self, request):
        """
        Device polls for pairing status using the code.
        Checks both Mesa (Option A) and PairingSession (Option B).
        """
        code = request.query_params.get('code')
        if not code:
            return Response({'detail': 'Code required'}, status=400)
            
        from django.utils import timezone
        from api.models import PairingSession
        
        # Option A: Check Mesa with this code
        mesa = Mesa.objects.filter(pairing_code=code).first()
        if mesa:
            if mesa.pairing_code_expires_at and mesa.pairing_code_expires_at < timezone.now():
                return Response({'status': 'EXPIRED'})
            
            # Check if paired (pending token in last_error)
            if mesa.last_error and mesa.last_error.startswith("PENDING_TOKEN:"):
                token = mesa.last_error.split(":", 1)[1]
                mesa.last_error = None
                mesa.pairing_code = None
                mesa.pairing_code_expires_at = None
                mesa.save(update_fields=['last_error', 'pairing_code', 'pairing_code_expires_at'])
                return Response({'status': 'PAIRED', 'device_token': token, 'mesa_id': mesa.id})
                
            return Response({'status': 'WAITING', 'mode': 'mesa'})
        
        # Option B: Check PairingSession
        try:
            session = PairingSession.objects.get(pairing_code=code)
        except PairingSession.DoesNotExist:
            return Response({'status': 'EXPIRED'})
        
        if session.expires_at < timezone.now():
            return Response({'status': 'EXPIRED'})
        
        # Check if session has been linked to a mesa and has a token
        if session.device_token_hash and session.mesa:
            # Token was generated - return it once
            # We need to store it temporarily somewhere. Use mesa.last_error for consistency.
            if session.mesa.last_error and session.mesa.last_error.startswith("PENDING_TOKEN:"):
                token = session.mesa.last_error.split(":", 1)[1]
                session.mesa.last_error = None
                session.mesa.save(update_fields=['last_error'])
                # Also copy the token hash to mesa for future auth
                session.mesa.device_token_hash = session.device_token_hash
                session.mesa.save(update_fields=['device_token_hash'])
                return Response({'status': 'PAIRED', 'device_token': token, 'mesa_id': session.mesa.id})
            
            return Response({'status': 'PAIRED', 'mesa_id': session.mesa.id})  # Token already retrieved
        
        return Response({'status': 'WAITING', 'mode': 'session'})

    @action(detail=False, methods=['post'], permission_classes=[permissions.IsAuthenticated])
    def pair(self, request):
        """
        Dashboard confirms pairing for a mesa and code.
        Supports linking via Mesa directly (Option A) or via Session (Option B).
        """
        from api.serializers import DevicePairSerializer
        from api.models import PairingSession
        import secrets
        import hashlib
        
        serializer = DevicePairSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
            
        mesa_id = serializer.validated_data.get('mesa_id')
        code = serializer.validated_data.get('pairing_code')
        
        try:
            mesa = Mesa.objects.get(id=mesa_id)
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)
        
        # Ensure user can pair this mesa.
        if not _is_admin(request.user) and mesa.usuario_id != request.user.id:
            return Response({'detail': 'Forbidden'}, status=403)

        # Check if code matches Mesa (Option A)
        if mesa.pairing_code == code:
            from django.utils import timezone
            if not mesa.pairing_code_expires_at or mesa.pairing_code_expires_at < timezone.now():
                return Response({'detail': 'Pairing code expired'}, status=400)
        else:
            # Check if code matches a Session (Option B)
            try:
                session = PairingSession.objects.get(pairing_code=code)
                from django.utils import timezone
                if session.expires_at < timezone.now():
                    return Response({'detail': 'Pairing code expired'}, status=400)
                # Link session to this mesa
                session.mesa = mesa
            except PairingSession.DoesNotExist:
                return Response({'detail': 'Invalid pairing code'}, status=400)
        
        # Generate Token
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        
        # Save token to Mesa
        mesa.device_token_hash = token_hash
        # Store raw token temporarily for retrieval by device (via status endpoint)
        mesa.last_error = f"PENDING_TOKEN:{raw_token}"
        mesa.pairing_code = None
        mesa.pairing_code_expires_at = None
        mesa.save(update_fields=['device_token_hash', 'last_error', 'pairing_code', 'pairing_code_expires_at'])
        
        # If using session, save token hash there too so status check knows it's done
        if 'session' in locals() and session:
            session.device_token_hash = token_hash
            session.save(update_fields=['mesa', 'device_token_hash'])
        
        return Response({'status': 'ok'})

    @action(detail=False, methods=['post'], permission_classes=[permissions.IsAuthenticated])
    def unbind(self, request):
        """
        Unbind a device from a Mesa. Called from Dashboard.
        Requires: mesa_id
        """
        mesa_id = request.data.get('mesa_id')
        if not mesa_id:
            return Response({'detail': 'mesa_id required'}, status=400)
        
        try:
            mesa = Mesa.objects.get(id=mesa_id)
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)

        if not _is_admin(request.user) and mesa.usuario_id != request.user.id:
            return Response({'detail': 'Forbidden'}, status=403)
        
        if not mesa.device_token_hash:
            return Response({'detail': 'Mesa has no linked device'}, status=400)
        
        # Clear device link
        mesa.device_token_hash = None
        mesa.pairing_code = None
        mesa.last_error = None
        mesa.save(update_fields=['device_token_hash', 'pairing_code', 'last_error'])
        
        return Response({'status': 'ok'})

    @action(detail=False, methods=['post'])
    def heartbeat(self, request):
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        from api.serializers import DeviceHeartbeatSerializer
        from django.utils import timezone
        
        serializer = DeviceHeartbeatSerializer(data=request.data)
        if serializer.is_valid():
            # Update generic stats
            mesa.last_seen = timezone.now()
            # Could save other stats if model supports it
            mesa.save(update_fields=['last_seen'])
            
        return Response({'status': 'ok'})


    @action(detail=False, methods=['post'])
    def toggle_mapper(self, request):
        """
        Toggles the mapper_enabled state for the mesa.
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        mesa.mapper_enabled = not mesa.mapper_enabled
        mesa.save(update_fields=['mapper_enabled'])
        return Response({'status': 'ok', 'mapper_enabled': mesa.mapper_enabled})

    @action(detail=False, methods=['post'])
    def set_index(self, request):
        """
        Updates the current_image_index for the mesa.
        -1 = Calibration Grid
        0+ = Image Index
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        index = request.data.get('index')
        if index is not None:
            try:
                mesa.current_image_index = int(index)
            except (TypeError, ValueError):
                return Response({'detail': 'Index must be an integer'}, status=400)
            mesa.save(update_fields=['current_image_index', 'ultima_actualizacion'])
            return Response({'status': 'ok', 'index': mesa.current_image_index})
        return Response({'detail': 'Index required'}, status=400)

    @action(detail=False, methods=['get'], renderer_classes=[ServerSentEventRenderer])
    def stream(self, request):
        """
        Server-Sent Events (SSE) stream for real-time updates.
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)
            
        import time
        import json
        from django.http import StreamingHttpResponse
        
        def event_stream():
            last_check = mesa.ultima_actualizacion
            
            # Send initial state immediately
            initial_data = {
                'type': 'calibration',
                'data': {
                    'corners': mesa.calibration_json.get('corners') if mesa.calibration_json else None,
                    'mapper_enabled': mesa.mapper_enabled,
                    'current_image_index': mesa.current_image_index
                }
            }
            yield f"data: {json.dumps(initial_data)}\n\n"
            
            last_ping = time.time()
            
            while True:
                # Refresh from DB to check for updates
                mesa.refresh_from_db()
                
                if mesa.ultima_actualizacion > last_check:
                    last_check = mesa.ultima_actualizacion
                    payload = {
                        'type': 'calibration',
                        'data': {
                            'corners': mesa.calibration_json.get('corners') if mesa.calibration_json else None,
                            'mapper_enabled': mesa.mapper_enabled,
                            'current_image_index': mesa.current_image_index
                        }
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                
                # Keep-Alive
                now = time.time()
                if now - last_ping > 15:
                    yield ": keep-alive\n\n"
                    last_ping = now

                # Check updates at a lower rate to reduce DB pressure
                time.sleep(1.0)

        response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'  # Disable Nginx buffering
        return response

    @action(detail=False, methods=['get'])
    def current_item(self, request):
        """
        Device-friendly current item endpoint.
        Returns current MOSTRANDO item plus preloaded image list for that modulo/fase.
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)

        from api.models import MesaQueueStatus

        item = mesa.queue_items.select_related(
            'modulo', 'imagen', 'mesa', 'modulo__planta', 'modulo__planta__proyecto'
        ).filter(status=MesaQueueStatus.MOSTRANDO).first()

        if not item:
            return Response(None)

        item_data = MesaQueueItemSerializer(item, context={'request': request}).data
        images = Imagen.objects.filter(
            modulo_id=item.modulo_id,
            fase=item.fase,
            activo=True
        ).order_by('orden')
        item_data['images'] = ImagenSerializer(images, many=True, context={'request': request}).data
        return Response(item_data)

    @action(detail=False, methods=['post'])
    def mark_done(self, request):
        """
        Mark current MOSTRANDO item as HECHO from player/device token
        and auto-promote next EN_COLA item.
        """
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)

        from api.models import MesaQueueStatus

        current_item = mesa.queue_items.filter(status=MesaQueueStatus.MOSTRANDO).first()
        if not current_item:
            return Response({'detail': 'No item currently showing'}, status=404)

        current_item.marcar_hecho(user=None)

        next_item = mesa.queue_items.filter(status=MesaQueueStatus.EN_COLA).order_by('position').first()
        if next_item:
            next_item.status = MesaQueueStatus.MOSTRANDO
            next_item.save(update_fields=['status'])
            mesa.imagen_actual = next_item.imagen
            mesa.current_image_index = 0
        else:
            mesa.imagen_actual = None
            mesa.current_image_index = 0
        mesa.save(update_fields=['imagen_actual', 'current_image_index'])

        return Response({'status': 'ok'})

    @action(detail=False, methods=['post'])
    def upload_foto(self, request):
        """
        Upload a fabrication photo from the mini-PC camera service.
        Accepts device Bearer auth OR user Token auth (supervisor mode).
        Expects multipart form with:
        - 'foto': the image file
        - 'modulo_id': int
        - 'fase': 'INFERIOR' or 'SUPERIOR'
        - 'paso': int (0-based image index)
        - 'imagen_id': int (optional, the blueprint image being projected)
        - 'mesa_id': int (required when using user Token auth)
        """
        import os
        from django.conf import settings as django_settings
        from django.utils import timezone
        from api.models import Fase

        # Try device auth first, then fall back to user Token auth
        mesa = self._authenticate_device(request)
        if not mesa:
            # Check if user is authenticated via DRF Token auth
            if hasattr(request, 'user') and request.user and request.user.is_authenticated:
                mesa_id = request.data.get('mesa_id')
                if mesa_id:
                    mesa = Mesa.objects.filter(id=mesa_id).first()
                if not mesa:
                    return Response({'detail': 'mesa_id required for user auth'}, status=400)
            else:
                return Response({'detail': 'Unauthorized'}, status=401)

        foto_file = request.FILES.get('foto')
        if not foto_file:
            return Response({'detail': 'foto file required'}, status=400)

        modulo_id = request.data.get('modulo_id')
        fase = request.data.get('fase')
        paso = request.data.get('paso')
        imagen_id = request.data.get('imagen_id')

        if not all([modulo_id, fase, paso is not None]):
            return Response({'detail': 'modulo_id, fase, and paso are required'}, status=400)

        try:
            modulo = Modulo.objects.select_related('planta', 'planta__proyecto').get(id=modulo_id)
        except Modulo.DoesNotExist:
            return Response({'detail': 'Modulo not found'}, status=404)

        if fase not in [Fase.INFERIOR, Fase.SUPERIOR]:
            return Response({'detail': 'fase must be INFERIOR or SUPERIOR'}, status=400)

        imagen_ref = None
        if imagen_id:
            try:
                imagen_ref = Imagen.objects.get(id=imagen_id)
            except Imagen.DoesNotExist:
                pass

        # Build file path: fotos/{proyecto_id}/{planta_id}/{modulo_id}/
        proyecto_id = modulo.proyecto_id
        planta_id = modulo.planta_id or 0
        media_path = os.path.join('fotos', str(proyecto_id), str(planta_id), str(modulo.id))
        full_dir = os.path.join(django_settings.MEDIA_ROOT, media_path)
        os.makedirs(full_dir, exist_ok=True)

        # Generate unique filename
        ts = timezone.now().strftime('%Y%m%d_%H%M%S')
        fase_pref = 'INF' if fase == Fase.INFERIOR else 'SUP'
        ext = os.path.splitext(foto_file.name)[1] or '.jpg'
        filename = f"{modulo.nombre}_{fase_pref}_paso{paso}_{ts}{ext}"

        file_path = os.path.join(full_dir, filename)
        with open(file_path, 'wb+') as destination:
            for chunk in foto_file.chunks():
                destination.write(chunk)

        url = f'/media/{media_path}/{filename}'

        foto = FotoFabricacion.objects.create(
            modulo=modulo,
            mesa=mesa,
            fase=fase,
            paso=int(paso),
            imagen_referencia=imagen_ref,
            url=url,
            filename_original=foto_file.name,
            file_size=foto_file.size
        )

        serializer = FotoFabricacionSerializer(foto)
        return Response(serializer.data, status=201)

    @action(detail=False, methods=['get'])
    def state(self, request):
        mesa = self._authenticate_device(request)
        if not mesa:
            return Response({'detail': 'Unauthorized'}, status=401)

        from api.serializers import MesaStateSerializer
        serializer = MesaStateSerializer(mesa)
        return Response(serializer.data)
        
    @action(detail=False, methods=['post'], permission_classes=[permissions.IsAuthenticated])
    def revoke(self, request):
        # Admin action (normally authenticated, for PoC maybe just open or requires Secret)
        # Let's assume simple Mesa ID + Secret Header
        # Or just Dashboard authenticated. For PoC let's use standard IsAuthenticated if called from Dash.
        # If called from Device? A device shouldn't revoke itself easily?
        # User request: "POST /api/device/revoke ... Protect with X-Setup-Key"
        
        import os

        setup_key = request.headers.get('X-Setup-Key')
        expected_setup_key = os.environ.get('DEVICE_SETUP_KEY')
        has_valid_setup_key = bool(expected_setup_key and setup_key == expected_setup_key)
        if not has_valid_setup_key and not _is_admin(request.user):
            return Response({'detail': 'Forbidden'}, status=403)

        mesa_id = request.data.get('mesa_id')
        if not mesa_id:
             return Response({'detail': 'mesa_id required'}, status=400)
             
        try:
            mesa = Mesa.objects.get(id=mesa_id)
            mesa.device_token_hash = None
            mesa.pairing_code = None
            mesa.last_error = None
            mesa.save()
            return Response({'status': 'revoked'})
        except Mesa.DoesNotExist:
            return Response({'detail': 'Mesa not found'}, status=404)

    def _authenticate_device(self, request):
        """Helper to validate Bearer token against hashes."""
        import hashlib
        auth_header = request.headers.get('Authorization')
        token = None
        
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]
        elif request.query_params.get('token'):
            token = request.query_params.get('token')
            
        if not token or token.lower() in ['undefined', 'null', '']:
            return None
            
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        
        return Mesa.objects.filter(device_token_hash=token_hash).first()


class MesaQueueItemViewSet(viewsets.ModelViewSet):
    """
    API endpoint para gestionar items en la cola de mesas (WorkItems).
    """
    queryset = MesaQueueItem.objects.select_related('mesa', 'modulo', 'imagen', 'modulo__planta', 'modulo__planta__proyecto').all().order_by('mesa', 'position')
    serializer_class = MesaQueueItemSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = MesaQueueItem.objects.select_related('mesa', 'modulo', 'imagen', 'modulo__planta', 'modulo__planta__proyecto').all().order_by('position')
        if not _is_admin(self.request.user):
            queryset = queryset.filter(mesa__usuario=self.request.user)
        mesa_id = self.request.query_params.get('mesa', None)
        status_filter = self.request.query_params.get('status', None)
        if mesa_id is not None:
            queryset = queryset.filter(mesa_id=mesa_id)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset

    @action(detail=True, methods=['post'], url_path='mark_done')
    def mark_done(self, request, pk=None):
        """
        Marks a MesaQueueItem as HECHO. Also flips the matching Modulo
        phase boolean (inferior_hecho / superior_hecho) so the module
        eventually transitions to COMPLETADO / CERRADO.
        """
        from django.utils import timezone
        item = self.get_object()
        item.status = MesaQueueStatus.HECHO
        if item.done_at is None:
            item.done_at = timezone.now()
        item.done_by = request.user if request.user.is_authenticated else None
        item.save(update_fields=['status', 'done_at', 'done_by'])

        modulo = item.modulo
        if modulo is not None:
            if item.fase == 'INFERIOR':
                modulo.inferior_hecho = True
            elif item.fase == 'SUPERIOR':
                modulo.superior_hecho = True
            modulo.actualizar_estado()

        serializer = self.get_serializer(item)
        return Response(serializer.data)

    def perform_create(self, serializer):
        mesa = serializer.validated_data.get('mesa')
        if mesa and (not _is_admin(self.request.user)) and mesa.usuario_id != self.request.user.id:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('No puedes crear items en mesas de otro usuario')
        try:
            item = serializer.save()
        except IntegrityError:
            raise ValidationError('Esta fase ya tiene una asignacion activa en otra mesa')
        except ValueError as exc:
            raise ValidationError(str(exc))
        from api.models import MesaQueueStatus
        
        # Check if there are any active items (MOSTRANDO)
        # If not, auto-promote this new item
        active_exists = MesaQueueItem.objects.filter(
            mesa=item.mesa,
            status=MesaQueueStatus.MOSTRANDO
        ).exists()
        
        if not active_exists:
            item.status = MesaQueueStatus.MOSTRANDO
            item.save(update_fields=['status'])
            item.mesa.imagen_actual = item.imagen
            item.mesa.current_image_index = 0
            item.mesa.save(update_fields=['imagen_actual', 'current_image_index'])

    def perform_update(self, serializer):
        mesa = serializer.validated_data.get('mesa')
        if mesa and (not _is_admin(self.request.user)) and mesa.usuario_id != self.request.user.id:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('No puedes mover items a mesas de otro usuario')
        try:
            serializer.save()
        except IntegrityError:
            raise ValidationError('No se pudo mover: esta fase ya tiene una asignacion activa')
        except ValueError as exc:
            raise ValidationError(str(exc))

    def perform_destroy(self, instance):
        from api.models import MesaQueueStatus
        mesa = instance.mesa
        was_mostrando = (instance.status == MesaQueueStatus.MOSTRANDO)
        
        # Perform deletion
        instance.delete()
        
        # If we deleted the active item, promote the next one
        if was_mostrando:
            next_item = MesaQueueItem.objects.filter(
                mesa=mesa,
                status=MesaQueueStatus.EN_COLA
            ).order_by('position').first()
            
            if next_item:
                next_item.status = MesaQueueStatus.MOSTRANDO
                next_item.save(update_fields=['status'])
                mesa.imagen_actual = next_item.imagen
                mesa.current_image_index = 0
                mesa.save(update_fields=['imagen_actual', 'current_image_index'])
            else:
                # No more items, clear projection
                mesa.imagen_actual = None
                mesa.current_image_index = 0
                mesa.save(update_fields=['imagen_actual', 'current_image_index'])

    @action(detail=True, methods=['post'])
    def marcar_hecho(self, request, pk=None):
        """Mark a work item as done."""
        item = self.get_object()
        from api.models import MesaQueueStatus

        previous_status = item.status
        mesa = item.mesa
        item.marcar_hecho(user=request.user)

        # Auto-advance only if the item was currently showing.
        if previous_status == MesaQueueStatus.MOSTRANDO:
            next_item = MesaQueueItem.objects.filter(
                mesa=mesa,
                status=MesaQueueStatus.EN_COLA
            ).order_by('position').first()

            if next_item:
                next_item.status = MesaQueueStatus.MOSTRANDO
                next_item.save(update_fields=['status'])
                mesa.imagen_actual = next_item.imagen
                mesa.current_image_index = 0
            else:
                mesa.imagen_actual = None
                mesa.current_image_index = 0
            mesa.save(update_fields=['imagen_actual', 'current_image_index'])

        serializer = self.get_serializer(item)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def mostrar(self, request, pk=None):
        """Set this item as the one currently showing."""
        from api.models import MesaQueueStatus
        item = self.get_object()
        # Unset any other MOSTRANDO items for this desk
        MesaQueueItem.objects.filter(
            mesa=item.mesa,
            status=MesaQueueStatus.MOSTRANDO
        ).update(status=MesaQueueStatus.EN_COLA)
        # Set this one as MOSTRANDO
        item.status = MesaQueueStatus.MOSTRANDO
        item.save(update_fields=['status'])
        # Update mesa cache
        item.mesa.imagen_actual = item.imagen
        item.mesa.current_image_index = 0
        item.mesa.save(update_fields=['imagen_actual', 'current_image_index'])
        serializer = self.get_serializer(item)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def move(self, request, pk=None):
        """Move an item to another mesa with explicit business rules."""
        from api.models import Mesa, MesaQueueStatus

        item = self.get_object()
        target_mesa_id = request.data.get('mesa')
        target_position = request.data.get('position', item.position)

        if target_mesa_id in [None, '']:
            raise ValidationError({'mesa': 'Campo requerido'})

        try:
            target_mesa_id = int(target_mesa_id)
        except (TypeError, ValueError):
            raise ValidationError({'mesa': 'Mesa invalida'})

        try:
            target_position = int(target_position)
        except (TypeError, ValueError):
            raise ValidationError({'position': 'Position must be an integer'})

        try:
            target_mesa = Mesa.objects.get(id=target_mesa_id)
        except Mesa.DoesNotExist:
            raise ValidationError({'mesa': 'Mesa destino no existe'})

        if (not _is_admin(request.user)) and target_mesa.usuario_id != request.user.id:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('No puedes mover items a mesas de otro usuario')

        if item.status == MesaQueueStatus.MOSTRANDO and target_mesa.id != item.mesa_id:
            raise ValidationError('No se puede mover entre mesas un item con estado MOSTRANDO')

        conflict = MesaQueueItem.objects.select_related('mesa').filter(
            modulo=item.modulo,
            fase=item.fase,
            status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
        ).exclude(id=item.id).first()
        if conflict:
            raise ValidationError(f'Esta fase ya esta asignada a {conflict.mesa.nombre}')

        item.mesa = target_mesa
        item.position = max(0, target_position)
        try:
            item.save(update_fields=['mesa', 'position'])
        except IntegrityError:
            raise ValidationError('No se pudo mover: esta fase ya tiene una asignacion activa')
        except ValueError as exc:
            raise ValidationError(str(exc))

        serializer = self.get_serializer(item)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        """Reorder items in the mesa queue. Expects: {items: [{id: X, position: Y}, ...]}"""
        items_data = request.data.get('items', [])
        for item_data in items_data:
            try:
                item = MesaQueueItem.objects.get(id=item_data['id'])
                if not _is_admin(request.user) and item.mesa.usuario_id != request.user.id:
                    continue
                item.position = item_data['position']
                item.save(update_fields=['position'])
            except MesaQueueItem.DoesNotExist:
                pass
        return Response({'status': 'ok'})


class FotoFabricacionViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint to list/retrieve fabrication photos.
    Filterable by modulo, planta, proyecto, fase.
    """
    queryset = FotoFabricacion.objects.select_related(
        'modulo', 'modulo__planta', 'modulo__planta__proyecto', 'mesa', 'imagen_referencia'
    ).all()
    serializer_class = FotoFabricacionSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        queryset = FotoFabricacion.objects.select_related(
            'modulo', 'modulo__planta', 'modulo__planta__proyecto', 'mesa'
        ).all().order_by('-capturada_at')

        if not _is_admin(self.request.user):
            queryset = queryset.filter(modulo__proyecto__usuario=self.request.user)

        modulo_id = self.request.query_params.get('modulo')
        planta_id = self.request.query_params.get('planta')
        proyecto_id = self.request.query_params.get('proyecto')
        fase = self.request.query_params.get('fase')

        if modulo_id:
            queryset = queryset.filter(modulo_id=modulo_id)
        if planta_id:
            queryset = queryset.filter(modulo__planta_id=planta_id)
        if proyecto_id:
            queryset = queryset.filter(modulo__proyecto_id=proyecto_id)
        if fase:
            queryset = queryset.filter(fase=fase)

        return queryset

    @action(detail=False, methods=['get'])
    def download_zip(self, request):
        """
        Download photos as ZIP file.
        Query params: ?proyecto=ID or ?planta=ID or ?modulo=ID
        ZIP name uses the entity name; internal structure excludes the
        top-level folder (Windows "Extract All" creates it from the ZIP name).
        """
        import os
        import zipfile
        import io
        from django.conf import settings as django_settings
        from django.http import HttpResponse

        proyecto_id = request.query_params.get('proyecto')
        planta_id = request.query_params.get('planta')
        modulo_id = request.query_params.get('modulo')

        fotos = self.get_queryset()

        if not fotos.exists():
            return Response({'detail': 'No photos found'}, status=404)

        buffer = io.BytesIO()
        zip_entity_name = None
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for foto in fotos:
                proyecto_nombre = foto.modulo.proyecto.nombre if foto.modulo.proyecto else 'sin_proyecto'
                planta_nombre = foto.modulo.planta.nombre if foto.modulo.planta else 'sin_planta'
                modulo_nombre = foto.modulo.nombre
                filename = os.path.basename(foto.url)

                # Adapt folder structure to download scope.
                # The top-level entity name becomes the ZIP filename
                # (Windows "Extract All" creates a folder from the ZIP name).
                if modulo_id:
                    archive_path = filename
                    if not zip_entity_name:
                        zip_entity_name = modulo_nombre
                elif planta_id:
                    archive_path = f"{modulo_nombre}/{filename}"
                    if not zip_entity_name:
                        zip_entity_name = planta_nombre
                else:
                    archive_path = f"{planta_nombre}/{modulo_nombre}/{filename}"
                    if not zip_entity_name:
                        zip_entity_name = proyecto_nombre

                # Resolve actual file on disk
                relative_path = foto.url.lstrip('/')
                if relative_path.startswith('media/'):
                    relative_path = relative_path[len('media/'):]
                file_path = os.path.join(django_settings.MEDIA_ROOT, relative_path)
                if os.path.exists(file_path):
                    zf.write(file_path, archive_path)

        buffer.seek(0)
        response = HttpResponse(buffer.read(), content_type='application/zip')
        dl_name = f'{zip_entity_name}.zip' if zip_entity_name else 'fotos.zip'

        response['Content-Disposition'] = f'attachment; filename="{dl_name}"'
        return response
