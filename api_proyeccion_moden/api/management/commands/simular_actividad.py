"""
Simulates two-ish weeks of fabrication activity for a single user, marking
PENDIENTE modules as COMPLETADO with past `completado_at` timestamps. Goes
project-by-project in id order: finishes one project (or as many modules
as it can fit in the working-day budget) before moving on to the next.

Variability per day: a small chance of a rest day, otherwise a randint
between (max_per_day - spread, max_per_day) modules. Saturdays and Sundays
are always skipped.

Designed for the demo accounts (ferralia) where we want the dashboard
KPIs and weekly chart to look populated without touching production.

Usage:
    python manage.py simular_actividad ferralia --dry-run
    python manage.py simular_actividad ferralia --dias 14 --max-por-dia 6
"""

import random
from collections import Counter
from datetime import datetime, time, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.contrib.auth.models import User
from django.db import transaction
from django.utils import timezone

from api.models import Modulo, ModuloEstado, Proyecto


class Command(BaseCommand):
    help = (
        "Simula actividad de fabricacion para un usuario marcando modulos "
        "PENDIENTE como COMPLETADO con fechas variables en los ultimos N dias."
    )

    def add_arguments(self, parser):
        parser.add_argument('username',
                            help="Username del operario (p.ej. ferralia).")
        parser.add_argument('--dias', type=int, default=14,
                            help="Ventana hacia atras en dias naturales (default 14).")
        parser.add_argument('--max-por-dia', type=int, default=6,
                            help="Maximo de modulos por dia laborable (default 6).")
        parser.add_argument('--seed', type=int, default=42,
                            help="Semilla aleatoria para reproducibilidad (default 42).")
        parser.add_argument('--rest-day-chance', type=float, default=0.08,
                            help="Probabilidad [0..1] de un dia laborable sin actividad (default 0.08).")
        parser.add_argument('--dry-run', action='store_true',
                            help="Muestra el plan sin escribir nada.")

    def handle(self, *args, **options):
        username = options['username']
        dias = options['dias']
        max_por_dia = options['max_por_dia']
        seed = options['seed']
        rest_chance = options['rest_day_chance']
        dry_run = options['dry_run']

        rng = random.Random(seed)

        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            raise CommandError(f"Usuario '{username}' no existe.")

        proyectos = list(
            Proyecto.objects.filter(usuario=user).order_by('id')
        )
        if not proyectos:
            self.stdout.write(self.style.WARNING(
                f"El usuario {username} no tiene proyectos asignados."
            ))
            return

        # Recolectar modulos pendientes en orden: proyecto por proyecto, alfabetico.
        plan_modulos = []
        for p in proyectos:
            mods = list(
                Modulo.objects.filter(
                    proyecto=p,
                    estado=ModuloEstado.PENDIENTE,
                    cerrado=False,
                ).order_by('nombre')
            )
            plan_modulos.extend((p, m) for m in mods)

        if not plan_modulos:
            self.stdout.write(self.style.WARNING(
                "No hay modulos PENDIENTE en los proyectos del usuario."
            ))
            return

        # Construir dias laborables (lun-vie) en orden cronologico ascendente.
        today = timezone.localdate()
        oldest = today - timedelta(days=dias - 1)
        working_days = []
        d = oldest
        while d <= today:
            if d.weekday() < 5:
                working_days.append(d)
            d += timedelta(days=1)

        if not working_days:
            self.stdout.write(self.style.WARNING(
                "El rango pedido no contiene dias laborables."
            ))
            return

        # Asignar modulos a dias con variabilidad.
        spread = min(4, max_por_dia - 1)  # ej. max=6 -> rango 2..6
        plan = []  # [(proyecto, modulo, datetime)]
        idx = 0
        tz = timezone.get_current_timezone()

        for day in working_days:
            if idx >= len(plan_modulos):
                break
            if rng.random() < rest_chance:
                continue
            count = rng.randint(max(1, max_por_dia - spread), max_por_dia)
            for _ in range(count):
                if idx >= len(plan_modulos):
                    break
                proyecto, modulo = plan_modulos[idx]
                idx += 1
                hour = rng.randint(8, 16)
                minute = rng.randint(0, 59)
                dt = timezone.make_aware(
                    datetime.combine(day, time(hour, minute)), tz,
                )
                plan.append((proyecto, modulo, dt))

        # Imprimir resumen del plan.
        self.stdout.write("")
        self.stdout.write(self.style.HTTP_INFO(
            f"Usuario: {username} ({len(proyectos)} proyectos, "
            f"{len(plan_modulos)} modulos pendientes)."
        ))
        self.stdout.write(self.style.HTTP_INFO(
            f"Ventana: {oldest.isoformat()} -> {today.isoformat()} "
            f"({len(working_days)} dias laborables)."
        ))
        self.stdout.write(self.style.HTTP_INFO(
            f"Plan: {len(plan)} modulos a completar."
        ))

        per_day = Counter(dt.date() for _, _, dt in plan)
        per_proyecto = Counter(p.nombre for p, _, _ in plan)
        self.stdout.write("")
        self.stdout.write("Por dia:")
        for day in working_days:
            n = per_day.get(day, 0)
            mark = "  -" if n == 0 else f"  {n}"
            self.stdout.write(f"  {day.isoformat()} {day.strftime('%a')}: {mark}")

        self.stdout.write("")
        self.stdout.write("Por proyecto:")
        for nombre, n in per_proyecto.most_common():
            self.stdout.write(f"  {nombre}: {n}")

        if idx < len(plan_modulos):
            self.stdout.write("")
            self.stdout.write(self.style.WARNING(
                f"Quedan {len(plan_modulos) - idx} modulos pendientes "
                f"sin asignar (no caben en la ventana)."
            ))

        if dry_run:
            self.stdout.write("")
            self.stdout.write(self.style.WARNING(
                "DRY RUN — no se ha escrito nada en la base de datos."
            ))
            return

        # Aplicar.
        with transaction.atomic():
            for _, modulo, dt in plan:
                modulo.inferior_hecho = True
                modulo.superior_hecho = True
                modulo.estado = ModuloEstado.COMPLETADO
                modulo.completado_at = dt
                modulo.save(update_fields=[
                    'inferior_hecho', 'superior_hecho', 'estado', 'completado_at',
                ])

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"OK: {len(plan)} modulos marcados como COMPLETADO."
        ))
