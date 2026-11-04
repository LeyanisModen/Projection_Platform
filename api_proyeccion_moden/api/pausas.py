"""Pausas de mesa que pone Moden desde el admin (ver models.PausaMesa).

Una mesa en pausa sigue con su cola, pero el player tapa la proyeccion con
"Mesa en pausa" y el servidor no la deja avanzar: ni la botonera, ni el
visor del supervisor, ni el dashboard de la ferralla.
"""
from datetime import datetime, timedelta

from django.db.models import Q
from django.utils import timezone

from .models import PausaMesa, PausaMesaTipo


def _hora_local(momento):
    return timezone.localtime(momento).isoformat() if momento else None


def _fin_de_ventana(pausa, local):
    """Fin de la ventana diaria en la que cae ``local``; None si no cae en ninguna."""
    desde, hasta, hora = pausa.hora_desde, pausa.hora_hasta, local.time()
    if desde is None or hasta is None or desde == hasta:
        return None
    if desde < hasta:
        if not desde <= hora < hasta:
            return None
        dia = local.date()
    elif hora >= desde:
        # Cruza la medianoche: acaba manana.
        dia = local.date() + timedelta(days=1)
    elif hora < hasta:
        dia = local.date()
    else:
        return None
    return timezone.make_aware(datetime.combine(dia, hasta))


def fin_si_activa(pausa, ahora):
    """(activa, hasta): hasta es cuando acaba si esta activa, None si no tiene fin."""
    if pausa.inicio > ahora or (pausa.fin is not None and pausa.fin <= ahora):
        return False, None
    if pausa.tipo != PausaMesaTipo.DIARIA:
        return True, pausa.fin
    fin = _fin_de_ventana(pausa, timezone.localtime(ahora))
    if fin is None:
        return False, None
    return True, min(fin, pausa.fin) if pausa.fin else fin


def vigentes(mesas, ahora=None):
    """Las pausas que aun no han acabado: las activas y las programadas."""
    ahora = ahora or timezone.now()
    return PausaMesa.objects.filter(mesa__in=mesas).filter(Q(fin__isnull=True) | Q(fin__gt=ahora))


def pausa_activa(mesa, ahora=None):
    """{'motivo', 'hasta'} si la mesa esta en pausa ahora; None si no.

    Con varias a la vez, la que acaba mas tarde (sin fin, la que manda).
    """
    ahora = ahora or timezone.now()
    activas = []
    for pausa in vigentes([mesa], ahora):
        activa, hasta = fin_si_activa(pausa, ahora)
        if activa:
            activas.append((pausa, hasta))
    if not activas:
        return None
    pausa, hasta = max(activas, key=lambda par: (par[1] is None, par[1] or ahora))
    return {'id': pausa.id, 'motivo': pausa.motivo, 'hasta': _hora_local(hasta)}


def resumen(pausa, ahora=None):
    ahora = ahora or timezone.now()
    activa, _ = fin_si_activa(pausa, ahora)
    return {
        'id': pausa.id, 'mesa': pausa.mesa_id, 'tipo': pausa.tipo, 'motivo': pausa.motivo,
        'inicio': _hora_local(pausa.inicio), 'fin': _hora_local(pausa.fin),
        'hora_desde': pausa.hora_desde.strftime('%H:%M') if pausa.hora_desde else None,
        'hora_hasta': pausa.hora_hasta.strftime('%H:%M') if pausa.hora_hasta else None,
        'activa': activa,
    }
