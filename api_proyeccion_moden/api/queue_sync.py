from django.db import transaction
from django.db.models import Count, Max, Q
from django.utils import timezone

from api.models import (
    EstrategiaColaSuperior,
    Fase,
    GrupoMesas,
    GrupoMesasProyecto,
    Mesa,
    MesaQueueItem,
    MesaQueueStatus,
    MesaTipo,
    Modulo,
    ModuloEstado,
)


ACTIVE_QUEUE_STATUSES = [MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO]
EARLY_IMAGE_INDEX_LIMIT = 1


class QueueRelocationError(Exception):
    """Raised when a bastidor change would move work already on screen."""


def module_operational_state(modulo, showing_items=None):
    """Return the module state visible to operators.

    The persisted state continues to describe completed phases. Operationally,
    a module is also in progress once a showing phase has passed the two setup
    images and its physical position is therefore committed.
    """
    if modulo.cerrado:
        return ModuloEstado.CERRADO
    if modulo.inferior_hecho and modulo.superior_hecho:
        return ModuloEstado.COMPLETADO
    if modulo.inferior_hecho or modulo.superior_hecho:
        return ModuloEstado.EN_PROGRESO

    if showing_items is None:
        showing_items = getattr(modulo, "reorder_showing_items", None)
    if showing_items is None:
        showing_items = (
            modulo.mesa_queue_items.select_related("mesa")
            .filter(status=MesaQueueStatus.MOSTRANDO)
        )

    if any(
        item.mesa.current_image_index > EARLY_IMAGE_INDEX_LIMIT
        for item in showing_items
    ):
        return ModuloEstado.EN_PROGRESO
    return ModuloEstado.PENDIENTE


def module_reorderability(modulo, showing_items=None):
    """Return whether a module can still change its bastidor position.

    Images 1 and 2 are treated as setup time. Once either phase reaches the
    third image, its physical position is considered committed.
    """
    if modulo.estado != ModuloEstado.PENDIENTE:
        return False, (
            f'No se puede mover "{modulo.nombre}" porque su estado es '
            f'{modulo.estado}. Solo se mueven modulos pendientes.'
        )

    if modulo.inferior_hecho or modulo.superior_hecho or modulo.cerrado:
        return False, (
            f'No se puede mover "{modulo.nombre}" porque ya tiene una fase '
            'fabricada.'
        )

    if showing_items is None:
        showing_items = getattr(modulo, "reorder_showing_items", None)
    if showing_items is None:
        showing_items = (
            modulo.mesa_queue_items.select_related("mesa")
            .filter(status=MesaQueueStatus.MOSTRANDO)
        )

    advanced_items = [
        item
        for item in showing_items
        if item.mesa.current_image_index > EARLY_IMAGE_INDEX_LIMIT
    ]
    if advanced_items:
        phases = ", ".join(
            f'{item.fase}: imagen {item.mesa.current_image_index + 1}'
            for item in advanced_items
        )
        return False, (
            f'No se puede mover "{modulo.nombre}" porque su fabricacion ya '
            f'ha comenzado ({phases}).'
        )

    return True, None


def module_reorderability_map(modules):
    """Calculate reorderability for a module collection with one queue query."""
    modules = list(modules)
    showing_by_module = {modulo.id: [] for modulo in modules}
    if not showing_by_module:
        return {}

    showing_items = (
        MesaQueueItem.objects.select_related("mesa")
        .filter(
            modulo_id__in=showing_by_module,
            status=MesaQueueStatus.MOSTRANDO,
        )
    )
    for item in showing_items:
        showing_by_module[item.modulo_id].append(item)

    return {
        modulo.id: module_reorderability(
            modulo,
            showing_items=showing_by_module[modulo.id],
        )
        for modulo in modules
    }


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
        insert_at = len(active_items)
        if peer_indexes:
            insert_at = max(peer_indexes) + 1
            if fase == Fase.INFERIOR:
                for peer_index in peer_indexes:
                    peer_order = active_items[peer_index].modulo.orden_intra or 0
                    if peer_order < (modulo.orden_intra or 0):
                        insert_at = peer_index
                        break

                current_index = next(
                    (
                        index
                        for index, queued in enumerate(active_items)
                        if current and queued.id == current.id
                    ),
                    None,
                )
                current_is_peer = bool(
                    current
                    and current.modulo.grupo_bastidor_id == modulo.grupo_bastidor_id
                    and current.fase == fase
                )
                if (
                    current_is_peer
                    and current_index is not None
                    and insert_at <= current_index
                ):
                    if mesa.current_image_index <= EARLY_IMAGE_INDEX_LIMIT:
                        should_preempt = True
                    else:
                        insert_at = max(peer_indexes) + 1

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
    group_ids = set()
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
                group_ids.add(group.id)
    for group in GrupoMesas.objects.filter(id__in=group_ids):
        reconcile_superior_queue_for_group(group)
    return created


def sync_new_module(modulo, assigned_by=None):
    pending_fases = set()
    if not modulo.inferior_hecho:
        pending_fases.add(Fase.INFERIOR)
    if not modulo.superior_hecho:
        pending_fases.add(Fase.SUPERIOR)
    created = sync_module_phases(
        modulo,
        pending_fases,
        assigned_by=assigned_by,
        prioritize=False,
    )
    return created


def _persist_active_order(mesa, items, current):
    previous_current_id = next(
        (
            item.id
            for item in items
            if item.status == MesaQueueStatus.MOSTRANDO
        ),
        None,
    )
    current_id = current.id if current else None
    if current_id is not None and all(item.id != current_id for item in items):
        current_id = None

    if current_id is None and items:
        current_id = items[0].id
    current_changed = previous_current_id != current_id

    for position, item in enumerate(items):
        desired_status = (
            MesaQueueStatus.MOSTRANDO
            if item.id == current_id
            else MesaQueueStatus.EN_COLA
        )
        updates = []
        if item.position != position:
            item.position = position
            updates.append("position")
        if item.status != desired_status:
            item.status = desired_status
            updates.append("status")
        if updates:
            item.save(update_fields=updates)

    if current_changed or not items:
        current_item = next(
            (item for item in items if item.id == current_id),
            None,
        )
        mesa.imagen_actual = current_item.imagen if current_item else None
        mesa.current_image_index = 0
        mesa.save(
            update_fields=[
                "imagen_actual",
                "current_image_index",
                "ultima_actualizacion",
            ]
        )


def _backfill_missing_superior_items(group, inferior_items, superior_items):
    """Create SUP work accidentally missing for modules already queued in INF."""
    inferior_by_module = {}
    for item in inferior_items:
        if item.modulo.cerrado or item.modulo.superior_hecho:
            continue
        inferior_by_module.setdefault(item.modulo_id, item)

    if not inferior_by_module:
        return superior_items

    active_superior_module_ids = set(
        MesaQueueItem.objects.select_for_update()
        .filter(
            modulo_id__in=inferior_by_module,
            fase=Fase.SUPERIOR,
            status__in=ACTIVE_QUEUE_STATUSES,
        )
        .values_list("modulo_id", flat=True)
    )
    missing_inferior_items = [
        item
        for module_id, item in inferior_by_module.items()
        if module_id not in active_superior_module_ids
    ]
    if not missing_inferior_items:
        return superior_items

    superior_mesas = list(
        group.mesas.select_for_update()
        .filter(tipo=MesaTipo.SUPERIOR, activa=True)
        .order_by("indice", "id")
    )
    if not superior_mesas:
        return superior_items

    loads = {
        mesa.id: sum(1 for item in superior_items if item.mesa_id == mesa.id)
        for mesa in superior_mesas
    }
    next_positions = {
        mesa.id: max(
            (
                item.position
                for item in superior_items
                if item.mesa_id == mesa.id
            ),
            default=-1,
        ) + 1
        for mesa in superior_mesas
    }

    for inferior_item in missing_inferior_items:
        target_mesa = min(
            superior_mesas,
            key=lambda mesa: (loads[mesa.id], mesa.indice, mesa.id),
        )
        superior_item, created = MesaQueueItem.objects.filter(
            status__in=ACTIVE_QUEUE_STATUSES,
        ).select_related("mesa").get_or_create(
            modulo_id=inferior_item.modulo_id,
            fase=Fase.SUPERIOR,
            defaults={
                "mesa": target_mesa,
                "imagen": None,
                "position": next_positions[target_mesa.id],
                "plan_group_index": inferior_item.plan_group_index,
                "status": MesaQueueStatus.EN_COLA,
                "assigned_by_id": inferior_item.assigned_by_id,
            },
        )
        if not created:
            if (
                superior_item.mesa.grupo_id == group.id
                and all(item.id != superior_item.id for item in superior_items)
            ):
                superior_items.append(superior_item)
                if superior_item.mesa_id in loads:
                    loads[superior_item.mesa_id] += 1
                    next_positions[superior_item.mesa_id] = max(
                        next_positions[superior_item.mesa_id],
                        superior_item.position + 1,
                    )
            continue

        superior_items.append(superior_item)
        loads[target_mesa.id] += 1
        next_positions[target_mesa.id] += 1

    return superior_items


def initialize_superior_demands_for_group(group):
    """Recover real SUP demand for work that was already active or completed.

    This is primarily used when adaptive ordering is enabled on a group that
    was already producing. Normal operation records the timestamp as soon as
    INF passes its setup images or finishes.
    """
    with transaction.atomic():
        pending_superior_module_ids = set(
            MesaQueueItem.objects.filter(
                mesa__grupo=group,
                fase=Fase.SUPERIOR,
                status__in=ACTIVE_QUEUE_STATUSES,
                modulo__superior_hecho=False,
                modulo__superior_needed_at__isnull=True,
            ).values_list("modulo_id", flat=True)
        )
        if not pending_superior_module_ids:
            return 0

        modules = list(
            Modulo.objects.select_for_update().filter(
                id__in=pending_superior_module_ids,
                superior_hecho=False,
                superior_needed_at__isnull=True,
            )
        )
        if not modules:
            return 0

        active_inferior = {
            item.modulo_id: item
            for item in (
                MesaQueueItem.objects.select_related("mesa")
                .filter(
                    mesa__grupo=group,
                    mesa__tipo=MesaTipo.INFERIOR,
                    fase=Fase.INFERIOR,
                    status=MesaQueueStatus.MOSTRANDO,
                    modulo_id__in=pending_superior_module_ids,
                )
                .order_by("mesa__indice", "position", "id")
            )
        }
        inferior_done_at = dict(
            MesaQueueItem.objects.filter(
                mesa__grupo=group,
                fase=Fase.INFERIOR,
                status=MesaQueueStatus.HECHO,
                done_at__isnull=False,
                modulo_id__in=pending_superior_module_ids,
            )
            .values("modulo_id")
            .annotate(last_done_at=Max("done_at"))
            .values_list("modulo_id", "last_done_at")
        )

        now = timezone.now()
        changed = []
        for modulo in modules:
            active_item = active_inferior.get(modulo.id)
            if (
                active_item
                and active_item.mesa.current_image_index
                > EARLY_IMAGE_INDEX_LIMIT
            ):
                modulo.superior_needed_at = (
                    active_item.mesa.ultima_actualizacion or now
                )
            elif modulo.inferior_hecho:
                modulo.superior_needed_at = (
                    inferior_done_at.get(modulo.id) or now
                )
            else:
                continue
            changed.append(modulo)

        if changed:
            Modulo.objects.bulk_update(changed, ["superior_needed_at"])
        return len(changed)


def register_superior_demand_for_mesa(mesa, needed_at=None):
    """Record that the INF item on screen now requires its SUP counterpart."""
    if (
        mesa.tipo != MesaTipo.INFERIOR
        or mesa.current_image_index <= EARLY_IMAGE_INDEX_LIMIT
    ):
        return False

    current_item = (
        MesaQueueItem.objects.filter(
            mesa=mesa,
            fase=Fase.INFERIOR,
            status=MesaQueueStatus.MOSTRANDO,
        )
        .only("modulo_id")
        .first()
    )
    if not current_item:
        return False

    changed = Modulo.objects.filter(
        id=current_item.modulo_id,
        superior_hecho=False,
        superior_needed_at__isnull=True,
    ).update(superior_needed_at=needed_at or timezone.now())
    if changed and mesa.grupo_id:
        group = GrupoMesas.objects.get(id=mesa.grupo_id)
        if group.estrategia_cola_superior == EstrategiaColaSuperior.ADAPTATIVA:
            reconcile_superior_queue_for_group(group)
    return bool(changed)


def reconcile_superior_queue_if_adaptive(group):
    """Reconcile a group only when its explicit adaptive policy is active."""
    if not group:
        return []
    if group.estrategia_cola_superior != EstrategiaColaSuperior.ADAPTATIVA:
        return []
    return reconcile_superior_queue_for_group(group)


def reconcile_superior_queue_for_group(group):
    """Backfill and order SUP work according to the group's selected policy.

    Superior work past the initial images remains anchored so an in-progress
    sequence is never interrupted. Planned groups use the round-robin merge of
    inferior mesas. Adaptive groups first serve modules already requested by
    real INF progress; untouched and superior-only work retains the theoretical
    order afterwards.
    """
    adaptive = (
        group.estrategia_cola_superior == EstrategiaColaSuperior.ADAPTATIVA
    )
    if adaptive:
        initialize_superior_demands_for_group(group)

    with transaction.atomic():
        inferior_items = list(
            MesaQueueItem.objects.select_for_update()
            .select_related("mesa", "modulo")
            .filter(
                mesa__grupo=group,
                mesa__tipo=MesaTipo.INFERIOR,
                fase=Fase.INFERIOR,
                status__in=ACTIVE_QUEUE_STATUSES,
            )
            .order_by("mesa__indice", "mesa_id", "position", "id")
        )
        superior_items = list(
            MesaQueueItem.objects.select_for_update()
            .select_related("mesa", "modulo")
            .filter(
                mesa__grupo=group,
                fase=Fase.SUPERIOR,
                status__in=ACTIVE_QUEUE_STATUSES,
            )
            .order_by("mesa__indice", "mesa_id", "position", "id")
        )
        superior_items = _backfill_missing_superior_items(
            group,
            inferior_items,
            superior_items,
        )
        if not superior_items or (not inferior_items and not adaptive):
            return superior_items

        inferior_by_mesa = {}
        inferior_source_by_module = {}
        inferior_item_by_module = {}
        for item in inferior_items:
            inferior_by_mesa.setdefault(item.mesa_id, []).append(item)
            inferior_source_by_module[item.modulo_id] = item.mesa_id
            inferior_item_by_module[item.modulo_id] = item

        mesa_ids = list(inferior_by_mesa)
        mesa_index = {mesa_id: index for index, mesa_id in enumerate(mesa_ids)}
        superior_by_module = {item.modulo_id: item for item in superior_items}
        anchored = [
            item for item in superior_items
            if item.status == MesaQueueStatus.MOSTRANDO
            and item.mesa.current_image_index > EARLY_IMAGE_INDEX_LIMIT
        ]
        priority_source_id = None
        priority_items = []
        if adaptive:
            priority_items = sorted(
                (
                    item for item in superior_items
                    if item not in anchored
                    and item.modulo.superior_needed_at is not None
                ),
                key=lambda item: (
                    item.modulo.superior_needed_at,
                    item.assigned_at,
                    item.id,
                ),
            )
            if not anchored and not priority_items:
                # With no real demand yet, preserve the current initial item.
                # This makes adaptive mode indistinguishable from the planned
                # sequence while both inferior mesas still advance together.
                anchored = [
                    item for item in superior_items
                    if item.status == MesaQueueStatus.MOSTRANDO
                ]
        elif not anchored:
            progress_by_mesa = {
                mesa_id: items[0].mesa.current_image_index
                for mesa_id, items in inferior_by_mesa.items()
            }
            max_progress = max(progress_by_mesa.values())
            leading_mesas = [
                mesa_id
                for mesa_id, progress in progress_by_mesa.items()
                if progress == max_progress
            ]
            if (
                len(mesa_ids) > 1
                and max_progress > EARLY_IMAGE_INDEX_LIMIT
                and len(leading_mesas) == 1
            ):
                priority_source_id = leading_mesas[0]
            else:
                # Without a clear dependency priority, retain an initial item
                # as a soft anchor. This avoids disrupting fresh plans and
                # inserting a newly imported module ahead of existing work.
                anchored = [
                    item for item in superior_items
                    if item.status == MesaQueueStatus.MOSTRANDO
                ]
        anchored_module_ids = {item.modulo_id for item in anchored}
        priority_module_ids = {item.modulo_id for item in priority_items}

        queues = []
        for mesa_id in mesa_ids:
            queues.append([
                superior_by_module[item.modulo_id]
                for item in inferior_by_mesa[mesa_id]
                if item.modulo_id in superior_by_module
                and item.modulo_id not in anchored_module_ids
                and item.modulo_id not in priority_module_ids
            ])

        # Continue after the inferior mesa that supplied genuinely started SUP
        # work. An initial SUP item is replaceable only when one inferior mesa
        # is clearly further along; otherwise preserve the existing head so a
        # fresh plan or module import does not churn an otherwise valid queue.
        cursor = 0
        if queues:
            if anchored:
                source_id = inferior_source_by_module.get(anchored[-1].modulo_id)
                if source_id in mesa_index:
                    cursor = (mesa_index[source_id] + 1) % len(queues)
            elif priority_source_id in mesa_index:
                cursor = mesa_index[priority_source_id]
            else:
                source_id = inferior_source_by_module.get(
                    superior_items[0].modulo_id
                )
                if source_id in mesa_index:
                    cursor = mesa_index[source_id]

        desired = list(priority_items)
        while any(queues):
            for _ in range(len(queues)):
                if queues[cursor]:
                    desired.append(queues[cursor].pop(0))
                    cursor = (cursor + 1) % len(queues)
                    break
                cursor = (cursor + 1) % len(queues)

        desired_ids = {item.id for item in desired}
        standalone = [
            item for item in superior_items
            if item.id not in desired_ids
            and item.modulo_id not in anchored_module_ids
        ]
        desired.extend(standalone)
        rank = {item.id: index for index, item in enumerate(desired)}

        for item in superior_items:
            inferior_item = inferior_item_by_module.get(item.modulo_id)
            if (
                inferior_item
                and item.plan_group_index != inferior_item.plan_group_index
            ):
                item.plan_group_index = inferior_item.plan_group_index
                item.save(update_fields=["plan_group_index"])

        superior_mesas = {
            item.mesa_id: item.mesa for item in superior_items
        }
        for mesa_id, mesa in superior_mesas.items():
            mesa_items = [item for item in superior_items if item.mesa_id == mesa_id]
            current = next(
                (
                    item for item in mesa_items
                    if item.modulo_id in anchored_module_ids
                ),
                None,
            )
            pending = [item for item in mesa_items if item is not current]
            pending.sort(key=lambda item: (rank.get(item.id, len(rank)), item.id))
            ordered = ([current] if current else []) + pending
            _persist_active_order(mesa, ordered, current)

        return sorted(
            superior_items,
            key=lambda item: (item.mesa.indice, item.position, item.id),
        )


def reconcile_module_queue_after_bastidor_move(modulo):
    """Keep queued work aligned after an admin moves a module.

    Inferior work follows the mesa already used by the destination bastidor.
    Superior work keeps its current mesa while it remains in the same
    operational group, because superior queues are intentionally distributed.
    """
    bastidor = getattr(modulo, "grupo_bastidor", None)
    if not bastidor:
        return []

    active_items = list(
        MesaQueueItem.objects.select_for_update()
        .select_related("mesa")
        .filter(modulo=modulo, status__in=ACTIVE_QUEUE_STATUSES)
        .order_by("id")
    )
    if not active_items:
        return []

    group = None
    if bastidor.asignado_a_id:
        group = GrupoMesas.objects.filter(
            id=bastidor.asignado_a_id,
            activa=True,
        ).first()
    else:
        active_group_ids = {
            item.mesa.grupo_id
            for item in active_items
            if item.mesa.grupo_id is not None
        }
        if len(active_group_ids) == 1:
            group = GrupoMesas.objects.filter(
                id=next(iter(active_group_ids)),
                activa=True,
            ).first()
            if group:
                bastidor.asignado_a = group
                bastidor.save(update_fields=["asignado_a"])

    if group is None:
        group = _group_for_module(modulo, {})
    if group is None:
        return []

    relocations = []
    for item in active_items:
        peer = (
            _peer_assignment(modulo, item.fase, group)
            if item.fase == Fase.INFERIOR
            else None
        )
        if peer and peer.mesa.activa and peer.mesa.tipo == item.mesa.tipo:
            target_mesa = peer.mesa
            plan_group_index = peer.plan_group_index
        elif item.mesa.grupo_id == group.id:
            target_mesa = item.mesa
            plan_group_index = bastidor.indice
        else:
            target_mesa, plan_group_index = _resolve_target(
                modulo,
                item.fase,
                group,
                {},
            )

        if target_mesa is None:
            continue
        if plan_group_index is None:
            plan_group_index = bastidor.indice

        if item.mesa_id != target_mesa.id and item.status == MesaQueueStatus.MOSTRANDO:
            raise QueueRelocationError(
                f'No se puede mover "{modulo.nombre}" al {bastidor.nombre}: '
                f'ya se esta mostrando en {item.mesa.nombre}.'
            )
        relocations.append((item.id, item.mesa_id, target_mesa.id, plan_group_index))

    moved_items = []
    for item_id, source_mesa_id, target_mesa_id, plan_group_index in relocations:
        item = MesaQueueItem.objects.select_for_update().get(id=item_id)
        same_mesa = source_mesa_id == target_mesa_id
        if same_mesa and item.fase != Fase.INFERIOR:
            if item.plan_group_index != plan_group_index:
                item.plan_group_index = plan_group_index
                item.save(update_fields=["plan_group_index"])
            continue
        if (
            same_mesa
            and item.status == MesaQueueStatus.MOSTRANDO
            and item.mesa.current_image_index > EARLY_IMAGE_INDEX_LIMIT
        ):
            if item.plan_group_index != plan_group_index:
                item.plan_group_index = plan_group_index
                item.save(update_fields=["plan_group_index"])
            continue

        locked_mesas = {
            mesa.id: mesa
            for mesa in Mesa.objects.select_for_update().filter(
                id__in=sorted({source_mesa_id, target_mesa_id})
            )
        }
        source_mesa = locked_mesas[source_mesa_id]
        target_mesa = locked_mesas[target_mesa_id]

        update_fields = []
        if not same_mesa:
            item.mesa = target_mesa
            update_fields.append("mesa")
        item.plan_group_index = plan_group_index
        update_fields.append("plan_group_index")
        item.save(update_fields=update_fields)

        if not same_mesa:
            source_items, source_current = _ordered_active_items(source_mesa)
            _persist_active_order(source_mesa, source_items, source_current)

        target_items, target_current = _ordered_active_items(target_mesa)
        target_items = [queued for queued in target_items if queued.id != item.id]
        peer_indexes = [
            index
            for index, queued in enumerate(target_items)
            if queued.modulo.grupo_bastidor_id == bastidor.id
            and queued.fase == item.fase
        ]
        insert_at = len(target_items)
        if peer_indexes:
            insert_at = max(peer_indexes) + 1
            # La cola inferior fabrica cada bastidor en orden inverso al
            # card: el ultimo modulo colocado es el primero en salir.
            for peer_index in peer_indexes:
                peer_order = target_items[peer_index].modulo.orden_intra or 0
                if peer_order < (modulo.orden_intra or 0):
                    insert_at = peer_index
                    break

            current_index = next(
                (
                    index
                    for index, queued in enumerate(target_items)
                    if target_current and queued.id == target_current.id
                ),
                None,
            )
            current_is_same_bastidor = bool(
                target_current
                and target_current.modulo.grupo_bastidor_id == bastidor.id
                and target_current.fase == item.fase
            )
            if target_current and target_current.id == item.id:
                # El modulo que se estaba mostrando se ha recolocado desde
                # el card dentro del margen inicial. El primero del nuevo
                # orden pasa a ser el actual, aunque ya no sea este item.
                target_current = None
            if (
                current_is_same_bastidor
                and current_index is not None
                and insert_at <= current_index
            ):
                if target_mesa.current_image_index <= EARLY_IMAGE_INDEX_LIMIT:
                    target_current = item
                else:
                    # No se interrumpe un modulo que ya paso del margen
                    # inicial, aunque el card haya cambiado de orden.
                    insert_at = max(peer_indexes) + 1

        target_items.insert(insert_at, item)
        _persist_active_order(target_mesa, target_items, target_current)
        moved_items.append(item)

    reconcile_superior_queue_for_group(group)
    superior_item = (
        MesaQueueItem.objects.filter(
            modulo=modulo,
            fase=Fase.SUPERIOR,
            status__in=ACTIVE_QUEUE_STATUSES,
        )
        .order_by("id")
        .last()
    )
    if superior_item and all(item.id != superior_item.id for item in moved_items):
        moved_items.append(superior_item)
    return moved_items
