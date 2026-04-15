from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import (
    DetalleModuloFase,
    FotoFabricacion,
    GrupoMesas,
    Imagen,
    Mesa,
    MesaQueueItem,
    Modulo,
    ModuloQueue,
    ModuloQueueItem,
    PairingSession,
    Planta,
    Proyecto,
)


class Command(BaseCommand):
    help = (
        "Borra datos operativos y de proyectos preservando usuarios, perfiles y tokens. "
        "Elimina proyectos, grupos, mesas, colas, imagenes y sesiones de emparejamiento."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--noinput",
            action="store_true",
            help="Ejecuta sin pedir confirmacion interactiva.",
        )

    def handle(self, *args, **options):
        if not options["noinput"]:
            self.stdout.write(self.style.WARNING(
                "Se van a borrar proyectos, grupos, mesas, colas, imagenes y datos operativos."
            ))
            self.stdout.write("Los usuarios y accesos se conservaran.")
            confirmation = input("Escribe RESET para continuar: ").strip()
            if confirmation != "RESET":
                self.stdout.write(self.style.ERROR("Operacion cancelada."))
                return

        with transaction.atomic():
            counts = {
                "pairing_sessions": PairingSession.objects.count(),
                "mesa_queue_items": MesaQueueItem.objects.count(),
                "modulo_queue_items": ModuloQueueItem.objects.count(),
                "modulo_queues": ModuloQueue.objects.count(),
                "foto_fabricacion": FotoFabricacion.objects.count(),
                "imagenes": Imagen.objects.count(),
                "detalles_fase": DetalleModuloFase.objects.count(),
                "modulos": Modulo.objects.count(),
                "plantas": Planta.objects.count(),
                "proyectos": Proyecto.objects.count(),
                "mesas": Mesa.objects.count(),
                "grupos_mesas": GrupoMesas.objects.count(),
            }

            PairingSession.objects.all().delete()
            MesaQueueItem.objects.all().delete()
            ModuloQueueItem.objects.all().delete()
            ModuloQueue.objects.all().delete()
            FotoFabricacion.objects.all().delete()
            Imagen.objects.all().delete()
            DetalleModuloFase.objects.all().delete()
            Modulo.objects.all().delete()
            Planta.objects.all().delete()
            Proyecto.objects.all().delete()
            Mesa.objects.all().delete()
            GrupoMesas.objects.all().delete()

        self.stdout.write(self.style.SUCCESS("Datos operativos borrados correctamente."))
        for key, value in counts.items():
            self.stdout.write(f"- {key}: {value}")
