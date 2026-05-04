"""Genera assets/icon.ico desde el favicon de la web Angular.

Reejecutar este script si el logo cambia:

    python admin_tools/perspective_tool/assets/build_icon.py
"""
from pathlib import Path

from PIL import Image


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SOURCE = REPO / "app_proyeccion_moden" / "src" / "assets" / "FaviconME_32x32.png"
DEST = HERE / "icon.ico"

SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"No se encuentra el favicon: {SOURCE}")
    img = Image.open(SOURCE).convert("RGBA")
    img.save(DEST, format="ICO", sizes=SIZES)
    print(f"OK -> {DEST} ({DEST.stat().st_size} bytes, sizes={SIZES})")


if __name__ == "__main__":
    main()
