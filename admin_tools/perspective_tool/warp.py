from __future__ import annotations

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List

import cv2
import numpy as np
from PySide6.QtCore import QObject, QRunnable, Signal, Slot

from calibration_io import Calibration


JPEG_QUALITY = 88
DAY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def default_worker_count() -> int:
    return min(os.cpu_count() or 1, 8)


def _scaled_corners(calib: Calibration, img_w: int, img_h: int) -> np.ndarray:
    src_w, src_h = calib.source_size
    sx = img_w / src_w if src_w else 1.0
    sy = img_h / src_h if src_h else 1.0
    pts = []
    for x, y in calib.as_points():
        pts.append([x * sx, y * sy])
    return np.array(pts, dtype=np.float32)


def apply_warp(image: np.ndarray, calib: Calibration) -> np.ndarray:
    h, w = image.shape[:2]
    src = _scaled_corners(calib, w, h)
    out_w, out_h = calib.output_size
    dst = np.array(
        [[0, 0], [out_w - 1, 0], [0, out_h - 1], [out_w - 1, out_h - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(image, matrix, (out_w, out_h), flags=cv2.INTER_LINEAR)


def list_jpgs(folder: Path) -> List[Path]:
    exts = {".jpg", ".jpeg", ".JPG", ".JPEG"}
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix in exts)


def sibling_output_dir(input_dir: Path) -> Path:
    """Decide dónde van las imágenes rectificadas.

    - Si la carpeta de entrada se llama como un día (YYYY-MM-DD), asumimos
      la jerarquía típica `<mesa>/<dia>/` y devolvemos `<mesa>_rect/<dia>/`.
      Así todas las rectificadas de una mesa caen agrupadas bajo una misma
      carpeta padre, lo que permite filtrar por rango de fechas en la
      pestaña Timelapse.
    - En cualquier otro caso (carpeta sin formato de fecha), caemos al
      comportamiento simple: `<carpeta>_rect/` hermana de la entrada.
    """
    input_dir = Path(input_dir)
    if DAY_DIR_RE.match(input_dir.name):
        mesa_dir = input_dir.parent
        return mesa_dir.parent / (mesa_dir.name + "_rect") / input_dir.name
    return input_dir.parent / (input_dir.name + "_rect")


class BatchSignals(QObject):
    progress = Signal(int, int)         # done, total
    log = Signal(str)
    finished = Signal(int, int, int)    # ok, skipped, errors


class BatchWarpRunner(QRunnable):
    def __init__(
        self,
        input_dir: Path,
        output_dir: Path,
        calib: Calibration,
        workers: int = 0,
    ) -> None:
        super().__init__()
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.calib = calib
        self.workers = workers if workers > 0 else default_worker_count()
        self.signals = BatchSignals()
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def _process_one(self, src_path: Path) -> str:
        if self._cancelled:
            return "skipped"
        dst_path = self.output_dir / src_path.name
        if dst_path.exists():
            return "skipped"
        try:
            img = cv2.imread(str(src_path))
            if img is None:
                raise ValueError("no se pudo leer (¿archivo corrupto?)")
            rectified = apply_warp(img, self.calib)
            cv2.imwrite(
                str(dst_path),
                rectified,
                [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
            )
            return "ok"
        except Exception as exc:
            self.signals.log.emit(f"  ⚠ {src_path.name}: {exc}")
            return "error"

    @Slot()
    def run(self) -> None:
        files = list_jpgs(self.input_dir)
        total = len(files)
        if total == 0:
            self.signals.log.emit(f"No hay imágenes JPG en {self.input_dir}")
            self.signals.finished.emit(0, 0, 0)
            return

        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.signals.log.emit(
            f"Procesando {total} imágenes con {self.workers} hilos en paralelo…"
        )
        self.signals.log.emit(f"Salida: {self.output_dir}")

        ok = skipped = errors = 0
        done = 0
        log_step = max(1, min(total // 20, 50))
        last_logged = 0
        t_start = time.monotonic()

        pool = ThreadPoolExecutor(max_workers=self.workers)
        try:
            futures = [pool.submit(self._process_one, f) for f in files]
            for fut in as_completed(futures):
                try:
                    result = fut.result()
                except Exception as exc:
                    errors += 1
                    self.signals.log.emit(f"  ⚠ error inesperado: {exc}")
                    result = "error"

                if result == "ok":
                    ok += 1
                elif result == "skipped":
                    skipped += 1
                elif result == "error":
                    errors += 1

                done += 1
                self.signals.progress.emit(done, total)

                if (done - last_logged) >= log_step or done == total:
                    pct = int(done * 100 / total)
                    elapsed = time.monotonic() - t_start
                    rate = done / elapsed if elapsed > 0 else 0.0
                    eta_s = int((total - done) / rate) if rate > 0 else 0
                    eta_txt = (
                        f", ~{eta_s // 60}m{eta_s % 60:02d}s restantes"
                        if eta_s and done < total
                        else ""
                    )
                    self.signals.log.emit(
                        f"Procesadas {done} de {total} ({pct}%){eta_txt}"
                    )
                    last_logged = done

                if self._cancelled:
                    break
        finally:
            pool.shutdown(wait=not self._cancelled, cancel_futures=self._cancelled)

        elapsed = time.monotonic() - t_start
        if self._cancelled:
            self.signals.log.emit(
                f"Cancelado tras procesar {done} de {total} en {elapsed:.1f}s"
            )
        else:
            self.signals.log.emit(
                f"Listo en {elapsed:.1f}s — "
                f"{ok} corregidas, {skipped} saltadas (ya existían), {errors} con errores"
            )

        self.signals.finished.emit(ok, skipped, errors)
