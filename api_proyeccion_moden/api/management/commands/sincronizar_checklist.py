"""Empuja la lista de control maestra a todos los proyectos.

Uso: python manage.py sincronizar_checklist

Hace lo mismo que editar cada paso de la lista maestra: crea las copias que
falten y alinea titulo, orden, marcas, plazo, bloqueo y requisitos en las que
existen. Pensado para ejecutarlo una vez tras la migracion 0060 (que enlaza
las copias antiguas por titulo pero no las actualiza).
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import ProyectoCheckDefinicion
from api.office import propagar_definicion


class Command(BaseCommand):
    help = 'Alinea la lista de control de todos los proyectos con la lista maestra.'

    @transaction.atomic
    def handle(self, *args, **options):
        definiciones = list(ProyectoCheckDefinicion.objects.all())
        for definicion in definiciones:
            propagar_definicion(definicion)
        self.stdout.write(f'{len(definiciones)} paso(s) de la lista maestra propagados a todos los proyectos.')
