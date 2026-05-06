"""
Reconciles the project queues with the real module state, useful after
a bulk import / simulation that marked modules as COMPLETADO directly
without going through the per-mesa flow.

Three passes, all idempotent:
  1) MesaQueueItem rows still EN_COLA or MOSTRANDO whose module phase
     is already done -> HECHO (with done_at = modulo.completado_at).
  2) GrupoMesasProyecto entries whose project no longer has any
     pending phase get deleted.
  3) Re-number `orden` per group so the head is at 0.

Usage:
    python manage.py sincronizar_estado_colas
    python manage.py sincronizar_estado_colas --usuario ferralia
    python manage.py sincronizar_estado_colas --dry-run
"""

from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from api.models import (
    Fase, GrupoMesasProyecto, MesaQueueItem, MesaQueueStatus, Proyecto,
)


class Command(BaseCommand):
    help = "Reconcilia colas y MesaQueueItem con el estado real de los modulos."

    def add_arguments(self, parser):
        parser.add_argument('--usuario', default=None,
                            help="Limita la limpieza a proyectos del usuario indicado.")
        parser.add_argument('--dry-run', action='store_true',
                            help="Muestra los cambios sin aplicarlos.")

    def handle(self, *args, **options):
        username = options['usuario']
        dry_run = options['dry_run']

        proyecto_filter = Q()
        if username:
            try:
                user = User.objects.get(username=username)
            except User.DoesNotExist:
                self.stdout.write(self.style.ERROR(
                    f"Usuario '{username}' no existe."
                ))
                return
            proyecto_filter = Q(usuario=user)

        proyectos_scope = Proyecto.objects.filter(proyecto_filter)
        proyectos_ids = list(proyectos_scope.values_list('id', flat=True))

        # Pass 1: close MesaQueueItem rows whose phase is already done.
        items_qs = MesaQueueItem.objects.filter(
            status__in=[MesaQueueStatus.EN_COLA, MesaQueueStatus.MOSTRANDO],
            modulo__proyecto_id__in=proyectos_ids,
        ).select_related('modulo')
        items_to_close = []
        for item in items_qs:
            fase_done = (
                item.modulo.inferior_hecho if item.fase == Fase.INFERIOR
                else item.modulo.superior_hecho
            )
            if fase_done:
                items_to_close.append(item)

        # Pass 2: drop GrupoMesasProyecto for projects with no pending phase.
        cola_qs = GrupoMesasProyecto.objects.filter(
            proyecto_id__in=proyectos_ids,
        ).select_related('proyecto')
        cola_to_drop = []
        for entry in cola_qs:
            has_pending = entry.proyecto.modulos.filter(
                cerrado=False,
            ).filter(
                Q(inferior_hecho=False) | Q(superior_hecho=False),
            ).exists()
            if not has_pending:
                cola_to_drop.append(entry)

        self.stdout.write("")
        self.stdout.write(self.style.HTTP_INFO(
            f"Proyectos en alcance: {len(proyectos_ids)}"
            + (f" (usuario={username})" if username else "")
        ))
        self.stdout.write(f"  MesaQueueItem a cerrar: {len(items_to_close)}")
        self.stdout.write(f"  GrupoMesasProyecto a borrar: {len(cola_to_drop)}")
        for entry in cola_to_drop:
            self.stdout.write(
                f"    · grupo {entry.grupo_mesas_id} - "
                f"proyecto {entry.proyecto.nombre}"
            )

        if dry_run:
            self.stdout.write("")
            self.stdout.write(self.style.WARNING(
                "DRY RUN — no se ha escrito nada."
            ))
            return

        affected_grupo_ids = set()
        with transaction.atomic():
            for item in items_to_close:
                item.status = MesaQueueStatus.HECHO
                item.done_at = item.modulo.completado_at or timezone.now()
                item.save(update_fields=['status', 'done_at'])

            for entry in cola_to_drop:
                affected_grupo_ids.add(entry.grupo_mesas_id)
                entry.delete()

            # Pass 3: renumber orden per affected group so the head sits at 0.
            for gid in affected_grupo_ids:
                for index, entry in enumerate(
                    GrupoMesasProyecto.objects
                    .filter(grupo_mesas_id=gid)
                    .order_by('orden', 'id')
                ):
                    if entry.orden != index:
                        entry.orden = index
                        entry.save(update_fields=['orden'])

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"OK: {len(items_to_close)} items cerrados, "
            f"{len(cola_to_drop)} entradas de cola borradas, "
            f"{len(affected_grupo_ids)} grupos renumerados."
        ))
