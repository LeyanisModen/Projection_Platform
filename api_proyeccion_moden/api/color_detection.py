"""Color presence detection for fabrication check photos.

Mirrors the pipeline in `detector.pyw` (HSV mask -> morphology -> contour
filters by area / solidity / aspect ratio / bbox density), so the same
ranges that we calibrated against real coloured cards in front of the
camera are used here.

The photo is valid when, for every colour expected by the module's
`codigos_color`, the number of card-shaped contours found is at least
the number of times that colour appears in the code (so 'bb' requires
TWO blue cards, not one).

When called with debug=True, every contour that survived the minimum
area filter is reported individually with its metrics and (if it was
rejected) the filter that rejected it. annotate_image() consumes that
detection list to draw a debug overlay on top of the original photo.
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

# Pipeline parameters. Areas are stored as a fraction of the reference
# 4K frame so they auto-scale to whatever resolution the uploaded photo
# actually has (the visor downscales to 2048 px on the longer side
# before upload).
#
# Range tuned for OBSBOT Tiny 2 mounted ~4.5 m above one edge of a 3 m
# wide table, looking at 15x5 cm coloured cards. At that geometry the
# card is roughly 600-3000 px² on the compressed (2048 px) frame, so
# a ~225-4500 px² window leaves headroom for cards a bit further
# (~6 m) without letting random small specks through. Detector.pyw's
# original (3000, 8000) range assumed smaller cards / closer camera.
_REF_FRAME_AREA = 3840 * 2160
_MIN_AREA_RATIO = 800 / _REF_FRAME_AREA    # ~225 px² on a 2048x1152 frame
_MAX_AREA_RATIO = 16000 / _REF_FRAME_AREA  # ~4500 px² on a 2048x1152 frame

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


def _evaluate_contour(cnt, total_area):
    """Run every card filter on a single contour and return either
    ('passed', metrics_dict) or (rejected_by, metrics_dict).

    metrics_dict has bbox, area, solidity, aspect_ratio, bbox_density
    so the caller can render an annotated overlay or surface the data
    in a debug panel.

    Returns None when the contour is below the minimum area threshold
    (sub-pixel noise we don't even want to report).
    """
    area = cv2.contourArea(cnt)
    min_area = _MIN_AREA_RATIO * total_area
    max_area = _MAX_AREA_RATIO * total_area

    if area <= min_area:
        return None  # noise, not interesting

    metrics = {
        'area': float(round(area, 1)),
        'solidity': None,
        'aspect_ratio': None,
        'bbox_density': None,
        'bbox': None,
    }

    if area >= max_area:
        x, y, w, h = cv2.boundingRect(cnt)
        metrics['bbox'] = [int(x), int(y), int(w), int(h)]
        return 'area_too_large', metrics

    hull_area = cv2.contourArea(cv2.convexHull(cnt))
    if hull_area <= 0:
        x, y, w, h = cv2.boundingRect(cnt)
        metrics['bbox'] = [int(x), int(y), int(w), int(h)]
        return 'invalid_hull', metrics
    solidity = float(area) / float(hull_area)
    metrics['solidity'] = round(solidity, 3)

    x, y, w, h = cv2.boundingRect(cnt)
    metrics['bbox'] = [int(x), int(y), int(w), int(h)]

    if solidity < _SOLIDITY_MIN:
        return 'solidity', metrics

    if h <= 0 or w <= 0:
        return 'invalid_bbox', metrics
    ar = float(w) / float(h)
    metrics['aspect_ratio'] = round(ar, 3)
    if not any(lo < ar < hi for lo, hi in _ASPECT_RATIO_RANGES):
        return 'aspect_ratio', metrics

    bbox_area = w * h
    density = (area / bbox_area) * 100.0
    metrics['bbox_density'] = round(density, 1)
    if density < _BBOX_DENSITY_MIN:
        return 'bbox_density', metrics

    return 'passed', metrics


def _scan_color(hsv_blurred, color_name, total_area):
    """Return every reportable detection for a single colour."""
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

    out = []
    for cnt in contours:
        result = _evaluate_contour(cnt, total_area)
        if result is None:
            continue
        verdict, metrics = result
        out.append({
            'color': color_name,
            'passed': verdict == 'passed',
            'rejected_by': None if verdict == 'passed' else verdict,
            **metrics,
        })
    return out


def detect_colors(image_bytes, codigos_color, debug=False):
    expected = _expected_color_names(codigos_color)
    expected_counts = Counter(expected)

    base = {
        'expected': expected,
        'expected_counts': dict(expected_counts),
    }

    if not expected:
        return {
            'valid': True,
            'cards_per_color': {},
            **base,
        }

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {
            'valid': False,
            'cards_per_color': {},
            'error': 'invalid_image',
            **base,
        }

    height, width = bgr.shape[:2]
    total_area = float(width * height)

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    blurred = cv2.GaussianBlur(hsv, _BLUR_KERNEL, 0)

    cards_per_color = {}
    detections_all = []
    for color in sorted(set(expected)):
        color_detections = _scan_color(blurred, color, total_area)
        cards_per_color[color] = sum(1 for d in color_detections if d['passed'])
        detections_all.extend(color_detections)

    missing = {
        color: needed - cards_per_color.get(color, 0)
        for color, needed in expected_counts.items()
        if cards_per_color.get(color, 0) < needed
    }

    result = {
        'valid': not missing,
        'cards_per_color': cards_per_color,
        'missing': missing,
        'image_size': [width, height],
        **base,
    }
    if debug:
        result['detections'] = detections_all
    return result


# ---------------------------------------------------------------------------
# Annotated-image rendering (debug-only)
# ---------------------------------------------------------------------------

# BGR colours for the overlay (the photo is BGR while in OpenCV).
_PASSED_BGR = (0, 220, 0)        # green
_REJECTED_BGR = (0, 140, 255)    # orange
_TEXT_BGR = (255, 255, 255)
_TEXT_SHADOW_BGR = (0, 0, 0)

_BORDER_PASSED = 4
_BORDER_REJECTED = 3


def annotate_image(image_bytes, detections, jpeg_quality=85):
    """Draw every detection on the photo and return the JPEG bytes.

    Passed contours get a thick green border; rejected ones get an
    orange border with the rejection reason next to them. Useful for
    eyeballing why a real card isn't passing (HSV range, area,
    aspect ratio, etc.).
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return image_bytes  # nothing we can do

    h_img, w_img = bgr.shape[:2]
    # Scale text and line widths so the overlay is legible regardless
    # of resolution.
    font_scale = max(0.5, min(w_img, h_img) / 1500.0)
    line_thickness = max(2, int(round(min(w_img, h_img) / 700.0)))

    for det in detections:
        bbox = det.get('bbox')
        if not bbox:
            continue
        x, y, w, h = bbox
        passed = det.get('passed')
        color = _PASSED_BGR if passed else _REJECTED_BGR
        thickness = _BORDER_PASSED if passed else _BORDER_REJECTED
        thickness = max(thickness, line_thickness)
        cv2.rectangle(bgr, (x, y), (x + w, y + h), color, thickness)

        # Build a short label with the colour, verdict and the most
        # informative metric.
        label_parts = [det.get('color', '?')]
        if passed:
            label_parts.append('OK')
        else:
            reason = det.get('rejected_by') or 'rej'
            label_parts.append(reason)
            metric_value = None
            if reason == 'solidity':
                metric_value = det.get('solidity')
            elif reason == 'aspect_ratio':
                metric_value = det.get('aspect_ratio')
            elif reason == 'bbox_density':
                metric_value = det.get('bbox_density')
            elif reason in ('area_too_large', 'area_too_small'):
                metric_value = det.get('area')
            if metric_value is not None:
                label_parts.append(f'{metric_value}')
        label = ' '.join(str(p) for p in label_parts)

        # Place the label above the bbox; if there's no room, put it
        # inside the top-left corner.
        text_size, _ = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, line_thickness
        )
        text_w, text_h = text_size
        text_x = x
        text_y = y - 6
        if text_y - text_h < 0:
            text_y = y + text_h + 6
        # Black shadow for legibility on bright backgrounds.
        cv2.putText(
            bgr, label, (text_x + 1, text_y + 1),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale,
            _TEXT_SHADOW_BGR, line_thickness + 1, cv2.LINE_AA,
        )
        cv2.putText(
            bgr, label, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale,
            _TEXT_BGR, line_thickness, cv2.LINE_AA,
        )

    ok, jpeg = cv2.imencode(
        '.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_quality)]
    )
    if not ok:
        return image_bytes
    return jpeg.tobytes()
