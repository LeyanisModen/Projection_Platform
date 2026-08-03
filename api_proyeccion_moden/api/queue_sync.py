from django.db import transaction
from django.db.models import Count, Max, Q

from api.models import (
    Fase,
    GrupoMesas,
    GrupoMesasProyecto,
    Mesa,
    MesaQueueItem,
    MesaQueueStatus,
    MesaTipo,
)


ACTIVE_QUEUE_STATUSES = [MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO]
EARLY_IMAGE_INDEX_LIMIT = 1


def capture_phase_assignment_hints(modulo, fases):
    """Remember the latest operational assignment before reset deletes it."""
    items = list(
        MesaQueueItem.objects.select_related("mesa", "mesa__grupo")
        .filter(modulo=modulo, fase__in=fases)
        .order_by("id")
    )
    reserved_group_id = getattr(
        getattr(modulo, "grupo_bastidor", None), "asignado_a_id", None
    )
    hints = {}
    for fase in fases:
        candidates = [item for item in items if item.fase == fase]
        if not candidates:
            continue
        selected = max(
            candidates,
            key=lambda item: (
                item.status in ACTIVE_QUEUE_STATUSES,
                bool(reserved_group_id and item.mesa.grupo_id == reserved_group_id),
                item.id,
            ),
        )
        hints[fase] = {
            "mesa_id": selected.mesa_id,
            "grupo_id": selected.mesa.grupo_id,
            "plan_group_index": selected.plan_group_index,
            "was_showing": selected.status == MesaQueueStatus.MOSTRANDO,
        }
    return hints


def _group_for_module(modulo, hint):
    hint_group_id = hint.get("grupo_id") if hint else None
    if hint_group_id:
        group = GrupoMesas.objects.filter(id=hint_group_id, activa=True).first()
        if group:
            return group

    bastidor = getattr(modulo, "grupo_bastidor", None)
    if bastidor and bastidor.asignado_a_id:
        group = GrupoMesas.objects.filter(
            id=bastidor.asignado_a_id, activa=True
        ).first()
        if group:
            return group

    queued_groups = list(
        GrupoMesas.objects.filter(
            activa=True,
            proyectos_cola__proyecto=modulo.proyecto,
        )
        .annotate(
            active_work=Count(
                "mesas__queue_items",
                filter=Q(mesas__queue_items__status__in=ACTIVE_QUEUE_STATUSES),
            )
        )
        .order_by("active_work", "id")
        .distinct()
    )
    return queued_groups[0] if queued_groups else None


def _ensure_project_in_group_queue(group, proyecto):
    if GrupoMesasProyecto.objects.filter(
        grupo_mesas=group, proyecto=proyecto
    ).exists():
        return

    last_order = group.proyectos_cola.aggregate(value=Max("orden"))["value"]
    GrupoMesasProyecto.objects.create(
        grupo_mesas=group,
        proyecto=proyecto,
        orden=(last_order + 1) if last_order is not None else 0,
    )
    if group.proyecto_actual_id is None:
        group.proyecto_actual = proyecto
        group.save(update_fields=["proyecto_actual"])


def _peer_assignment(modulo, fase, group):
    bastidor_id = getattr(modulo, "grupo_bastidor_id", None)
    if not bastidor_id:
        return None

    peers = list(
        MesaQueueItem.objects.select_related("mesa")
        .filter(
            mesa__grupo=group,
            modulo__grupo_bastidor_id=bastidor_id,
            fase=fase,
        )
        .exclude(modulo=modulo)
        .order_by("id")
    )
    if not peers:
        return None
    return max(
        peers,
        key=lambda item: (item.status in ACTIVE_QUEUE_STATUSES, item.id),
    )


def _resolve_target(modulo, fase, group, hint):
    expected_type = (
        MesaTipo.INFERIOR if fase == Fase.INFERIOR else MesaTipo.SUPERIOR
    )
    hint_mesa_id = hint.get("mesa_id") if hint else None
    if hint_mesa_id:
        hinted_mesa = Mesa.objects.filter(
            id=hint_mesa_id,
            grupo=group,
            tipo=expected_type,
            activa=True,
        ).first()
        if hinted_mesa:
            return hinted_mesa, hint.get("plan_group_index")

    # Inferior modules from one physical bastidor must stay on the same mesa.
    peer = _peer_assignment(modulo, fase, group) if fase == Fase.INFERIOR else None
    if peer and peer.mesa.activa and peer.mesa.tipo == expected_type:
        return peer.mesa, peer.plan_group_index

    mesa = (
        group.mesas.filter(tipo=expected_type, activa=True)
        .annotate(
            active_work=Count(
                "queue_items",
                filter=Q(queue_items__status__in=ACTIVE_QUEUE_STATUSES),
            )
        )
        .order_by("active_work", "indice", "id")
        .first()
    )
    if not mesa:
        return None, None

    bastidor = getattr(modulo, "grupo_bastidor", None)
    plan_group_index = getattr(bastidor, "indice", None)
    return mesa, plan_group_index


def _ordered_active_items(mesa):
    items = list(
        MesaQueueItem.objects.select_for_update()
        .select_related("modulo")
        .filter(mesa=mesa, status__in=ACTIVE_QUEUE_STATUSES)
        .order_by("position", "id")
    )
    current = next(
        (item for item in items if item.status == MesaQueueStatus.MOSTRANDO),
        None,
    )
    if current and items[0] != current:
        items.remove(current)
        items.insert(0, current)
    return items, current


def _insert_phase(modulo, fase, mesa, plan_group_index, assigned_by, prioritize, hint):
    existing = MesaQueueItem.objects.filter(
        modulo=modulo,
        fase=fase,
        status__in=ACTIVE_QUEUE_STATUSES,
    ).first()
    if existing:
        return existing

    mesa = Mesa.objects.select_for_update().get(id=mesa.id)
    active_items, current = _ordered_active_items(mesa)

    if prioritize:
        should_preempt = (
            current is None
            or bool(hint and hint.get("was_showing"))
            or mesa.current_image_index <= EARLY_IMAGE_INDEX_LIMIT
        )
        insert_at = 0 if should_preempt else 1
    else:
        should_preempt = current is None
        peer_indexes = [
            index
            for index, item in enumerate(active_items)
            if item.modulo.proyecto_id == modulo.proyecto_id
            and item.modulo.grupo_bastidor_id == modulo.grupo_bastidor_id
        ]
        insert_at = (max(peer_indexes) + 1) if peer_indexes else len(active_items)

    item = MesaQueueItem.objects.create(
        mesa=mesa,
        modulo=modulo,
        fase=fase,
        imagen=None,
        position=len(active_items),
        plan_group_index=plan_group_index,
        status=MesaQueueStatus.EN_COLA,
        assigned_by=(
            assigned_by
            if assigned_by is not None and assigned_by.is_authenticated
            else None
        ),
    )
    active_items.insert(min(insert_at, len(active_items)), item)

    showing_item = item if should_preempt else current
    if showing_item is None:
        showing_item = item

    for position, queued_item in enumerate(active_items):
        desired_status = (
            MesaQueueStatus.MOSTRANDO
            if queued_item.id == showing_item.id
            else MesaQueueStatus.EN_COLA
        )
        updates = []
        if queued_item.position != position:
            queued_item.position = position
            updates.append("position")
        if queued_item.status != desired_status:
            queued_item.status = desired_status
            updates.append("status")
        if updates:
            queued_item.save(update_fields=updates)

    if showing_item.id == item.id:
        mesa.imagen_actual = item.imagen
        mesa.current_image_index = 0
        mesa.save(
            update_fields=[
                "imagen_actual",
                "current_image_index",
                "ultima_actualizacion",
            ]
        )
    return item


def sync_module_phases(modulo, fases, assigned_by=None, hints=None, prioritize=False):
    """Add missing phases without rebuilding or discarding the existing queue."""
    hints = hints or {}
    created = []
    with transaction.atomic():
        for fase in (Fase.INFERIOR, Fase.SUPERIOR):
            if fase not in fases:
                continue
            hint = hints.get(fase) or {}
            group = _group_for_module(modulo, hint)
            if not group:
                continue
            mesa, plan_group_index = _resolve_target(modulo, fase, group, hint)
            if not mesa:
                continue

            _ensure_project_in_group_queue(group, modulo.proyecto)
            bastidor = getattr(modulo, "grupo_bastidor", None)
            if bastidor and bastidor.asignado_a_id is None:
                bastidor.asignado_a = group
                bastidor.save(update_fields=["asignado_a"])

            item = _insert_phase(
                modulo,
                fase,
                mesa,
                plan_group_index,
                assigned_by,
                prioritize,
                hint,
            )
            if item:
                created.append(item)
    return created


def sync_new_module(modulo, assigned_by=None):
    pending_fases = set()
    if not modulo.inferior_hecho:
        pending_fases.add(Fase.INFERIOR)
    if not modulo.superior_hecho:
        pending_fases.add(Fase.SUPERIOR)
    return sync_module_phases(
        modulo,
        pending_fases,
        assigned_by=assigned_by,
        prioritize=False,
    )
