from django.core.management.base import BaseCommand, CommandError

from api.models import Fase, GrupoMesas, MesaQueueItem, MesaQueueStatus, Proyecto
from api.queue_sync import reconcile_superior_queue_for_group


ACTIVE_STATUSES = [MesaQueueStatus.MOSTRANDO, MesaQueueStatus.EN_COLA]


class Command(BaseCommand):
    help = "Reconcilia la cola superior de los grupos que fabrican un proyecto."

    def add_arguments(self, parser):
        parser.add_argument(
            "--project",
            required=True,
            help="Nombre exacto del proyecto que se quiere reconciliar.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Muestra el alcance y el orden actual sin aplicar cambios.",
        )

    def _superior_order(self, group, project):
        return list(
            MesaQueueItem.objects.filter(
                mesa__grupo=group,
                modulo__proyecto=project,
                fase=Fase.SUPERIOR,
                status__in=ACTIVE_STATUSES,
            )
            .select_related("mesa", "modulo")
            .order_by("mesa__indice", "position", "id")
            .values_list(
                "mesa__nombre",
                "modulo__nombre",
                "status",
                "position",
                "mesa__current_image_index",
            )
        )

    def _write_order(self, label, order):
        self.stdout.write(label)
        for mesa, modulo, status, position, image_index in order:
            self.stdout.write(
                f"  {mesa}: {position} - {modulo} - {status} "
                f"(imagen={image_index})"
            )

    def handle(self, *args, **options):
        project_name = options["project"]
        try:
            project = Proyecto.objects.get(nombre__iexact=project_name)
        except Proyecto.DoesNotExist as exc:
            raise CommandError(f"No existe el proyecto '{project_name}'.") from exc
        except Proyecto.MultipleObjectsReturned as exc:
            raise CommandError(
                f"Hay varios proyectos llamados '{project_name}'; usa un nombre unico."
            ) from exc

        groups = list(
            GrupoMesas.objects.filter(
                mesas__queue_items__modulo__proyecto=project,
                mesas__queue_items__status__in=ACTIVE_STATUSES,
            )
            .distinct()
            .order_by("id")
        )
        if not groups:
            raise CommandError(
                f"El proyecto '{project.nombre}' no tiene colas activas."
            )

        for group in groups:
            before = self._superior_order(group, project)
            self.stdout.write(self.style.HTTP_INFO(f"Grupo {group.id}: {group.nombre}"))
            self._write_order("Antes:", before)
            if options["dry_run"]:
                continue

            reconcile_superior_queue_for_group(group)
            self._write_order("Despues:", self._superior_order(group, project))

        if options["dry_run"]:
            self.stdout.write(self.style.WARNING("DRY RUN: no se aplicaron cambios."))
        else:
            self.stdout.write(self.style.SUCCESS("Cola superior reconciliada."))
