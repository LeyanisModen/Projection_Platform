"""
Backfills ``completado_at`` on a batch of PENDIENTE modules of a project,
spread across the last N working days. Designed for filling the stats
dashboard with realistic-looking data during testing/demo.

Usage:
    python manage.py seed_completed_modules --project ANDOAIN_P1 --per-day 5 --days 8

The command is idempotent in the sense that re-running it will keep
picking from whatever remains PENDIENTE; already-completed modules are
never touched.
"""

import random
from datetime import datetime, time, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from api.models import Modulo, ModuloEstado, Proyecto


class Command(BaseCommand):
    help = "Mark N pendiente modules of a project as COMPLETADO with past completado_at."

    def add_arguments(self, parser):
        parser.add_argument('--project', required=True,
                            help='Nombre exacto del proyecto (p.ej. ANDOAIN_P1).')
        parser.add_argument('--per-day', type=int, default=5,
                            help='Modulos a completar por dia laborable (default 5).')
        parser.add_argument('--days', type=int, default=8,
                            help='Cantidad de dias laborables hacia atras a rellenar (default 8).')
        parser.add_argument('--skip-today', action='store_true',
                            help='Si se pasa, omite hoy del reparto (por defecto hoy SI se incluye).')

    def handle(self, *args, **options):
        project_name = options['project']
        per_day = options['per_day']
        days = options['days']
        skip_today = options['skip_today']

        try:
            proyecto = Proyecto.objects.get(nombre=project_name)
        except Proyecto.DoesNotExist:
            raise CommandError(f"No existe el proyecto '{project_name}'.")

        # Only truly pending modules; skip anything already in progress or done.
        pending = list(
            Modulo.objects.filter(
                proyecto=proyecto,
                estado=ModuloEstado.PENDIENTE,
                cerrado=False,
            )
        )
        random.shuffle(pending)

        # Build the list of working days, newest first so iteration fills
        # today first and older days only if there are modules left.
        today = timezone.localdate()
        working_days = []
        cursor = today - timedelta(days=1) if skip_today else today
        while len(working_days) < days:
            if cursor.weekday() < 5:  # 0=Mon .. 4=Fri
                working_days.append(cursor)
            cursor = cursor - timedelta(days=1)

        tz = timezone.get_current_timezone()
        total_target = per_day * len(working_days)
        if total_target > len(pending):
            self.stdout.write(self.style.WARNING(
                f"Solo hay {len(pending)} modulos PENDIENTE disponibles; se pedian {total_target}."
            ))

        idx = 0
        completed_by_day = {}
        for day in working_days:
            for _ in range(per_day):
                if idx >= len(pending):
                    break
                m = pending[idx]
                idx += 1
                hour = random.randint(8, 16)
                minute = random.randint(0, 59)
                dt = timezone.make_aware(
                    datetime.combine(day, time(hour, minute)), tz,
                )
                m.inferior_hecho = True
                m.superior_hecho = True
                m.estado = ModuloEstado.COMPLETADO
                m.completado_at = dt
                m.save(update_fields=[
                    'inferior_hecho', 'superior_hecho', 'estado', 'completado_at',
                ])
                completed_by_day[day.isoformat()] = completed_by_day.get(day.isoformat(), 0) + 1

        self.stdout.write(self.style.SUCCESS(
            f"Marcados {idx} modulos de '{project_name}' como COMPLETADO."
        ))
        for iso_day in sorted(completed_by_day):
            self.stdout.write(f"  {iso_day}: {completed_by_day[iso_day]}")
