"""Color presence detection for fabrication check photos.

Given a JPEG and the `codigos_color` string of a module (chars from
`y/g/c/v/m/o`, with `x` meaning skip), report which of the expected
colors are actually visible in the image. The photo is considered
valid when every expected color is present above `MIN_PIXEL_RATIO`.
"""

import cv2
import numpy as np


# Hue in OpenCV HSV is 0-179. Ranges are tuned conservatively; refine
# with real shop-floor photos.
COLOR_HSV_RANGES = {
    'y': [((20, 80, 80),  (35, 255, 255))],    # yellow
    'g': [((36, 60, 60),  (85, 255, 255))],    # green
    'c': [((86, 80, 80),  (105, 255, 255))],   # cyan
    'v': [((120, 50, 50), (145, 255, 255))],   # violet / purple
    'm': [((146, 80, 80), (175, 255, 255))],   # magenta / pink
    'o': [((8, 120, 120), (20, 255, 255))],    # orange
}

MIN_PIXEL_RATIO = 0.01


def _expected_codes(codigos_color):
    if not codigos_color:
        return []
    return [c for c in codigos_color.lower() if c in COLOR_HSV_RANGES]


def detect_colors(image_bytes, codigos_color, min_ratio=MIN_PIXEL_RATIO):
    expected = _expected_codes(codigos_color)
    if not expected:
        return {
            'valid': True,
            'expected': [],
            'detected': [],
            'pixel_ratios': {},
            'min_ratio': min_ratio,
        }

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {
            'valid': False,
            'expected': expected,
            'detected': [],
            'pixel_ratios': {},
            'min_ratio': min_ratio,
            'error': 'invalid_image',
        }

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    total = hsv.shape[0] * hsv.shape[1]

    pixel_ratios = {}
    detected = []
    for code in sorted(set(expected)):
        mask = None
        for lower, upper in COLOR_HSV_RANGES[code]:
            m = cv2.inRange(
                hsv,
                np.array(lower, dtype=np.uint8),
                np.array(upper, dtype=np.uint8),
            )
            mask = m if mask is None else cv2.bitwise_or(mask, m)
        ratio = float(cv2.countNonZero(mask)) / float(total) if total else 0.0
        pixel_ratios[code] = round(ratio, 4)
        if ratio >= min_ratio:
            detected.append(code)

    valid = all(code in detected for code in expected)
    return {
        'valid': valid,
        'expected': expected,
        'detected': sorted(detected),
        'pixel_ratios': pixel_ratios,
        'min_ratio': min_ratio,
    }
