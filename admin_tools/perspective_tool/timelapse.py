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
        show_timestamp: bool = False,
    ) -> None:
        super().__init__()
        self.images = list(images)
        self.output_path = Path(output_path)
        self.fps = max(1, int(fps))
        self.width = width if width and width > 0 else None
        self.prefer_ffmpeg = prefer_ffmpeg
        self.show_timestamp = bool(show_timestamp)
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

    def _timestamp_label(self, image_path: Path) -> str:
        t = _parse_time(image_path.name)
        if t is None:
            return ""
        return f"{t.hour:02d}:{t.minute:02d}:{t.second:02d}"

    @staticmethod
    def _draw_timestamp(frame, label: str):
        if not label:
            return frame

        h, w = frame.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = max(0.65, min(2.0, w / 1200.0))
        thickness = max(1, int(round(scale * 2)))
        margin = max(14, int(round(w * 0.018)))
        pad_x = max(12, int(round(w * 0.014)))
        pad_y = max(8, int(round(w * 0.009)))

        (text_w, text_h), baseline = cv2.getTextSize(label, font, scale, thickness)
        x1 = margin
        y2 = h - margin
        x2 = min(w - margin, x1 + text_w + pad_x * 2)
        y1 = max(margin, y2 - text_h - baseline - pad_y * 2)

        overlay = frame.copy()
        cv2.rectangle(overlay, (x1, y1), (x2, y2), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.58, frame, 0.42, 0, frame)
        cv2.putText(
            frame,
            label,
            (x1 + pad_x, y2 - pad_y - baseline),
            font,
            scale,
            (255, 255, 255),
            thickness,
            cv2.LINE_AA,
        )
        return frame

    def _read_frame(self, image_path: Path, out_w: int, out_h: int):
        img = cv2.imread(str(image_path))
        if img is None:
            return None
        if (img.shape[1], img.shape[0]) != (out_w, out_h):
            img = cv2.resize(img, (out_w, out_h), interpolation=cv2.INTER_AREA)
        if self.show_timestamp:
            img = self._draw_timestamp(img, self._timestamp_label(image_path))
        return img

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
                img = self._read_frame(p, out_w, out_h)
                if img is None:
                    self.signals.log.emit(f"Saltado (no leíble): {p.name}")
                    continue
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
            ffmpeg_images = self.images
            if self.show_timestamp:
                self.signals.log.emit("Preparando frames con hora visible...")
                prepared_dir = Path(tmp) / "frames"
                prepared_dir.mkdir()
                ffmpeg_images = []
                total = len(self.images)
                for i, p in enumerate(self.images, start=1):
                    if self._cancelled:
                        self.signals.finished.emit(False, "Cancelado")
                        return
                    img = self._read_frame(p, out_w, out_h)
                    if img is None:
                        self.signals.log.emit(f"Saltado (no legible): {p.name}")
                        continue
                    out_frame = prepared_dir / f"frame_{i:06d}.jpg"
                    cv2.imwrite(str(out_frame), img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                    ffmpeg_images.append(out_frame)
                    self.signals.progress.emit(i, total)
                if not ffmpeg_images:
                    raise RuntimeError("No se pudo preparar ningun frame legible")

            list_file = Path(tmp) / "files.txt"
            with list_file.open("w", encoding="utf-8") as fh:
                for p in ffmpeg_images:
                    fh.write(f"file '{escape(p)}'\n")
                    fh.write(f"duration {1.0 / self.fps:.6f}\n")
                fh.write(f"file '{escape(ffmpeg_images[-1])}'\n")

            vf = (
                f"fps={self.fps}"
                if self.show_timestamp
                else f"scale={out_w}:{out_h}:flags=lanczos,fps={self.fps}"
            )
            cmd = [
                ffmpeg_exe,
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", str(list_file),
                "-vf", vf,
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
