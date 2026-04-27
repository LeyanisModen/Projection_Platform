"""Color presence detection for fabrication check photos.

Mirrors the pipeline in `detector.pyw` (HSV mask -> morphology -> contour
filters by area / solidity / aspect ratio / bbox density), so the same
ranges that we calibrated against real coloured cards in front of the
camera are used here.

The photo is valid when, for every colour expected by the module's
`codigos_color`, the number of card-shaped contours found is at least
the number of times that colour appears in the code (so 'bb' requires
TWO blue cards, not one).
"""

from collections import Counter

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# HSV ranges (from detector.pyw - tuned against real cards in the workshop).
# Hue is 0-179 in OpenCV.
# NOTE: 'yellow' upper-S (150) is below lower-S (180); this matches
# detector.pyw verbatim. If yellow stops detecting in real tests, this is
# the first place to look.
# ---------------------------------------------------------------------------
_COLOR_HSV_RANGES = {
    'orange': ((5, 180, 180),    (20, 255, 255)),
    'yellow': ((22, 180, 180),   (30, 150, 255)),
    'green':  ((40, 130, 130),   (85, 255, 255)),
    'blue':   ((90, 120, 130),   (125, 255, 255)),
    'purple': ((125, 100, 100),  (145, 255, 255)),
    'pink':   ((140, 60, 150),   (179, 120, 255)),
}

# Map Modulo.codigos_color chars to detector colour names. The model's
# help_text uses y/g/c/v/m/o/x; the detector calibrated against pink
# (instead of magenta), blue (instead of cyan) and purple (instead of
# violet), so we collapse near-equivalents to whichever range we have.
_CODE_TO_COLOR = {
    'y': 'yellow',
    'g': 'green',
    'c': 'blue',     # cyan -> blue range
    'b': 'blue',
    'v': 'purple',   # violet -> purple range
    'p': 'pink',
    'm': 'pink',     # magenta -> pink range
    'o': 'orange',
    'x': None,       # skip
}

# Pipeline parameters (from detector.pyw). Areas are stored as a fraction
# of the reference 4K frame so they auto-scale to whatever resolution the
# uploaded photo actually has (the visor downscales to 2048 px on the
# longer side before upload).
_REF_FRAME_AREA = 3840 * 2160
_MIN_AREA_RATIO = 3000 / _REF_FRAME_AREA
_MAX_AREA_RATIO = 8000 / _REF_FRAME_AREA

_SOLIDITY_MIN = 0.65
_BBOX_DENSITY_MIN = 70.0  # percent
_ASPECT_RATIO_RANGES = ((0.3, 0.85), (1.15, 3.5))

_MORPH_KERNEL = np.ones((5, 5), np.uint8)
_BLUR_KERNEL = (5, 5)


def _expected_color_names(codigos_color):
    if not codigos_color:
        return []
    out = []
    for ch in codigos_color.lower():
        name = _CODE_TO_COLOR.get(ch)
        if name:
            out.append(name)
    return out


def _count_cards(hsv_blurred, color_name, total_area):
    """Run the detector.pyw pipeline for a single colour.

    Returns the number of contours that pass every filter (area,
    solidity, aspect ratio, bbox density).
    """
    lower, upper = _COLOR_HSV_RANGES[color_name]
    mask = cv2.inRange(
        hsv_blurred,
        np.array(lower, dtype=np.uint8),
        np.array(upper, dtype=np.uint8),
    )
    mask = cv2.erode(mask, _MORPH_KERNEL, iterations=1)
    mask = cv2.dilate(mask, _MORPH_KERNEL, iterations=2)

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    min_area = _MIN_AREA_RATIO * total_area
    max_area = _MAX_AREA_RATIO * total_area

    cards = 0
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if not (min_area < area < max_area):
            continue

        hull_area = cv2.contourArea(cv2.convexHull(cnt))
        if hull_area <= 0:
            continue
        if (area / hull_area) < _SOLIDITY_MIN:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        if h <= 0 or w <= 0:
            continue
        ar = w / float(h)
        if not any(lo < ar < hi for lo, hi in _ASPECT_RATIO_RANGES):
            continue

        bbox_area = w * h
        density_pct = (area / bbox_area) * 100.0
        if density_pct < _BBOX_DENSITY_MIN:
            continue

        cards += 1

    return cards


def detect_colors(image_bytes, codigos_color):
    expected = _expected_color_names(codigos_color)
    expected_counts = Counter(expected)

    if not expected:
        return {
            'valid': True,
            'expected': [],
            'expected_counts': {},
            'cards_per_color': {},
        }

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {
            'valid': False,
            'expected': expected,
            'expected_counts': dict(expected_counts),
            'cards_per_color': {},
            'error': 'invalid_image',
        }

    height, width = bgr.shape[:2]
    total_area = float(width * height)

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    blurred = cv2.GaussianBlur(hsv, _BLUR_KERNEL, 0)

    cards_per_color = {}
    missing = {}
    for color, needed in expected_counts.items():
        found = _count_cards(blurred, color, total_area)
        cards_per_color[color] = found
        if found < needed:
            missing[color] = needed - found

    return {
        'valid': not missing,
        'expected': expected,
        'expected_counts': dict(expected_counts),
        'cards_per_color': cards_per_color,
        'missing': missing,
        'image_size': [width, height],
    }
