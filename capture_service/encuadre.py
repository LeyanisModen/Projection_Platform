"""
Framing of the OBSBOT (pan / tilt / zoom) through DirectShow.

capture_service.py runs this as a separate process, after releasing its own
camera handle and with a timeout: if the driver hangs, this process is killed
and the service carries on taking photos.

Only DirectShow is used. Through Media Foundation (the backend the service
uses for photos) the OBSBOT always reports 0 and a "set" drives the gimbal to
that absolute value, so restoring a value read from it sends the camera to its
factory position. DirectShow reads the real position and goes back to it
(tested on a factory mini-PC on 2026-11-11).

    python encuadre.py leer|guardar|comprobar <camera_index> <referencia.json>

Prints a single JSON line with the result:
    leer       -> {"resultado": "leida", "posicion": {...}}
    guardar    -> {"resultado": "guardada", "posicion": {...}}
    comprobar  -> "ok" | "corregida" | "no_vuelve" | "sin_referencia"
Errors: "no_abre" (camera busy or missing), "sin_control" (the camera does
not expose pan/tilt/zoom), "error".
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2

# Zoom first: it changes the field of view the gimbal position is judged in.
AXES = (
    ('zoom', cv2.CAP_PROP_ZOOM),
    ('pan', cv2.CAP_PROP_PAN),
    ('tilt', cv2.CAP_PROP_TILT),
)
# DirectShow reports whole degrees for pan/tilt and whole steps for zoom.
TOLERANCE = 1.0
MAX_WAIT_SECONDS = 8.0
# The value can read as reached before the gimbal has physically stopped.
SETTLE_SECONDS = 2.0


def read_position(cap):
    return {axis: float(cap.get(prop)) for axis, prop in AXES}


def axes_off(position, reference):
    return [
        axis for axis, _ in AXES
        if abs(position[axis] - reference[axis]) > TOLERANCE
    ]


def load_reference(path: Path):
    data = json.loads(path.read_text(encoding='utf-8'))
    return {axis: float(data[axis]) for axis, _ in AXES}


def save_reference(path: Path, position):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = dict(position)
    data['guardada'] = datetime.now().isoformat(timespec='seconds')
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data), encoding='utf-8')
    tmp.replace(path)


def run(mode, camera_index, reference_path: Path,
        open_camera=None, sleep=time.sleep, monotonic=time.monotonic):
    if mode not in ('leer', 'guardar', 'comprobar'):
        return {'resultado': 'error', 'detalle': f'modo desconocido: {mode}'}
    reference = None
    if mode == 'comprobar':
        if not reference_path.is_file():
            return {'resultado': 'sin_referencia'}
        reference = load_reference(reference_path)

    open_camera = open_camera or (
        lambda index: cv2.VideoCapture(index, cv2.CAP_DSHOW)
    )
    cap = open_camera(camera_index)
    if not cap.isOpened():
        return {'resultado': 'no_abre'}
    try:
        current = read_position(cap)
        if all(value == -1 for value in current.values()):
            return {'resultado': 'sin_control', 'posicion': current}

        if mode == 'leer':
            return {'resultado': 'leida', 'posicion': current}

        if mode == 'guardar':
            # A framing set by hand in the OBSBOT app sits between whole
            # degrees, and a correction can only send the camera to whole
            # degrees (it came back ~0.5 deg off, 21 of image difference, in
            # the 2026-11-11 test). So the camera is moved to the whole
            # degrees it reports and that commanded position is the one kept:
            # every later return lands where the reference photo is taken.
            target = {axis: float(round(value)) for axis, value in current.items()}
            for axis, prop in AXES:
                cap.set(prop, target[axis])
            sleep(SETTLE_SECONDS)
            save_reference(reference_path, target)
            result = {'resultado': 'guardada', 'posicion': target}
            if target != current:
                result['antes_de_ajustar'] = current
            if all(value == 0 for value in target.values()):
                # Pan, tilt and zoom at 0 is the factory position (camera
                # looking straight ahead), never the view of a table.
                result['aviso'] = 'posicion de fabrica (0, 0, 0)'
            return result

        off = axes_off(current, reference)
        if not off:
            return {'resultado': 'ok', 'posicion': current}

        for axis, prop in AXES:
            if axis in off:
                cap.set(prop, reference[axis])
        deadline = monotonic() + MAX_WAIT_SECONDS
        after = read_position(cap)
        while axes_off(after, reference) and monotonic() < deadline:
            sleep(0.25)
            after = read_position(cap)
        sleep(SETTLE_SECONDS)
        after = read_position(cap)
        return {
            'resultado': 'no_vuelve' if axes_off(after, reference) else 'corregida',
            'antes': current,
            'despues': after,
            'referencia': reference,
        }
    finally:
        cap.release()


def main(argv):
    if len(argv) != 4:
        return {'resultado': 'error', 'detalle': 'uso: encuadre.py modo indice referencia.json'}
    try:
        return run(argv[1], int(argv[2]), Path(argv[3]))
    except Exception as exc:
        return {'resultado': 'error', 'detalle': f'{type(exc).__name__}: {exc}'}


if __name__ == '__main__':
    print(json.dumps(main(sys.argv)), flush=True)
