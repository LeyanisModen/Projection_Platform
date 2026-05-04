from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from datetime import date, time
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
from PySide6.QtCore import QObject, QRunnable, Signal, Slot


DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^(\d{2})-(\d{2})-(\d{2})\.(jpg|jpeg)$", re.IGNORECASE)


def ffmpeg_path() -> Optional[str]:
    """Resuelve la ruta a un binario ffmpeg ejecutable.

    Prioriza el binario empaquetado por imageio-ffmpeg (parte de
    requirements.txt) y como último recurso usa el ffmpeg de PATH si lo hay.
    Devuelve None si no hay ninguno disponible.
    """
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path:
            return path
    except Exception:
        pass
    return shutil.which("ffmpeg")


def ffmpeg_available() -> bool:
    return ffmpeg_path() is not None


def _parse_time(name: str) -> Optional[time]:
    m = TIME_RE.match(name)
    if not m:
        return None
    h, mm, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return time(h, mm, s)
    except ValueError:
        return None


def _parse_day(name: str) -> Optional[date]:
    if not DAY_RE.match(name):
        return None
    try:
        y, m, d = name.split("-")
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def enumerate_images(
    folder: Path,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    time_from: Optional[time] = None,
    time_to: Optional[time] = None,
) -> List[Path]:
    folder = Path(folder)
    if not folder.is_dir():
        return []

    day_subfolders = [
        p for p in folder.iterdir() if p.is_dir() and _parse_day(p.name) is not None
    ]

    candidates: List[Tuple[Optional[date], Optional[time], Path]] = []

    if day_subfolders:
        for day_dir in day_subfolders:
            d = _parse_day(day_dir.name)
            if date_from and d and d < date_from:
                continue
            if date_to and d and d > date_to:
                continue
            for f in day_dir.iterdir():
                if not f.is_file():
                    continue
                t = _parse_time(f.name)
                if time_from and t and t < time_from:
                    continue
                if time_to and t and t > time_to:
                    continue
                if f.suffix.lower() in (".jpg", ".jpeg"):
                    candidates.append((d, t, f))
    else:
        for f in folder.iterdir():
            if not f.is_file():
                continue
            if f.suffix.lower() not in (".jpg", ".jpeg"):
                continue
            t = _parse_time(f.name)
            if time_from and t and t < time_from:
                continue
            if time_to and t and t > time_to:
                continue
            candidates.append((None, t, f))

    candidates.sort(key=lambda x: (x[0] or date.min, x[1] or time.min, x[2].name))
    return [path for _, _, path in candidates]


class TimelapseSignals(QObject):
    progress = Signal(int, int)     # done, total
    log = Signal(str)
    finished = Signal(bool, str)    # ok, message


class TimelapseRunner(QRunnable):
    def __init__(
        self,
        images: List[Path],
        output_path: Path,
        fps: int,
        width: Optional[int],
        prefer_ffmpeg: bool = True,
    ) -> None:
        super().__init__()
        self.images = list(images)
        self.output_path = Path(output_path)
        self.fps = max(1, int(fps))
        self.width = width if width and width > 0 else None
        self.prefer_ffmpeg = prefer_ffmpeg
        self.signals = TimelapseSignals()
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @Slot()
    def run(self) -> None:
        if not self.images:
            self.signals.finished.emit(False, "No hay imágenes que procesar")
            return

        try:
            ffmpeg = ffmpeg_path() if self.prefer_ffmpeg else None
            if ffmpeg:
                self._run_ffmpeg(ffmpeg)
            else:
                if self.prefer_ffmpeg:
                    self.signals.log.emit(
                        "ffmpeg no disponible — usando fallback OpenCV"
                    )
                self._run_opencv()
        except Exception as exc:
            self.signals.finished.emit(False, f"Error: {exc}")

    def _target_size(self, sample: Path) -> Tuple[int, int]:
        img = cv2.imread(str(sample))
        if img is None:
            raise ValueError(f"No se pudo leer {sample}")
        h, w = img.shape[:2]
        if self.width is None:
            return (w - (w % 2), h - (h % 2))
        new_w = self.width - (self.width % 2)
        new_h = int(round(h * (new_w / w)))
        new_h -= new_h % 2
        return (new_w, new_h)

    def _run_opencv(self) -> None:
        out_w, out_h = self._target_size(self.images[0])
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(self.output_path), fourcc, self.fps, (out_w, out_h))
        if not writer.isOpened():
            raise RuntimeError("cv2.VideoWriter no pudo abrir el archivo de salida")

        total = len(self.images)
        try:
            for i, p in enumerate(self.images, start=1):
                if self._cancelled:
                    break
                img = cv2.imread(str(p))
                if img is None:
                    self.signals.log.emit(f"Saltado (no leíble): {p.name}")
                    continue
                if (img.shape[1], img.shape[0]) != (out_w, out_h):
                    img = cv2.resize(img, (out_w, out_h), interpolation=cv2.INTER_AREA)
                writer.write(img)
                self.signals.progress.emit(i, total)
        finally:
            writer.release()

        if self._cancelled:
            self.signals.finished.emit(False, "Cancelado")
        else:
            self.signals.finished.emit(True, f"Generado {self.output_path}")

    def _run_ffmpeg(self, ffmpeg_exe: str) -> None:
        out_w, out_h = self._target_size(self.images[0])

        def escape(p: Path) -> str:
            return str(p).replace("'", r"'\''")

        with tempfile.TemporaryDirectory(prefix="timelapse_") as tmp:
            list_file = Path(tmp) / "files.txt"
            with list_file.open("w", encoding="utf-8") as fh:
                for p in self.images:
                    fh.write(f"file '{escape(p)}'\n")
                    fh.write(f"duration {1.0 / self.fps:.6f}\n")
                fh.write(f"file '{escape(self.images[-1])}'\n")

            cmd = [
                ffmpeg_exe,
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", str(list_file),
                "-vf", f"scale={out_w}:{out_h}:flags=lanczos,fps={self.fps}",
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                str(self.output_path),
            ]
            self.signals.log.emit("Ejecutando ffmpeg…")
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                tail = "\n".join(proc.stderr.splitlines()[-12:])
                raise RuntimeError(f"ffmpeg falló:\n{tail}")

        self.signals.progress.emit(len(self.images), len(self.images))
        self.signals.finished.emit(True, f"Generado {self.output_path}")
