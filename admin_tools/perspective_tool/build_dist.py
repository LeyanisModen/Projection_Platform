"""Empaqueta Perspective Tool como un .exe distribuible (modo onedir).

Uso:

    cd admin_tools/perspective_tool
    .venv\\Scripts\\activate
    pip install -r requirements-dev.txt
    python build_dist.py

Resultado: una carpeta dist/PerspectiveTool/ con PerspectiveTool.exe dentro.
Para distribuir: comprimirla en un .zip y mandárselo al destinatario.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
NAME = "PerspectiveTool"
ENTRY = HERE / "main.py"
ICON = HERE / "assets" / "icon.ico"
ASSETS = HERE / "assets"
DIST = HERE / "dist"
BUILD = HERE / "build"
SPEC = HERE / f"{NAME}.spec"


def _prewarm_ffmpeg() -> None:
    """Fuerza la descarga del binario de ffmpeg antes del build, para que
    PyInstaller lo recoja con --collect-all imageio_ffmpeg."""
    try:
        import imageio_ffmpeg

        ff = imageio_ffmpeg.get_ffmpeg_exe()
        print(f"[ok] ffmpeg listo en: {ff}")
    except Exception as exc:
        print(f"[warn] no se pudo preparar imageio-ffmpeg: {exc}")


def _clean() -> None:
    for p in (DIST, BUILD):
        if p.exists():
            print(f"[clean] borrando {p}")
            shutil.rmtree(p)
    if SPEC.exists():
        print(f"[clean] borrando {SPEC}")
        SPEC.unlink()


def main() -> None:
    if not ENTRY.exists():
        raise SystemExit(f"No encuentro main.py en {ENTRY}")
    if not ICON.exists():
        raise SystemExit(
            f"Falta {ICON}. Ejecuta primero: python assets/build_icon.py"
        )

    _prewarm_ffmpeg()
    _clean()

    sep = os.pathsep  # ';' en Windows, ':' en Linux/macOS

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name", NAME,
        "--windowed",                                  # sin consola negra de fondo
        "--icon", str(ICON),
        "--add-data", f"{ASSETS}{sep}assets",          # icon.ico accesible en runtime
        "--collect-all", "imageio_ffmpeg",             # binario de ffmpeg incluido
        str(ENTRY),
    ]
    print("[run]", " ".join(cmd))
    subprocess.run(cmd, check=True)

    out = DIST / NAME
    print()
    print(f"[ok] Bundle creado en: {out}")
    print("Comprime esa carpeta entera en .zip y mándala. El destinatario")
    print("solo tiene que descomprimirla y hacer doble clic en PerspectiveTool.exe.")


if __name__ == "__main__":
    main()
