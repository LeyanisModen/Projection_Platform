from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Tuple


CORNER_LABELS = ("TL", "TR", "BL", "BR")


@dataclass
class Calibration:
    corners: List[int] = field(default_factory=lambda: [0, 0, 0, 0, 0, 0, 0, 0])
    source_size: Tuple[int, int] = (1920, 1080)
    output_size: Tuple[int, int] = (1600, 900)
    name: str = ""
    version: int = 1

    def as_points(self) -> List[Tuple[int, int]]:
        c = self.corners
        return [(c[0], c[1]), (c[2], c[3]), (c[4], c[5]), (c[6], c[7])]

    def set_point(self, index: int, x: int, y: int) -> None:
        if not 0 <= index < 4:
            raise IndexError(index)
        self.corners[index * 2] = int(x)
        self.corners[index * 2 + 1] = int(y)

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "name": self.name,
            "corners": list(self.corners),
            "source_size": list(self.source_size),
            "output_size": list(self.output_size),
        }


def load_calibration(path: str | Path) -> Calibration:
    p = Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{p}: el JSON raíz debe ser un objeto")

    corners = data.get("corners")
    if not isinstance(corners, list) or len(corners) != 8:
        raise ValueError(f"{p}: 'corners' debe ser una lista de 8 enteros")
    corners = [int(v) for v in corners]

    source_size = tuple(data.get("source_size", [1920, 1080]))
    output_size = tuple(data.get("output_size", [1600, 900]))
    if len(source_size) != 2 or len(output_size) != 2:
        raise ValueError(f"{p}: 'source_size' y 'output_size' deben ser [W, H]")

    return Calibration(
        corners=corners,
        source_size=(int(source_size[0]), int(source_size[1])),
        output_size=(int(output_size[0]), int(output_size[1])),
        name=str(data.get("name", "")),
        version=int(data.get("version", 1)),
    )


def save_calibration(path: str | Path, calib: Calibration) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(calib.to_dict(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def default_output_size_from_corners(corners: List[int]) -> Tuple[int, int]:
    xs = corners[0::2]
    ys = corners[1::2]
    w = max(xs) - min(xs)
    h = max(ys) - min(ys)
    return (max(2, int(w)), max(2, int(h)))
